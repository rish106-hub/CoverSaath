import { createHash } from 'node:crypto';
import { sanitizeEvidenceTextForStorage } from '../ai-analysis/privacy-evidence-gate.js';
import {
  POLICY_PARAMETER_REGISTRY_VERSION,
  getPolicyParameterRegistry,
} from './policy-parameter-registry.js';

const supportedDecisionTrigger = trigger => ['emergency', 'planned_care', 'renewal'].includes(trigger) ? trigger : 'renewal';

const normalized = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const opaque = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const byteLength = value => Buffer.byteLength(value, 'utf8');

// Request packing limits. These mirror the privacy evidence gate defaults and
// the model task input schema; they are deliberately NOT raised here. If the gate
// is configured with narrower limits, the gate fails closed with a stable code
// rather than this module sending more than it permits.
export const SOURCE_REQUEST_LIMITS = Object.freeze({
  maxSources: 30,
  maxSourceBytes: 4_000,
  maxTotalBytes: 48_000,
  maxRequestedFields: 40,
});
const PAGE_STORAGE_BYTES = 16_000;
const NO_KEY_EXCERPT_BYTES = 1_200;
const ENVELOPE_SLACK_BYTES = 256;
const MAX_KEYS_PER_PAGE = 30;
const FALLBACK_PARAMETER_KEY = 'a.document_set';

export const SOURCE_BLOCKER_CODES = Object.freeze({
  excluded: 'SOURCE_EXCLUDED',
  notSent: 'SOURCE_NOT_SENT',
});
export const SOURCE_BLOCKER_REASONS = Object.freeze({
  restricted: 'RESTRICTED_EVIDENCE',
  unusable: 'SOURCE_TEXT_UNUSABLE',
  budget: 'REQUEST_BUDGET_EXCEEDED',
});
// Per-page sanitisation failures that exclude only that page. Any other failure
// is unexpected and still fails the run closed.
const PAGE_EXCLUSION_REASONS = Object.freeze({
  RESTRICTED_EVIDENCE: SOURCE_BLOCKER_REASONS.restricted,
  EVIDENCE_SOURCE_LIMIT: SOURCE_BLOCKER_REASONS.unusable,
  PRIVACY_GATE_MALFORMED: SOURCE_BLOCKER_REASONS.unusable,
});

function sourcePackRequired() {
  const error = new Error('Live analysis requires at least one authorised, protected OCR source page.');
  error.code = 'SOURCE_PACK_REQUIRED';
  error.statusCode = 409;
  return error;
}

function parameterMatchers(registry) {
  return registry.parameters
    .filter(parameter => parameter.modelExtraction.allowed && parameter.dataClass !== 'RESTRICTED')
    .map(parameter => ({
      key: parameter.key,
      needles: [normalized(parameter.label), normalized(parameter.key.slice(2))]
        .filter(needle => needle.length >= 4)
        .map(needle => ` ${needle} `),
    }));
}

function matchedKeys(text, matchers) {
  const searchable = ` ${normalized(text)} `;
  return matchers
    .filter(matcher => matcher.needles.some(needle => searchable.includes(needle)))
    .map(matcher => matcher.key);
}

// Cut at a byte bound without splitting a UTF-8 character or an opaque gate token.
function truncateSafely(value, maxBytes) {
  if (byteLength(value) <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && byteLength(value.slice(0, end)) > maxBytes) end -= 1;
  return value.slice(0, end).replace(/<[A-Z_]*(?::[a-f0-9]*)?$/, '').trimEnd();
}

// One page -> one bounded excerpt. Lines that mention a requested parameter (and
// the line that follows, where table values often wrap) are kept in page order.
// A page that mentions nothing is represented by a short head excerpt.
function selectExcerpt(text, matchers) {
  const units = text.split(/\n+|(?<=[.;])\s+/).map(unit => unit.trim()).filter(Boolean);
  const scored = units.map(unit => matchedKeys(unit, matchers).length > 0);
  const chosen = [];
  let used = 0;
  let previousMatched = false;
  units.forEach((unit, index) => {
    const wanted = scored[index] || previousMatched;
    previousMatched = scored[index];
    if (!wanted) return;
    const size = byteLength(unit) + 1;
    if (used + size > SOURCE_REQUEST_LIMITS.maxSourceBytes) return;
    chosen.push(unit);
    used += size;
  });
  if (chosen.length === 0) {
    const firstMatch = units.find((_unit, index) => scored[index]);
    if (firstMatch) return truncateSafely(firstMatch, SOURCE_REQUEST_LIMITS.maxSourceBytes);
    return truncateSafely(units.join('\n'), NO_KEY_EXCERPT_BYTES);
  }
  return chosen.join('\n');
}

function envelopeBaseBytes(registry) {
  const longestKeys = registry.parameters.map(parameter => parameter.key).sort((a, b) => b.length - a.length).slice(0, SOURCE_REQUEST_LIMITS.maxRequestedFields);
  return byteLength(JSON.stringify({
    context: { caseId: `case_${'0'.repeat(24)}`, subjectId: `subject_${'0'.repeat(24)}`, purpose: 'x'.repeat(240), requestedFields: longestKeys },
    sources: [],
    upstream: [],
  })) + ENVELOPE_SLACK_BYTES;
}

function requestEntryBytes(page) {
  return byteLength(JSON.stringify({ id: `source_${'0'.repeat(24)}`, version: page.version, page: page.page, text: page.text, status: 'known' })) + 1;
}

// Chooses which sanitised pages are sent to the model. Coverage first (each pick
// must add a not-yet-covered parameter), then corroborating pages, until the gate
// limits are reached. Pages that do not fit are reported by the caller; they are
// never silently dropped.
function planSentPages(candidates, registry) {
  let remaining = SOURCE_REQUEST_LIMITS.maxTotalBytes - envelopeBaseBytes(registry);
  const covered = new Set();
  const sent = new Set();
  const take = candidate => {
    sent.add(candidate);
    remaining -= candidate.cost;
    candidate.keys.forEach(key => covered.add(key));
  };
  while (sent.size < SOURCE_REQUEST_LIMITS.maxSources) {
    let best = null;
    for (const candidate of candidates) {
      if (sent.has(candidate) || candidate.cost > remaining) continue;
      const gain = candidate.keys.filter(key => !covered.has(key)).length;
      if (gain === 0) continue;
      if (!best || gain > best.gain || (gain === best.gain && candidate.keys.length > best.candidate.keys.length)) best = { candidate, gain };
    }
    if (!best) break;
    take(best.candidate);
  }
  const corroborating = candidates.filter(candidate => !sent.has(candidate))
    .sort((a, b) => b.keys.length - a.keys.length || a.order - b.order);
  for (const candidate of corroborating) {
    if (sent.size >= SOURCE_REQUEST_LIMITS.maxSources) break;
    if (candidate.cost <= remaining) take(candidate);
  }
  return sent;
}

// One stable blocker per (document, reason). Opaque document id and reason code
// only: no raw text, page content or internal identifiers.
function blockersFor(entries, code) {
  const grouped = new Map();
  for (const entry of entries) {
    const key = `${entry.documentId}:${entry.reasonCode}`;
    const current = grouped.get(key) ?? { code, reasonCode: entry.reasonCode, documentId: entry.documentId, pageCount: 0 };
    current.pageCount += 1;
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

export function createCoverageAnalysisSourceInput(caseRecord, pages, { registryVersion = POLICY_PARAMETER_REGISTRY_VERSION } = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw sourcePackRequired();
  // Unknown registry versions throw here: the run never pins a registry it cannot resolve.
  const registry = getPolicyParameterRegistry(registryVersion);
  const matchers = parameterMatchers(registry);

  const excluded = [];
  const admissible = [];
  pages.forEach((page, order) => {
    const documentId = opaque(page.document_upload_id);
    try {
      const stored = sanitizeEvidenceTextForStorage(page.extracted_text, { maxBytes: PAGE_STORAGE_BYTES });
      const pageKeys = matchedKeys(stored.text, matchers).slice(0, MAX_KEYS_PER_PAGE);
      // The excerpt is re-sanitised: dropping lines must not make the remainder restricted.
      const excerpt = sanitizeEvidenceTextForStorage(selectExcerpt(stored.text, matchers), { maxBytes: SOURCE_REQUEST_LIMITS.maxSourceBytes });
      const excerptKeys = matchedKeys(excerpt.text, matchers).slice(0, MAX_KEYS_PER_PAGE);
      const keys = excerptKeys.length > 0 ? excerptKeys : [FALLBACK_PARAMETER_KEY];
      const candidate = {
        order,
        id: page.id,
        version: page.source_version ?? 'unknown',
        page: page.page_number,
        document: page.document_upload_id,
        documentId,
        text: excerpt.text,
        textDigest: stored.digest,
        redactionReasonCodes: [...new Set([...stored.reasonCodes, ...excerpt.reasonCodes])].sort(),
        keys,
        fullTextKeys: pageKeys.length > 0 ? pageKeys : [FALLBACK_PARAMETER_KEY],
      };
      candidate.cost = requestEntryBytes(candidate);
      admissible.push(candidate);
    } catch (error) {
      const reasonCode = PAGE_EXCLUSION_REASONS[error?.code];
      if (!reasonCode) throw error;
      excluded.push({ documentId, reasonCode });
    }
  });
  if (admissible.length === 0) throw Object.assign(sourcePackRequired(), { sourceBlockers: blockersFor(excluded, SOURCE_BLOCKER_CODES.excluded) });

  const sentSet = planSentPages(admissible, registry);
  const sources = admissible.filter(candidate => sentSet.has(candidate));
  const notSent = admissible.filter(candidate => !sentSet.has(candidate));

  const sentKeys = new Set(sources.flatMap(source => source.keys));
  const requestedFields = registry.parameters.map(parameter => parameter.key)
    .filter(key => sentKeys.has(key))
    .slice(0, SOURCE_REQUEST_LIMITS.maxRequestedFields);
  const requested = new Set(requestedFields);
  const candidateKeys = new Set(admissible.flatMap(candidate => candidate.fullTextKeys));
  const subjectId = caseRecord.analysis_subject_adult_id ?? caseRecord.opened_by_adult_id;

  // Acquisition states follow the parameter state machine: not_requested ->
  // requested -> received. 'received' only where a sanitised page excerpt for the
  // key is part of the model request. A key whose pages were not sent stays
  // 'requested'; a key never found is 'not_requested'.
  const parameterStates = registry.parameters.map(parameter => ({
    parameterKey: parameter.key,
    acquisitionState: requested.has(parameter.key) ? 'received' : candidateKeys.has(parameter.key) ? 'requested' : 'not_requested',
    resolutionState: 'unknown',
  }));

  const policyId = `UNCLASSIFIED:${opaque(caseRecord.id)}`;
  // One descriptor per requested parameter. Page text lives once, in sourcePages.
  const evidence = requestedFields.map(parameterKey => ({
    id: `ocr:${parameterKey}`,
    fact: parameterKey,
    field: parameterKey,
    parameterKey,
    sourceIds: sources.filter(source => source.keys.includes(parameterKey)).map(source => source.id),
    value: null,
    evidenceStatus: 'ocr_candidate',
    status: 'ocr_candidate',
    dimension: 'suitability',
    policyId,
  }));

  return {
    parameterRegistryVersion: registryVersion,
    parameterStates,
    consent: true,
    synthetic: false,
    trigger: supportedDecisionTrigger(caseRecord.trigger_type),
    statedEstimate: Number(caseRecord.stated_estimate_minor ?? 0) / 100,
    // Only pages that are part of the model request are authorised for dispatch.
    authorizedSourceIds: sources.map(source => source.id),
    // Exact source-page -> document set selected under current consent. The
    // pre-dispatch validator re-checks every pair against the database before
    // each model call, so a page can never be re-attributed to another document.
    authorizedSources: sources.map(source => ({ sourceId: source.id, documentId: source.document })),
    // One entry per sent page, with its own id, version and page number.
    sourcePages: sources.map(source => ({
      sourceId: source.id,
      version: source.version,
      page: source.page,
      documentId: source.document,
      text: source.text,
      textDigest: source.textDigest,
      redactionReasonCodes: source.redactionReasonCodes,
      parameterKeys: source.keys,
    })),
    sourceSelection: {
      sent: sources.length,
      excluded: excluded.length,
      notSent: notSent.map(source => ({ documentId: source.documentId, page: source.page, reasonCode: SOURCE_BLOCKER_REASONS.budget })),
    },
    sourceBlockers: [
      ...blockersFor(excluded, SOURCE_BLOCKER_CODES.excluded),
      ...blockersFor(notSent.map(source => ({ documentId: source.documentId, reasonCode: SOURCE_BLOCKER_REASONS.budget })), SOURCE_BLOCKER_CODES.notSent),
    ],
    profilePacket: {
      subjectId,
      source: { type: 'ocr', id: sources[0].id, version: sources[0].version, page: sources[0].page, location: `page:${sources[0].page}` },
      requestedFields,
      consent: {
        id: caseRecord.consent_grant_id ?? 'coverage-reconstruction-consent',
        subjectId,
        status: 'granted',
        purpose: 'coverage_reconstruction',
        sources: ['ocr'],
        fields: requestedFields,
      },
    },
    groupPolicies: [{ policyId, evidence }],
    personalPacket: {
      synthetic: false,
      consent: true,
      evidence,
    },
    continuity: {},
  };
}

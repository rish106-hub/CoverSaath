import { createHash } from 'node:crypto';
import { sanitizeEvidenceTextForStorage } from '../ai-analysis/privacy-evidence-gate.js';
import {
  POLICY_PARAMETER_REGISTRY_VERSION,
  getPolicyParameterRegistry,
} from './policy-parameter-registry.js';

const supportedDecisionTrigger = trigger => ['emergency', 'planned_care', 'renewal'].includes(trigger) ? trigger : 'renewal';

const normalized = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const opaque = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
// The run-level placeholder policy that parameter records and the evidence
// descriptors of a run reference until evidence is classified to a real policy.
export const unclassifiedPolicyId = caseId => `UNCLASSIFIED:${opaque(caseId)}`;
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
const ENVELOPE_SLACK_BYTES = 256;
const MAX_KEYS_PER_PAGE = 30;

export const SOURCE_BLOCKER_CODES = Object.freeze({
  excluded: 'SOURCE_EXCLUDED',
  notSent: 'SOURCE_NOT_SENT',
});
export const SOURCE_BLOCKER_REASONS = Object.freeze({
  restricted: 'RESTRICTED_EVIDENCE',
  unusable: 'SOURCE_TEXT_UNUSABLE',
  budget: 'REQUEST_BUDGET_EXCEEDED',
  // The page mentions no requested parameter, so none of it is allowlisted for
  // the model request. Reported in sourceSelection.notSent; never sent.
  noParameterMatch: 'NO_PARAMETER_MATCH',
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

// Allowlist excerpt planner. A page contributes only the lines that mention a
// requested parameter. A page that mentions none contributes nothing (the caller
// reports it as NO_PARAMETER_MATCH); there is no head-of-page fallback.
//
// The line after a matched line (table values often wrap onto it) is NOT
// included by default: it is included only when it looks like a policy term
// value (a digit, amount, percentage or duration) and cannot be a person row
// (no capitalised multi-word sequence, relationship word, name next to a date,
// or identifier placeholder).
const PLACEHOLDER_TOKEN = /<[A-Z]+(?:_[A-Z]+)*_[1-9][0-9]{0,5}>|<[A-Z_]+:[a-f0-9]{16}>/g;
const RELATIONSHIP_WORD = /\b(?:self|spouse|son|daughter|father|mother|child|children|wife|husband)\b/i;
const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
const DATE_LIKE = new RegExp(`\\b\\d{1,2}[/.\\-]\\d{1,2}[/.\\-]\\d{2,4}\\b|\\b\\d{4}[/.\\-]\\d{1,2}[/.\\-]\\d{1,2}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS}\\.?,?\\s+\\d{2,4}\\b|\\b${MONTHS}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{2,4}\\b`, 'i');
const CAPITALISED_SEQUENCE = /\b\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)+|\b\p{Lu}{2,}(?:\s+\p{Lu}{2,})+\b/u;
const NAME_LIKE_WORD = /^\p{Lu}\p{Ll}+$/u;
const TERM_VALUE = /\d|%|\b(?:percent|per cent|lakhs?|crores?|rupees?|days?|weeks?|months?|years?)\b/i;

function looksLikePersonRow(unit) {
  if (RELATIONSHIP_WORD.test(unit)) return true;
  // A date together with any capitalised word: possibly a name next to a date.
  if (DATE_LIKE.test(unit)) {
    const words = unit.split(/[\s|,;:]+/).filter(Boolean);
    if (words.some(word => NAME_LIKE_WORD.test(word))) return true;
  }
  return false;
}

function mayFollowMatchedLine(unit) {
  if (unit.search(PLACEHOLDER_TOKEN) !== -1) return false;
  if (looksLikePersonRow(unit) || CAPITALISED_SEQUENCE.test(unit)) return false;
  return TERM_VALUE.test(unit);
}

// Returns the excerpt, or null when no unit of the page mentions a parameter.
function selectExcerpt(text, matchers) {
  const units = text.split(/\n+|(?<=[.;])\s+/).map(unit => unit.trim()).filter(Boolean);
  const matched = units.map(unit => matchedKeys(unit, matchers).length > 0);
  if (!matched.some(Boolean)) return null;
  const chosen = [];
  let used = 0;
  units.forEach((unit, index) => {
    const wanted = matched[index] || (index > 0 && matched[index - 1] && mayFollowMatchedLine(unit));
    if (!wanted) return;
    const size = byteLength(unit) + 1;
    if (used + size > SOURCE_REQUEST_LIMITS.maxSourceBytes) return;
    chosen.push(unit);
    used += size;
  });
  if (chosen.length === 0) return truncateSafely(units.find((_unit, index) => matched[index]), SOURCE_REQUEST_LIMITS.maxSourceBytes);
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

// `knownIdentifiers` are the household's own names, dates of birth, phones and
// emails, loaded server-side by the caller for this call only. They are handed to
// the gate so they are minimised to placeholders before anything is stored; they
// are never copied into the returned input.
export function createCoverageAnalysisSourceInput(caseRecord, pages, { registryVersion = POLICY_PARAMETER_REGISTRY_VERSION, knownIdentifiers } = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw sourcePackRequired();
  // Unknown registry versions throw here: the run never pins a registry it cannot resolve.
  const registry = getPolicyParameterRegistry(registryVersion);
  const matchers = parameterMatchers(registry);
  const gateOptions = knownIdentifiers === undefined ? {} : { knownIdentifiers };

  const excluded = [];
  const unmatched = [];
  const admissible = [];
  pages.forEach((page, order) => {
    const documentId = opaque(page.document_upload_id);
    try {
      const stored = sanitizeEvidenceTextForStorage(page.extracted_text, { maxBytes: PAGE_STORAGE_BYTES, ...gateOptions });
      const pageKeys = matchedKeys(stored.text, matchers).slice(0, MAX_KEYS_PER_PAGE);
      const selected = selectExcerpt(stored.text, matchers);
      // The excerpt is re-sanitised: dropping lines must not make the remainder restricted.
      const excerpt = selected === null ? null : sanitizeEvidenceTextForStorage(selected, { maxBytes: SOURCE_REQUEST_LIMITS.maxSourceBytes, ...gateOptions });
      const excerptKeys = excerpt === null ? [] : matchedKeys(excerpt.text, matchers).slice(0, MAX_KEYS_PER_PAGE);
      if (excerptKeys.length === 0) {
        // Nothing on this page is allowlisted for the model. It is not sent and is
        // reported (never silently dropped); keys seen only in the full page text
        // still count as requested-but-not-received.
        unmatched.push({ documentId, page: page.page_number, pageKeys });
        return;
      }
      const candidate = {
        order,
        id: page.id,
        version: page.source_version ?? 'unknown',
        page: page.page_number,
        document: page.document_upload_id,
        documentId,
        text: excerpt.text,
        redactionReasonCodes: [...new Set([...stored.reasonCodes, ...excerpt.reasonCodes])].sort(),
        keys: excerptKeys,
        fullTextKeys: pageKeys.length > 0 ? pageKeys : excerptKeys,
      };
      candidate.cost = requestEntryBytes(candidate);
      admissible.push(candidate);
    } catch (error) {
      const reasonCode = PAGE_EXCLUSION_REASONS[error?.code];
      if (!reasonCode) throw error;
      excluded.push({ documentId, reasonCode });
    }
  });
  const noMatchNotSent = unmatched.map(item => ({ documentId: item.documentId, page: item.page, reasonCode: SOURCE_BLOCKER_REASONS.noParameterMatch }));
  if (admissible.length === 0) {
    throw Object.assign(sourcePackRequired(), {
      sourceBlockers: [
        ...blockersFor(excluded, SOURCE_BLOCKER_CODES.excluded),
        ...blockersFor(noMatchNotSent, SOURCE_BLOCKER_CODES.notSent),
      ],
    });
  }

  const sentSet = planSentPages(admissible, registry);
  const sources = admissible.filter(candidate => sentSet.has(candidate));
  const notSent = admissible.filter(candidate => !sentSet.has(candidate));

  const sentKeys = new Set(sources.flatMap(source => source.keys));
  const requestedFields = registry.parameters.map(parameter => parameter.key)
    .filter(key => sentKeys.has(key))
    .slice(0, SOURCE_REQUEST_LIMITS.maxRequestedFields);
  const requested = new Set(requestedFields);
  const candidateKeys = new Set([...admissible.flatMap(candidate => candidate.fullTextKeys), ...unmatched.flatMap(item => item.pageKeys)]);
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

  const policyId = unclassifiedPolicyId(caseRecord.id);
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
      redactionReasonCodes: source.redactionReasonCodes,
      parameterKeys: source.keys,
    })),
    sourceSelection: {
      sent: sources.length,
      excluded: excluded.length,
      // Every page that is not part of the model request, with its reason.
      notSent: [
        ...notSent.map(source => ({ documentId: source.documentId, page: source.page, reasonCode: SOURCE_BLOCKER_REASONS.budget })),
        ...noMatchNotSent,
      ],
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

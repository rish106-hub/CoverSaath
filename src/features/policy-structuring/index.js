// Whole-document policy structuring (ADR 0006). Sarvam block pages are sectioned, privacy-gated,
// extracted and reconciled by an injected model call, then decided by deterministic code. Nothing a
// model returns is stored above extracted_unverified or conflicting. Off unless POLICY_STRUCTURING_ENABLED.
import { GEMINI_MODEL_RECIPIENT, sanitizeEvidenceTextForStorage } from '../ai-analysis/privacy-evidence-gate.js';
import { POLICY_PARAMETER_REGISTRY_VERSION } from '../coverage-analysis/policy-parameter-registry.js';
import { sectionDocument } from './sectioner.js';
import { STRUCTURING_LIMITS, extractChunks } from './extractor.js';
import { decideStates, reconcile } from './reconciler.js';
import { buildCoverageReport } from './coverage-report.js';
import { decideOutcome, structuringCriticalKeys } from './outcome.js';

export { STRUCTURING_DROPPED_TAGS, sectionDocument, sectionStoredDocument } from './sectioner.js';
export { normalizeValue, validateExtractedItems } from './validator.js';
export { EXTRACTOR_VERSION, STRUCTURING_LIMITS, extractChunks, registryCatalog } from './extractor.js';
export { RECONCILER_VERSION, SHORT_VALUE_CHARS, decideStates, deterministicConflicts, groupItems, isConflict, reconcile } from './reconciler.js';
export { CRITICAL_FIELD_KEYS, buildCoverageReport, readingMatches, scoreCriticalFields, scoreStructuring } from './coverage-report.js';
export {
  EVIDENCE_OUTCOMES, MAX_SKIPPED_SHARE, MIN_ACCEPTED_ITEMS, OUTCOME_THRESHOLDS, PROCESSING_STATUSES,
  decideOutcome, storedOutcome, structuringCriticalKeys,
} from './outcome.js';

export const POLICY_STRUCTURING_VERSION = 'policy-structuring/v2';
const GATE_MAX_BYTES = 16_000;

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

export const structuringEnabled = (env = process.env) => env.POLICY_STRUCTURING_ENABLED === 'true';

// Document-specific Gemini grant (ADR 0006): an active grant whose scope names this exact document for
// `derive` by the Gemini recipient. A scope without a document id does not count. `consents` is the
// ConsentRepository (requireActive and get). The check is async (S3.2): every caller awaits it,
// including the commit, which runs it inside its transaction.
export function documentGrantCheck({ consents, grantId, subjectAdultId, documentId, householdId }) {
  const scope = { resourceType: 'document', action: 'derive', dataCategory: 'insurance_document', recipient: GEMINI_MODEL_RECIPIENT };
  if (typeof householdId !== 'string' || !householdId) fail('STRUCTURING_CONFIG', 'The document household is required.');
  return async () => {
    await consents.requireActive(grantId, { subjectAdultId, resourceId: documentId, ...scope });
    const grant = await consents.get(grantId);
    // The grant must belong to the document's household, so its revocation erases this document's output.
    if (grant?.household_id !== householdId) fail('CONSENT_SCOPE_REQUIRED', 'A document-specific Gemini grant is required.');
    const named = grant?.scopes.some(entry => entry.resource_type === scope.resourceType && entry.resource_id === documentId
      && entry.action === scope.action && entry.data_category === scope.dataCategory && entry.recipient === scope.recipient);
    if (!named) fail('CONSENT_SCOPE_REQUIRED', 'A document-specific Gemini grant is required.');
  };
}

// Every document string sent to a model passes the privacy gate first: chunk text and its section title.
// The gated text is what the model sees and what evidence quotes are checked against. A truncated or
// refused chunk is not sent; a refused title is dropped, never sent raw.
export function gateChunks(chunks, { knownIdentifiers, sanitize = sanitizeEvidenceTextForStorage } = {}) {
  const sent = [];
  const skipped = {};
  const gateTitle = title => {
    if (typeof title !== 'string' || !title.trim()) return null;
    try {
      const gated = sanitize(title, { maxBytes: GATE_MAX_BYTES, knownIdentifiers });
      return gated.truncated ? null : gated.text;
    } catch {
      return null;
    }
  };
  for (const chunk of chunks) {
    try {
      const gated = sanitize(chunk.text, { maxBytes: GATE_MAX_BYTES, knownIdentifiers });
      if (gated.truncated) skipped[chunk.id] = 'privacy_truncated';
      else sent.push({ ...chunk, text: gated.text, title: gateTitle(chunk.title) });
    } catch {
      skipped[chunk.id] = 'privacy_gate_refused';
    }
  }
  return { sent, skipped };
}

/**
 * pages: [{ page, blocks: [{ text, tag }] }]. consentCheck: async, throws when the document-specific
 * Gemini grant is no longer current; called before the run, before every model call and before commit.
 * commit: optional async ({ decisions, proposals, coverage, outcome }) => counts; coverage is counts-only (chunk
 * outcomes, skipped pages and reasons, calls, tokens); it must re-check consent inside its own
 * transaction (PolicyStructuringRepository.commitStructuring does).
 * outcome (decideOutcome, counts only): a `failed` evidence outcome is never committed.
 */
export async function structurePolicyDocument({
  pages, call, consentCheck, commit = null, alreadyStored = null, knownIdentifiers, limits,
  registryVersion = POLICY_PARAMETER_REGISTRY_VERSION, maxChunkChars, env = process.env,
}) {
  if (!structuringEnabled(env)) fail('STRUCTURING_DISABLED', 'Policy structuring is disabled.');
  if (typeof call !== 'function' || typeof consentCheck !== 'function') fail('STRUCTURING_CONFIG', 'A model call and a consent check are required.');
  await consentCheck();
  // A document already structured under this pipeline version is not paid for again.
  if (alreadyStored && await alreadyStored()) return { version: POLICY_STRUCTURING_VERSION, replayed: true };
  const sectioned = sectionDocument(pages, maxChunkChars ? { maxChunkChars } : undefined);
  const gated = gateChunks(sectioned.chunks, { knownIdentifiers });
  const extraction = await extractChunks({ chunks: gated.sent, registryVersion, call, consentCheck, limits });
  for (const [chunkId, reason] of Object.entries(gated.skipped)) extraction.chunkOutcomes[chunkId] = { status: 'skipped', reason };
  const caps = { ...STRUCTURING_LIMITS, ...limits };
  const reconciliation = await reconcile({
    accepted: extraction.accepted, proposals: extraction.proposals, call, consentCheck, budgetStopped: extraction.budgetStopped,
    limits: { maxInputTokens: Math.max(0, caps.maxInputTokensPerDocument - extraction.usage.inputTokens) },
  });
  const decisions = decideStates({ accepted: extraction.accepted, conflicts: reconciliation.conflicts });
  const before = buildCoverageReport({ sectioned, extraction, reconciliation });
  const outcome = decideOutcome(before, { criticalKeys: structuringCriticalKeys(registryVersion), presentKeys: decisions.map(decision => decision.parameterKey) });
  let committed = null;
  if (commit && outcome.evidenceOutcome !== 'failed') {
    await consentCheck();
    const coverage = {
      chunks: before.chunks, calls: before.calls, usage: before.usage, rejectedReasons: before.items.rejectedReasons,
      skippedChunks: before.perChunk.filter(entry => entry.outcome === 'skipped').map(entry => ({ page: entry.page, reason: entry.reason })),
    };
    committed = await commit({ decisions, proposals: extraction.proposals, coverage, outcome });
  }
  return {
    version: POLICY_STRUCTURING_VERSION,
    outcome,
    decisions,
    proposals: extraction.proposals,
    conflicts: reconciliation.conflicts,
    commit: committed,
    extraction,
    reconciliation,
    report: buildCoverageReport({ sectioned, extraction, reconciliation, commit: committed }),
  };
}

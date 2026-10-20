// Question-driven investigation (ADR 0008). The model proposes cited findings; code validates every clause id and
// quote, runs a mandatory override sweep, and assembles the answer. Nothing here decides coverage or does arithmetic.
// Every clause sent to a model passes the privacy gate first, consent is re-checked before each call, and the
// provider call is injected (no SDK or fetch is imported here).
import { sanitizeEvidenceTextForStorage } from '../ai-analysis/privacy-evidence-gate.js';
import { EVIDENCE_INVESTIGATE_TASK, EVIDENCE_SWEEP_TASK, FINDING_EFFECTS, INVESTIGATE_SCHEMA, STRUCTURING_INSTRUCTIONS, SWEEP_SCHEMA } from '../ai-analysis/structuring-contract.js';
import { validateAnswer, validateFinding } from '../../contracts/policy-evidence.js';
import { classifyClause } from './clauses.js';

export const INVESTIGATION_VERSION = 'policy-evidence-investigation/v2';
// maxInputBytes is only the fallback when the caller's gateway does not state its limit; it matches
// STRUCTURING_GATEWAY_LIMITS.maxInputBytes. Clause budgets are always derived from it, never set separately.
// maxClausesPerCall matches the gateway's structuring payload array bound (schemas.js validateStructuringInput).
export const INVESTIGATION_LIMITS = Object.freeze({
  maxInputBytes: 64_000, payloadMarginBytes: 1_024, maxClausesPerCall: 500, ftsPerKind: 8, maxFindings: 60, maxOverrides: 60, maxQuestionChars: 2000,
});
const GATE_MAX_BYTES = 16_000;
const OVERRIDE_EFFECTS = new Set(['limits', 'excludes', 'waives', 'overrides', 'conditions']);
const BASE_KINDS = Object.freeze(['benefit', 'limit', 'waiting_period', 'exclusion', 'definition', 'endorsement', 'schedule_fact', 'condition']);

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

/** Deterministic checklist of clause kinds to read for a question. A coverage question reads every coverage kind. */
export function checklistFor(question) {
  const kinds = new Set(BASE_KINDS);
  if (/\b(?:claim|cashless|network|reimburs|intimat|document|procedure|grievance)\w*/i.test(question)) kinds.add('procedure');
  return [...kinds];
}

const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

function gate(text, knownIdentifiers) {
  try {
    const gated = sanitizeEvidenceTextForStorage(text, { maxBytes: GATE_MAX_BYTES, knownIdentifiers });
    return gated.truncated ? null : gated.text;
  } catch { return null; }
}

/** Gates every clause; a refused or truncated clause is withheld, never sent raw. */
export function gateClauses(clauses, knownIdentifiers) {
  const sent = [];
  const withheld = [];
  for (const clause of clauses) {
    const text = gate(clause.text, knownIdentifiers);
    if (text === null) { withheld.push(clause.clauseId); continue; }
    const title = clause.sectionPath?.[0] ? gate(clause.sectionPath[0], knownIdentifiers) : null;
    sent.push({ ...clause, text, title });
  }
  return { sent, withheld };
}

const toWire = clause => ({ clause_id: clause.clauseId, document_id: clause.documentId, page: clause.page, kind: clause.kind, title: clause.title, text: clause.text });
// One clause's share of the serialised payload, including the comma that separates it in the clauses array.
const clauseBytes = clause => bytes(toWire(clause)) + 1;

/**
 * Bytes left for clauses in a payload, measured the way the gateway measures it (JSON.stringify of the payload,
 * model-gateway.js), after the rest of the payload and a safety margin. `skeleton` is the payload with `clauses: []`.
 */
export function clauseBudget(skeleton, { maxInputBytes, payloadMarginBytes = INVESTIGATION_LIMITS.payloadMarginBytes }) {
  return maxInputBytes - payloadMarginBytes - bytes(skeleton);
}

/**
 * Context for the model. Whole gated policy when it fits the clause budget (see clauseBudget); otherwise endorsements
 * and schedule clauses, then FTS hits interleaved by rank (`search` is household-scoped): a search over every clause
 * first, then one per checklist kind as a boost, then 'other'. Kind ranks; it never decides what can be found.
 */
export function selectContext({ gated, checklist, question, search, budgetBytes, maxClauses = INVESTIGATION_LIMITS.maxClausesPerCall }) {
  const total = gated.reduce((sum, clause) => sum + clauseBytes(clause), 0);
  if (total <= budgetBytes && gated.length <= maxClauses) return { clauses: gated, path: 'whole_policy', truncated: false };
  const byId = new Map(gated.map((clause, index) => [clause.clauseId, { clause, index }]));
  const ordered = [];
  const seen = new Set();
  const take = clause => {
    const entry = byId.get(clause.clauseId);
    if (entry && !seen.has(clause.clauseId)) { seen.add(clause.clauseId); ordered.push(entry); }
  };
  gated.filter(clause => clause.kind === 'endorsement' || clause.kind === 'schedule_fact').forEach(take);
  const lists = [
    search({ query: question, kinds: null, limit: INVESTIGATION_LIMITS.ftsPerKind }),
    ...[...new Set([...checklist, 'other'])].map(kind => search({ query: question, kinds: [kind], limit: INVESTIGATION_LIMITS.ftsPerKind })),
  ];
  for (let rank = 0; rank < INVESTIGATION_LIMITS.ftsPerKind; rank += 1) for (const hits of lists) if (hits[rank]) take(hits[rank]);
  const kept = [];
  let used = 0;
  let truncated = false;
  for (const entry of ordered) {
    const size = clauseBytes(entry.clause);
    if (used + size > budgetBytes || kept.length >= maxClauses) { truncated = true; continue; }
    used += size;
    kept.push(entry);
  }
  kept.sort((a, b) => a.index - b.index);
  return { clauses: kept.map(entry => entry.clause), path: 'retrieved', truncated: truncated || kept.length < gated.length };
}

const strings = list => (Array.isArray(list) ? list.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim().slice(0, 500)) : null);

/** A consequential claim (condition, exception, value, appliesTo) is kept only if it is printed in a cited clause. */
function grounded(claim, clauseIds, clauseText) {
  return typeof claim === 'string' && claim.length > 0 && clauseIds.some(id => (clauseText.get(id) ?? '').includes(claim));
}

function parseFindings(json, clauseText, limits) {
  const findings = [];
  let rejected = 0;
  const seen = new Set();
  const raw = Array.isArray(json?.findings) ? json.findings : [];
  for (const item of raw.slice(0, limits.maxFindings)) {
    const candidate = {
      findingId: `f${findings.length + 1}`,
      clauseIds: Array.isArray(item?.clause_ids) ? item.clause_ids : [],
      quote: typeof item?.quote === 'string' ? item.quote.trim() : '',
      subject: typeof item?.subject === 'string' ? item.subject.trim().slice(0, 200) : '',
      appliesTo: typeof item?.applies_to === 'string' ? item.applies_to.trim().slice(0, 200) : null,
      conditions: strings(item?.conditions), exceptions: strings(item?.exceptions),
      overrides: [], value: typeof item?.value === 'string' ? item.value.trim().slice(0, 500) : null,
      // Unknown or missing effect is 'conditions': a bad label may under-claim, never over-claim coverage.
      effect: FINDING_EFFECTS.includes(item?.effect) ? item.effect : 'conditions',
      openKind: typeof item?.open_kind === 'string' ? item.open_kind.trim().slice(0, 120) : null,
      state: 'extracted_unverified',
    };
    const key = JSON.stringify([candidate.clauseIds, candidate.quote, candidate.effect]);
    if (validateFinding(candidate, clauseText).length || seen.has(key)) { rejected += 1; continue; }
    // The main quote is valid; every other assertion must carry its own source text or it is dropped.
    for (const field of ['conditions', 'exceptions']) {
      const kept = (candidate[field] ?? []).filter(claim => grounded(claim, candidate.clauseIds, clauseText));
      rejected += (candidate[field] ?? []).length - kept.length;
      candidate[field] = kept;
    }
    for (const field of ['value', 'appliesTo']) {
      if (candidate[field] !== null && candidate[field] !== '' && !grounded(candidate[field], candidate.clauseIds, clauseText)) { candidate[field] = null; rejected += 1; }
    }
    seen.add(key);
    findings.push(candidate);
  }
  rejected += Math.max(0, raw.length - limits.maxFindings);
  return { findings, rejected };
}

function parseOverrides(json, clauseText, findingIds, limits) {
  const overrides = [];
  let rejected = 0;
  const raw = Array.isArray(json?.overrides) ? json.overrides : [];
  for (const item of raw.slice(0, limits.maxOverrides)) {
    const clauseIds = Array.isArray(item?.clause_ids) ? item.clause_ids : [];
    const quote = typeof item?.quote === 'string' ? item.quote.trim() : '';
    const valid = clauseIds.length > 0 && clauseIds.every(id => clauseText.has(id)) && OVERRIDE_EFFECTS.has(item?.effect)
      && quote && clauseIds.some(id => clauseText.get(id).includes(quote));
    if (!valid) { rejected += 1; continue; }
    const targets = (Array.isArray(item.target_finding_ids) ? item.target_finding_ids : []).filter(id => findingIds.has(id));
    overrides.push({ clauseIds, quote, subject: typeof item.subject === 'string' ? item.subject.trim().slice(0, 200) : '', effect: item.effect, targets });
  }
  rejected += Math.max(0, raw.length - limits.maxOverrides);
  return { overrides, rejected };
}

const SWEEP_KINDS = Object.freeze(['exclusion', 'limit', 'waiting_period', 'endorsement', 'condition', 'schedule_fact', 'definition', 'other']);
const SWEEP_TERMS = 'exclusion excluded waiver waived override notwithstanding limit sub-limit capped waiting period not payable';

/**
 * Context for the sweep, bounded by its own clause budget (the sweep payload also carries the findings). Clauses cited
 * by a finding come first and are never dropped. On the retrieved path, fresh retrieval driven by the findings comes
 * next (the cross-page exclusion a first retrieval missed), then sweep-relevant kinds, then the rest of the first-pass
 * context. `dropped` counts first-pass clauses left out; `truncated` is true when any candidate did not fit.
 */
export function selectSweepContext({ context, gated, findings, search, budgetBytes, maxClauses = INVESTIGATION_LIMITS.maxClausesPerCall }) {
  const gatedById = new Map(gated.map(clause => [clause.clauseId, clause]));
  const inContext = new Set(context.clauses.map(clause => clause.clauseId));
  const cited = new Set(findings.flatMap(finding => finding.clauseIds ?? []));
  const ordered = [];
  const seen = new Set();
  const take = clause => { if (clause && !seen.has(clause.clauseId)) { seen.add(clause.clauseId); ordered.push(clause); } };
  context.clauses.filter(clause => cited.has(clause.clauseId)).forEach(take);
  if (context.path !== 'whole_policy') {
    const queries = [...new Set([SWEEP_TERMS, ...findings.flatMap(finding => [finding.subject, `${finding.subject} ${SWEEP_TERMS}`, finding.quote])])].slice(0, 12);
    for (const query of queries) {
      // Sweep kinds are a boost; the unfiltered search then reaches a clause of any kind.
      for (const kinds of [SWEEP_KINDS, null]) {
        for (const hit of search({ query, kinds, limit: INVESTIGATION_LIMITS.ftsPerKind })) take(gatedById.get(hit.clauseId));
      }
    }
  }
  context.clauses.filter(clause => SWEEP_KINDS.includes(clause.kind)).forEach(take);
  context.clauses.forEach(take);
  const kept = [];
  let used = 0;
  let truncated = false;
  for (const clause of ordered) {
    const size = clauseBytes(clause);
    if (!cited.has(clause.clauseId) && (used + size > budgetBytes || kept.length >= maxClauses)) { truncated = true; continue; }
    used += size;
    kept.push(clause);
  }
  const keptIds = new Set(kept.map(clause => clause.clauseId));
  const index = new Map(gated.map((clause, position) => [clause.clauseId, position]));
  return {
    clauses: kept.sort((a, b) => index.get(a.clauseId) - index.get(b.clauseId)),
    added: kept.filter(clause => !inContext.has(clause.clauseId)).length,
    dropped: context.clauses.filter(clause => !keptIds.has(clause.clauseId)).length,
    truncated,
  };
}

const entryOf = (finding, clauseById) => ({
  findingId: finding.findingId, subject: finding.subject, quote: finding.quote, clauseIds: finding.clauseIds,
  pages: [...new Set(finding.clauseIds.map(id => clauseById.get(id).page))].sort((a, b) => a - b),
  effect: finding.effect, conditions: finding.conditions, exceptions: finding.exceptions, overrides: finding.overrides,
});

// A quote that itself states a restriction can never be filed as covered, whatever effect the model reported
// (untrusted policy text can steer the label). It is routed to conditions instead.
const LIMITING_QUOTE = /\b(?:not\s+(?:covered|payable|admissible|eligible)|excluded?|exclusions?|capped|sub-?limits?|waiting\s+period|limited\s+to|shall\s+not|no\s+cover)\b/i;

// Words that name no policy subject. Conservative: a word missing from this list can only add an unknown, never remove one.
const GENERIC_TERMS = new Set(`about above after also analysis answer any are authorised be been before benefit benefits both can cannot claim claims clause
cost costs could cover covered covers coverage cashless does done each eligible for from get give have how include included insurance insured insurer into
is it its limit limits made make many may member members much need not only other our out over paid pay payable plan policies policy possible really
should some such than that the their them then there these they this those under upto what when where whether which while who will with within would
you your treatment treatments procedure procedures hospital hospitalisation expense expenses mother father wife husband spouse son daughter parent parents family child children myself`.split(/\s+/));

/** Candidate subject terms from the question: plain lowercase words of 5+ letters that are not generic. Deterministic, no model. */
export function subjectTerms(question) {
  const words = String(question).toLowerCase().match(/[a-z]{5,}/g) ?? [];
  return [...new Set(words.filter(word => !GENERIC_TERMS.has(word)))].slice(0, 5);
}
const stemOf = term => term.slice(0, Math.max(5, term.length - 3));

const EXCLUSION_TEXT = Object.freeze({
  over_document_limit: 'the case has more authorised documents than one question can read',
  superseded_version: 'a newer version of the same document exists',
  not_named: 'the request did not name them',
  ocr_incomplete: 'their stored text is incomplete',
  ocr_unavailable: 'their stored text is unavailable',
  not_found: 'they could not be found',
  no_clauses: 'no clause could be built from their stored text',
  not_in_context: 'none of their clauses passed the privacy check or fitted the reading budget',
});

/** Code assembles the answer from validated findings. There is no verdict: only cited evidence and unknowns. */
export function assembleAnswer({ question, gatedQuestion = question, findings, overrides, context, checklist, rejected, sweepCompleted, documentIds, completeness, storedText = null }) {
  const clauseById = new Map(context.clauses.map(clause => [clause.clauseId, clause]));
  const covered = [];
  const limited = [];
  const conditions = [];
  for (const finding of findings) {
    // The validated effect picks the bucket. The clause's keyword kind is a ranking hint and says nothing about a
    // finding quoted from a large mixed clause (a benefits table labelled 'exclusion' for one "Not Covered" row).
    if (finding.effect === 'covers' && !LIMITING_QUOTE.test(finding.quote)) covered.push(entryOf(finding, clauseById));
    else if (finding.effect === 'limits' || finding.effect === 'excludes') limited.push(entryOf(finding, clauseById));
    else conditions.push({ subject: finding.subject, text: finding.quote, clauseIds: finding.clauseIds, effect: finding.effect === 'covers' ? 'conditions' : finding.effect });
    for (const condition of finding.conditions) conditions.push({ subject: finding.subject, text: condition, clauseIds: finding.clauseIds });
  }
  for (const override of overrides) {
    const entry = { findingId: null, subject: override.subject, quote: override.quote, clauseIds: override.clauseIds, effect: override.effect, targets: override.targets };
    if (override.effect === 'limits' || override.effect === 'excludes') limited.push(entry);
    else conditions.push({ subject: override.subject, text: override.quote, clauseIds: override.clauseIds, effect: override.effect });
  }
  const unknowns = [];
  // A subject the question names but no clause that was read mentions may sit in a document that was not uploaded.
  const readText = context.clauses.map(clause => clause.text.toLowerCase()).join('\n');
  // Terms come from the gated question, so nothing the privacy gate redacted is echoed into the answer.
  const unnamed = subjectTerms(gatedQuestion).filter(term => !readText.includes(stemOf(term)));
  if (unnamed.length) {
    const plural = unnamed.length > 1;
    const where = context.path === 'whole_policy' ? 'it may be in documents not uploaded, such as the full policy wording' : 'it may be in policy text that was not retrieved or in documents not uploaded';
    unknowns.push(`${unnamed.join(', ')} ${plural ? 'are' : 'is'} not named in the documents read, so ${plural ? where.replace('it may', 'they may') : where}.`);
  }
  // Kinds are keyword ranking hints, never evidence of absence. When the whole policy was read nothing is unread;
  // on the retrieved path a missing kind only means no clause carrying that label was retrieved.
  if (context.path !== 'whole_policy') {
    for (const kind of checklist) {
      if (!context.clauses.some(clause => clause.kind === kind)) unknowns.push(`No clause labelled ${kind} by the keyword classifier was retrieved; such terms may be in policy text that was not read.`);
    }
  }
  // Document-to-policy association is not established (ADR 0007 is blocked); callers read several documents together
  // only when the requester names them, and that grouping is never presented as verified.
  const documents = new Set(context.clauses.map(clause => clause.documentId));
  if (documents.size > 1) unknowns.push(`${documents.size} documents were read together as named in the request. That they belong to one policy is not verified, so facts from different documents may describe different policies.`);
  // Nothing authorised is left out silently: every excluded document and unread clause is counted here.
  for (const { reason, count } of completeness.documentsExcluded) {
    unknowns.push(`${count} authorised document(s) were not read because ${EXCLUSION_TEXT[reason]}. Evidence in them is not reflected in this answer.`);
  }
  if (completeness.clausesWithheld > 0) unknowns.push(`${completeness.clausesWithheld} clause(s) were withheld by the privacy check and were not read.`);
  if (completeness.clausesNotRead > 0) unknowns.push(`The policy text exceeded the reading budget, so ${completeness.clausesNotRead} clause(s) were not read.`);
  if (completeness.sweepOverBudget) unknowns.push('The findings cite more policy text than one override check can read, so that check was not run.');
  if (completeness.sweepTruncated) unknowns.push('The check for overriding or conflicting clauses could not read every candidate clause within the reading budget.');
  if (rejected > 0) unknowns.push(`${rejected} model finding(s) failed validation and were dropped.`);
  if (!sweepCompleted) unknowns.push('The check for overriding or conflicting clauses did not complete.');
  if (!findings.length && !overrides.length) unknowns.push('No clause in the policy text answers the question.');

  const sources = [];
  const sourceSeen = new Set();
  const cite = (clauseIds, quote) => {
    for (const id of clauseIds) {
      const clause = clauseById.get(id);
      const key = `${id}|${quote}`;
      if (!sourceSeen.has(key) && clause.text.includes(quote)) {
        sourceSeen.add(key);
        // The model reads gated text, so a quote may carry privacy placeholders: it cites the right clause and page but
        // is not verbatim source text. `verbatim` says which, checked against the stored (ungated) clause.
        const source = { documentId: clause.documentId, page: clause.page, quote, clauseId: id };
        if (storedText) source.verbatim = storedText.get(id)?.includes(quote) ?? false;
        sources.push(source);
      }
    }
  };
  findings.forEach(finding => {
    cite(finding.clauseIds, finding.quote);
    for (const claim of [...finding.conditions, ...finding.exceptions]) cite(finding.clauseIds, claim);
  });
  overrides.forEach(override => cite(override.clauseIds, override.quote));

  const hasQualifiers = limited.length > 0 || conditions.length > 0 || findings.some(finding => finding.exceptions.length > 0);
  const state = !sources.length ? 'insufficient_evidence' : hasQualifiers || !sweepCompleted || unknowns.length ? 'conditional' : 'evidence_found';
  const overridesChecked = checklist.map(kind => ({ kind, clauseIds: context.clauses.filter(clause => clause.kind === kind).map(clause => clause.clauseId) }));
  overridesChecked.push({ kind: 'override_sweep', status: sweepCompleted ? 'completed' : 'not_completed' });
  const answer = {
    question, state, covered, limited_or_excluded: limited, conditions, overrides_checked: overridesChecked, unknowns,
    calculations: [], sources, documentIds, contextPath: context.path, completeness, pipelineVersion: INVESTIGATION_VERSION, legalReview: 'required',
  };
  const errors = validateAnswer(answer);
  if (errors.length) fail('INVESTIGATION_ANSWER_INVALID', `Assembled answer is invalid: ${errors.join('; ')}`);
  return answer;
}

const EXCLUSION_REASONS = new Set(Object.keys(EXCLUSION_TEXT));

/**
 * `documentScope` ({ authorised, excluded: [{ reason, count }] }) is the caller's account of authorised documents it
 * did not pass in, so they are reported instead of silently omitted. The payload ceiling is the smaller of
 * `limits.maxInputBytes` and the gateway limit the call states (`call.maxInputBytes`).
 */
export async function investigate({ question, clauses, search = () => [], call, consentCheck, knownIdentifiers = [], limits = {}, documentScope = null } = {}) {
  const stated = [limits.maxInputBytes, call?.maxInputBytes].filter(value => Number.isInteger(value) && value > 0);
  const caps = { ...INVESTIGATION_LIMITS, ...limits, maxInputBytes: stated.length ? Math.min(...stated) : INVESTIGATION_LIMITS.maxInputBytes };
  const excluded = Array.isArray(documentScope?.excluded) ? documentScope.excluded : [];
  if (!excluded.every(entry => EXCLUSION_REASONS.has(entry?.reason) && Number.isInteger(entry.count) && entry.count > 0)) fail('INVESTIGATION_INPUT_INVALID', 'Excluded documents need a known reason and a count.');
  if (typeof question !== 'string' || !question.trim() || question.length > caps.maxQuestionChars) fail('INVESTIGATION_INPUT_INVALID', 'A question of reasonable length is required.');
  if (!Array.isArray(clauses) || clauses.length === 0) fail('INVESTIGATION_NO_EVIDENCE', 'The case has no stored policy clauses.');
  if (typeof call !== 'function' || typeof consentCheck !== 'function') fail('INVESTIGATION_INPUT_INVALID', 'A provider call and a consent check are required.');
  const gatedQuestion = gate(question.trim(), knownIdentifiers);
  if (gatedQuestion === null) fail('INVESTIGATION_QUESTION_REFUSED', 'The question contains restricted data and cannot be sent.');
  const checklist = checklistFor(question);
  // Kinds are recomputed from the stored text so clauses stored under an older classifier route like new ones.
  const current = clauses.map(clause => ({ ...clause, kind: classifyClause(clause.sectionPath?.[0] ?? null, clause.text) }));
  const { sent, withheld } = gateClauses(current, knownIdentifiers);
  if (!sent.length) fail('INVESTIGATION_NO_EVIDENCE', 'No clause could be released to the model.');
  // The fallback FTS search returns stored (ungated) clauses; only clauses that passed the gate are used.
  const questions = [{ text: gatedQuestion }];
  const firstBudget = clauseBudget({ questions, checklist, clauses: [] }, caps);
  if (firstBudget <= 0) fail('INVESTIGATION_BUDGET_EXCEEDED', 'The question leaves no room for policy text within the model input limit.');
  const context = selectContext({ gated: sent, checklist, question: gatedQuestion, search, budgetBytes: firstBudget, maxClauses: caps.maxClausesPerCall });
  const clauseText = new Map(context.clauses.map(clause => [clause.clauseId, clause.text]));
  const wire = context.clauses.map(toWire);
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const run = async (task, payload, schema) => {
    // Budgets are derived so this never fires; if it does, it is a defect, reported as such rather than as a provider error.
    if (bytes(payload) > caps.maxInputBytes) fail('INVESTIGATION_BUDGET_EXCEEDED', 'The model payload exceeds the input limit.');
    await consentCheck();
    usage.calls += 1;
    const response = await call({ task, system: STRUCTURING_INSTRUCTIONS[task], payload, schema });
    usage.inputTokens += Number.isFinite(response?.usage?.inputTokens) ? response.usage.inputTokens : 0;
    usage.outputTokens += Number.isFinite(response?.usage?.outputTokens) ? response.usage.outputTokens : 0;
    return response?.json;
  };

  // Coded budget defects and consent refusals keep their codes; everything else is a provider failure.
  const passThrough = error => error?.code === 'INVESTIGATION_BUDGET_EXCEEDED' || /^CONSENT_/.test(String(error?.code));
  // Nothing retrieved means nothing to ask: no model call, and the answer says the evidence is insufficient.
  let first = { findings: [] };
  if (wire.length) {
    try {
      first = await run(EVIDENCE_INVESTIGATE_TASK, { questions, checklist, clauses: wire }, INVESTIGATE_SCHEMA);
    } catch (error) {
      if (passThrough(error)) throw error;
      throw Object.assign(new Error('The investigation could not be completed.'), { code: 'INVESTIGATION_PROVIDER_ERROR', statusCode: 502, cause: error?.code });
    }
  }
  if (!first || typeof first !== 'object' || !Array.isArray(first.findings)) fail('INVESTIGATION_MALFORMED', 'The investigation returned an unusable response.');
  const parsed = parseFindings(first, clauseText, caps);

  // Mandatory override sweep. A failed sweep never hides the first pass: it is reported as an unknown.
  let overrides = [];
  let sweepRejected = 0;
  let sweepCompleted = false;
  let sweepContext = { clauses: [], added: 0, dropped: 0, truncated: false };
  let sweepOverBudget = false;
  if (parsed.findings.length) {
    try {
      const sweepFindings = parsed.findings.map(finding => ({ finding_id: finding.findingId, subject: finding.subject, quote: finding.quote, clause_ids: finding.clauseIds }));
      const sweepBudget = clauseBudget({ questions, findings: sweepFindings, clauses: [] }, caps);
      sweepContext = selectSweepContext({ context, gated: sent, findings: parsed.findings, search, budgetBytes: sweepBudget, maxClauses: caps.maxClausesPerCall });
      const sweepText = new Map(sweepContext.clauses.map(clause => [clause.clauseId, clause.text]));
      const sweepPayload = { questions, findings: sweepFindings, clauses: sweepContext.clauses.map(toWire) };
      // Cited clauses are never dropped, so findings that cite more than fits make the sweep impossible: it is skipped
      // and reported as not completed rather than failing the whole question.
      sweepOverBudget = bytes(sweepPayload) > caps.maxInputBytes || sweepPayload.clauses.length > caps.maxClausesPerCall;
      const second = sweepOverBudget ? null : await run(EVIDENCE_SWEEP_TASK, sweepPayload, SWEEP_SCHEMA);
      if (second && Array.isArray(second.overrides)) {
        const result = parseOverrides(second, sweepText, new Set(parsed.findings.map(finding => finding.findingId)), caps);
        overrides = result.overrides;
        sweepRejected = result.rejected;
        sweepCompleted = true;
        for (const override of overrides) {
          for (const target of override.targets) parsed.findings.find(finding => finding.findingId === target)?.overrides.push(...override.clauseIds);
        }
      }
    } catch (error) {
      if (passThrough(error)) throw error;
    }
  } else {
    // Nothing to sweep: no first-pass finding exists, so the sweep is trivially complete, unless nothing was read at all.
    sweepCompleted = wire.length > 0;
  }
  // The answer reflects every clause that reached the model: the first pass plus the sweep, if it completed.
  const position = new Map(sent.map((clause, index) => [clause.clauseId, index]));
  const readById = new Map([...context.clauses, ...(sweepCompleted ? sweepContext.clauses : [])].map(clause => [clause.clauseId, clause]));
  const read = [...readById.values()].sort((a, b) => position.get(a.clauseId) - position.get(b.clauseId));
  const documentIds = [...new Set(read.map(clause => clause.documentId))];
  const documentsInput = new Set(clauses.map(clause => clause.documentId));
  // A document passed in whose clauses were all withheld or left out of every context is reported, not lost.
  const unread = [...documentsInput].filter(documentId => !documentIds.includes(documentId)).length;
  const documentsExcluded = excluded.map(({ reason, count }) => ({ reason, count }));
  if (unread) documentsExcluded.push({ reason: 'not_in_context', count: unread });
  const completeness = {
    documentsAuthorised: Number.isInteger(documentScope?.authorised) ? documentScope.authorised : documentsInput.size + excluded.reduce((sum, entry) => sum + entry.count, 0),
    documentsRead: documentIds.length,
    documentsExcluded,
    clausesStored: clauses.length,
    clausesWithheld: withheld.length,
    clausesNotRead: sent.length - read.length,
    sweepClausesDropped: sweepCompleted ? sweepContext.dropped : 0,
    sweepTruncated: sweepCompleted && sweepContext.truncated,
    sweepOverBudget,
  };
  const answer = assembleAnswer({
    question: question.trim(), gatedQuestion, findings: parsed.findings, overrides, context: { ...context, clauses: read }, checklist,
    rejected: parsed.rejected + sweepRejected, sweepCompleted, documentIds, completeness,
    storedText: new Map(clauses.map(clause => [clause.clauseId, clause.text])),
  });
  return { answer, usage, contextPath: context.path };
}

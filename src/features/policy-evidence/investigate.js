// Question-driven investigation (ADR 0008). The model proposes cited findings; code validates every clause id and
// quote, runs a mandatory override sweep, and assembles the answer. Nothing here decides coverage or does arithmetic.
// Every clause sent to a model passes the privacy gate first, consent is re-checked before each call, and the
// provider call is injected (no SDK or fetch is imported here).
import { sanitizeEvidenceTextForStorage } from '../ai-analysis/privacy-evidence-gate.js';
import { EVIDENCE_INVESTIGATE_TASK, EVIDENCE_SWEEP_TASK, INVESTIGATE_SCHEMA, STRUCTURING_INSTRUCTIONS, SWEEP_SCHEMA } from '../ai-analysis/structuring-contract.js';
import { validateAnswer, validateFinding } from '../../contracts/policy-evidence.js';

export const INVESTIGATION_VERSION = 'policy-evidence-investigation/v1';
export const INVESTIGATION_LIMITS = Object.freeze({
  contextBudgetBytes: 80_000, ftsPerKind: 8, maxFindings: 60, maxOverrides: 60, maxQuestionChars: 2000,
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

/**
 * Context for the model. Whole gated policy when it fits the byte budget; otherwise endorsements and schedule
 * clauses plus FTS hits per checklist kind (`search` is household-scoped), trimmed to the budget.
 */
export function selectContext({ gated, checklist, question, search, budgetBytes }) {
  const total = gated.reduce((sum, clause) => sum + bytes(toWire(clause)), 0);
  if (total <= budgetBytes) return { clauses: gated, path: 'whole_policy', truncated: false };
  const byId = new Map(gated.map((clause, index) => [clause.clauseId, { clause, index }]));
  const ordered = [];
  const seen = new Set();
  const take = clause => {
    const entry = byId.get(clause.clauseId);
    if (entry && !seen.has(clause.clauseId)) { seen.add(clause.clauseId); ordered.push(entry); }
  };
  gated.filter(clause => clause.kind === 'endorsement' || clause.kind === 'schedule_fact').forEach(take);
  const perKind = checklist.map(kind => search({ query: question, kinds: [kind], limit: INVESTIGATION_LIMITS.ftsPerKind }));
  for (let rank = 0; rank < INVESTIGATION_LIMITS.ftsPerKind; rank += 1) for (const hits of perKind) if (hits[rank]) take(hits[rank]);
  const kept = [];
  let used = 0;
  let truncated = false;
  for (const entry of ordered) {
    const size = bytes(toWire(entry.clause));
    if (used + size > budgetBytes) { truncated = true; continue; }
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
      openKind: typeof item?.open_kind === 'string' ? item.open_kind.trim().slice(0, 120) : null,
      state: 'extracted_unverified',
    };
    const key = JSON.stringify([candidate.clauseIds, candidate.quote]);
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

const SWEEP_KINDS = Object.freeze(['exclusion', 'limit', 'waiting_period', 'endorsement', 'condition', 'schedule_fact', 'definition']);
const SWEEP_TERMS = 'exclusion excluded waiver waived override notwithstanding limit sub-limit capped waiting period not payable';

/**
 * Fresh retrieval for the sweep, driven by the first-pass findings rather than the question alone. Returns the
 * context clauses plus gated clauses that the first pass never saw (the cross-page exclusion a first retrieval missed).
 * A whole-policy context already holds everything, so nothing new is added there.
 */
export function selectSweepContext({ context, gated, findings, search, budgetBytes }) {
  if (context.path === 'whole_policy') return { clauses: context.clauses, added: 0 };
  const have = new Set(context.clauses.map(clause => clause.clauseId));
  const gatedById = new Map(gated.map(clause => [clause.clauseId, clause]));
  const queries = [...new Set([SWEEP_TERMS, ...findings.flatMap(finding => [finding.subject, `${finding.subject} ${SWEEP_TERMS}`, finding.quote])])].slice(0, 12);
  const extra = [];
  let used = context.clauses.reduce((sum, clause) => sum + bytes(toWire(clause)), 0);
  for (const query of queries) {
    for (const hit of search({ query, kinds: SWEEP_KINDS, limit: INVESTIGATION_LIMITS.ftsPerKind })) {
      const clause = gatedById.get(hit.clauseId);
      if (!clause || have.has(clause.clauseId)) continue;
      const size = bytes(toWire(clause));
      if (used + size > budgetBytes * 1.5) continue;
      used += size; have.add(clause.clauseId); extra.push(clause);
    }
  }
  const index = new Map(gated.map((clause, position) => [clause.clauseId, position]));
  const clauses = [...context.clauses, ...extra].sort((a, b) => index.get(a.clauseId) - index.get(b.clauseId));
  return { clauses, added: extra.length };
}

const LIMITING_KINDS = new Set(['limit', 'exclusion', 'waiting_period']);
const entryOf = (finding, clauseById) => ({
  findingId: finding.findingId, subject: finding.subject, quote: finding.quote, clauseIds: finding.clauseIds,
  pages: [...new Set(finding.clauseIds.map(id => clauseById.get(id).page))].sort((a, b) => a - b),
  conditions: finding.conditions, exceptions: finding.exceptions, overrides: finding.overrides,
});

/** Code assembles the answer from validated findings. There is no verdict: only cited evidence and unknowns. */
export function assembleAnswer({ question, findings, overrides, context, checklist, withheld, rejected, sweepCompleted, documentIds }) {
  const clauseById = new Map(context.clauses.map(clause => [clause.clauseId, clause]));
  const covered = [];
  const limited = [];
  const conditions = [];
  for (const finding of findings) {
    const kinds = finding.clauseIds.map(id => clauseById.get(id).kind);
    const entry = entryOf(finding, clauseById);
    if (kinds.some(kind => LIMITING_KINDS.has(kind))) limited.push(entry);
    else if (kinds.some(kind => kind === 'condition' || kind === 'procedure' || kind === 'endorsement')) conditions.push({ subject: finding.subject, text: finding.quote, clauseIds: finding.clauseIds });
    else covered.push(entry);
    for (const condition of finding.conditions) conditions.push({ subject: finding.subject, text: condition, clauseIds: finding.clauseIds });
  }
  for (const override of overrides) {
    const entry = { findingId: null, subject: override.subject, quote: override.quote, clauseIds: override.clauseIds, effect: override.effect, targets: override.targets };
    if (override.effect === 'limits' || override.effect === 'excludes') limited.push(entry);
    else conditions.push({ subject: override.subject, text: override.quote, clauseIds: override.clauseIds, effect: override.effect });
  }
  const unknowns = [];
  for (const kind of checklist) {
    if (!context.clauses.some(clause => clause.kind === kind)) unknowns.push(`No ${kind} clause was found in the policy text that was read.`);
  }
  // Document-to-policy association is not established (ADR 0007 is blocked), so several documents are never merged silently.
  const documents = new Set(context.clauses.map(clause => clause.documentId));
  if (documents.size > 1) unknowns.push(`${documents.size} documents were read together. Which policy each belongs to is not established, so facts from different documents may describe different policies.`);
  if (withheld > 0) unknowns.push(`${withheld} clause(s) were withheld by the privacy check and were not read.`);
  if (context.truncated) unknowns.push('The policy text exceeded the reading budget, so some clauses were not read.');
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
        sources.push({ documentId: clause.documentId, page: clause.page, quote, clauseId: id });
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
    calculations: [], sources, documentIds, contextPath: context.path, pipelineVersion: INVESTIGATION_VERSION, legalReview: 'required',
  };
  const errors = validateAnswer(answer);
  if (errors.length) fail('INVESTIGATION_ANSWER_INVALID', `Assembled answer is invalid: ${errors.join('; ')}`);
  return answer;
}

export async function investigate({ question, clauses, search = () => [], call, consentCheck, knownIdentifiers = [], limits = {} } = {}) {
  const caps = { ...INVESTIGATION_LIMITS, ...limits };
  if (typeof question !== 'string' || !question.trim() || question.length > caps.maxQuestionChars) fail('INVESTIGATION_INPUT_INVALID', 'A question of reasonable length is required.');
  if (!Array.isArray(clauses) || clauses.length === 0) fail('INVESTIGATION_NO_EVIDENCE', 'The case has no stored policy clauses.');
  if (typeof call !== 'function' || typeof consentCheck !== 'function') fail('INVESTIGATION_INPUT_INVALID', 'A provider call and a consent check are required.');
  const gatedQuestion = gate(question.trim(), knownIdentifiers);
  if (gatedQuestion === null) fail('INVESTIGATION_QUESTION_REFUSED', 'The question contains restricted data and cannot be sent.');
  const checklist = checklistFor(question);
  const { sent, withheld } = gateClauses(clauses, knownIdentifiers);
  if (!sent.length) fail('INVESTIGATION_NO_EVIDENCE', 'No clause could be released to the model.');
  // The fallback FTS search returns stored (ungated) clauses; only clauses that passed the gate are used.
  const context = selectContext({ gated: sent, checklist, question: gatedQuestion, search, budgetBytes: caps.contextBudgetBytes });
  const clauseText = new Map(context.clauses.map(clause => [clause.clauseId, clause.text]));
  const wire = context.clauses.map(toWire);
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const run = async (task, payload, schema) => {
    await consentCheck();
    usage.calls += 1;
    const response = await call({ task, system: STRUCTURING_INSTRUCTIONS[task], payload, schema });
    usage.inputTokens += Number.isFinite(response?.usage?.inputTokens) ? response.usage.inputTokens : 0;
    usage.outputTokens += Number.isFinite(response?.usage?.outputTokens) ? response.usage.outputTokens : 0;
    return response?.json;
  };

  let first;
  try {
    first = await run(EVIDENCE_INVESTIGATE_TASK, { questions: [{ text: gatedQuestion }], checklist, clauses: wire }, INVESTIGATE_SCHEMA);
  } catch (error) {
    throw Object.assign(new Error('The investigation could not be completed.'), { code: 'INVESTIGATION_PROVIDER_ERROR', statusCode: 502, cause: error?.code });
  }
  if (!first || typeof first !== 'object' || !Array.isArray(first.findings)) fail('INVESTIGATION_MALFORMED', 'The investigation returned an unusable response.');
  const parsed = parseFindings(first, clauseText, caps);

  // Mandatory override sweep. A failed sweep never hides the first pass: it is reported as an unknown.
  let overrides = [];
  let sweepRejected = 0;
  let sweepCompleted = false;
  let sweepContext = { clauses: context.clauses, added: 0 };
  if (parsed.findings.length) {
    try {
      sweepContext = selectSweepContext({ context, gated: sent, findings: parsed.findings, search, budgetBytes: caps.contextBudgetBytes });
      const sweepText = new Map(sweepContext.clauses.map(clause => [clause.clauseId, clause.text]));
      const sweepPayload = {
        questions: [{ text: gatedQuestion }],
        findings: parsed.findings.map(finding => ({ finding_id: finding.findingId, subject: finding.subject, quote: finding.quote, clause_ids: finding.clauseIds })),
        clauses: sweepContext.clauses.map(toWire),
      };
      const second = await run(EVIDENCE_SWEEP_TASK, sweepPayload, SWEEP_SCHEMA);
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
      if (error?.code === 'CONSENT_SCOPE_REQUIRED' || /^CONSENT_/.test(String(error?.code))) throw error;
    }
  } else {
    // Nothing to sweep: no first-pass finding exists, so the sweep is trivially complete.
    sweepCompleted = true;
  }
  const documentIds = [...new Set(context.clauses.map(clause => clause.documentId))];
  const answer = assembleAnswer({
    question: question.trim(), findings: parsed.findings, overrides, context: { ...context, clauses: sweepContext.clauses }, checklist, withheld: withheld.length,
    rejected: parsed.rejected + sweepRejected, sweepCompleted, documentIds,
  });
  return { answer, usage, contextPath: context.path };
}

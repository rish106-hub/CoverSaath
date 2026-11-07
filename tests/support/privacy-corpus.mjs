// Privacy gate golden corpus and brand probes (ADR 0017 D6; docs/architecture/privacy-gate-golden-corpus.md).
// SYNTHETIC DATA ONLY. Every number, name and address below is generated or invented. NEVER DIAL OR WRITE TO A VALUE
// IN THIS FILE: no fictional Indian mobile range is known (ADR 0017 Q3), so phones are seeded generated values.
import { gateText } from '../../src/features/ai-analysis/privacy-evidence-gate.js';
import { CORPUS_ROWS, CORPUS_SEED, ROW_COUNTS } from './corpus-rows.mjs';

export { CORPUS_SEED, ROW_COUNTS };
export const CORPUS = CORPUS_ROWS;

// P4: the number of known_gap rows may only fall. Gate v9 started at 61 (49 designed in advance, 12 found by the corpus);
// gate v10 (ADR 0017 Phase 4) closed 28 of them, leaving 33.
export const KNOWN_GAP_CEILING = 33;
export const CATEGORY_COUNTS = Object.freeze({
  AAD: 40, PAN: 24, ABH: 24, PHN: 36, EML: 12, NML: 20, NDV: 24, NTR: 24, MBR: 30, DOA: 20, OCR: 30, RST: 12, PRS: 44,
});

export const gated = (text, options = {}) => gateText(text, { knownIdentifiers: [], ...options });

// A valid draft per non-coverage model task. Coverage tasks are built by sanitizeEvidenceForModel (their structured
// upstream can only be minted by the gate), so they have no hand-built draft.
export function validDraft(task) {
  const wireClause = () => ({
    clause_id: 'clause_0123456789abcdef01234567', document_id: 'doc_0123456789abcdef01234567', page: 3, kind: 'limit',
    title: gated('Room rent'), text: gated('Room rent is limited to 1% of the sum insured per day.'),
  });
  switch (task) {
    case 'policy_structuring_extract':
      return { payload: {
        registry: [{ key: 'd.sum_insured', label: 'Sum insured', valueType: 'money' }],
        chunks: [{ chunk_id: 'p1-b0', page: 1, block_indexes: [0, 1], kind: 'text', title: gated('Benefits'), text: gated('Sum insured: 500000. Waiting period of 24 months.') }],
      } };
    case 'policy_structuring_reconcile':
      return { payload: { groups: [{
        group_id: 'g1', target: gated('d.co_pay_general'), subject: gated('policy'),
        readings: [{ value: gated('1% of sum insured'), quote: gated('Room rent is limited to 1% of the sum insured'), page: 3 }],
      }] } };
    case 'policy_evidence_investigate':
      return { payload: { questions: [{ text: gated('Is cataract surgery covered?') }], checklist: ['benefit', 'exclusion'], clauses: [wireClause()] } };
    case 'policy_evidence_override_sweep':
      return { payload: {
        questions: [{ text: gated('Is cataract surgery covered?') }],
        findings: [{ finding_id: 'f1', subject: gated('cataract surgery'), quote: gated('Cataract surgery is covered'), clause_ids: ['clause_0123456789abcdef01234567'] }],
        clauses: [wireClause()],
      } };
    default:
      throw new Error(`No hand-built draft for ${task}.`);
  }
}

export const STRUCTURING_DRAFT_TASKS = Object.freeze([
  'policy_structuring_extract', 'policy_structuring_reconcile', 'policy_evidence_investigate', 'policy_evidence_override_sweep',
]);

// Copies plain objects and arrays but keeps GatedText values (frozen, branded) by reference.
export function cloneDraft(value, keep = candidate => Object.isFrozen(candidate)) {
  if (value === null || typeof value !== 'object' || keep(value)) return value;
  if (Array.isArray(value)) return value.map(item => cloneDraft(item, keep));
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneDraft(child, keep)]));
}

/** Every path that holds a GatedText in a draft, as arrays of keys. */
export function gatedPaths(draft, isGated, path = [], out = []) {
  if (isGated(draft)) { out.push(path); return out; }
  if (draft && typeof draft === 'object') for (const [key, child] of Object.entries(draft)) gatedPaths(child, isGated, [...path, key], out);
  return out;
}

export function setAt(draft, path, value) {
  const copy = cloneDraft(draft);
  let cursor = copy;
  for (const key of path.slice(0, -1)) cursor = cursor[key];
  cursor[path.at(-1)] = value;
  return copy;
}

export function pathText(path) {
  return path.reduce((text, key) => (typeof key === 'number' || /^\d+$/.test(key) ? `${text}[${key}]` : `${text}.${key}`), 'input');
}

/** Paths of every plain object and every array in a draft (for extra-key, missing-key and over-long-array probes). */
export function containerPaths(draft, isGated, path = [], out = { objects: [], arrays: [] }) {
  if (!draft || typeof draft !== 'object' || isGated(draft)) return out;
  (Array.isArray(draft) ? out.arrays : out.objects).push(path);
  for (const [key, child] of Object.entries(draft)) containerPaths(child, isGated, [...path, key], out);
  return out;
}

/** Values that look like a GatedText and are not (ADR 0017 T7). Built fresh so none is shared between tests. */
export function forgedGatedTexts() {
  const real = gated('Sum insured: 500000');
  const symbols = Object.getOwnPropertySymbols(real);
  const withSymbol = { ...real };
  for (const symbol of symbols) Object.defineProperty(withSymbol, symbol, { value: real[symbol], enumerable: false });
  return [
    ['hand_built_literal', { text: 'x', gateVersion: real.gateVersion, placeholderCount: 0, reasonCodeCount: 0, inputBytes: 1, outputBytes: 1 }],
    ['symbol_copied_onto_literal', Object.freeze(withSymbol)],
    ['structured_clone', structuredClone(real)],
    ['proxy_around_real', new Proxy(real, {})],
    ['object_create_from_real', Object.create(real)],
    ['getter_text', Object.freeze({ get text() { return 'x'; }, gateVersion: real.gateVersion })],
    ['json_round_trip', JSON.parse(JSON.stringify(real))],
  ];
}

export const BRAND_PROBES = Object.freeze({ forgedGatedTexts, validDraft, STRUCTURING_DRAFT_TASKS });

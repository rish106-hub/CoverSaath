import test from 'node:test';
import assert from 'node:assert/strict';
import { INVESTIGATION_LIMITS, buildClauses, checklistFor, investigate } from '../src/features/policy-evidence/index.js';
import { validateAnswer } from '../src/contracts/index.js';

// Synthetic policy only: fictional insurer, numbers and member.
const stored = {
  pages: [
    { page: 1, status: 'stored', blocks: [
      { tag: 'headline', text: 'Policy Schedule' },
      { tag: 'paragraph', text: 'Sum Insured Rs. 5,00,000. Insured member: Asha Example, mother.' },
    ] },
    { page: 12, status: 'stored', blocks: [
      { tag: 'section-title', text: 'Eye Benefits' },
      { tag: 'paragraph', text: 'We will pay for cataract surgery as a hospitalisation benefit.' },
    ] },
    { page: 38, status: 'stored', blocks: [
      { tag: 'section-title', text: 'Sub-limits' },
      { tag: 'paragraph', text: 'Cataract surgery is capped at Rs. 40,000 per eye.' },
    ] },
    { page: 61, status: 'stored', blocks: [
      { tag: 'section-title', text: 'Waiting Periods' },
      { tag: 'paragraph', text: 'Cataract has a waiting period of 24 months from the policy start.' },
    ] },
    { page: 70, status: 'stored', blocks: [
      { tag: 'section-title', text: 'Endorsement' },
      { tag: 'paragraph', text: 'The cataract waiting period is waived for members continuously insured for 2 years.' },
    ] },
  ],
};
const clauses = buildClauses(stored, { documentId: 'doc-1', sourceVersion: 'v1' }).clauses;
const byPage = page => clauses.find(clause => clause.page === page);
const ids = (...pages) => pages.map(page => byPage(page).clauseId);

const finding = (page, quote, extra = {}) => ({ clause_ids: ids(page), quote, subject: 'cataract surgery', conditions: [], exceptions: [], ...extra });
const firstPass = { findings: [
  finding(12, 'cataract surgery as a hospitalisation benefit', { effect: 'covers' }),
  finding(38, 'capped at Rs. 40,000 per eye', { effect: 'limits' }),
  finding(61, 'waiting period of 24 months', { effect: 'limits' }),
] };
const sweep = { overrides: [
  { clause_ids: ids(70), quote: 'waiting period is waived for members continuously insured for 2 years', effect: 'waives', target_finding_ids: ['f3'] },
] };

function fixture({ first = firstPass, second = sweep, payloads = [] } = {}) {
  return async ({ task, payload }) => {
    payloads.push({ task, payload });
    if (task === 'policy_evidence_investigate') return { json: first, usage: { inputTokens: 100, outputTokens: 20 } };
    if (task === 'policy_evidence_override_sweep') { if (second instanceof Error) throw second; return { json: second, usage: { inputTokens: 100, outputTokens: 10 } }; }
    throw new Error(`unexpected task ${task}`);
  };
}
const QUESTION = 'Will my policy cover cataract surgery for my mother?';
const run = (options = {}) => investigate({ question: QUESTION, clauses, consentCheck: async () => {}, ...options });
// The payload ceiling that leaves exactly `clauseBytes` for first-pass clauses.
const capFor = clauseBytes => clauseBytes + INVESTIGATION_LIMITS.payloadMarginBytes
  + Buffer.byteLength(JSON.stringify({ questions: [{ text: QUESTION }], checklist: checklistFor(QUESTION), clauses: [] }));

test('B3: whole policy is read, findings are cited, the cap lands in limited and the waiver in conditions', async () => {
  const payloads = [];
  const { answer, contextPath } = await run({ call: fixture({ payloads }) });
  assert.equal(contextPath, 'whole_policy');
  assert.equal(answer.state, 'conditional', 'never a bare yes');
  assert.deepEqual(validateAnswer(answer), []);
  assert.ok(answer.limited_or_excluded.some(entry => entry.pages.includes(38)), 'page 38 cap is reported');
  assert.ok(answer.limited_or_excluded.some(entry => entry.pages.includes(61)), 'waiting period is reported');
  assert.ok(answer.conditions.some(entry => entry.effect === 'waives'), 'endorsement waiver is surfaced');
  assert.ok(answer.covered.some(entry => entry.pages.includes(12)));
  assert.ok(answer.sources.every(source => source.documentId === 'doc-1' && source.page >= 1 && source.quote));
  assert.deepEqual(answer.calculations, []);
  assert.equal(answer.overrides_checked.at(-1).status, 'completed');
  assert.equal(payloads.filter(entry => entry.task === 'policy_evidence_override_sweep').length, 1, 'sweep is mandatory');
});

test('B3: findings with unknown clause ids, invented quotes or model-set states are rejected or capped', async () => {
  const first = { findings: [
    finding(12, 'cataract surgery as a hospitalisation benefit', { state: 'proven' }),
    { clause_ids: ['doc-1:nope'], quote: 'x', subject: 's', conditions: [], exceptions: [] },
    finding(38, 'capped at Rs. 90,000 per eye'),
  ] };
  const { answer } = await run({ call: fixture({ first, second: { overrides: [] } }) });
  assert.equal(answer.sources.length, 1);
  assert.ok(answer.unknowns.some(text => /2 model finding/.test(text)));
  assert.equal(JSON.stringify(answer).includes('proven'), false);
});

test('B3: an override sweep that finds a cap moves the answer from covered to limited', async () => {
  const first = { findings: [finding(12, 'cataract surgery as a hospitalisation benefit')] };
  const cap = { overrides: [{ clause_ids: ids(38), quote: 'capped at Rs. 40,000 per eye', effect: 'limits', target_finding_ids: ['f1'] }] };
  const without = await run({ call: fixture({ first, second: { overrides: [] } }) });
  const withCap = await run({ call: fixture({ first, second: cap }) });
  assert.equal(without.answer.limited_or_excluded.length, 0);
  assert.equal(withCap.answer.limited_or_excluded.length, 1);
  assert.equal(withCap.answer.state, 'conditional');
});

test('B3: a failed sweep keeps the first pass and reports an unknown; consent loss stops the question', async () => {
  const { answer } = await run({ call: fixture({ second: new Error('boom') }) });
  assert.equal(answer.state, 'conditional');
  assert.ok(answer.unknowns.some(text => /overriding or conflicting/.test(text)));
  assert.equal(answer.overrides_checked.at(-1).status, 'not_completed');

  let calls = 0;
  const consentCheck = async () => { calls += 1; if (calls === 2) throw Object.assign(new Error('revoked'), { code: 'CONSENT_REVOKED' }); };
  await assert.rejects(run({ call: fixture(), consentCheck }), { code: 'CONSENT_REVOKED' });
});

test('B3: provider failure on the first pass produces no answer', async () => {
  await assert.rejects(run({ call: async () => { throw new Error('down'); } }), { code: 'INVESTIGATION_PROVIDER_ERROR' });
  await assert.rejects(run({ call: async () => ({ json: { nope: 1 } }) }), { code: 'INVESTIGATION_MALFORMED' });
});

test('B3: payload carries gated text only; restricted clauses are withheld and the question is gated', async () => {
  const synthetic = { pages: [{ page: 1, status: 'stored', blocks: [
    { tag: 'section-title', text: 'Members' },
    { tag: 'paragraph', text: 'Member name: Priya Examplesingh covered for cataract surgery.' },
    { tag: 'section-title', text: 'Billing' },
    { tag: 'paragraph', text: 'Credit card number 4111 1111 1111 1111 is on file for cataract premium.' },
    { tag: 'section-title', text: 'Benefits' },
    { tag: 'paragraph', text: 'Cataract surgery is a covered hospitalisation benefit.' },
  ] }] };
  const built = buildClauses(synthetic, { documentId: 'doc-2', sourceVersion: 'v1' }).clauses;
  const payloads = [];
  const { answer } = await investigate({
    question: 'Is cataract surgery covered for Priya Examplesingh?', clauses: built, consentCheck: async () => {},
    knownIdentifiers: [{ kind: 'NAME', value: 'Priya Examplesingh' }],
    call: fixture({ payloads, first: { findings: [] }, second: { overrides: [] } }),
  });
  const sent = JSON.stringify(payloads);
  assert.doesNotMatch(sent, /Priya|Examplesingh/);
  assert.doesNotMatch(sent, /4111/);
  assert.ok(answer.unknowns.some(text => /withheld by the privacy check/.test(text)));
  assert.equal(answer.state, 'insufficient_evidence');
  await assert.rejects(investigate({ question: 'my card number 4111 1111 1111 1111 cover?', clauses: built, consentCheck: async () => {}, call: fixture() }), { code: 'INVESTIGATION_QUESTION_REFUSED' });
});

test('B3: above the byte budget the context is retrieved, bounded and reported', async () => {
  const searched = [];
  const search = ({ kinds }) => { searched.push(kinds?.[0] ?? 'any'); return kinds ? clauses.filter(clause => clause.kind === kinds[0]) : []; };
  const { answer, contextPath } = await run({ call: fixture({ second: { overrides: [] } }), search, limits: { maxInputBytes: capFor(700) } });
  assert.equal(contextPath, 'retrieved');
  assert.ok(searched.length > 0);
  assert.ok(answer.unknowns.some(text => /reading budget/.test(text)));
  assert.ok(answer.sources.every(source => clauses.some(clause => clause.documentId === source.documentId && clause.page === source.page)));
});

test('B3: no clauses is an error, and an empty first pass is insufficient evidence with unknowns', async () => {
  await assert.rejects(investigate({ question: 'q?', clauses: [], consentCheck: async () => {}, call: fixture() }), { code: 'INVESTIGATION_NO_EVIDENCE' });
  const { answer } = await run({ call: fixture({ first: { findings: [] } }) });
  assert.equal(answer.state, 'insufficient_evidence');
  assert.ok(answer.unknowns.length > 0);
});

test('B3: ungrounded conditions, exceptions, value and appliesTo are dropped and counted', async () => {
  const first = { findings: [finding(38, 'capped at Rs. 40,000 per eye', {
    conditions: ['Cataract surgery is capped at Rs. 40,000 per eye', 'pre-authorisation within 48 hours'],
    exceptions: ['not printed anywhere'], value: 'Rs. 40,000', applies_to: 'all members worldwide',
  })] };
  const { answer } = await run({ call: fixture({ first, second: { overrides: [] } }) });
  const texts = answer.conditions.map(entry => entry.text);
  assert.ok(!texts.some(text => /pre-authorisation|worldwide/.test(text)));
  assert.ok(texts.includes('Cataract surgery is capped at Rs. 40,000 per eye'));
  assert.ok(answer.unknowns.some(text => /3 model finding\(s\) failed validation/.test(text)), 'pre-authorisation, exception and appliesTo dropped');
});

test('B3: the sweep runs its own retrieval and sees a clause the first pass context missed', async () => {
  const payloads = [];
  const exclusion = byPage(61);
  const budget = 700;
  const search = ({ query, kinds }) => (/waiting|exclusion/.test(query) ? clauses.filter(clause => clause.clauseId === exclusion.clauseId) : []);
  const first = { findings: [finding(12, 'cataract surgery as a hospitalisation benefit')] };
  const second = { overrides: [{ clause_ids: [exclusion.clauseId], quote: 'waiting period of 24 months', effect: 'limits', target_finding_ids: ['f1'] }] };
  const { answer } = await run({ call: fixture({ first, second, payloads }), search: input => (input.kinds?.length === 1 ? [byPage(12)] : search(input)), limits: { maxInputBytes: capFor(budget) } });
  const sweepIds = payloads.find(entry => entry.task === 'policy_evidence_override_sweep').payload.clauses.map(clause => clause.clause_id);
  const firstIds = payloads.find(entry => entry.task === 'policy_evidence_investigate').payload.clauses.map(clause => clause.clause_id);
  assert.ok(!firstIds.includes(exclusion.clauseId) && sweepIds.includes(exclusion.clauseId));
  assert.ok(answer.limited_or_excluded.some(entry => entry.clauseIds.includes(exclusion.clauseId)));
});

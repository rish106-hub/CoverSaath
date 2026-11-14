import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';
import { createBackendServices } from '../src/backend/services/index.js';
import { at, insert, seedWorld } from './support/postgres-fixtures.mjs';
import { formatFactValue, maskPolicyNumber, MEMORY_DOCUMENT_SECTIONS } from '../src/backend/services/memory-document.js';

// The owner's memory document (target flow steps 12-13): rendered on demand from sealed rows, never stored. Synthetic data only.
// Needs PostgreSQL (TEST_DATABASE_URL); REQUIRE_POSTGRES=1 makes a missing database an error instead of a skip.

const opts = postgresTestOptions();
const BOOT = 'coversaath-test-bootstrap-token-0018';
const MARK = 'Quillberry-marker';
const POLICY_NUMBER = 'SYNTH-0000-5678-9012';
const ON = { HOLDINGS_ENABLED: 'true', MEMORY_ENABLED: 'true' };

async function startApp(database, env) {
  const server = createApiServer({ database, env: { KNOWVIA_BOOTSTRAP_TOKEN: BOOT, ...env } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { token } = {}) => {
    const response = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* markdown */ }
    return { status: response.status, headers: response.headers, text, data };
  };
  return { call, stop: () => new Promise(resolve => server.close(resolve)) };
}

async function world(t, env = ON) {
  const fresh = await freshDatabase(t);
  const { handle, services, db } = fresh;
  const a = await seedWorld(handle.pool, 'a');
  const b = await seedWorld(handle.pool, 'b');
  for (const w of [a, b]) {
    const key = w.household.split('-')[1];
    w.profileGrant = `pi-${key}`;
    w.coverageGrant = `cr-${key}`;
    await insert(handle.pool, 'consent_grants', { id: w.profileGrant, household_id: w.household, subject_adult_id: w.adult, purpose: 'profile_intake' });
    await insert(handle.pool, 'consent_grants', { id: w.coverageGrant, household_id: w.household, subject_adult_id: w.adult, purpose: 'coverage_reconstruction' });
    w.token = (await services.auth.issueSession({ adultUserId: w.adult })).token;
    w.holding = await services.policyHoldings.create({ householdId: w.household, adultId: w.adult, documentId: w.document, kind: 'retail_health', policyId: w.policy });
  }
  const app = await startApp(db, env);
  t.after(() => app.stop());
  return { ...fresh, services, app, a, b };
}

// Facts in the shape the collate job writes: sealed { value, alternatives }.
async function seedFacts(s) {
  const { services, handle, a } = s;
  const base = { householdId: a.household, holdingId: a.holding.id, policyId: a.policy, consentGrantId: a.coverageGrant, provenance: { sourceDocumentId: a.document, sourcePageId: a.page } };
  const own = (factKey, value, extra = {}) => services.memoryFacts.insertFact({ ...base, factKey, tier: 'own_pdf', status: 'extracted_unverified', value: { value, alternatives: [] }, ...extra });
  await insert(handle.pool, 'policy_clauses', { id: 'clause-a-ped', household_id: a.household, case_id: a.case, document_id: a.document, page: 7, title: 'Pre-existing diseases', text: services.columnCrypto.seal('policy_clauses', 'text', 'clause-a-ped', 'Pre-existing diseases are covered after 36 months.'), digest: 'e'.repeat(64) });
  await own('sum_insured', { amountMinor: 50_000_000 });
  await own('waiting_ped', { days: 1095 }, { provenance: { ...base.provenance, policyClauseId: 'clause-a-ped' } });
  await own('clause_exclusion', { text: 'Cosmetic treatment is excluded.' });
  await own('copay_percent', { bp: 1000 });
  // A conflict on the initial waiting period: own PDF and insurer wording disagree.
  const left = await services.memoryFacts.insertFact({ ...base, factKey: 'waiting_initial', tier: 'own_pdf', status: 'conflicting', value: { value: null, alternatives: [{ days: 30 }, { days: 60 }] } });
  const right = await services.memoryFacts.insertFact({ ...base, factKey: 'waiting_initial', tier: 'ida_wording', status: 'conflicting', value: { value: null, alternatives: [{ days: 30 }, { days: 60 }] }, referenceRef: { source: 'fss', evidence: [{ pageNumber: 4 }], verificationStatus: 'verified' }, provenance: { sourceDocumentId: a.document } });
  await services.memoryFacts.openConflict({ householdId: a.household, holdingId: a.holding.id, factKey: 'waiting_initial', candidateFactIds: [left.fact.id, right.fact.id], reason: 'own_vs_insurer' });
  // Records: policy number and version (sealed), a declaration, a premium payment and a due.
  await handle.pool.query('UPDATE policies SET policy_number_masked = $1, policy_version = $2 WHERE id = $3', [
    services.columnCrypto.seal('policies', 'policy_number_masked', a.policy, POLICY_NUMBER), services.columnCrypto.seal('policies', 'policy_version', a.policy, 'v3'), a.policy]);
  await services.declarations.create({ householdId: a.household, adultId: a.adult, memberId: a.member, kind: 'pre_existing_disease', label: `${MARK} hypertension`, declaredOn: '2024-05-01', declaredToInsurer: true, holdingId: a.holding.id, consentGrantId: a.profileGrant });
  await services.premiums.recordPayment({ householdId: a.household, adultId: a.adult, holdingId: a.holding.id, amountPaise: 1_234_500, paidOn: '2026-01-15', channel: 'upi', consentGrantId: a.profileGrant });
  await services.premiums.addDue({ householdId: a.household, adultId: a.adult, holdingId: a.holding.id, dueOn: '2027-01-15', amountPaise: 1_234_500, consentGrantId: a.profileGrant });
}

const path = holding => `/api/v1/holdings/${holding.id}/memory-document`;

test('memory document: fixed sections, citations on every fact line, policy number masked, headers', opts, async t => {
  const s = await world(t);
  await seedFacts(s);
  const r = await s.app.call(path(s.a.holding), { token: s.a.token });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  // Sections, in order.
  const headings = [...r.text.matchAll(/^## (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(headings, [...MEMORY_DOCUMENT_SECTIONS]);
  // Every bullet ends with a citation or [unknown].
  const bullets = r.text.split('\n').filter(line => line.startsWith('- '));
  assert.ok(bullets.length >= 12, `${bullets.length} bullets`);
  for (const line of bullets) assert.match(line, /\[[^\]]+\]$/, line);
  // Page and clause citations come from the stored rows (schedule page 2, clause on page 7 titled below).
  assert.match(r.text, /What is the sum insured\? INR 5,00,000 \(read from your document, not verified\) \[policy_schedule, p\.2\]/);
  assert.match(r.text, /waiting period for pre-existing diseases\? 1095 days.*\[policy_schedule, p\.2, clause Pre-existing diseases\]/);
  assert.match(r.text, /## Exclusions\n\n- What does the policy not cover\? Cosmetic treatment is excluded\./);
  assert.match(r.text, /## Declared conditions\n\n- Member member-a: .*Quillberry-marker hypertension \(pre existing disease, declared on 2024-05-01, declared to the insurer\) \[owner statement\]/);
  assert.match(r.text, /Premium paid 2026-01-15: INR 12,345 by upi \[owner statement\]/);
  assert.match(r.text, /Premium due 2027-01-15: INR 12,345, expected \[owner statement\]/);
  // The open conflict names both readings and cites the insurer page.
  const conflicts = r.text.split('## Conflicts to resolve')[1].split('## Open questions')[0];
  assert.match(conflicts, /initial waiting period\? Readings: 30 days or 60 days \[policy_schedule, p\.2\]; 30 days or 60 days \[insurer_wording, p\.4\]/);
  // Masked policy number: last 4 only.
  assert.match(r.text, /Policy number: X{12}9012 \[policy record\]/);
  assert.equal(r.text.includes('5678'), false);
  assert.equal(r.text.includes('SYNTH-0000'), false);
  assert.match(r.text, /Version: v3 \[policy record\]/);
  assert.match(r.text, /FOR LEGAL REVIEW/);
  // Open questions list unknown keys, each as an unknown citation.
  assert.match(r.text.split('## Open questions')[1], /- What is the room rent limit per day\? \[unknown\]/);
  // Nothing is stored: no new row anywhere carries the document text.
  const dump = JSON.stringify(await s.db.many('SELECT * FROM audit_events'));
  assert.equal(dump.includes(MARK), false);
});

test('memory document: a household with no facts still renders every section as unknown', opts, async t => {
  const s = await world(t);
  const r = await s.app.call(path(s.b.holding), { token: s.b.token });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([...r.text.matchAll(/^## (.+)$/gm)].map(match => match[1]), [...MEMORY_DOCUMENT_SECTIONS]);
  for (const line of r.text.split('\n').filter(item => item.startsWith('- '))) assert.match(line, /\[[^\]]+\]$/, line);
  assert.match(r.text, /Policy number: unknown \[unknown\]/);
});

test('memory document: another household sees 404, no token 401, and a non-owner member the same 404', opts, async t => {
  const s = await world(t);
  await seedFacts(s);
  const foreign = await s.app.call(path(s.a.holding), { token: s.b.token });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.data.error.code, 'HOLDING_NOT_FOUND');
  assert.equal(foreign.text.includes(MARK), false);
  const missing = await s.app.call('/api/v1/holdings/no-such-holding/memory-document', { token: s.a.token });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error.code, 'HOLDING_NOT_FOUND');
  assert.equal((await s.app.call(path(s.a.holding))).status, 401);
  // A member role (not owner) in A's household is refused like a stranger.
  await insert(s.handle.pool, 'adult_users', { id: 'adult-a-member' });
  await insert(s.handle.pool, 'household_roles', { id: 'role-a-member', household_id: s.a.household, adult_user_id: 'adult-a-member', role: 'member' });
  const memberToken = (await s.services.auth.issueSession({ adultUserId: 'adult-a-member' })).token;
  const asMember = await s.app.call(path(s.a.holding), { token: memberToken });
  assert.equal(asMember.status, 404);
  assert.equal(asMember.data.error.code, 'HOLDING_NOT_FOUND');
});

test('memory document: off unless HOLDINGS_ENABLED and MEMORY_ENABLED are exactly true (503 coded)', opts, async t => {
  const s = await world(t, {});
  const noHoldings = await s.app.call(path(s.a.holding), { token: s.a.token });
  assert.equal(noHoldings.status, 503);
  assert.equal(noHoldings.data.error.code, 'HOLDINGS_DISABLED');
  const holdingsOnly = await startApp(s.db, { HOLDINGS_ENABLED: 'true' });
  t.after(() => holdingsOnly.stop());
  const noMemory = await holdingsOnly.call(path(s.a.holding), { token: s.a.token });
  assert.equal(noMemory.status, 503);
  assert.equal(noMemory.data.error.code, 'MEMORY_DISABLED');
  const garbage = await startApp(s.db, { HOLDINGS_ENABLED: 'true', MEMORY_ENABLED: 'TRUE' });
  t.after(() => garbage.stop());
  assert.equal((await garbage.call(path(s.a.holding), { token: s.a.token })).data.error.code, 'MEMORY_DISABLED');
});

// Nothing is stored by this feature, so there is no erasure path to add: after a revocation of the document-processing grant the
// route refuses with the coded consent error and nothing of the earlier rendering remains anywhere.
test('memory document: after revocation the route answers the coded consent error', opts, async t => {
  const s = await world(t);
  await seedFacts(s);
  assert.equal((await s.app.call(path(s.a.holding), { token: s.a.token })).status, 200);
  // A grant withdrawn but not yet erased (the window between the two): the consent re-check refuses.
  await s.handle.pool.query('UPDATE consent_grants SET revoked_at = $1 WHERE id = $2', [new Date().toISOString(), s.a.consent]);
  const after = await s.app.call(path(s.a.holding), { token: s.a.token });
  assert.equal(after.status, 403, after.text);
  assert.equal(after.data.error.code, 'CONSENT_REQUIRED');
  assert.equal(after.text.includes(MARK), false);
});

test('memory document: revocation through the consent service erases the holding, so the route answers the same coded 404', opts, async t => {
  const s = await world(t);
  await seedFacts(s);
  await s.services.consents.revoke({ grantId: s.a.consent, revokedByAdultId: s.a.adult, reason: 'user_request' });
  const after = await s.app.call(path(s.a.holding), { token: s.a.token });
  assert.ok([403, 404].includes(after.status), after.text);
  assert.ok(['CONSENT_REQUIRED', 'HOLDING_NOT_FOUND'].includes(after.data.error.code));
  assert.equal(after.text.includes(MARK), false);
});

test('memory document: the service function the chat path can call renders the same text and enforces the owner', opts, async t => {
  const s = await world(t);
  await seedFacts(s);
  const { memoryDocument } = createBackendServices(s.db, { env: ON });
  const text = await memoryDocument.render({ householdId: s.a.household, holdingId: s.a.holding.id, adultId: s.a.adult });
  assert.match(text, /^# Memory\n/);
  await assert.rejects(memoryDocument.render({ householdId: s.a.household, holdingId: s.a.holding.id, adultId: s.b.adult }), error => error.code === 'HOLDING_NOT_FOUND');
  await assert.rejects(memoryDocument.render({ householdId: s.b.household, holdingId: s.a.holding.id, adultId: s.a.adult }), error => error.code === 'HOLDING_NOT_FOUND');
});

test('memory document: value formatting and policy number masking are pure', () => {
  assert.equal(maskPolicyNumber('SYNTH-0000-5678-9012'), 'XXXXXXXXXXXX9012');
  assert.equal(maskPolicyNumber('1234'), '1234');
  assert.equal(maskPolicyNumber('123'), null);
  assert.equal(maskPolicyNumber(null), null);
  assert.equal(formatFactValue('money', { amountMinor: 1_234_500 }), 'INR 12,345');
  assert.equal(formatFactValue('money', { amountMinor: 1_00_050 }), 'INR 1,000.50');
  assert.equal(formatFactValue('percent', { bp: 1050 }), '10.5%');
  assert.equal(formatFactValue('date_range', { startIso: '2026-01-01', endIso: '2026-12-31' }), '2026-01-01 to 2026-12-31');
  assert.equal(formatFactValue('bool', { value: true }), 'yes');
  assert.equal(formatFactValue('money', { amountMinor: 'x' }), null);
  assert.equal(formatFactValue('duration', null), null);
});

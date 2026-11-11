import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestOptions } from './support/pg.mjs';
import { startApp, scenario, fixture, bootstrapToken } from './support/read-back-harness.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { createJobWorker } from '../src/backend/services/job-worker.js';
import { JobQueueRepository } from '../src/backend/repositories/job-queue-repository.js';
import { buildJobHandlers } from '../src/server/worker.js';
import { HOLDING_JOB_KINDS } from '../src/contracts/holdings.js';

// Holdings pipeline end to end on PostgreSQL (complete.md 3.2 steps 3-6, O-A4 success test): two synthetic sources (the household's
// own PDF through policy_facts and a fake IDA reference port), one disagreement -> exactly one conflict; the owner resolves it ->
// a user_confirmed declaration row and status ready; re-running every job is a no-op; another household gets the same 404.
// Synthetic values only. Needs TEST_DATABASE_URL (REQUIRE_POSTGRES=1 turns a skip into a failure).

const opts = postgresTestOptions();
const ON = { POLICY_FACTS_ENABLED: 'true', HOLDINGS_ENABLED: 'true' };
const SYNTHETIC_UIN = 'SYNHLIP26001V012526';
const SCHEDULE = ['Sum Insured: Rs. 5,00,000/-', 'Pre-existing Diseases Waiting Period: 36 months', 'Maternity Waiting Period: 2 years 6 months', 'Co-payment: 20%'];
const page = lines => lines.map(text => ({ text, tag: 'paragraph' }));

// The IDA tier, as deterministic code would read it from reference_cache. The PED wait agrees, the co-payment differs.
const referenceFacts = {
  async forHolding() {
    return [
      { factKey: 'waiting_ped', refId: 'ref-syn-ped', origin: 'reference', value: { days: 1095, original: [3, 'year'] }, quote: 'Pre-existing diseases are covered after 3 years.', cacheKey: `product:${SYNTHETIC_UIN}`, version: 'v1' },
      { factKey: 'copay_percent', refId: 'ref-syn-copay', origin: 'reference', value: { bp: 1000 }, quote: 'A co-payment of 10% applies to every claim.', cacheKey: `product:${SYNTHETIC_UIN}`, version: 'v1' },
      // A model-proposed reference value is refused and never becomes reviewed_reference.
      { factKey: 'waiting_maternity', refId: 'ref-syn-model', origin: 'model_proposed', value: { days: 910 }, cacheKey: `product:${SYNTHETIC_UIN}`, version: 'v1' },
    ];
  },
};

const count = async (app, sql, params = []) => Number((await app.database.one(sql, params)).n);

async function world(t, { env = ON, pages = [page(SCHEDULE), page(['Schedule of benefits'])] } = {}) {
  fixture.pages = pages;
  const app = await startApp(t, { env });
  const s = await scenario(app, { name: 'Holding' });
  const services = createBackendServices(app.database, { env: ON, referenceFacts });
  const at = new Date().toISOString();
  s.holdingId = `hold-${s.documentId}`.slice(0, 100);
  // OCR completion already made this document's holding and detect job (HOLDINGS_ENABLED); the test seeds its own.
  await app.database.run("DELETE FROM job_queue WHERE kind = 'holding.detect_insurer'");
  await app.database.run('DELETE FROM policy_holdings WHERE document_id = ?', [s.documentId]);
  await app.database.run(`INSERT INTO policy_holdings (id, household_id, document_id, kind, status, created_at, updated_at)
    VALUES (?, ?, ?, 'retail_health', 'product_reported', ?, ?)`, [s.holdingId, s.householdId, s.documentId, at, at]);
  const queue = new JobQueueRepository(app.database);
  const worker = createJobWorker({ queue, handlers: buildJobHandlers(services, ON), workerId: 'test-worker', leaseMs: 60_000, heartbeatMs: 20_000 });
  const drain = async () => {
    const outcomes = [];
    for (let n = 0; n < 50; n += 1) {
      const outcome = await worker.runOnce();
      if (!outcome) break;
      outcomes.push(outcome.outcome);
    }
    return outcomes;
  };
  return { app, s, services, queue, drain };
}

const snapshot = async app => ({
  memory: await app.database.many('SELECT id, source_tier, status, fact_key, superseded_at FROM household_memory_facts ORDER BY id'),
  conflicts: await app.database.many('SELECT id, resolution FROM memory_conflicts ORDER BY id'),
  holding: await app.database.many('SELECT status, updated_at FROM policy_holdings ORDER BY id'),
  facts: await count(app, 'SELECT count(*) AS n FROM policy_facts'),
});

test('pipeline: two sources, one disagreement -> one conflict; resolve -> user_confirmed and ready; re-run is a no-op', opts, async t => {
  const { app, s, services, drain } = await world(t);
  await services.holdings.startPipeline({ householdId: s.householdId, holdingId: s.holdingId });
  const outcomes = await drain();
  assert.ok(outcomes.length >= 4 && outcomes.every(outcome => outcome === 'succeeded'), JSON.stringify(outcomes));

  // Jobs: identifiers only, a sha256 dedupe key, at most 3 attempts.
  const jobs = await app.database.many("SELECT kind, payload_json, dedupe_key, max_attempts FROM job_queue WHERE kind LIKE 'holding.%'");
  assert.deepEqual(new Set(jobs.map(job => job.kind)), new Set(Object.values(HOLDING_JOB_KINDS)));
  for (const job of jobs) {
    assert.match(job.dedupe_key, /^[0-9a-f]{64}$/);
    assert.ok(job.payload_json.length <= 1024);
    assert.deepEqual(Object.keys(JSON.parse(job.payload_json)).sort(), ['holdingId', 'inputSha']);
    assert.equal(job.max_attempts, 3);
  }

  const memory = await app.database.many('SELECT * FROM household_memory_facts WHERE superseded_at IS NULL');
  const by = (key, tier) => memory.find(row => row.fact_key === key && row.source_tier === tier);
  assert.equal(by('waiting_ped', 'ida_wording').status, 'reviewed_reference');
  assert.ok(by('waiting_ped', 'ida_wording').policy_fact_id, 'the reviewed_reference row cites the own-PDF fact');
  assert.equal(by('waiting_ped', 'own_pdf').status, 'extracted_unverified');
  assert.equal(by('copay_percent', 'own_pdf').status, 'conflicting');
  assert.equal(by('copay_percent', 'ida_wording').status, 'conflicting');
  assert.equal(by('waiting_maternity', 'ida_wording'), undefined, 'the model-proposed reference value is refused');
  assert.equal(by('sum_insured', 'own_pdf').status, 'extracted_unverified');
  assert.equal(by('sum_insured', 'ida_wording'), undefined, 'IDA never writes a personal value');
  assert.ok(memory.every(row => row.status !== 'user_confirmed' && row.source_tier !== 'user_declaration'), 'no machine path writes the user tier');
  assert.ok(memory.every(row => /^enc2\./.test(row.value_enc)));
  const conflicts = await app.database.many('SELECT * FROM memory_conflicts');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].fact_key, 'copay_percent');
  assert.equal(conflicts[0].reason, 'own_vs_insurer');
  assert.equal((await app.database.one('SELECT status FROM policy_holdings WHERE id = ?', [s.holdingId])).status, 'conflicts');

  // Owner reads: facts and conflicts. Values open for the owner; no UIN or cache key in any body.
  const facts = await app.call(`/api/v1/holdings/${s.holdingId}/facts`, { token: s.token });
  assert.equal(facts.status, 200, JSON.stringify(facts.data));
  const fact = key => facts.data.facts.find(item => item.factKey === key);
  assert.equal(fact('waiting_ped').status, 'reviewed_reference');
  assert.equal(fact('waiting_ped').value.days, 1095);
  assert.equal(fact('copay_percent').status, 'conflicting');
  assert.equal(fact('copay_percent').checkWithInsurer, true);
  assert.equal(fact('copay_percent').openConflictId, conflicts[0].id);
  assert.ok(facts.data.unknownKeys.includes('grace_period'));
  const listed = await app.call(`/api/v1/holdings/${s.holdingId}/conflicts`, { token: s.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.conflicts.length, 1);
  const [conflict] = listed.data.conflicts;
  assert.equal(conflict.candidates.length, 2);
  const ida = conflict.candidates.find(item => item.tier === 'ida_wording');
  assert.equal(ida.quote, 'A co-payment of 10% applies to every claim.');
  assert.equal(conflict.candidates.find(item => item.tier === 'own_pdf').quote, 'Co-payment: 20%', 'both quotes are returned to the owner');
  for (const body of [facts.data, listed.data]) {
    const text = JSON.stringify(body);
    assert.ok(!text.includes(SYNTHETIC_UIN) && !text.includes('cacheKey') && !text.includes('enc2.'), 'no UIN, locator or ciphertext in a response');
  }

  // Resolve: the owner chooses the insurer reading.
  const resolved = await app.call(`/api/v1/holdings/${s.holdingId}/conflicts/${conflict.id}/resolve`, { method: 'POST', token: s.token, body: { chosenFactId: ida.id } });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
  assert.equal(resolved.data.status, 'user_confirmed');
  assert.equal(resolved.data.holdingStatus, 'ready');
  const declaration = await app.database.one("SELECT * FROM household_memory_facts WHERE source_tier = 'user_declaration'");
  assert.equal(declaration.status, 'user_confirmed');
  assert.equal(declaration.capture_method, 'conflict_resolution');
  assert.equal(declaration.declared_by_adult_id, s.adultId);
  assert.deepEqual([...declaration.resolves_fact_ids].sort(), [...conflicts[0].candidate_fact_ids].sort());
  assert.equal(await count(app, "SELECT count(*) AS n FROM household_memory_facts WHERE fact_key = 'copay_percent' AND source_tier <> 'user_declaration' AND superseded_at IS NULL"), 2, 'machine rows stay');
  const after = await app.call(`/api/v1/holdings/${s.holdingId}/facts`, { token: s.token });
  const copay = after.data.facts.find(item => item.factKey === 'copay_percent');
  assert.equal(copay.status, 'user_confirmed');
  assert.equal(copay.value.bp, 1000);
  assert.equal(copay.checkWithInsurer, true);
  assert.equal(copay.alternatives.length, 2, 'both readings are still returned for a product term');
  // The same choice again is a replay; another choice on a closed conflict is refused.
  const again = await app.call(`/api/v1/holdings/${s.holdingId}/conflicts/${conflict.id}/resolve`, { method: 'POST', token: s.token, body: { chosenFactId: ida.id } });
  assert.equal(again.status, 200);
  assert.equal(again.data.replay, true);
  const other = conflict.candidates.find(item => item.tier === 'own_pdf');
  const refused = await app.call(`/api/v1/holdings/${s.holdingId}/conflicts/${conflict.id}/resolve`, { method: 'POST', token: s.token, body: { chosenFactId: other.id } });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error.code, 'MEMORY_CONFLICT_ALREADY_RESOLVED');

  // Re-running every job is a no-op: no new rows, conflicts, facts or status change.
  const before = await snapshot(app);
  await services.holdings.startPipeline({ householdId: s.householdId, holdingId: s.holdingId });
  const rerun = await drain();
  assert.ok(rerun.length >= 4 && rerun.every(outcome => outcome === 'succeeded'), JSON.stringify(rerun));
  for (const kind of Object.values(HOLDING_JOB_KINDS)) {
    await services.jobQueue.enqueue({ kind, householdId: s.householdId, documentId: s.documentId, payload: { holdingId: s.holdingId } });
  }
  await drain();
  assert.deepEqual(await snapshot(app), before);
  assert.equal((await app.database.one('SELECT status FROM policy_holdings WHERE id = ?', [s.holdingId])).status, 'ready');
});

test('pipeline: two pages that disagree on one own-PDF value open an in-tier conflict; the holding settles conflicts, not ready; owner can resolve', opts, async t => {
  const { app, s, services, drain } = await world(t, { pages: [page(['Sum Insured: Rs. 5,00,000/-']), page(['Sum Insured: Rs. 7,00,000/-'])] });
  await services.holdings.startPipeline({ householdId: s.householdId, holdingId: s.holdingId });
  const outcomes = await drain();
  assert.ok(outcomes.every(outcome => outcome === 'succeeded'), JSON.stringify(outcomes));
  const own = await app.database.one("SELECT * FROM household_memory_facts WHERE fact_key = 'sum_insured' AND source_tier = 'own_pdf' AND superseded_at IS NULL");
  assert.equal(own.status, 'conflicting');
  const conflicts = await app.database.many("SELECT * FROM memory_conflicts WHERE fact_key = 'sum_insured'");
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'two_pages');
  assert.equal(conflicts[0].resolution, 'pending');
  assert.ok(conflicts[0].candidate_fact_ids.length >= 2);
  assert.equal((await app.database.one('SELECT status FROM policy_holdings WHERE id = ?', [s.holdingId])).status, 'conflicts', 'an unresolved in-tier conflict never settles ready');
  const listed = await app.call(`/api/v1/holdings/${s.holdingId}/conflicts`, { token: s.token });
  assert.equal(listed.data.conflicts.find(item => item.factKey === 'sum_insured').candidates.length, 1, 'the one row that carries both readings is listed once');
  const resolved = await app.call(`/api/v1/holdings/${s.holdingId}/conflicts/${conflicts[0].id}/resolve`, { method: 'POST', token: s.token, body: { chosenFactId: own.id, alternativeIndex: 1 } });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
  await services.holdings.startPipeline({ householdId: s.householdId, holdingId: s.holdingId });
  await drain();
  assert.equal(Number((await app.database.one("SELECT count(*) AS n FROM memory_conflicts WHERE fact_key = 'sum_insured' AND resolution = 'pending'")).n), 0);
});

test('routes: 401 without a session; foreign household, non-owner member and missing holding answer the same 404', opts, async t => {
  const { app, s, services, drain } = await world(t);
  await services.holdings.startPipeline({ householdId: s.householdId, holdingId: s.holdingId });
  await drain();
  const [conflict] = await app.database.many('SELECT id, candidate_fact_ids FROM memory_conflicts');
  assert.equal((await app.call(`/api/v1/holdings/${s.holdingId}/facts`)).status, 401);
  const foreign = await app.call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: 'Foreign household', owner: { displayName: 'Other Synthetic' } } });
  const member = await services.households.createAdult({ displayName: 'Member Synthetic' });
  await services.households.addRole({ householdId: s.householdId, adultUserId: member.id, role: 'member' });
  const memberToken = (await services.auth.issueSession({ adultUserId: member.id })).token;
  const outcomes = [];
  for (const token of [foreign.data.session.token, memberToken]) {
    outcomes.push(await app.call(`/api/v1/holdings/${s.holdingId}/facts`, { token }));
    outcomes.push(await app.call(`/api/v1/holdings/${s.holdingId}/conflicts`, { token }));
    outcomes.push(await app.call(`/api/v1/holdings/${s.holdingId}/conflicts/${conflict.id}/resolve`, { method: 'POST', token, body: { chosenFactId: conflict.candidate_fact_ids[0] } }));
  }
  outcomes.push(await app.call('/api/v1/holdings/hold-does-not-exist/facts', { token: s.token }));
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 404, JSON.stringify(outcome.data));
    assert.equal(outcome.data.error.code, 'HOLDING_NOT_FOUND');
  }
  assert.equal(new Set(outcomes.map(outcome => JSON.stringify(outcome.data))).size, 1, 'the bodies are identical');
  assert.equal(await count(app, "SELECT count(*) AS n FROM household_memory_facts WHERE source_tier = 'user_declaration'"), 0, 'no foreign write happened');
  // Bad choices are coded 4xx.
  const badChoice = await app.call(`/api/v1/holdings/${s.holdingId}/conflicts/${conflict.id}/resolve`, { method: 'POST', token: s.token, body: { chosenFactId: 'hmf-not-a-candidate' } });
  assert.equal(badChoice.data.error.code, 'MEMORY_CONFLICT_CHOICE_INVALID');
  const missing = await app.call(`/api/v1/holdings/${s.holdingId}/conflicts/mcf-missing/resolve`, { method: 'POST', token: s.token, body: { chosenFactId: conflict.candidate_fact_ids[0] } });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error.code, 'MEMORY_CONFLICT_NOT_FOUND');
});

test('flag off: routes answer HOLDINGS_DISABLED and the worker registers no holdings handler', opts, async t => {
  const { app, s } = await world(t, { env: { POLICY_FACTS_ENABLED: 'true' } });
  const response = await app.call(`/api/v1/holdings/${s.holdingId}/facts`, { token: s.token });
  assert.equal(response.status, 503);
  assert.equal(response.data.error.code, 'HOLDINGS_DISABLED');
  const handlers = buildJobHandlers(createBackendServices(app.database, { env: {} }), { HOLDINGS_ENABLED: 'TRUE' });
  assert.ok(Object.keys(handlers).every(kind => !kind.startsWith('holding.')));
});

test('erasure: erasing the household removes the holding, its memory rows and conflicts, and no other household', opts, async t => {
  const { app, s, services, drain } = await world(t);
  await services.holdings.startPipeline({ householdId: s.householdId, holdingId: s.holdingId });
  await drain();
  const conflict = await app.database.one('SELECT * FROM memory_conflicts');
  await services.holdingPipelineRepository.resolveConflict({ holding: await services.holdingPipelineRepository.getHolding({ householdId: s.householdId, holdingId: s.holdingId }), conflictId: conflict.id, chosenFactId: conflict.candidate_fact_ids[0], adultId: s.adultId });
  assert.ok(await count(app, 'SELECT count(*) AS n FROM household_memory_facts WHERE household_id = ?', [s.householdId]) >= 4);
  const erased = await app.call(`/api/v1/households/${s.householdId}/erasure`, { method: 'POST', token: s.token, body: { confirm: s.householdId } });
  assert.equal(erased.status, 200, JSON.stringify(erased.data));
  for (const table of ['household_memory_facts', 'memory_conflicts', 'policy_holdings']) {
    assert.equal(await count(app, `SELECT count(*) AS n FROM ${table} WHERE household_id = ?`, [s.householdId]), 0, table);
  }
  assert.equal(await count(app, "SELECT count(*) AS n FROM job_queue WHERE household_id = ? AND kind LIKE 'holding.%' AND status IN ('queued', 'running')", [s.householdId]), 0);
});

test('erasure: deleting the document removes the holding and every row the pipeline derived from it', opts, async t => {
  const { app, s, services, drain } = await world(t);
  await services.holdings.startPipeline({ householdId: s.householdId, holdingId: s.holdingId });
  await drain();
  const deleted = await app.call(`/api/v1/documents/${s.documentId}`, { method: 'DELETE', token: s.token });
  assert.ok([200, 202].includes(deleted.status), JSON.stringify(deleted.data));
  for (const table of ['household_memory_facts', 'memory_conflicts', 'policy_holdings']) {
    assert.equal(await count(app, `SELECT count(*) AS n FROM ${table} WHERE household_id = ?`, [s.householdId]), 0, table);
  }
});

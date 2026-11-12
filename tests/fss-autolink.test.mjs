import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { postgresTestOptions } from './support/pg.mjs';
import { startApp, scenario, fixture, uploadDocument } from './support/read-back-harness.mjs';
import { FSS_STUB_ENV } from './support/fss-stub.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { createJobWorker } from '../src/backend/services/job-worker.js';
import { JobQueueRepository } from '../src/backend/repositories/job-queue-repository.js';
import { createInsuranceDataClient } from '../src/integrations/index.js';
import { buildJobHandlers } from '../src/server/worker.js';
import { WORDING_STATES, WORDING_REASONS } from '../src/contracts/holdings.js';

// ADR 0034, row 1b: the confirmed product attaches the insurer's terms from FSS (a local fixture stub, never the network) as the
// ida_wording tier, once, through collate. Synthetic data only. Needs TEST_DATABASE_URL.

const opts = postgresTestOptions();
const UIN = 'SYNHLIP26001V012526';
const ENV = { POLICY_FACTS_ENABLED: 'true', HOLDINGS_ENABLED: 'true', ...FSS_STUB_ENV, REFERENCE_DATA_TIMEOUT_MS: '150' };
const page = lines => lines.map(text => ({ text, tag: 'paragraph' }));
const schedule = (copay = '10%') => [page(['Sum Insured: Rs. 5,00,000/-', `Co-payment: ${copay}`, 'Pre-existing Diseases Waiting Period: 36 months']), page(['Schedule of benefits'])];
const fixtureJson = name => JSON.parse(readFileSync(new URL(`./fixtures/fss/${name}.json`, import.meta.url), 'utf8'));
const n = async (app, sql, params = []) => Number((await app.database.one(sql, params)).n);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const SHA_A = 'a'.repeat(64);

// A fixture FSS: product by UIN, versions, facts pages. `fail` is an HTTP status or 'timeout'. Counts every request.
function fakeFss({ products = null, versions = null, pages = ['facts-page-1', 'facts-page-2'].map(fixtureJson), fail = null } = {}) {
  const calls = [];
  const productRow = { ...fixtureJson('product').data[0], uin_raw: UIN, verification_status: 'independently_verified' };
  const state = { fail };
  const fetchImpl = (url, init = {}) => {
    const target = new URL(String(url));
    calls.push(`${target.pathname}${target.search}`);
    if (state.fail === 'timeout') return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    if (typeof state.fail === 'number') return Promise.resolve(new Response('upstream detail', { status: state.fail }));
    const path = target.pathname;
    if (path === '/v1/products') return Promise.resolve(json({ data: products ?? [productRow] }));
    if (/\/v1\/products\/[^/]+\/versions$/.test(path)) return Promise.resolve(json({ data: versions ?? fixtureJson('versions').data }));
    if (/\/v1\/versions\/[^/]+\/facts$/.test(path)) {
      const cursor = target.searchParams.get('cursor');
      const body = pages[cursor === null ? 0 : Number(cursor.replace('cur_', '')) - 1];
      return Promise.resolve(body ? json(body) : json({ error: 'not_found' }, 404));
    }
    return Promise.resolve(json({ error: 'not_found' }, 404));
  };
  return { fetchImpl, calls, setFail: value => { state.fail = value; } };
}

const factsPage = (facts, coverage, next = null) => ({ ...fixtureJson('facts-withheld'), facts, coverage, next_cursor: next });
const factRow = (id, type, value, over = {}) => ({
  fact_id: id, version_id: 'ver_synth_1', fact_type: type, value, verification_status: 'independently_verified', source_freshness: '2026-01-01T00:00:00Z',
  review_id: 'rev_synth_1', reviewer_id: 'reviewer_synth_1', taxonomy_version: 'synth-1', conditions: [], exceptions: [],
  evidence: [{ document_id: 'doc_synth_1', page_number: 12, sha256: SHA_A, page_sha256: SHA_A }], ...over,
});

async function world(t, { copay = '10%', fss = fakeFss() } = {}) {
  fixture.pages = schedule(copay);
  const app = await startApp(t, { env: ENV });
  const s = await scenario(app, { name: 'Holding' });
  const referenceClient = createInsuranceDataClient({ env: ENV, fetchImpl: fss.fetchImpl });
  const services = createBackendServices(app.database, { env: ENV, referenceClient });
  const holdingId = `hold-${s.documentId}`.slice(0, 100);
  const at = new Date().toISOString();
  await app.database.run("DELETE FROM job_queue WHERE kind = 'holding.detect_insurer'");
  await app.database.run('DELETE FROM policy_holdings WHERE document_id = ?', [s.documentId]);
  await app.database.run(`INSERT INTO policy_holdings (id, household_id, document_id, kind, status, created_at, updated_at) VALUES (?, ?, ?, 'retail_health', 'insurer_pending', ?, ?)`, [holdingId, s.householdId, s.documentId, at, at]);
  const sourceVersion = (await app.database.one('SELECT source_version FROM document_uploads WHERE id = ?', [s.documentId])).source_version;
  // The owner confirms the product (policy_profiles, state reported) and the holding links to it.
  await services.policyProfiles.confirm({ householdId: s.householdId, documentId: s.documentId, adultUserId: s.adultId, idempotencyKey: 'confirm-key-0001',
    statement: Object.freeze({ uin: UIN, insurerName: 'Synthetic Test Insurer', policyName: 'Synthetic Test Health Plan', expectedVersion: 0 }) });
  const profile = await services.policyProfiles.get({ householdId: s.householdId, documentId: s.documentId, sourceVersion });
  await services.policyHoldings.link({ householdId: s.householdId, adultId: s.adultId, holdingId, policyProfileId: profile.id });
  await services.policyHoldings.setStatus({ householdId: s.householdId, adultId: s.adultId, holdingId, status: 'product_reported' });
  const worker = createJobWorker({ queue: new JobQueueRepository(app.database), handlers: buildJobHandlers(services, ENV), workerId: 'test-worker', leaseMs: 60_000, heartbeatMs: 20_000 });
  const drain = async () => {
    const outcomes = [];
    for (let i = 0; i < 50; i += 1) { const outcome = await worker.runOnce(); if (!outcome) break; outcomes.push(outcome.outcome); }
    return outcomes;
  };
  const run = async () => { await services.holdings.startPipeline({ householdId: s.householdId, holdingId }); return drain(); };
  const holdingRow = () => app.database.one('SELECT reference_outcome, reference_checked_at FROM policy_holdings WHERE id = ?', [holdingId]);
  const idaRows = () => app.database.many("SELECT fact_key, status FROM household_memory_facts WHERE holding_id = ? AND source_tier = 'ida_wording' AND superseded_at IS NULL ORDER BY fact_key", [holdingId]);
  const summary = async () => {
    const holdings = await services.policyHoldings.list({ householdId: s.householdId, adultId: s.adultId });
    return (await services.holdings.summaries({ householdId: s.householdId, holdings })).get(holdingId);
  };
  const facts = async () => (await app.call(`/api/v1/holdings/${holdingId}/facts`, { token: s.token })).data;
  const fact = async key => (await facts()).facts.find(item => item.factKey === key);
  const fetchJobs = () => n(app, "SELECT count(*) AS n FROM job_queue WHERE kind = 'holding.fetch_reference' AND status IN ('queued', 'running')");
  return { app, s, services, fss, holdingId, run, drain, holdingRow, idaRows, summary, facts, fact, fetchJobs };
}

test('match attaches once and a rerun is a no-op (agree path: one reviewed_reference fact)', opts, async t => {
  const w = await world(t);
  const outcomes = await w.run();
  assert.ok(outcomes.length >= 4 && outcomes.every(outcome => outcome === 'succeeded'), JSON.stringify(outcomes));
  assert.equal((await w.holdingRow()).reference_outcome, 'attached');
  assert.deepEqual((await w.idaRows()).map(row => row.fact_key), ['copay_percent', 'waiting_initial', 'waiting_ped']);
  const copay = await w.fact('copay_percent');
  assert.equal(copay.status, 'reviewed_reference');
  assert.equal(copay.sourceTier, 'ida_wording');
  assert.equal(copay.openConflictId, null);
  // Only the source name, the cited page and the verification status come back from the sealed evidence.
  const fssSource = copay.sources.find(source => source.tier === 'ida_wording');
  assert.deepEqual(fssSource.reference, { source: 'fss', pageNumber: 12, verificationStatus: 'independently_verified' });
  assert.equal((await w.fact('waiting_initial')).status, 'reviewed_reference');
  assert.equal(await w.fact('room_rent_limit'), undefined, 'a family with no usable fact stays absent');

  const before = { memory: await w.app.database.many('SELECT id, status, superseded_at FROM household_memory_facts ORDER BY id'), calls: w.fss.calls.length };
  await w.services.holdings.fetchReference({ householdId: w.s.householdId, holdingId: w.holdingId });
  assert.ok((await w.drain()).every(outcome => outcome === 'succeeded'));
  assert.deepEqual(await w.app.database.many('SELECT id, status, superseded_at FROM household_memory_facts ORDER BY id'), before.memory, 'rerun wrote nothing');
  assert.equal(w.fss.calls.length, before.calls, 'a fresh cache means no second FSS call');
  assert.equal((await w.summary()).wordingState, 'fss');
});

test('the sealed evidence holds the FSS ids and pages, and the UIN is in no response, job payload or evidence', opts, async t => {
  const logs = [];
  const spied = ['log', 'info', 'warn', 'error', 'debug'].map(name => { const original = console[name]; console[name] = (...args) => { logs.push(args.map(String).join(' ')); }; return [name, original]; });
  t.after(() => { for (const [name, original] of spied) console[name] = original; });
  const w = await world(t);
  await w.run();
  const rows = await w.services.holdingPipelineRepository.currentMemory({ householdId: w.s.householdId, holdingId: w.holdingId });
  const ida = rows.filter(row => row.tier === 'ida_wording');
  assert.equal(ida.length, 3);
  for (const row of ida) {
    assert.equal(row.reference.source, 'fss');
    assert.match(row.reference.refId, /^fss:f_/);
    assert.equal(row.reference.versionId, 'ver_synth_1');
    assert.equal(row.reference.reviewerId, 'reviewer_synth_1');
    assert.deepEqual(row.reference.evidence[0], { documentId: 'doc_synth_1', pageNumber: row.reference.evidence[0].pageNumber, sha256: SHA_A });
    assert.equal(row.reference.quote, null);
  }
  const everything = JSON.stringify([
    await w.facts(), await w.summary(), ida.map(row => row.reference),
    (await w.app.call(`/api/v1/households/${w.s.householdId}/holdings`, { token: w.s.token })).data,
    await w.app.database.many('SELECT payload_json, dedupe_key, kind FROM job_queue'), await w.holdingRow(), logs,
  ]);
  assert.ok(!everything.includes(UIN), 'the UIN never leaves the server process');
  assert.ok(!everything.includes(FSS_STUB_ENV.REFERENCE_DATA_API_KEY), 'the FSS key never shows');
});

test('conflict path: the schedule and FSS disagree -> both conflicting, both readings kept, one open conflict', opts, async t => {
  const w = await world(t, { copay: '20%' });
  await w.run();
  const copay = await w.fact('copay_percent');
  assert.equal(copay.status, 'conflicting');
  assert.equal(copay.value, null);
  assert.deepEqual(copay.alternatives.map(item => item.bp).sort(), [1000, 2000]);
  assert.ok(copay.openConflictId);
  const rows = await w.app.database.many("SELECT source_tier, status FROM household_memory_facts WHERE holding_id = ? AND fact_key = 'copay_percent' AND superseded_at IS NULL ORDER BY source_tier", [w.holdingId]);
  assert.deepEqual(rows, [{ source_tier: 'ida_wording', status: 'conflicting' }, { source_tier: 'own_pdf', status: 'conflicting' }]);
  const conflicts = await w.app.database.many('SELECT reason, resolution FROM memory_conflicts WHERE holding_id = ?', [w.holdingId]);
  assert.deepEqual(conflicts, [{ reason: 'own_vs_insurer', resolution: 'pending' }]);
});

test('user_confirmed survives a refresh and a new collate', opts, async t => {
  const w = await world(t, { copay: '20%' });
  await w.run();
  const conflict = await w.app.database.one('SELECT * FROM memory_conflicts WHERE holding_id = ?', [w.holdingId]);
  const holding = await w.services.holdingPipelineRepository.getHolding({ householdId: w.s.householdId, holdingId: w.holdingId });
  await w.services.holdingPipelineRepository.resolveConflict({ holding, conflictId: conflict.id, chosenFactId: conflict.candidate_fact_ids[0], adultId: w.s.adultId });
  assert.equal((await w.fact('copay_percent')).status, 'user_confirmed');
  await w.app.database.run("UPDATE policy_holdings SET reference_checked_at = now() - interval '2 days' WHERE id = ?", [w.holdingId]);
  await w.services.holdings.fetchReference({ householdId: w.s.householdId, holdingId: w.holdingId });
  await w.drain();
  assert.equal((await w.fact('copay_percent')).status, 'user_confirmed');
});

test('no match: zero products -> missing / no_match, nothing attached', opts, async t => {
  const w = await world(t, { fss: fakeFss({ products: [] }) });
  assert.ok((await w.run()).every(outcome => outcome === 'succeeded'));
  assert.equal((await w.holdingRow()).reference_outcome, 'no_match');
  assert.equal((await w.idaRows()).length, 0);
  assert.deepEqual(await w.summary().then(({ wordingState, wordingReason }) => ({ wordingState, wordingReason })), { wordingState: 'missing', wordingReason: 'no_match' });
});

test('version unresolved and synthetic-only products map to their codes', opts, async t => {
  const ambiguous = [...fixtureJson('versions').data, { ...fixtureJson('versions').data[0], version_id: 'ver_synth_2' }];
  const w = await world(t, { fss: fakeFss({ versions: ambiguous }) });
  await w.run();
  assert.equal((await w.summary()).wordingReason, 'version_unresolved');
  const synthetic = await world(t, { fss: fakeFss({ products: [{ ...fixtureJson('product').data[0], uin_raw: UIN, verification_status: 'synthetic_test' }] }) });
  await synthetic.run();
  assert.equal((await synthetic.summary()).wordingReason, 'synthetic_only');
  assert.equal((await synthetic.idaRows()).length, 0);
});

test('403 and 5xx and 429 and a timeout: missing with a code, no retry, no crash', opts, async t => {
  for (const [fail, code] of [[403, 'unauthorized'], [401, 'unauthorized'], [500, 'unavailable'], [429, 'rate_limited'], ['timeout', 'unavailable']]) {
    const fss = fakeFss({ fail });
    const w = await world(t, { fss });
    const outcomes = await w.run();
    assert.ok(outcomes.every(outcome => outcome === 'succeeded'), `${fail}: ${JSON.stringify(outcomes)}`);
    assert.equal(fss.calls.length, 1, `${fail}: one call, no retry`);
    assert.equal((await w.holdingRow()).reference_outcome, code, String(fail));
    assert.equal((await w.idaRows()).length, 0);
    const view = await w.summary();
    assert.deepEqual([view.wordingState, view.wordingReason], ['missing', code]);
    assert.equal(await n(w.app, "SELECT count(*) AS n FROM job_queue WHERE kind = 'holding.fetch_reference' AND status IN ('queued', 'running', 'dead')"), 0, `${fail}: no retry job`);
    assert.ok(WORDING_REASONS.includes(code));
  }
});

test('withheld or empty facts (including a missing entitlement) -> no_usable_facts; a conflicted family stays absent', opts, async t => {
  const empty = await world(t, { fss: fakeFss({ pages: [fixtureJson('facts-withheld')] }) });
  await empty.run();
  assert.equal((await empty.holdingRow()).reference_outcome, 'no_usable_facts');
  assert.equal((await empty.summary()).wordingState, 'missing');

  const mixed = await world(t, { fss: fakeFss({ pages: [factsPage([
    factRow('f_room', 'room_rent_limit', { kind: 'room_rent_limit', limit_type: 'fixed_amount_per_day', amount: 5000 }),
    factRow('f_copay', 'copay', { kind: 'copay', percentage: 10 }),
  ], { room_rent_limit: 'conflicting_evidence', copay: 'verified', waiting_periods: 'not_observed', exclusions: 'not_observed' })] }) });
  await mixed.run();
  assert.deepEqual((await mixed.idaRows()).map(row => row.fact_key), ['copay_percent']);
  assert.equal(await mixed.fact('room_rent_limit'), undefined);
});

test('room rent from FSS maps to money and partial coverage still gives fss', opts, async t => {
  const w = await world(t, { fss: fakeFss({ pages: [factsPage([factRow('f_room', 'room_rent_limit', { kind: 'room_rent_limit', limit_type: 'fixed_amount_per_day', amount: 5000 })],
    { room_rent_limit: 'partial', copay: 'not_observed', waiting_periods: 'not_observed', exclusions: 'not_observed' })] }) });
  await w.run();
  assert.equal((await w.fact('room_rent_limit')).value.amountMinor, 500_000);
  assert.equal((await w.summary()).wordingState, 'fss');
});

test('partial coverage (waiting periods partial, copay verified) -> fss with no reason', opts, async t => {
  const w = await world(t);
  await w.run();
  const view = await w.summary();
  assert.deepEqual([view.wordingState, view.wordingReason], ['fss', null]);
});

test('wordingState: missing/not_checked before any check, manual once a wording is linked; closed vocabulary', opts, async t => {
  assert.deepEqual([...WORDING_STATES], ['fss', 'manual', 'missing']);
  const w = await world(t, { fss: fakeFss({ products: [] }) });
  assert.deepEqual(await w.summary().then(v => [v.wordingState, v.wordingReason]), ['missing', 'not_checked']);
  const wordingId = await uploadDocument(w.app, w.s, { kind: 'policy_wording' });
  const linked = await w.app.call(`/api/v1/holdings/${w.holdingId}/documents`, { method: 'POST', token: w.s.token, body: { documentId: wordingId, kind: 'wording' } });
  assert.equal(linked.status, 200, JSON.stringify(linked.data));
  assert.deepEqual(await w.summary().then(v => [v.wordingState, v.wordingReason]), ['manual', null]);
});

test('one refresh per day: reads never call FSS; stale checks queue one job; transient failures retry after an hour', opts, async t => {
  const w = await world(t);
  await w.run();
  const calls = w.fss.calls.length;
  await w.summary(); await w.summary();
  await w.app.call(`/api/v1/households/${w.s.householdId}/holdings`, { token: w.s.token });
  assert.equal(await w.fetchJobs(), 0, 'checked a moment ago: nothing queued');
  assert.equal(w.fss.calls.length, calls, 'reads never call FSS');

  await w.app.database.run("UPDATE policy_holdings SET reference_checked_at = now() - interval '25 hours' WHERE id = ?", [w.holdingId]);
  await w.summary(); await w.summary();
  assert.equal(await w.fetchJobs(), 1, 'older than 24 h: one job per holding and day');
  assert.equal(w.fss.calls.length, calls, 'queuing the job is not a call');
  const queued = await w.app.database.one("SELECT payload_json, dedupe_key FROM job_queue WHERE kind = 'holding.fetch_reference' AND status = 'queued'");
  assert.match(queued.dedupe_key, /^[0-9a-f]{64}$/);
  assert.ok(!queued.payload_json.includes(UIN));
  await w.drain();
  assert.equal(await w.fetchJobs(), 0);
  assert.ok((await w.holdingRow()).reference_checked_at, 'the check time moved');

  // Transient outcomes retry after one hour, others wait a day.
  for (const [outcome, ageMinutes, queuedExpected] of [['unavailable', 30, 0], ['unavailable', 90, 1], ['no_match', 90, 0], ['rate_limited', 61, 1]]) {
    await w.app.database.run('DELETE FROM job_queue WHERE kind = ?', ['holding.fetch_reference']);
    await w.app.database.run("UPDATE policy_holdings SET reference_outcome = ?, reference_checked_at = now() - (? * interval '1 minute') WHERE id = ?", [outcome, ageMinutes, w.holdingId]);
    await w.summary();
    assert.equal(await w.fetchJobs(), queuedExpected, `${outcome} ${ageMinutes} min`);
  }
});

test('an unconfirmed holding queues no refresh and attaches nothing', opts, async t => {
  const w = await world(t);
  await w.app.database.run("UPDATE policy_holdings SET status = 'insurer_pending', policy_profile_id = NULL WHERE id = ?", [w.holdingId]);
  await w.app.database.run("UPDATE policy_holdings SET reference_checked_at = NULL WHERE id = ?", [w.holdingId]);
  await w.summary();
  assert.equal(await w.fetchJobs(), 0);
  assert.equal(w.fss.calls.length, 0);
});

test('revocation erases the insurer-tier rows and a later refresh cannot bring them back', opts, async t => {
  const w = await world(t);
  await w.run();
  assert.equal((await w.idaRows()).length, 3);
  const grant = (await w.app.database.one('SELECT consent_grant_id FROM document_uploads WHERE id = ?', [w.s.documentId])).consent_grant_id;
  await w.services.consents.revoke({ grantId: grant, revokedByAdultId: w.s.adultId, reason: 'user_request' });
  assert.equal(await n(w.app, "SELECT count(*) AS n FROM household_memory_facts WHERE household_id = ? AND source_tier = 'ida_wording'", [w.s.householdId]), 0);
  assert.equal(await n(w.app, 'SELECT count(*) AS n FROM household_memory_facts WHERE household_id = ?', [w.s.householdId]), 0);
  await assert.rejects(w.services.holdings.fetchReference({ householdId: w.s.householdId, holdingId: w.holdingId }), error => ['HOLDING_NOT_FOUND', 'HOLDING_NOT_READY'].includes(error.code));
  assert.equal(await n(w.app, "SELECT count(*) AS n FROM household_memory_facts WHERE source_tier = 'ida_wording'"), 0);
});

test('holding deletion removes the insurer-tier rows with the holding', opts, async t => {
  const w = await world(t);
  await w.run();
  assert.equal((await w.idaRows()).length, 3);
  const deleted = await w.app.call(`/api/v1/documents/${w.s.documentId}`, { method: 'DELETE', token: w.s.token });
  assert.ok([200, 202].includes(deleted.status), JSON.stringify(deleted.data));
  assert.equal(await n(w.app, 'SELECT count(*) AS n FROM policy_holdings WHERE id = ?', [w.holdingId]), 0);
  assert.equal(await n(w.app, "SELECT count(*) AS n FROM household_memory_facts WHERE household_id = ? AND source_tier = 'ida_wording'", [w.s.householdId]), 0);
});

test('another household gets the same 404 and no insurer rows of ours', opts, async t => {
  const w = await world(t);
  await w.run();
  const other = await scenario(w.app, { name: 'Other' });
  const response = await w.app.call(`/api/v1/holdings/${w.holdingId}/facts`, { token: other.token });
  assert.equal(response.status, 404);
  assert.ok(!JSON.stringify(response.data).includes('fss'));
});

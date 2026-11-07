import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createDatabase } from '../src/backend/database/postgres/db.js';
import { createPostgresPool } from '../src/backend/database/postgres/pool.js';
import { RuntimeLimitsRepository } from '../src/backend/repositories/runtime-limits-repository.js';
import { createSharedProjectBudget, createRunBudget } from '../src/features/ai-analysis/live-coverage-runtime.js';
import { createPolicyEvidenceService } from '../src/backend/services/policy-evidence-service.js';
import { QUESTION_CONSENT_SCOPE } from '../src/contracts/policy-evidence.js';
import { readServerConfig } from '../src/server/config.js';
import { createApiServer } from '../src/server/server.js';

// B1 (ADR 0014 addendum): the request limit, the model spend cap and the evidence claim hold across two processes.
// A "process" here is a separate connection pool and a separate service/server instance sharing one database; nothing
// is shared in memory. Synthetic values only.
const pgOptions = postgresTestOptions();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));

async function secondProcess(t, handle) {
  const pool = createPostgresPool({ connectionString: handle.url, max: 4, applicationName: 'coversaath-test-second-process' });
  t.after(() => pool.end());
  return createDatabase(pool);
}

test('limits default to the database; memory is an explicit off switch', () => {
  const base = { KNOWVIA_BOOTSTRAP_TOKEN: 'coversaath-test-bootstrap-token-0015' };
  const config = readServerConfig(base);
  assert.deepEqual([config.rateLimitBackend, config.budgetBackend, config.evidenceClaimBackend], ['database', 'database', 'database']);
  const off = readServerConfig({ ...base, RATE_LIMIT_BACKEND: 'memory', MODEL_BUDGET_BACKEND: 'memory', EVIDENCE_CLAIM_BACKEND: 'memory' });
  assert.deepEqual([off.rateLimitBackend, off.budgetBackend, off.evidenceClaimBackend], ['memory', 'memory', 'memory']);
  assert.throws(() => readServerConfig({ ...base, EVIDENCE_CLAIM_BACKEND: 'redis' }), /EVIDENCE_CLAIM_BACKEND/);
});

test('two API processes with default settings share one request limit', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const db2 = await secondProcess(t, handle);
  const env = { KNOWVIA_BOOTSTRAP_TOKEN: 'coversaath-test-bootstrap-token-0015', API_RATE_LIMIT_PER_MINUTE: '3', APP_EVENTS_ENABLED: 'false', DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64') };
  const listen = async database => {
    const server = createApiServer({ database, env });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}/api/v1/ready`;
  };
  const [one, two] = [await listen(db), await listen(db2)];
  // Each process alone sees at most 2 requests, below its own limit of 3; together they exceed it.
  const statuses = [];
  for (const url of [one, two, one, two]) statuses.push((await fetch(url)).status);
  assert.deepEqual(statuses.filter(status => status === 429).length, 1, 'the fourth request is refused by the shared counter');
  assert.equal(statuses[3], 429);
});

test('the spend cap holds when two processes reserve at the same time', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const db2 = await secondProcess(t, handle);
  const ledgers = [new RuntimeLimitsRepository(db), new RuntimeLimitsRepository(db2)];
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => ledgers[index % 2].reserveBudget({ scope: 'project', amountUsd: 0.01, maxUsd: 0.055 })));
  assert.equal(results.filter(Boolean).length, 5, 'exactly five 1-cent reservations fit under 5.5 cents across both processes');
  // Through the run budget, as the live path uses it.
  const project = createSharedProjectBudget({ ledger: ledgers[1], scope: 'other' }).get(0.015);
  const run = createRunBudget(0.05, project);
  assert.ok(await run.reserve(0.01));
  assert.equal(await createRunBudget(0.05, createSharedProjectBudget({ ledger: ledgers[0], scope: 'other' }).get(0.015)).reserve(0.01), null, 'the other process sees the first process spend');
});

// Evidence claim: a small stub of the backend services (as in policy-evidence-document-versions.test.mjs).
const scope = id => ({ resource_type: QUESTION_CONSENT_SCOPE.resourceType, resource_id: id, action: QUESTION_CONSENT_SCOPE.action, data_category: QUESTION_CONSENT_SCOPE.dataCategory, recipient: QUESTION_CONSENT_SCOPE.recipient });
function evidenceProcess({ runtimeLimits, state, claimLeaseMs, env = {} }) {
  const saved = new Map();
  const answers = new Map();
  const services = {
    runtimeLimits,
    documents: {
      listForCase: () => [{ id: 'wording', householdId: 'h', caseId: 'c', logicalDocumentId: 'wording', version: 1, lifecycleState: 'active' }],
      latestActiveVersions: () => new Map([['wording', 1]]),
      getDocument: () => ({ id: 'wording', householdId: 'h', caseId: 'c', logicalDocumentId: 'wording', version: 1, lifecycleState: 'active' }),
    },
    consents: { requireActive: () => {}, get: () => ({ household_id: 'h', scopes: [scope('wording')] }) },
    ocr: { getDocumentBlockPages: () => ({ documentId: 'wording', sourceVersion: '1', complete: true, pages: [{ page: 1, status: 'stored', blocks: [{ tag: 'section-title', text: 'Room Rent' }, { tag: 'paragraph', text: 'Room rent is capped at 1% of sum insured per day.' }] }] }) },
    clauses: {
      findAnswerByKey: () => null,
      clauseDocumentIds: () => [...saved.keys()],
      saveClauses: ({ documentId, clauses }) => { saved.set(documentId, clauses); },
      listClauses: ({ documentIds }) => documentIds.flatMap(id => saved.get(id) ?? []),
      searchClauses: () => [],
      saveAnswer: async ({ idempotencyKey, answer, access, consentCheck }) => {
        await consentCheck();
        answers.set(idempotencyKey, answer);
        return { replayed: false, answerId: `answer-${answers.size}`, caseId: 'c', answer, access };
      },
    },
  };
  const createModelCall = () => async () => {
    state.calls += 1;
    await state.onCall?.();
    return { json: { findings: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  const service = createPolicyEvidenceService({ services, loadKnownIdentifiers: async () => [], createModelCall, env: { POLICY_EVIDENCE_ENABLED: 'true', ...env }, ...(claimLeaseMs ? { claimLeaseMs } : {}) });
  const ask = (key = 'idem-key-0001') => service.ask({ caseRecord: { id: 'c', household_id: 'h' }, subjectAdultId: 'a', question: 'What is the room rent limit?', consentGrantId: 'g', idempotencyKey: key });
  return { ask };
}
const claimRows = db => db.many('SELECT claim_hash, owner FROM evidence_claims');

test('the evidence claim is not double-granted across two processes and is released afterwards', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const db2 = await secondProcess(t, handle);
  const state = { calls: 0 };
  const a = evidenceProcess({ runtimeLimits: new RuntimeLimitsRepository(db), state });
  const b = evidenceProcess({ runtimeLimits: new RuntimeLimitsRepository(db2), state });
  const releases = [];
  state.onCall = () => new Promise(resolve => { releases.push(resolve); sleep(5_000).then(resolve); });
  const first = a.ask();
  while (!releases.length) await tick();
  assert.equal((await claimRows(db)).length, 1, 'the lease is a database row');
  assert.ok((await claimRows(db)).every(row => /^[0-9a-f]{64}$/.test(row.claim_hash) && !row.claim_hash.includes('idem')), 'only a digest is stored');
  await assert.rejects(b.ask(), { code: 'IDEMPOTENCY_IN_PROGRESS', statusCode: 409 });
  assert.equal(state.calls, 1, 'the other process did not start a second paid call');
  // A different key is a different question.
  const other = b.ask('idem-key-0002');
  while (releases.length < 2) await tick();
  releases.forEach(release => release());
  state.onCall = undefined;
  await Promise.all([first, other]);
  assert.deepEqual(await claimRows(db), [], 'finished questions leave no lease behind');
  await b.ask();
  assert.equal(state.calls, 3, 'once released, the key can be taken by the other process');
});

test('a failed question frees its lease for a retry on another process', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const db2 = await secondProcess(t, handle);
  const state = { calls: 0 };
  const a = evidenceProcess({ runtimeLimits: new RuntimeLimitsRepository(db), state });
  const b = evidenceProcess({ runtimeLimits: new RuntimeLimitsRepository(db2), state });
  state.onCall = () => { throw Object.assign(new Error('provider down'), { code: 'PROVIDER_FAILED' }); };
  await assert.rejects(a.ask());
  assert.deepEqual(await claimRows(db), []);
  state.onCall = undefined;
  await b.ask();
});

test('a lease that is renewed outlives its term; a crashed holder expires and can be replaced', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const db2 = await secondProcess(t, handle);
  const limits = [new RuntimeLimitsRepository(db), new RuntimeLimitsRepository(db2)];
  // Live holder: a 300 ms lease renewed about every 100 ms keeps the claim through a 900 ms question.
  const state = { calls: 0 };
  const a = evidenceProcess({ runtimeLimits: limits[0], state, claimLeaseMs: 300 });
  const b = evidenceProcess({ runtimeLimits: limits[1], state, claimLeaseMs: 300 });
  state.onCall = () => sleep(900);
  const running = a.ask();
  await sleep(700);
  await assert.rejects(b.ask(), { code: 'IDEMPOTENCY_IN_PROGRESS' }, 'renewal kept the lease past three lease terms');
  await running;
  state.onCall = undefined;

  // Crashed holder: it took the lease and never renews or releases it.
  const claimHash = 'c'.repeat(64);
  assert.equal(await limits[0].acquireClaim({ claimHash, owner: 'crashed-owner-token-0001', leaseMs: 250 }), true);
  assert.equal(await limits[1].acquireClaim({ claimHash, owner: 'second-owner-token-00002', leaseMs: 250 }), false, 'refused while the lease is live');
  await sleep(400);
  assert.equal(await limits[1].acquireClaim({ claimHash, owner: 'second-owner-token-00002', leaseMs: 5_000 }), true, 'taken over after expiry');
  // The crashed process waking up late cannot renew or release the new holder's lease.
  assert.equal(await limits[0].renewClaim({ claimHash, owner: 'crashed-owner-token-0001', leaseMs: 5_000 }), false);
  assert.equal(await limits[0].releaseClaim({ claimHash, owner: 'crashed-owner-token-0001' }), false);
  assert.equal((await claimRows(db)).length, 1);
  assert.equal(await limits[1].releaseClaim({ claimHash, owner: 'second-owner-token-00002' }), true);

  // Expired leases are purged; live ones are not.
  await limits[0].acquireClaim({ claimHash: 'd'.repeat(64), owner: 'purge-owner-token-000001', leaseMs: 100 });
  await limits[0].acquireClaim({ claimHash: 'e'.repeat(64), owner: 'purge-owner-token-000002', leaseMs: 60_000 });
  await sleep(250);
  assert.equal(await limits[0].purgeExpiredClaims(), 1);
  assert.deepEqual((await claimRows(db)).map(row => row.claim_hash), ['e'.repeat(64)]);
});

test('two processes racing for one lease: exactly one wins', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const db2 = await secondProcess(t, handle);
  const limits = [new RuntimeLimitsRepository(db), new RuntimeLimitsRepository(db2)];
  for (let round = 0; round < 10; round += 1) {
    const claimHash = round.toString(16).padStart(64, '0');
    const granted = await Promise.all(Array.from({ length: 8 }, (_, index) => limits[index % 2].acquireClaim({ claimHash, owner: `racer-token-${round}-${index}-padding`, leaseMs: 60_000 })));
    assert.equal(granted.filter(Boolean).length, 1, `round ${round}`);
  }
});

test('EVIDENCE_CLAIM_BACKEND=memory keeps the claim in process and writes no lease', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  const state = { calls: 0 };
  const a = evidenceProcess({ runtimeLimits: new RuntimeLimitsRepository(db), state, env: { EVIDENCE_CLAIM_BACKEND: 'memory' } });
  const releases = [];
  state.onCall = () => new Promise(resolve => { releases.push(resolve); sleep(2_000).then(resolve); });
  const first = a.ask();
  while (!releases.length) await tick();
  assert.deepEqual(await claimRows(db), []);
  await assert.rejects(a.ask(), { code: 'IDEMPOTENCY_IN_PROGRESS' });
  releases[0]();
  await first;
});

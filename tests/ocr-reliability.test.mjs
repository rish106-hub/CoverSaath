import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { createHoldingsService } from '../src/backend/services/holdings-service.js';
import { at, insert, seedWorld } from './support/postgres-fixtures.mjs';

// OCR completion reliability (audit F6, F9, F10). Synthetic data only. Needs PostgreSQL (TEST_DATABASE_URL).
const opts = postgresTestOptions();
const sha = character => character.repeat(64);
const jobFor = (documentId, id, grant, status = 'processing') => ({
  id, documentUploadId: documentId, provider: 'fixture', status, contractVersion: 'knowvia.ocr.v1',
  authorization: { authorized: true, consentGrantId: grant, purpose: 'document_processing' }, requestedAt: at, updatedAt: at,
});
const pagesFor = documentId => [{
  documentUploadId: documentId, pageNumber: 1, sourceVersion: 'v1', textSha256: sha('c'), text: 'Synthetic page text', extractionStatus: 'extracted',
  confidenceBasisPoints: 9000, createdAt: at, outputContractVersion: 'knowvia.ocr.v1', providerPageRef: 'ref:1', provenance: { fixture: true }, blocks: null,
}];
const done = { status: 'succeeded', resultDigest: sha('d'), completedAt: at, updatedAt: at };
async function addDocument(pool, w, id) {
  await insert(pool, 'document_uploads', { id, household_id: w.household, case_id: w.case, uploaded_by_adult_id: w.adult, consent_grant_id: w.consent, document_kind: 'policy_wording', content_sha256: createHash('sha256').update(id).digest('hex') });
}
const holdingCount = async db => Number((await db.one('SELECT count(*) AS c FROM policy_holdings')).c);

test('F6: a failed completion hook is logged, and a replay re-creates the holding exactly once', opts, async t => {
  const { handle, db } = await freshDatabase(t);
  const a = await seedWorld(handle.pool, 'a');
  await addDocument(handle.pool, a, 'doc-r');
  const services = createBackendServices(db, { env: { HOLDINGS_ENABLED: 'true' } });
  const original = services.policyHoldings.create.bind(services.policyHoldings);
  let failures = 1;
  services.policyHoldings.create = async input => {
    if (failures-- > 0) throw Object.assign(new Error('boom with Synthetic detail'), { code: 'HOLDING_BOOM' });
    return original(input);
  };
  const lines = [];
  t.mock.method(console, 'warn', line => lines.push(String(line)));
  await services.ocr.createOrGetJob(jobFor('doc-r', 'ocr-r', a.consent));
  assert.equal((await services.ocr.completeJob('ocr-r', pagesFor('doc-r'), done)).status, 'succeeded');
  assert.equal(await holdingCount(db), 0);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { event: 'ocr_after_complete_failed', code: 'HOLDING_BOOM', jobId: 'ocr-r' });
  assert.doesNotMatch(lines[0], /Synthetic|doc-r|household/);
  // Replay with the same digest: the hook runs again and creates the missing holding.
  assert.equal((await services.ocr.completeJob('ocr-r', pagesFor('doc-r'), done)).status, 'succeeded');
  assert.equal(await holdingCount(db), 1);
  assert.equal(Number((await db.one("SELECT count(*) AS c FROM job_queue WHERE kind = 'holding.detect_insurer'")).c), 1);
  // Duplicate replay: still one holding and one job.
  await services.ocr.completeJob('ocr-r', pagesFor('doc-r'), done);
  assert.equal(await holdingCount(db), 1);
  assert.equal(Number((await db.one("SELECT count(*) AS c FROM job_queue WHERE kind = 'holding.detect_insurer'")).c), 1);
});

test('F9: revoking cancels a failed-persistence job and a later completion stores nothing', opts, async t => {
  const { handle, db } = await freshDatabase(t);
  const a = await seedWorld(handle.pool, 'a');
  await addDocument(handle.pool, a, 'doc-f');
  const services = createBackendServices(db, { env: { HOLDINGS_ENABLED: 'true' } });
  await services.ocr.createOrGetJob(jobFor('doc-f', 'ocr-f', a.consent));
  await db.run("UPDATE ocr_jobs SET status = 'failed', error_code = 'OCR_PERSISTENCE_FAILED' WHERE id = 'ocr-f'");
  await services.consents.revoke({ grantId: a.consent, revokedByAdultId: a.adult });
  assert.equal((await db.one("SELECT status FROM ocr_jobs WHERE id = 'ocr-f'")).status, 'cancelled');
  await assert.rejects(services.ocr.completeJob('ocr-f', pagesFor('doc-f'), done));
  assert.equal(Number((await db.one('SELECT count(*) AS c FROM source_pages WHERE ocr_job_id = ?', ['ocr-f'])).c), 0);
  assert.equal(await holdingCount(db), 0);
});

test('F9: completeJob fails closed for a failed-persistence job whose grant is revoked', opts, async t => {
  const { handle, db } = await freshDatabase(t);
  const a = await seedWorld(handle.pool, 'a');
  await addDocument(handle.pool, a, 'doc-g');
  const services = createBackendServices(db, { env: { HOLDINGS_ENABLED: 'true' } });
  await services.ocr.createOrGetJob(jobFor('doc-g', 'ocr-g', a.consent));
  await db.run("UPDATE ocr_jobs SET status = 'failed', error_code = 'OCR_PERSISTENCE_FAILED' WHERE id = 'ocr-g'");
  await db.run('UPDATE consent_grants SET revoked_at = ? WHERE id = ?', [at, a.consent]);
  await assert.rejects(services.ocr.completeJob('ocr-g', pagesFor('doc-g'), done), error => error.code === 'CONSENT_REQUIRED');
  assert.equal(Number((await db.one('SELECT count(*) AS c FROM source_pages WHERE ocr_job_id = ?', ['ocr-g'])).c), 0);
  assert.equal(await holdingCount(db), 0);
});

test('F10: parse_completed.facts counts distinct unscoped fact keys, not memory rows', async () => {
  const tracked = [];
  const holding = { id: 'h1', householdId: 'hh1', documentId: 'd1', status: 'parsed', createdAt: new Date().toISOString() };
  const row = (factKey, tier, scopeKey = '') => ({ factKey, tier, scopeKey });
  const service = createHoldingsService({
    env: { HOLDINGS_ENABLED: 'true' },
    jobQueue: {},
    repository: {
      getHolding: async () => holding,
      openConflictCount: async () => 0,
      setStatus: async () => {},
      currentMemory: async () => [row('sum_insured', 'own_pdf'), row('sum_insured', 'ida_wording'), row('sum_insured', 'user_declaration'),
        row('premium_total', 'own_pdf'), row('premium_total', 'own_pdf', 'member-1'), row('not_a_registry_key', 'own_pdf')],
    },
    analytics: { track: async event => { tracked.push(event); } },
  });
  await service.memorise({ householdId: 'hh1', holdingId: 'h1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].properties.facts, 2);
});

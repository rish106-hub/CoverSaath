import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestOptions } from './support/pg.mjs';
import { startApp, scenario } from './support/read-back-harness.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { sharedColumnCrypto } from '../src/backend/security/column-crypto.js';
import { queryTerms, scoreClause, stem } from '../src/backend/repositories/clause-text-search.js';

const pgOptions = postgresTestOptions();

// Review fix (ADR 0013, D6): searching sealed clauses happens in the application, so it must be bounded in work and must not
// hold the event loop. Synthetic text only.

const VOCABULARY = ('hospital room rent ambulance maternity cataract waiting period exclusion sublimit copayment deductible '
  + 'preexisting disease surgery claim cashless network policy rider premium renewal sum insured limit charges expenses').split(' ');
const sentence = seed => Array.from({ length: 400 }, (_, i) => VOCABULARY[(seed * 7 + i * 13 + (i % 5)) % VOCABULARY.length] + (i % 3 === 0 ? 's' : '')).join(' ');

test('review: scoring a large synthetic corpus is linear and fast (stems are memoised, one pass per text)', () => {
  const terms = queryTerms('room rent ambulance charges');
  assert.equal(terms.length, 4);
  const texts = Array.from({ length: 2000 }, (_, i) => sentence(i).repeat(5)); // ~20 KB each, about 40 MB in total
  const started = Date.now();
  let matched = 0;
  for (const text of texts) if (scoreClause(terms, text, 'Room rent') > 0) matched += 1;
  const elapsed = Date.now() - started;
  assert.equal(matched, 2000);
  assert.ok(elapsed < 8000, `scoring 2000 clauses of 20 KB took ${elapsed} ms`);
  assert.equal(stem('charges'), stem('charge'), 'memoised stems stay correct');
  assert.equal(stem('charges'), stem('charges'));
});

test('review: a search over more clauses than the scan cap stops, flags truncated, stays inside a time bound and does not starve the event loop', pgOptions, async t => {
  const app = await startApp(t, { env: { DOCUMENT_READBACK_ENABLED: 'true' } });
  const s = await scenario(app, { read: true });
  const services = createBackendServices(app.database);
  const crypto = sharedColumnCrypto();
  const total = 2300;
  await app.database.transaction(async () => {
    for (let i = 0; i < total; i += 1) {
      const id = `perf-clause-${String(i).padStart(5, '0')}`;
      await app.database.run(`INSERT INTO policy_clauses (id, household_id, case_id, document_id, source_version, page, block_indexes_json, title, kind, text, digest, created_at)
        VALUES (?, ?, ?, ?, 'perf', ?, '[0]', ?, 'benefit', ?, ?, 't')`, [
        id, s.householdId, s.caseId, s.documentId, 1 + (i % 50), crypto.seal('policy_clauses', 'title', id, 'Benefits'),
        crypto.seal('policy_clauses', 'text', id, sentence(i).repeat(3)), 'd'.repeat(64)]);
    }
  });

  let worstGap = 0;
  let last = Date.now();
  const ticker = setInterval(() => { const now = Date.now(); worstGap = Math.max(worstGap, now - last); last = now; }, 20);
  const started = Date.now();
  const hits = await services.clauses.searchClauses({ householdId: s.householdId, caseId: s.caseId, documentIds: [s.documentId], query: 'ambulance charges', limit: 20 });
  const elapsed = Date.now() - started;
  clearInterval(ticker);

  assert.equal(hits.length, 20);
  assert.equal(hits.truncated, true, 'the scan cap was reached');
  assert.ok(elapsed < 10_000, `search took ${elapsed} ms`);
  assert.ok(worstGap < 1500, `the event loop was blocked for ${worstGap} ms at once`);
  // An ordinary-sized search is not flagged, and the flag does not change equality with a plain array.
  const small = await services.clauses.searchClauses({ householdId: s.householdId, caseId: s.caseId, documentIds: [s.documentId], query: 'zzzunmatchedword', limit: 5 });
  assert.deepEqual(small, []);
});

test('review: the passages response carries truncated only when the search was cut short', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: true });
  const res = await app.call(`/api/v1/cases/${s.caseId}/passages?q=${encodeURIComponent('room rent')}`, { token: s.token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.ok(!('truncated' in res.data));
});

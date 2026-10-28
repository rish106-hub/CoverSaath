// Catalogue reviewer grants and reviews on PostgreSQL (S3.2 WP2c): bounded independent grants, household confirmers,
// cross-household denial, idempotent reviews, read order, erasure, and concurrency under the household advisory lock.
// Repository level; the route-level journeys stay in catalogue-review-api.test.mjs (WP3). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { parameterAt, parameterIds, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { CatalogueReviewRepository } from '../src/backend/repositories/catalogue-review-repository.js';

const { householdId: H, caseId: CASE, documentId: DOC } = parameterIds;
const OWNER = 'adult-parameters';
const OUTSIDER = 'adult-outsider';
const MEMBER = 'adult-member';
const OTHER_H = 'household-other';
const OTHER_OWNER = 'adult-other-owner';
const OTHER_CASE = 'case-other-household';
const SECOND_CASE = 'case-parameters-second';
const factKey = name => createHash('sha256').update(name).digest('hex');

// The parameter world (household, owner, case, active document) plus an outsider, a second household adult, a second case
// of the same household, and another household with its own owner and case.
async function seed(db, at = parameterAt) {
  await seedParameterWorld(db, at);
  await db.transaction(async () => {
    for (const id of [OUTSIDER, MEMBER, OTHER_OWNER]) {
      await db.run("INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES (?, 'Synthetic adult', 'active', ?, ?)", [id, at, at]);
    }
    await db.run("INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at) VALUES ('role-member', ?, ?, 'member', 'active', ?)", [H, MEMBER, at]);
    await db.run("INSERT INTO service_cases (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at) VALUES (?, ?, 'member-parameters', ?, 'renewal', 'processing', ?, ?)", [SECOND_CASE, H, OWNER, at, at]);
    await db.run("INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, 'Other synthetic household', ?, ?)", [OTHER_H, at, at]);
    await db.run("INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at) VALUES ('role-other', ?, ?, 'owner', 'active', ?)", [OTHER_H, OTHER_OWNER, at]);
    await db.run("INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at) VALUES ('member-other', ?, ?, 'Adult', 'adult', ?, ?)", [OTHER_H, OTHER_OWNER, at, at]);
    await db.run("INSERT INTO service_cases (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at) VALUES (?, ?, 'member-other', ?, 'renewal', 'processing', ?, ?)", [OTHER_CASE, OTHER_H, OTHER_OWNER, at, at]);
  });
}

async function world(t) {
  const { db } = await freshDatabase(t);
  await seed(db);
  let now = new Date(parameterAt);
  const repo = new CatalogueReviewRepository(db, { clock: () => now });
  const soon = (ms = 3_600_000) => new Date(now.getTime() + ms).toISOString();
  const review = (over = {}) => ({
    householdId: H, caseId: CASE, reviewerAdultId: OUTSIDER, idempotencyKey: 'review-key-0001', decision: 'accepted', reasonCode: 'matches_clause',
    documentId: DOC, sourceVersion: 'version-1', clauseIds: ['clause-1'], sourceDigests: ['d'.repeat(64)], factKey: factKey('fact-1'), fact: { value: 'synthetic' }, ...over,
  });
  return { db, repo, soon, review, setNow: value => { now = new Date(value); }, tick: ms => { now = new Date(now.getTime() + ms); } };
}
const failure = async promise => { try { await promise; } catch (error) { return error; } return assert.fail('expected an error'); };

async function assertLinearChain(db, householdId) {
  const events = await db.many('SELECT previous_event_hash, event_hash FROM audit_events WHERE household_id = ? ORDER BY id', [householdId]);
  for (let i = 1; i < events.length; i += 1) assert.equal(events[i].previous_event_hash, events[i - 1].event_hash, `event ${i} links to its predecessor`);
  assert.equal(new Set(events.map(event => event.previous_event_hash)).size, events.length, 'the chain never forks');
}

test('confirmer grants: only the owner designates, only an adult of that household, never across households', postgresTestOptions(), async t => {
  const w = await world(t);
  assert.equal((await failure(w.repo.grantHouseholdConfirmer({ householdId: H, adultUserId: MEMBER, grantedByAdultId: MEMBER }))).code, 'REVIEWER_NOT_AUTHORISED', 'a non-owner');
  assert.equal((await failure(w.repo.grantHouseholdConfirmer({ householdId: H, adultUserId: OTHER_OWNER, grantedByAdultId: OWNER }))).code, 'CATALOGUE_REVIEW_INVALID', 'an adult outside the household');
  assert.equal((await failure(w.repo.grantHouseholdConfirmer({ householdId: H, adultUserId: OTHER_OWNER, grantedByAdultId: OTHER_OWNER }))).code, 'REVIEWER_NOT_AUTHORISED', 'the owner of another household');
  const grant = await w.repo.grantHouseholdConfirmer({ householdId: H, adultUserId: MEMBER, grantedByAdultId: OWNER });
  assert.equal(grant.kind, 'household_confirmer');
  assert.equal((await w.repo.grantHouseholdConfirmer({ householdId: H, adultUserId: MEMBER, grantedByAdultId: OWNER })).id, grant.id, 'a live confirmer grant is returned, not duplicated');
  assert.equal((await w.db.one("SELECT count(*) AS n FROM audit_events WHERE action = 'catalogue_reviewer.granted'")).n, 1);
  assert.equal(await w.repo.activeGrant(OTHER_H, MEMBER), null, 'a grant answers for its own household only');
});

test('independent grants are bounded: one case of the household, a future expiry within 30 days, never a household member or the operator', postgresTestOptions(), async t => {
  const w = await world(t);
  const grantFor = (over = {}) => w.repo.grantIndependentReviewer({ householdId: H, adultUserId: OUTSIDER, operatorId: 'test-operator', caseId: CASE, expiresAt: w.soon(), ...over });
  await assert.rejects(grantFor({ caseId: undefined }), /caseId/);
  await assert.rejects(grantFor({ caseId: OTHER_CASE }), /not a case of this household/);
  await assert.rejects(grantFor({ expiresAt: w.soon(-1000) }), /future UTC instant/);
  await assert.rejects(grantFor({ expiresAt: w.soon(31 * 86_400_000) }), /within 30 days/);
  await assert.rejects(grantFor({ expiresAt: 'tomorrow' }), /future UTC instant/);
  await assert.rejects(grantFor({ operatorId: OUTSIDER }), /cannot grant themselves/);
  await assert.rejects(grantFor({ adultUserId: MEMBER }), /independent reviewer/);
  await assert.rejects(grantFor({ adultUserId: OWNER }), /independent reviewer/);
  assert.equal((await w.db.one('SELECT count(*) AS n FROM catalogue_reviewer_grants')).n, 0, 'no refused grant was written');
  const grant = await grantFor();
  assert.equal(grant.case_id, CASE);
  assert.equal((await w.repo.activeGrant(H, OUTSIDER, CASE)).id, grant.id);
  assert.equal(await w.repo.activeGrant(H, OUTSIDER), null, 'an independent grant answers only for its case');
  assert.equal(await w.repo.activeGrant(H, OUTSIDER, SECOND_CASE), null, 'another case of the same household is out of scope');
  assert.equal(await w.repo.activeGrant(OTHER_H, OUTSIDER, OTHER_CASE), null, 'another household is out of scope');
  // The database refuses an unbounded independent grant too.
  await assert.rejects(w.db.run("UPDATE catalogue_reviewer_grants SET expires_at = NULL WHERE id = ?", [grant.id]), /needs an expiry and a case/);
  await assert.rejects(w.db.run("INSERT INTO catalogue_reviewer_grants (id, household_id, adult_user_id, kind, status, granted_by, created_at) VALUES ('x', ?, ?, 'independent_reviewer', 'active', 'operator:t', 'now')", [H, OUTSIDER]), /needs an expiry and a case/);
});

test('an expired or revoked independent grant records nothing and supports nothing; revocation is household-scoped', postgresTestOptions(), async t => {
  const w = await world(t);
  const grant = await w.repo.grantIndependentReviewer({ householdId: H, adultUserId: OUTSIDER, operatorId: 'test-operator', caseId: CASE, expiresAt: w.soon() });
  const first = await w.repo.record(w.review());
  assert.equal(first.replayed, false);
  assert.equal(first.authority, 'independent');
  assert.equal((await w.repo.list({ householdId: H, caseId: CASE }))[0].reviewerActive, true);
  w.tick(2 * 3_600_000);
  assert.equal(await w.repo.activeGrant(H, OUTSIDER, CASE), null, 'expired');
  assert.equal((await failure(w.repo.record(w.review({ idempotencyKey: 'review-key-0002' })))).code, 'REVIEWER_NOT_AUTHORISED', 'an expired reviewer cannot write');
  assert.equal((await failure(w.repo.record(w.review()))).code, 'REVIEWER_NOT_AUTHORISED', 'nor replay a previously authorised request');
  assert.equal((await w.repo.list({ householdId: H, caseId: CASE }))[0].reviewerActive, false, 'an expired reviewer supports nothing');
  w.tick(-2 * 3_600_000);
  assert.equal(await w.repo.revokeGrant({ householdId: OTHER_H, grantId: grant.id }), false, 'another household cannot revoke this grant');
  assert.equal(await w.repo.revokeGrant({ householdId: H, grantId: grant.id }), true);
  assert.equal(await w.repo.revokeGrant({ householdId: H, grantId: grant.id }), false, 'a second revocation changes nothing');
  assert.equal((await failure(w.repo.record(w.review({ idempotencyKey: 'review-key-0003' })))).code, 'REVIEWER_NOT_AUTHORISED');
  const [listed] = await w.repo.list({ householdId: H, caseId: CASE });
  assert.equal(listed.reviewerActive, false);
  assert.equal(listed.superseded, false);
  // A regrant opens a new window: the earlier review does not come back to life.
  w.tick(1000);
  await w.repo.grantIndependentReviewer({ householdId: H, adultUserId: OUTSIDER, operatorId: 'test-operator', caseId: CASE, expiresAt: w.soon() });
  assert.equal((await w.repo.list({ householdId: H, caseId: CASE }))[0].reviewerActive, false);
  assert.deepEqual((await w.db.many("SELECT action FROM audit_events WHERE action LIKE 'catalogue_reviewer.%' ORDER BY id")).map(row => row.action),
    ['catalogue_reviewer.granted', 'catalogue_reviewer.revoked', 'catalogue_reviewer.regranted']);
});

test('reviews: no grant or a grant in another household is refused; replays are idempotent; a reused key conflicts', postgresTestOptions(), async t => {
  const w = await world(t);
  assert.equal((await failure(w.repo.record(w.review()))).code, 'REVIEWER_NOT_AUTHORISED', 'no grant');
  await w.repo.grantHouseholdConfirmer({ householdId: OTHER_H, adultUserId: OTHER_OWNER, grantedByAdultId: OTHER_OWNER });
  assert.equal((await failure(w.repo.record(w.review({ reviewerAdultId: OTHER_OWNER })))).code, 'REVIEWER_NOT_AUTHORISED', 'a confirmer of another household');
  await w.repo.grantHouseholdConfirmer({ householdId: H, adultUserId: OWNER, grantedByAdultId: OWNER });
  const first = await w.repo.record(w.review({ reviewerAdultId: OWNER }));
  assert.equal(first.authority, 'household');
  const replay = await w.repo.record(w.review({ reviewerAdultId: OWNER }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.reviewId, first.reviewId);
  assert.equal((await failure(w.repo.record(w.review({ reviewerAdultId: OWNER, decision: 'rejected', reasonCode: 'does_not_match_clause' })))).code, 'IDEMPOTENCY_CONFLICT');
  await w.repo.grantHouseholdConfirmer({ householdId: H, adultUserId: MEMBER, grantedByAdultId: OWNER });
  assert.equal((await failure(w.repo.record(w.review({ reviewerAdultId: MEMBER })))).code, 'IDEMPOTENCY_CONFLICT', 'another reviewer cannot take over a key');
  for (const bad of [{ decision: 'proven' }, { reasonCode: 'because' }, { idempotencyKey: 'short' }]) {
    assert.equal((await failure(w.repo.record(w.review({ reviewerAdultId: OWNER, idempotencyKey: 'review-key-bad1', ...bad })))).code, 'CATALOGUE_REVIEW_INVALID');
  }
  // A malformed fact key is stopped by the table's CHECK constraint and rolls the whole write back, audit included.
  assert.equal((await failure(w.repo.record(w.review({ reviewerAdultId: OWNER, idempotencyKey: 'review-key-bad2', factKey: 'x' })))).code, '23514');
  assert.equal((await w.db.one('SELECT count(*) AS n FROM catalogue_reviews')).n, 1);
  const audit = await w.db.many("SELECT event_payload_json FROM audit_events WHERE action = 'catalogue_review.recorded'");
  assert.equal(audit.length, 1);
  assert.ok(!audit[0].event_payload_json.includes('synthetic'), 'audit holds no fact content');
  await assert.rejects(w.db.run("UPDATE catalogue_reviews SET decision = 'rejected'"), /immutable/);
});

test('read order: with equal timestamps the later review wins, and a household confirmation never supersedes an independent review', postgresTestOptions(), async t => {
  const w = await world(t);
  // The clock is fixed: every row below has the same created_at, so only insertion order can break the tie.
  await w.repo.grantHouseholdConfirmer({ householdId: H, adultUserId: OWNER, grantedByAdultId: OWNER });
  await w.repo.grantIndependentReviewer({ householdId: H, adultUserId: OUTSIDER, operatorId: 'test-operator', caseId: CASE, expiresAt: w.soon() });
  const ids = [];
  for (const [i, decision] of ['accepted', 'rejected', 'disputed', 'accepted', 'rejected'].entries()) {
    const reasonCode = decision === 'accepted' ? 'matches_clause' : 'clause_ambiguous';
    ids.push((await w.repo.record(w.review({ reviewerAdultId: OWNER, idempotencyKey: `household-key-${i}`, decision, reasonCode }))).reviewId);
  }
  let listed = await w.repo.list({ householdId: H, caseId: CASE });
  assert.deepEqual(listed.map(row => row.reviewId), ids, 'insertion order, not id order');
  assert.deepEqual(listed.map(row => row.superseded), [true, true, true, true, false], 'the last household review is current');
  const independent = await w.repo.record(w.review({ idempotencyKey: 'independent-key-1' }));
  await w.repo.record(w.review({ reviewerAdultId: OWNER, idempotencyKey: 'household-key-late', decision: 'rejected', reasonCode: 'does_not_match_clause' }));
  listed = await w.repo.list({ householdId: H, caseId: CASE });
  assert.equal(listed.find(row => !row.superseded).reviewId, independent.reviewId, 'the independent review stays current');
  assert.deepEqual(await w.repo.list({ householdId: OTHER_H, caseId: CASE }), [], 'another household reads nothing');
});

test('erasure: a document leaving the active state deletes the reviews that cite it', postgresTestOptions(), async t => {
  const w = await world(t);
  await w.repo.grantHouseholdConfirmer({ householdId: H, adultUserId: OWNER, grantedByAdultId: OWNER });
  await w.repo.record(w.review({ reviewerAdultId: OWNER }));
  assert.equal((await w.db.one('SELECT count(*) AS n FROM catalogue_reviews')).n, 1);
  await w.db.run("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = ?", [DOC]);
  assert.equal((await w.db.one('SELECT count(*) AS n FROM catalogue_reviews')).n, 0);
  assert.deepEqual(await w.repo.list({ householdId: H, caseId: CASE }), []);
});

test('concurrency: ten concurrent reviews with one idempotency key store one review and the household chain stays linear', postgresTestOptions(), async t => {
  const w = await world(t);
  await w.repo.grantIndependentReviewer({ householdId: H, adultUserId: OUTSIDER, operatorId: 'test-operator', caseId: CASE, expiresAt: w.soon() });
  const results = await Promise.all(Array.from({ length: 10 }, () => w.repo.record(w.review())));
  assert.equal(new Set(results.map(result => result.reviewId)).size, 1);
  assert.equal(results.filter(result => !result.replayed).length, 1);
  assert.equal((await w.db.one('SELECT count(*) AS n FROM catalogue_reviews')).n, 1);
  assert.equal((await w.db.one("SELECT count(*) AS n FROM audit_events WHERE action = 'catalogue_review.recorded'")).n, 1);
  // Distinct keys concurrently: all stored, the chain still linear.
  await Promise.all(Array.from({ length: 10 }, (_, i) => w.repo.record(w.review({ idempotencyKey: `parallel-key-${i}` }))));
  assert.equal((await w.db.one('SELECT count(*) AS n FROM catalogue_reviews')).n, 11);
  await assertLinearChain(w.db, H);
});

test('concurrency: a revocation racing a review lands wholly before it (refused) or wholly after it (recorded, then inactive)', postgresTestOptions(), async t => {
  for (let round = 0; round < 4; round += 1) {
    const w = await world(t);
    const grant = await w.repo.grantIndependentReviewer({ householdId: H, adultUserId: OUTSIDER, operatorId: 'test-operator', caseId: CASE, expiresAt: w.soon() });
    const [recorded, revoked] = await Promise.allSettled([w.repo.record(w.review()), w.repo.revokeGrant({ householdId: H, grantId: grant.id })]);
    assert.equal(revoked.status, 'fulfilled');
    assert.equal(revoked.value, true);
    const reviews = await w.repo.list({ householdId: H, caseId: CASE });
    if (recorded.status === 'fulfilled') {
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0].reviewerActive, false, 'recorded before revocation, counts for nothing after it');
      const order = (await w.db.many("SELECT action FROM audit_events WHERE action IN ('catalogue_review.recorded', 'catalogue_reviewer.revoked') ORDER BY id")).map(row => row.action);
      assert.deepEqual(order, ['catalogue_review.recorded', 'catalogue_reviewer.revoked']);
    } else {
      assert.equal(recorded.reason.code, 'REVIEWER_NOT_AUTHORISED');
      assert.equal(reviews.length, 0);
    }
    await assertLinearChain(w.db, H);
  }
});

test('concurrency: concurrent regrants of one reviewer leave one grant row and a linear chain', postgresTestOptions(), async t => {
  const w = await world(t);
  const grants = await Promise.all(Array.from({ length: 6 }, () => w.repo.grantIndependentReviewer({ householdId: H, adultUserId: OUTSIDER, operatorId: 'test-operator', caseId: CASE, expiresAt: w.soon() })));
  assert.equal(new Set(grants.map(grant => grant.id)).size, 1);
  assert.equal((await w.db.one('SELECT count(*) AS n FROM catalogue_reviewer_grants')).n, 1);
  assert.equal((await w.db.one("SELECT count(*) AS n FROM audit_events WHERE action = 'catalogue_reviewer.granted'")).n, 1);
  await assertLinearChain(w.db, H);
});

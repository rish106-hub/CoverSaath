import { randomUUID } from 'node:crypto';
import { AuditRepository } from './audit-repository.js';
import {
  curatedFreshness, validateCuratedFacts, validateCuratedProduct, validateSourceIdentity, verifySourceEvidence, normalisePageTexts, sha256Hex, MAX_SOURCE_BYTES,
} from '../../features/decision-catalogue/index.js';

// Trusted insurer-source workflow (SQLite 018, PostgreSQL 014). Public insurer wording only: no household data.
//
//   collected  -> candidate -> checked -> published
//   (register)   (propose)    (check)    (publish)       plus rejected, needs_revalidation, superseded
//
// A product reaches `verified` only by being PUBLISHED here: an authenticated adult holding an active, unexpired checker
// grant, who is not the person who collected it, compared the digest of their own copy with the archived bytes, accepted
// the quotes, and had every machine check pass again against the archive. Verification never comes from a record's own
// fields. Rows and archived bytes are never deleted; a changed source creates a new submission and withdraws the old one
// from use until the new one is checked. There is deliberately no network code here: bytes are supplied by a person.
// Audit payloads hold ids, digests and the public UIN, never page text.

export const SOURCE_ROLES = Object.freeze(['curator', 'checker']);
export const CHECK_REASON_CODES = Object.freeze(['quote_matches_source', 'quote_does_not_match_source', 'wrong_product_or_version', 'source_unreadable', 'other']);
export const MAX_SOURCE_GRANT_DAYS = 90;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function coded(code, message, statusCode, details) { return Object.assign(new Error(message), { code, statusCode, ...(details ? { details } : {}) }); }
const invalid = (message, details) => coded('CURATED_PRODUCT_INVALID', message, 400, details);
const forbidden = () => coded('SOURCE_ROLE_NOT_AUTHORISED', 'The caller does not hold an active role for this action.', 403);
const notFound = () => coded('CURATED_PRODUCT_NOT_FOUND', 'The curated product submission was not found.', 404);
const rejectedEvidence = blocking => coded('SOURCE_EVIDENCE_REJECTED', 'The source evidence failed a check.', 422, blocking);
const str = (value, name, max = 256) => {
  if (typeof value !== 'string' || !value || value.length > max) throw invalid(`${name} is invalid.`);
  return value;
};

export class CuratedProductRepository {
  constructor(database, { clock = () => new Date(), audit = null, env = {} } = {}) {
    if (!database?.prepare) throw new TypeError('A database is required.');
    this.database = database;
    this.clock = clock;
    this.audit = audit ?? new AuditRepository(database, { clock });
    // Insurer/regulator host allowlist (CURATED_SOURCE_HOSTS, comma separated, exact DNS names). Fails closed: unset or empty
    // refuses every source. An allowlist is a control on where a source may be named, not proof it is official or reusable.
    const hosts = String(env.CURATED_SOURCE_HOSTS ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
    for (const host of hosts) {
      if (!HOSTNAME.test(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local') || /^[\d.]+$/.test(host)) {
        throw new TypeError(`CURATED_SOURCE_HOSTS entry "${host}" must be a public DNS name, not an address or local name.`);
      }
    }
    this.allowedHosts = new Set(hosts);
  }

  #atomic(work) {
    const savepoint = `curated_product_${randomUUID().replaceAll('-', '')}`;
    let nested;
    if (typeof this.database.isTransaction === 'boolean') {
      nested = this.database.isTransaction;
      if (!nested) this.database.exec('BEGIN IMMEDIATE');
    } else {
      try { this.database.exec('BEGIN IMMEDIATE'); nested = false; } catch (error) {
        if (!/within a transaction/i.test(String(error?.message))) throw error;
        nested = true;
      }
    }
    if (nested) this.database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = work();
      this.database.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.database.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
      if (nested) this.database.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  }

  #now() { return this.clock().toISOString(); }
  #today() { return this.#now().slice(0, 10); }
  #event(adultId, action, resourceId, payload = {}) {
    this.audit.append({ actorType: 'human_reviewer', actorId: adultId, action, resourceType: 'curated_product_submission', resourceId, payload });
  }

  // ---- Roles: operator tooling only, no route, always temporary ----------------------------------------------------------

  grantRole({ adultUserId, role, operatorId, expiresAt }) {
    str(adultUserId, 'adultUserId'); str(operatorId, 'operatorId', 128);
    if (!SOURCE_ROLES.includes(role)) throw invalid('role is not supported.');
    if (operatorId === adultUserId) throw invalid('An operator cannot grant themselves.');
    const now = this.clock().getTime();
    if (typeof expiresAt !== 'string' || !ISO_INSTANT.test(expiresAt) || !(Date.parse(expiresAt) > now)
      || Date.parse(expiresAt) > now + MAX_SOURCE_GRANT_DAYS * 86_400_000) throw invalid(`expiresAt must be a future UTC instant within ${MAX_SOURCE_GRANT_DAYS} days.`);
    return this.#atomic(() => {
      const existing = this.database.prepare('SELECT * FROM source_curator_grants WHERE adult_user_id = ? AND role = ?').get(adultUserId, role);
      const grantedBy = `operator:${operatorId}`.slice(0, 128);
      let id = existing?.id;
      if (existing) {
        this.database.prepare("UPDATE source_curator_grants SET status = 'active', revoked_at = NULL, granted_by = ?, expires_at = ? WHERE id = ?").run(grantedBy, expiresAt, id);
      } else {
        id = `scg-${randomUUID()}`;
        this.database.prepare("INSERT INTO source_curator_grants (id, adult_user_id, role, status, granted_by, created_at, expires_at) VALUES (?, ?, ?, 'active', ?, ?, ?)")
          .run(id, adultUserId, role, grantedBy, this.#now(), expiresAt);
      }
      this.audit.append({ actorType: 'system', actorId: grantedBy, action: existing ? 'curated_source_role.regranted' : 'curated_source_role.granted', resourceType: 'source_curator_grant', resourceId: id, payload: { role, expiresAt } });
      return this.database.prepare('SELECT * FROM source_curator_grants WHERE id = ?').get(id);
    });
  }

  revokeRole({ grantId, revokedBy = 'operator' }) {
    const done = this.database.prepare("UPDATE source_curator_grants SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'").run(this.#now(), str(grantId, 'grantId'));
    if (Number(done.changes) > 0) this.audit.append({ actorType: 'system', actorId: String(revokedBy).slice(0, 128), action: 'curated_source_role.revoked', resourceType: 'source_curator_grant', resourceId: grantId });
    return Number(done.changes) > 0;
  }

  /** Re-read on every call: revocation and expiry take effect on the next request, whatever session the caller holds. */
  activeRole(adultId, role) {
    if (typeof adultId !== 'string' || !adultId) return null;
    const row = this.database.prepare("SELECT * FROM source_curator_grants WHERE adult_user_id = ? AND role = ? AND status = 'active'").get(adultId, role);
    return row && Date.parse(row.expires_at) > this.clock().getTime() ? row : null;
  }

  #require(adultId, role) { const grant = this.activeRole(adultId, role); if (!grant) throw forbidden(); return grant; }

  // ---- Reads -------------------------------------------------------------------------------------------------------------

  #row(id) { return this.database.prepare('SELECT * FROM curated_product_submissions WHERE id = ?').get(str(id, 'submissionId')); }
  #dto(row) {
    return {
      submissionId: row.id, uin: row.uin, insurer: row.insurer, productName: row.product_name, wordingVersion: row.wording_version,
      sourceUrl: row.source_url, sourceVersionId: row.source_version_id, contentSha256: row.content_sha256, retrievedOn: row.retrieved_on,
      effectiveFrom: row.effective_from, state: row.state, facts: JSON.parse(row.facts_json), machineChecks: JSON.parse(row.machine_checks_json),
      pageTexts: row.page_texts_json ? JSON.parse(row.page_texts_json) : null,
      collectedBy: row.collected_by, checkedBy: row.checked_by, checkedAt: row.checked_at, publishedAt: row.published_at,
      factsSha256: sha256Hex(row.facts_json), previousId: row.previous_id, lastRevalidatedAt: row.last_revalidated_at, createdAt: row.created_at,
    };
  }

  /** Only a curator or a checker with a live role may read a submission. Never returns the archived bytes. */
  get({ adultId, submissionId }) {
    if (!this.activeRole(adultId, 'curator') && !this.activeRole(adultId, 'checker')) throw forbidden();
    const row = this.#row(submissionId);
    if (!row) throw notFound();
    // The digest is withheld on purpose: a checker must compute it from their own copy, not read it back from here.
    const { contentSha256: _withheld, ...view } = this.#dto(row);
    return view;
  }

  #archive(sha) { return this.database.prepare('SELECT content FROM curated_source_archives WHERE sha256 = ?').get(sha)?.content ?? null; }

  /** Evidence re-run against the ARCHIVED bytes, so a swapped or damaged archive cannot ride on an earlier pass. */
  #verifyArchive(row) {
    const bytes = this.#archive(row.content_sha256);
    const record = { uin: row.uin, wordingVersion: row.wording_version, contentSha256: row.content_sha256 };
    const facts = JSON.parse(row.facts_json);
    const evidence = verifySourceEvidence({ record, bytes: bytes ? new Uint8Array(bytes) : null, pageTexts: row.page_texts_json ? JSON.parse(row.page_texts_json) : null, facts });
    if (evidence.blocking.length) throw rejectedEvidence(evidence.blocking);
    const today = this.#today();
    if (curatedFreshness({ retrievedOn: row.retrieved_on, effectiveFrom: row.effective_from }, today) !== 'current') throw coded('SOURCE_NOT_CURRENT', 'The source is stale or not yet effective; revalidate it.', 409);
    return evidence;
  }

  // ---- Workflow ----------------------------------------------------------------------------------------------------------

  #insert({ id = `cps-${randomUUID()}`, curatorId, identity, bytes, pageTexts, previousId = null, sha, evidence }) {
    const at = this.#now();
    this.database.prepare('INSERT OR IGNORE INTO curated_source_archives (sha256, byte_size, content, created_at) VALUES (?, ?, ?, ?)').run(sha, bytes.length, bytes, at);
    this.database.prepare(`INSERT INTO curated_product_submissions
      (id, uin, insurer, product_name, wording_version, source_url, source_version_id, content_sha256, retrieved_on, effective_from, page_texts_json,
       facts_json, machine_checks_json, state, collected_by, previous_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'collected', ?, ?, ?)`)
      .run(id, identity.uin, identity.insurer, identity.productName, identity.wordingVersion, identity.sourceUrl, identity.sourceVersionId, sha, identity.retrievedOn,
        identity.effectiveFrom ?? null, pageTexts ? JSON.stringify(pageTexts) : null,
        JSON.stringify({ bytes: 'digest_computed', humanReview: evidence.humanReview }), curatorId, previousId, at);
    this.#event(curatorId, 'curated_source.registered', id, { uin: identity.uin, sha256: sha, previousId });
    return id;
  }

  /**
   * Collection. The digest is computed from the bytes the curator supplied; a digest the curator claims must match it.
   * Several printed UINs, a UIN or version that is not in the supplied text, and a different document for a wording that is
   * already registered all fail closed.
   */
  register({ curatorId, uin, insurer, productName, wordingVersion, sourceUrl, sourceVersionId, retrievedOn, effectiveFrom = null, claimedSha256 = null, bytes, pageTexts = null }) {
    this.#require(curatorId, 'curator');
    const identity = { uin, insurer, productName, wordingVersion, sourceUrl, sourceVersionId: str(sourceVersionId, 'sourceVersionId', 200), retrievedOn, effectiveFrom };
    const problems = validateSourceIdentity(identity, { today: this.#today() });
    if (problems.length) throw invalid('The source identity is invalid.', problems);
    if (!this.allowedHosts.size) throw coded('SOURCE_HOSTS_NOT_CONFIGURED', 'No source hosts are allowed: set CURATED_SOURCE_HOSTS.', 409);
    if (new URL(sourceUrl).port || !this.allowedHosts.has(new URL(sourceUrl).hostname.toLowerCase())) throw invalid('sourceUrl is not on the insurer host allowlist.');
    if (curatedFreshness(identity, this.#today()) !== 'current') throw coded('SOURCE_NOT_CURRENT', 'The source is stale or not yet effective.', 409);
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES) throw invalid('bytes are invalid.');
    if (normalisePageTexts(pageTexts) === undefined) throw invalid('pageTexts are invalid.');
    if (claimedSha256 != null && (typeof claimedSha256 !== 'string' || !SHA256.test(claimedSha256))) throw invalid('claimedSha256 is malformed.');
    const sha = sha256Hex(bytes);
    const evidence = verifySourceEvidence({ record: { uin, wordingVersion, contentSha256: claimedSha256 ?? sha }, bytes, pageTexts });
    if (evidence.blocking.length) throw rejectedEvidence(evidence.blocking);
    return this.#atomic(() => {
      this.#require(curatorId, 'curator');
      const open = this.database.prepare("SELECT * FROM curated_product_submissions WHERE uin = ? AND wording_version = ? AND state IN ('collected', 'candidate', 'checked', 'published', 'needs_revalidation')").all(uin, wordingVersion);
      const same = open.find(row => row.content_sha256 === sha);
      if (same) return { ...this.#dto(same), replayed: true };
      if (open.length) throw coded('SOURCE_VERSION_CONFLICT', 'A different document is already registered for this UIN and wording version.', 409);
      const id = this.#insert({ curatorId, identity, bytes, pageTexts, sha, evidence });
      return { ...this.#dto(this.#row(id)), replayed: false };
    });
  }

  /** Candidate extraction. The curator who collected it proposes typed facts; each page and quotation is checked against the supplied text. */
  proposeFacts({ curatorId, submissionId, facts }) {
    this.#require(curatorId, 'curator');
    return this.#atomic(() => {
      this.#require(curatorId, 'curator');
      const row = this.#row(submissionId);
      if (!row || row.collected_by !== curatorId) throw notFound();
      if (!['collected', 'candidate'].includes(row.state)) throw coded('SUBMISSION_STATE_CONFLICT', `A ${row.state} submission cannot take new facts.`, 409);
      const problems = validateCuratedFacts(facts);
      if (problems.length) throw invalid('The facts are invalid.', problems);
      const clean = facts.map(f => ({ factType: f.factType, topic: f.topic ?? 'general', value: f.value, page: f.page, quote: f.quote }));
      const probe = { ...row, facts_json: JSON.stringify(clean) };
      const evidence = this.#verifyArchive(probe);
      const machine = { bytes: 'verified', uin: evidence.humanReview.length ? 'human_review' : 'verified', quotes: evidence.humanReview.length ? 'human_review' : 'verified', humanReview: evidence.humanReview };
      const done = this.database.prepare("UPDATE curated_product_submissions SET facts_json = ?, machine_checks_json = ?, state = 'candidate' WHERE id = ? AND state IN ('collected', 'candidate')")
        .run(probe.facts_json, JSON.stringify(machine), row.id);
      if (Number(done.changes) !== 1) throw coded('SUBMISSION_STATE_CONFLICT', 'The submission changed.', 409);
      this.#event(curatorId, 'curated_source.candidate_proposed', row.id, { factCount: clean.length, humanReview: evidence.humanReview });
      return this.#dto(this.#row(row.id));
    });
  }

  /**
   * Independent check. The checker authenticates as an adult with a live checker grant, is not the collector, supplies the
   * SHA-256 of their own copy of the source and states they read every quotation in it. Accepting re-runs every machine check
   * against the archived bytes. A page text the curator supplied is never trusted as the source itself.
   */
  check({ checkerId, submissionId, decision, reasonCode, observedSha256 = null, factsSha256 = null, quotesReviewed = false, uinAndVersionReviewed = false }) {
    this.#require(checkerId, 'checker');
    if (!['accept', 'reject'].includes(decision)) throw invalid('decision is not supported.');
    if (!CHECK_REASON_CODES.includes(reasonCode)) throw invalid('reasonCode is not supported.');
    if ((decision === 'accept') !== (reasonCode === 'quote_matches_source')) throw invalid('reasonCode does not fit the decision.');
    try {
      return this.#check({ checkerId, submissionId, decision, reasonCode, observedSha256, factsSha256, quotesReviewed, uinAndVersionReviewed });
    } catch (error) {
      // The mismatch event is written after the failed transaction rolled back, so the attempt stays on record.
      if (error?.code === 'SOURCE_DIGEST_MISMATCH' && error.audit) this.#event(checkerId, 'curated_source.check_digest_mismatch', submissionId, error.audit);
      throw error;
    }
  }

  #check({ checkerId, submissionId, decision, reasonCode, observedSha256, factsSha256, quotesReviewed, uinAndVersionReviewed }) {
    return this.#atomic(() => {
      this.#require(checkerId, 'checker');
      const row = this.#row(submissionId);
      if (!row) throw notFound();
      if (row.collected_by === checkerId) throw coded('SELF_REVIEW_REFUSED', 'The person who collected a source cannot check it.', 403);
      if (row.state !== 'candidate') throw coded('SUBMISSION_STATE_CONFLICT', `A ${row.state} submission cannot be checked.`, 409);
      if (decision === 'reject') {
        this.database.prepare("UPDATE curated_product_submissions SET state = 'rejected' WHERE id = ? AND state = 'candidate'").run(row.id);
        this.#event(checkerId, 'curated_source.rejected', row.id, { reasonCode });
        return this.#dto(this.#row(row.id));
      }
      if (quotesReviewed !== true) throw invalid('quotesReviewed must be true: a checker states they read each quotation in the source.');
      if (typeof observedSha256 !== 'string' || !SHA256.test(observedSha256)) throw invalid('observedSha256 is malformed.');
      if (observedSha256 !== row.content_sha256) {
        throw Object.assign(coded('SOURCE_DIGEST_MISMATCH', 'The checker\'s copy does not match the archived source.', 409), { audit: { observed: observedSha256 } });
      }
      // The approval covers exactly the facts the checker read: a re-proposal after they looked invalidates it.
      if (factsSha256 !== sha256Hex(row.facts_json)) throw coded('FACTS_CHANGED', 'The candidate facts changed or were not the ones reviewed.', 409);
      const evidence = this.#verifyArchive(row);
      // Without page text the UIN and wording version were compared to nothing; the checker must say they read them.
      if (evidence.humanReview.length && uinAndVersionReviewed !== true) throw invalid('uinAndVersionReviewed must be true: no page text was supplied, so the UIN and wording version were not machine-checked.');
      const done = this.database.prepare("UPDATE curated_product_submissions SET state = 'checked', checked_by = ?, checked_at = ? WHERE id = ? AND state = 'candidate'").run(checkerId, this.#now(), row.id);
      if (Number(done.changes) !== 1) throw coded('SUBMISSION_STATE_CONFLICT', 'The submission changed.', 409);
      this.#event(checkerId, 'curated_source.checked', row.id, { reasonCode, sha256: row.content_sha256 });
      return this.#dto(this.#row(row.id));
    });
  }

  /** Publication. Needs a live checker grant, a checked submission and every machine check passing again. Withdraws a superseded predecessor. */
  publish({ actorId, submissionId }) {
    this.#require(actorId, 'checker');
    return this.#atomic(() => {
      this.#require(actorId, 'checker');
      const row = this.#row(submissionId);
      if (!row) throw notFound();
      if (row.collected_by === actorId) throw coded('SELF_REVIEW_REFUSED', 'The person who collected a source cannot publish it.', 403);
      if (row.state !== 'checked') throw coded('SUBMISSION_STATE_CONFLICT', `A ${row.state} submission cannot be published.`, 409);
      this.#verifyArchive(row);
      if (row.previous_id) {
        this.database.prepare("UPDATE curated_product_submissions SET state = 'superseded' WHERE id = ? AND state IN ('published', 'needs_revalidation')").run(row.previous_id);
      }
      const done = this.database.prepare("UPDATE curated_product_submissions SET state = 'published', published_at = ? WHERE id = ? AND state = 'checked'").run(this.#now(), row.id);
      if (Number(done.changes) !== 1) throw coded('SUBMISSION_STATE_CONFLICT', 'The submission changed.', 409);
      this.#event(actorId, 'curated_source.published', row.id, { uin: row.uin, sha256: row.content_sha256, supersedes: row.previous_id });
      return this.#dto(this.#row(row.id));
    });
  }

  /**
   * Explicit revalidation with bytes a person downloaded. Never fetches. An unchanged digest only records the check. A
   * different digest withdraws the published wording from use (`needs_revalidation`, history kept) and opens a new collected
   * submission that must go through proposal, a different checker and publication again.
   */
  revalidate({ actorId, submissionId, bytes, sourceVersionId = null, retrievedOn = null, pageTexts = null }) {
    if (!this.activeRole(actorId, 'curator') && !this.activeRole(actorId, 'checker')) throw forbidden();
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES) throw invalid('bytes are invalid.');
    if (normalisePageTexts(pageTexts) === undefined) throw invalid('pageTexts are invalid.');
    const sha = sha256Hex(bytes);
    return this.#atomic(() => {
      const isCurator = Boolean(this.activeRole(actorId, 'curator'));
      if (!isCurator && !this.activeRole(actorId, 'checker')) throw forbidden();
      const row = this.#row(submissionId);
      if (!row) throw notFound();
      if (!['published', 'checked', 'candidate', 'collected'].includes(row.state)) throw coded('SUBMISSION_STATE_CONFLICT', `A ${row.state} submission cannot be revalidated.`, 409);
      if (sha === row.content_sha256) {
        this.database.prepare('UPDATE curated_product_submissions SET last_revalidated_at = ? WHERE id = ?').run(this.#now(), row.id);
        this.#event(actorId, 'curated_source.revalidated_unchanged', row.id, { sha256: sha });
        return { changed: false, submission: this.#dto(this.#row(row.id)), next: null };
      }
      if (!isCurator || row.collected_by !== actorId) throw forbidden();
      const identity = {
        uin: row.uin, insurer: row.insurer, productName: row.product_name, wordingVersion: row.wording_version, sourceUrl: row.source_url,
        sourceVersionId: str(sourceVersionId, 'sourceVersionId', 200), retrievedOn: retrievedOn ?? this.#today(), effectiveFrom: row.effective_from,
      };
      if (identity.sourceVersionId === row.source_version_id) throw invalid('A changed source needs a new sourceVersionId.');
      const problems = validateSourceIdentity(identity, { today: this.#today() });
      if (problems.length) throw invalid('The source identity is invalid.', problems);
      const evidence = verifySourceEvidence({ record: { uin: row.uin, wordingVersion: row.wording_version, contentSha256: sha }, bytes, pageTexts });
      if (evidence.blocking.length) throw rejectedEvidence(evidence.blocking);
      if (['published', 'checked'].includes(row.state)) {
        this.database.prepare("UPDATE curated_product_submissions SET state = 'needs_revalidation' WHERE id = ? AND state IN ('published', 'checked')").run(row.id);
      } else {
        this.database.prepare("UPDATE curated_product_submissions SET state = 'superseded' WHERE id = ? AND state IN ('candidate', 'collected')").run(row.id);
      }
      const id = this.#insert({ curatorId: actorId, identity, bytes, pageTexts, previousId: row.id, sha, evidence });
      this.#event(actorId, 'curated_source.changed', row.id, { previousSha256: row.content_sha256, sha256: sha, next: id });
      return { changed: true, submission: this.#dto(this.#row(row.id)), next: this.#dto(this.#row(id)) };
    });
  }

  /**
   * Operator-only invalidation of a published review (identity compromise, fraud, a wrong attestation). Grant expiry or
   * routine revocation never calls this: an honest review stays historically valid. The review columns are not edited; the
   * state moves to `needs_revalidation`, which stops the product informing anyone until it is collected and checked again.
   */
  invalidate({ submissionId, operatorId, reasonCode }) {
    str(operatorId, 'operatorId', 128);
    if (!['checker_compromised', 'review_found_wrong', 'source_superseded'].includes(reasonCode)) throw invalid('reasonCode is not supported.');
    return this.#atomic(() => {
      const row = this.#row(submissionId);
      if (!row) throw notFound();
      const done = this.database.prepare("UPDATE curated_product_submissions SET state = 'needs_revalidation' WHERE id = ? AND state IN ('published', 'checked')").run(row.id);
      if (Number(done.changes) !== 1) throw coded('SUBMISSION_STATE_CONFLICT', `A ${row.state} submission cannot be invalidated.`, 409);
      this.audit.append({ actorType: 'system', actorId: `operator:${operatorId}`.slice(0, 128), action: 'curated_source.invalidated', resourceType: 'curated_product_submission', resourceId: row.id, payload: { reasonCode, checkedBy: row.checked_by } });
      return this.#dto(this.#row(row.id));
    });
  }

  // ---- Use ---------------------------------------------------------------------------------------------------------------

  /**
   * The only producer of `verified: true`. Reads PUBLISHED rows (so a checker's accepted action exists) and shape-validates
   * them again. A row that no longer validates is left out, which reads as unknown, never as a term.
   */
  listVerified({ today = this.#today() } = {}) {
    const rows = this.database.prepare("SELECT * FROM curated_product_submissions WHERE state = 'published' ORDER BY uin, wording_version").all();
    const out = [];
    for (const row of rows) {
      if (!row.checked_by || !row.checked_at || row.checked_by === row.collected_by) continue;
      const checked = validateCuratedProduct({
        uin: row.uin, insurer: row.insurer, productName: row.product_name, wordingVersion: row.wording_version, sourceUrl: row.source_url,
        contentSha256: row.content_sha256, retrievedOn: row.retrieved_on, checkedOn: row.checked_at.slice(0, 10), effectiveFrom: row.effective_from,
        curatedBy: row.collected_by, checkedBy: row.checked_by, facts: JSON.parse(row.facts_json),
      }, { today });
      if (!checked.valid) continue;
      out.push(Object.freeze({ ...checked, verified: true, verification: Object.freeze({ submissionId: row.id, sourceVersionId: row.source_version_id, checkedAt: row.checked_at }) }));
    }
    return Object.freeze(out);
  }
}

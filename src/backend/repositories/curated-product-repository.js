import { randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { AuditRepository } from './audit-repository.js';
import {
  curatedFreshness, validateCuratedFacts, validateCuratedProduct, validateSourceIdentity, verifySourceEvidence, normalisePageTexts, sha256Hex, MAX_SOURCE_BYTES,
  curatedActionTimely, keyFingerprint, parsePublicKey, readCuratedAction, signatureDigest, verifyCuratedActionSignature,
  buildVerifiedProductRecords, canonicalCuratedFacts,
} from '../../features/decision-catalogue/index.js';
import { PDF_TEXT_EXTRACTOR_VERSION, createSandboxedPdfTextExtractor } from '../../features/input/index.js';

// Trusted insurer-source workflow (PostgreSQL 014, 015). Public insurer wording only: no household data.
//
//   collected  -> candidate -> checked -> published
//   (register)   (propose)    (check)    (publish)       plus rejected, needs_revalidation, superseded
//
// A product reaches `verified` only by being PUBLISHED here: an adult holding an active, unexpired checker grant, proven by
// an Ed25519 signature made with the key registered on that grant (ADR 0010), who is not the person who collected it, compared the digest of their own copy with the archived bytes, accepted
// the quotes, and had every machine check pass again against the archive. Verification never comes from a record's own
// fields. Page text is derived from the archived PDF bytes by the sandboxed extractor (never taken from the curator); a
// curator's own page text is only a candidate that must agree with it, and a document whose text, page mapping, UIN or
// wording version cannot be established is refused. Rows and archived bytes are never deleted; a changed source creates a new submission and withdraws the old one
// from use until the new one is checked. There is deliberately no network code here: bytes are supplied by a person.
// Audit payloads hold ids, digests and the public UIN, never page text.

export const SOURCE_ROLES = Object.freeze(['curator', 'checker']);
export const CHECK_REASON_CODES = Object.freeze(['quote_matches_source', 'quote_does_not_match_source', 'wrong_product_or_version', 'source_unreadable', 'other']);
export const MAX_SOURCE_GRANT_DAYS = 90;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DERIVED = 'derived_from_bytes';
// Whitespace and case are layout noise between a curator's candidate text and the derived text; everything else must match.
const squash = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
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
  /**
   * @param pdfText `{ version, extract(bytes) }`, defaulting to the sandboxed extractor. Only text from an extractor whose
   *        version is PDF_TEXT_EXTRACTOR_VERSION is ever read as verified.
   */
  constructor(database, { clock = () => new Date(), audit = null, env = {}, pdfText = null } = {}) {
    if (!database || typeof database !== 'object') throw new TypeError('A database is required.');
    this.database = database;
    this.pdfText = pdfText;
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

  // Every write is one transaction that takes the NULL-household advisory lock first (S3.2 design, decision 5): these rows
  // hold no household data and their audit events sit on the NULL-household chain, whose append takes the same lock again
  // (re-entrant). So role checks, signed-action checks, nonce spending, state transitions and the audit chain are
  // serialised: of two concurrent approvals or publications of one product exactly one applies. A nested call is a savepoint.
  #atomic(work) {
    return this.database.transaction(work, { locks: [householdLock(null)] });
  }

  #now() { return this.clock().toISOString(); }
  #today() { return this.#now().slice(0, 10); }
  #event(adultId, action, resourceId, payload = {}) {
    return this.audit.append({ actorType: 'human_reviewer', actorId: adultId, action, resourceType: 'curated_product_submission', resourceId, payload });
  }

  // ---- Roles: operator tooling only, no route, always temporary ----------------------------------------------------------

  /**
   * A checker grant must carry the checker's Ed25519 public key (base64 SPKI DER): check and publish are verified against it.
   * A regrant replaces the key, so actions signed with an earlier key stop verifying.
   */
  async grantRole({ adultUserId, role, operatorId, expiresAt, publicKey = null }) {
    str(adultUserId, 'adultUserId'); str(operatorId, 'operatorId', 128);
    if (!SOURCE_ROLES.includes(role)) throw invalid('role is not supported.');
    if (operatorId === adultUserId) throw invalid('An operator cannot grant themselves.');
    if (role === 'checker' ? !parsePublicKey(publicKey) : publicKey !== null && !parsePublicKey(publicKey)) throw invalid('publicKey must be an Ed25519 public key (base64 SPKI DER).');
    const now = this.clock().getTime();
    if (typeof expiresAt !== 'string' || !ISO_INSTANT.test(expiresAt) || !(Date.parse(expiresAt) > now)
      || Date.parse(expiresAt) > now + MAX_SOURCE_GRANT_DAYS * 86_400_000) throw invalid(`expiresAt must be a future UTC instant within ${MAX_SOURCE_GRANT_DAYS} days.`);
    const db = this.database;
    return this.#atomic(async () => {
      const existing = await db.one('SELECT * FROM source_curator_grants WHERE adult_user_id = ? AND role = ?', [adultUserId, role]);
      const grantedBy = `operator:${operatorId}`.slice(0, 128);
      let id = existing?.id;
      if (existing) {
        await db.run("UPDATE source_curator_grants SET status = 'active', revoked_at = NULL, granted_by = ?, expires_at = ?, public_key = ? WHERE id = ?", [grantedBy, expiresAt, publicKey, id]);
      } else {
        id = `scg-${randomUUID()}`;
        await db.run("INSERT INTO source_curator_grants (id, adult_user_id, role, status, granted_by, created_at, expires_at, public_key) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)",
          [id, adultUserId, role, grantedBy, this.#now(), expiresAt, publicKey]);
      }
      await this.audit.append({ actorType: 'system', actorId: grantedBy, action: existing ? 'curated_source_role.regranted' : 'curated_source_role.granted', resourceType: 'source_curator_grant', resourceId: id, payload: { role, expiresAt, keyFingerprint: publicKey ? keyFingerprint(publicKey) : null } });
      return db.one('SELECT * FROM source_curator_grants WHERE id = ?', [id]);
    });
  }

  async revokeRole({ grantId, revokedBy = 'operator' }) {
    str(grantId, 'grantId');
    const db = this.database;
    // The same lock as check and publish: a revocation lands wholly before or wholly after a signed action.
    return this.#atomic(async () => {
      const done = await db.run("UPDATE source_curator_grants SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'", [this.#now(), grantId]);
      if (done.changes > 0) await this.audit.append({ actorType: 'system', actorId: String(revokedBy).slice(0, 128), action: 'curated_source_role.revoked', resourceType: 'source_curator_grant', resourceId: grantId });
      return done.changes > 0;
    });
  }

  /** Re-read on every call: revocation and expiry take effect on the next request, whatever session the caller holds. */
  async activeRole(adultId, role) {
    if (typeof adultId !== 'string' || !adultId) return null;
    const row = await this.database.one("SELECT * FROM source_curator_grants WHERE adult_user_id = ? AND role = ? AND status = 'active'", [adultId, role]);
    return row && Date.parse(row.expires_at) > this.clock().getTime() ? row : null;
  }

  async #require(adultId, role) { const grant = await this.activeRole(adultId, role); if (!grant) throw forbidden(); return grant; }
  async #hasEitherRole(adultId) { return Boolean(await this.activeRole(adultId, 'curator')) || Boolean(await this.activeRole(adultId, 'checker')); }

  #extractor() {
    this.pdfText ??= createSandboxedPdfTextExtractor();
    if (typeof this.pdfText?.extract !== 'function' || typeof this.pdfText.version !== 'string') throw new TypeError('A PDF text extractor is required.');
    return this.pdfText;
  }

  /**
   * Page text from the bytes themselves. A curator's page text is a candidate: it must agree page for page with the derived
   * text or the source is refused. Text that cannot be established on every page refuses the source (fail closed).
   */
  async #deriveText(bytes, candidatePageTexts) {
    const extractor = this.#extractor();
    let derived;
    try { derived = await extractor.extract(bytes); } catch { throw rejectedEvidence(['page_text_unestablished']); }
    if (derived?.status !== 'established') {
      const pages = (derived?.pages ?? []).filter(page => page.status !== 'established').slice(0, 20).map(page => `page_text_unestablished:${page.page}:${page.reason}`);
      throw rejectedEvidence(['page_text_unestablished', ...(derived?.reason ? [`document:${derived.reason}`] : []), ...pages]);
    }
    const pageTexts = derived.pages.map(page => page.text);
    if (candidatePageTexts) {
      if (candidatePageTexts.length !== pageTexts.length) throw rejectedEvidence(['supplied_page_count_differs']);
      const differing = candidatePageTexts.map((text, i) => (squash(text) === squash(pageTexts[i]) ? null : `supplied_text_differs:${i + 1}`)).filter(Boolean);
      if (differing.length) throw rejectedEvidence(differing);
    }
    return { pageTexts, version: extractor.version };
  }

  // ---- Reads -------------------------------------------------------------------------------------------------------------

  #row(id) { return this.database.one('SELECT * FROM curated_product_submissions WHERE id = ?', [str(id, 'submissionId')]); }
  #dto(row) {
    return {
      submissionId: row.id, uin: row.uin, insurer: row.insurer, productName: row.product_name, wordingVersion: row.wording_version,
      sourceUrl: row.source_url, sourceVersionId: row.source_version_id, contentSha256: row.content_sha256, retrievedOn: row.retrieved_on,
      effectiveFrom: row.effective_from, state: row.state, facts: JSON.parse(row.facts_json), machineChecks: JSON.parse(row.machine_checks_json),
      pageTexts: row.page_texts_json ? JSON.parse(row.page_texts_json) : null,
      collectedBy: row.collected_by, checkedBy: row.checked_by, checkedAt: row.checked_at, publishedAt: row.published_at,
      factsSha256: sha256Hex(row.facts_json), pageTextOrigin: row.page_text_origin, textExtractorVersion: row.text_extractor_version, previousId: row.previous_id, lastRevalidatedAt: row.last_revalidated_at, createdAt: row.created_at,
    };
  }

  /** Only a curator or a checker with a live role may read a submission. Never returns the archived bytes. */
  async get({ adultId, submissionId }) {
    if (!(await this.#hasEitherRole(adultId))) throw forbidden();
    const row = await this.#row(submissionId);
    if (!row) throw notFound();
    // The digest is withheld on purpose: a checker must compute it from their own copy, not read it back from here.
    const { contentSha256: _withheld, ...view } = this.#dto(row);
    return view;
  }

  async #archive(sha) { return (await this.database.one('SELECT content FROM curated_source_archives WHERE sha256 = ?', [sha]))?.content ?? null; }

  /** Evidence re-run against the ARCHIVED bytes, so a swapped or damaged archive cannot ride on an earlier pass. */
  // Only text derived from the bytes by the current extractor supports a machine check. Older rows fail closed.
  #textOriginBlocking(row) {
    return row.page_text_origin === DERIVED && row.text_extractor_version === PDF_TEXT_EXTRACTOR_VERSION && row.page_texts_json ? [] : ['page_text_not_derived'];
  }

  async #verifyArchive(row) {
    const origin = this.#textOriginBlocking(row);
    if (origin.length) throw rejectedEvidence(origin);
    const bytes = await this.#archive(row.content_sha256);
    const record = { uin: row.uin, wordingVersion: row.wording_version, contentSha256: row.content_sha256 };
    const facts = JSON.parse(row.facts_json);
    const evidence = verifySourceEvidence({ record, bytes: bytes ? new Uint8Array(bytes) : null, pageTexts: row.page_texts_json ? JSON.parse(row.page_texts_json) : null, facts });
    if (evidence.blocking.length) throw rejectedEvidence(evidence.blocking);
    const today = this.#today();
    if (curatedFreshness({ retrievedOn: row.retrieved_on, effectiveFrom: row.effective_from }, today) !== 'current') throw coded('SOURCE_NOT_CURRENT', 'The source is stale or not yet effective; revalidate it.', 409);
    return evidence;
  }

  // ---- Workflow ----------------------------------------------------------------------------------------------------------

  async #insert({ id = `cps-${randomUUID()}`, curatorId, identity, bytes, pageTexts, extractorVersion, previousId = null, sha, evidence }) {
    const at = this.#now();
    const db = this.database;
    // An archive is keyed by its digest and immutable: the same bytes registered again keep the first row.
    await db.run('INSERT INTO curated_source_archives (sha256, byte_size, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (sha256) DO NOTHING', [sha, bytes.length, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), at]);
    await db.run(`INSERT INTO curated_product_submissions
      (id, uin, insurer, product_name, wording_version, source_url, source_version_id, content_sha256, retrieved_on, effective_from, page_texts_json,
       facts_json, machine_checks_json, state, collected_by, previous_id, created_at, page_text_origin, text_extractor_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 'collected', ?, ?, ?, ?, ?)`,
    [id, identity.uin, identity.insurer, identity.productName, identity.wordingVersion, identity.sourceUrl, identity.sourceVersionId, sha, identity.retrievedOn,
      identity.effectiveFrom ?? null, pageTexts ? JSON.stringify(pageTexts) : null,
      JSON.stringify({ bytes: 'digest_computed', text: DERIVED, humanReview: evidence.humanReview }), curatorId, previousId, at, DERIVED, extractorVersion]);
    await this.#event(curatorId, 'curated_source.registered', id, { uin: identity.uin, sha256: sha, previousId });
    return id;
  }

  /**
   * Collection. The digest is computed from the bytes the curator supplied; a digest the curator claims must match it.
   * Several printed UINs, a UIN or version that is not in the supplied text, and a different document for a wording that is
   * already registered all fail closed, and so does a document whose page text cannot be derived from its bytes.
   */
  async register({ curatorId, uin, insurer, productName, wordingVersion, sourceUrl, sourceVersionId, retrievedOn, effectiveFrom = null, claimedSha256 = null, bytes, pageTexts = null }) {
    await this.#require(curatorId, 'curator');
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
    const digestOnly = verifySourceEvidence({ record: { uin, wordingVersion, contentSha256: claimedSha256 ?? sha }, bytes });
    if (digestOnly.blocking.length) throw rejectedEvidence(digestOnly.blocking);
    const derived = await this.#deriveText(bytes, normalisePageTexts(pageTexts));
    const evidence = verifySourceEvidence({ record: { uin, wordingVersion, contentSha256: claimedSha256 ?? sha }, bytes, pageTexts: derived.pageTexts });
    if (evidence.blocking.length) throw rejectedEvidence(evidence.blocking);
    return this.#atomic(async () => {
      await this.#require(curatorId, 'curator');
      const open = await this.database.many("SELECT * FROM curated_product_submissions WHERE uin = ? AND wording_version = ? AND state IN ('collected', 'candidate', 'checked', 'published', 'needs_revalidation') ORDER BY created_at, id", [uin, wordingVersion]);
      const same = open.find(row => row.content_sha256 === sha);
      // A replay returns only a usable row. Text from an older extractor, or an invalidated row, is re-opened by revalidate.
      if (same && (same.state === 'needs_revalidation' || this.#textOriginBlocking(same).length)) {
        throw coded('SOURCE_REVALIDATION_REQUIRED', 'This document is registered but must be revalidated (stale text or invalidated review).', 409);
      }
      if (same) return { ...this.#dto(same), replayed: true };
      if (open.length) throw coded('SOURCE_VERSION_CONFLICT', 'A different document is already registered for this UIN and wording version.', 409);
      const id = await this.#insert({ curatorId, identity, bytes, pageTexts: derived.pageTexts, extractorVersion: derived.version, sha, evidence });
      return { ...this.#dto(await this.#row(id)), replayed: false };
    });
  }

  /** Candidate extraction. The curator who collected it proposes typed facts; each page and quotation is checked against the supplied text. */
  async proposeFacts({ curatorId, submissionId, facts }) {
    await this.#require(curatorId, 'curator');
    return this.#atomic(async () => {
      await this.#require(curatorId, 'curator');
      const row = await this.#row(submissionId);
      if (!row || row.collected_by !== curatorId) throw notFound();
      if (!['collected', 'candidate'].includes(row.state)) throw coded('SUBMISSION_STATE_CONFLICT', `A ${row.state} submission cannot take new facts.`, 409);
      const problems = validateCuratedFacts(facts);
      if (problems.length) throw invalid('The facts are invalid.', problems);
      const factsJson = canonicalCuratedFacts(facts);
      const clean = JSON.parse(factsJson);
      const probe = { ...row, facts_json: factsJson };
      const evidence = await this.#verifyArchive(probe);
      const machine = { bytes: 'verified', uin: evidence.humanReview.length ? 'human_review' : 'verified', quotes: evidence.humanReview.length ? 'human_review' : 'verified', humanReview: evidence.humanReview };
      const done = await this.database.run("UPDATE curated_product_submissions SET facts_json = ?, machine_checks_json = ?, state = 'candidate' WHERE id = ? AND state IN ('collected', 'candidate')",
        [probe.facts_json, JSON.stringify(machine), row.id]);
      if (done.changes !== 1) throw coded('SUBMISSION_STATE_CONFLICT', 'The submission changed.', 409);
      await this.#event(curatorId, 'curated_source.candidate_proposed', row.id, { factCount: clean.length, humanReview: evidence.humanReview });
      return this.#dto(await this.#row(row.id));
    });
  }

  /**
   * Verifies a signed checker action (ADR 0010) and returns its payload and grant. The caller id inside the payload is only a
   * claim: it is accepted when the signature verifies against the public key of that adult's live checker grant. Runs inside
   * the write transaction so a revocation or regrant between signing and applying is seen. The nonce row is written last,
   * by the caller, in the same transaction, so a refused action never consumes it and an accepted one cannot be replayed.
   */
  async #authoriseSigned(envelope, action) {
    const payload = readCuratedAction(envelope);
    if (payload.action !== action) throw coded('SOURCE_ACTION_MALFORMED', `The signed action is not a ${action}.`, 400);
    const grant = await this.#require(payload.checkerId, 'checker');
    if (!verifyCuratedActionSignature(grant.public_key, envelope)) throw coded('SOURCE_ACTION_SIGNATURE_INVALID', 'The signed action does not verify against the checker key.', 403);
    if (!curatedActionTimely(payload, this.clock().getTime())) throw coded('SOURCE_ACTION_EXPIRED', 'The signed action is outside its validity window.', 403);
    if (await this.database.one('SELECT 1 FROM curated_action_nonces WHERE nonce = ?', [payload.nonce])) throw coded('SOURCE_ACTION_REPLAYED', 'The signed action was already used.', 409);
    return { payload, grant };
  }

  async #spendNonce({ payload, grant }, envelope) {
    await this.database.run('INSERT INTO curated_action_nonces (nonce, grant_id, action, submission_id, signature_sha256, used_at) VALUES (?, ?, ?, ?, ?, ?)',
      [payload.nonce, grant.id, payload.action, payload.submissionId, signatureDigest(envelope), this.#now()]);
  }

  // Refused signed actions are recorded after the transaction rolled back. The actor is the CLAIMED checker id.
  async #refused(envelope, error, extra = []) {
    if (!['SOURCE_ACTION_SIGNATURE_INVALID', 'SOURCE_ACTION_EXPIRED', 'SOURCE_ACTION_REPLAYED', 'SOURCE_ROLE_NOT_AUTHORISED', 'SELF_REVIEW_REFUSED', ...extra].includes(error?.code)) return;
    let payload;
    try { payload = JSON.parse(envelope.payload); } catch { return; }
    if (typeof payload?.checkerId !== 'string' || typeof payload?.submissionId !== 'string') return;
    await this.audit.append({
      actorType: 'system', actorId: `claimed:${payload.checkerId}`.slice(0, 128), action: 'curated_source.signed_action_refused',
      resourceType: 'curated_product_submission', resourceId: payload.submissionId.slice(0, 128), payload: { reason: error.code, action: String(payload.action).slice(0, 20) },
    });
  }

  /**
   * Independent check, from a signed action only (operator CLI `check`; there is no route). The checker is not the collector,
   * signs the SHA-256 of their own copy of the source and the digest of the facts they read, and states they read every
   * quotation in it. Accepting re-runs every machine check against the archived bytes. A page text the curator supplied is
   * never trusted as the source itself.
   */
  async check({ signedAction }) {
    try {
      return await this.#atomic(async () => {
        const authorised = await this.#authoriseSigned(signedAction, 'check');
        const { payload } = authorised;
        if (!CHECK_REASON_CODES.includes(payload.reasonCode)) throw invalid('reasonCode is not supported.');
        if ((payload.decision === 'accept') !== (payload.reasonCode === 'quote_matches_source')) throw invalid('reasonCode does not fit the decision.');
        const result = await this.#check({ checkerId: payload.checkerId, ...payload });
        await this.#spendNonce(authorised, signedAction);
        return result;
      });
    } catch (error) {
      // Written after the failed transaction rolled back, so the attempt stays on record.
      if (error?.code === 'SOURCE_DIGEST_MISMATCH' && error.audit) await this.#event(error.audit.checkerId, 'curated_source.check_digest_mismatch', error.audit.submissionId, { observed: error.audit.observed });
      await this.#refused(signedAction, error);
      throw error;
    }
  }

  #check({ checkerId, submissionId, decision, reasonCode, observedSha256, factsSha256, quotesReviewed }) {
    return this.#atomic(async () => {
      const row = await this.#row(submissionId);
      if (!row) throw notFound();
      if (row.collected_by === checkerId) throw coded('SELF_REVIEW_REFUSED', 'The person who collected a source cannot check it.', 403);
      if (row.state !== 'candidate') throw coded('SUBMISSION_STATE_CONFLICT', `A ${row.state} submission cannot be checked.`, 409);
      if (decision === 'reject') {
        const rejected = await this.database.run("UPDATE curated_product_submissions SET state = 'rejected' WHERE id = ? AND state = 'candidate'", [row.id]);
        if (rejected.changes !== 1) throw coded('SUBMISSION_STATE_CONFLICT', 'The submission changed.', 409);
        await this.#event(checkerId, 'curated_source.rejected', row.id, { reasonCode });
        return this.#dto(await this.#row(row.id));
      }
      if (quotesReviewed !== true) throw invalid('quotesReviewed must be true: a checker states they read each quotation in the source.');
      if (typeof observedSha256 !== 'string' || !SHA256.test(observedSha256)) throw invalid('observedSha256 is malformed.');
      if (observedSha256 !== row.content_sha256) {
        throw Object.assign(coded('SOURCE_DIGEST_MISMATCH', 'The checker\'s copy does not match the archived source.', 409), { audit: { checkerId, submissionId: row.id, observed: observedSha256 } });
      }
      // The approval covers exactly the facts the checker read: a re-proposal after they looked invalidates it.
      if (factsSha256 !== sha256Hex(row.facts_json)) throw coded('FACTS_CHANGED', 'The candidate facts changed or were not the ones reviewed.', 409);
      const evidence = await this.#verifyArchive(row);
      // Derived page text is required, so the UIN, wording version and every quote were machine-checked against the archive.
      if (evidence.humanReview.length) throw rejectedEvidence(['page_text_unestablished']);
      const done = await this.database.run("UPDATE curated_product_submissions SET state = 'checked', checked_by = ?, checked_at = ? WHERE id = ? AND state = 'candidate'", [checkerId, this.#now(), row.id]);
      if (done.changes !== 1) throw coded('SUBMISSION_STATE_CONFLICT', 'The submission changed.', 409);
      await this.#event(checkerId, 'curated_source.checked', row.id, { reasonCode, sha256: row.content_sha256, factsSha256 });
      return this.#dto(await this.#row(row.id));
    });
  }

  /**
   * Publication, from a signed action only (operator CLI `publish`; there is no route). Needs a live checker grant whose key
   * signed it, a checked submission, the same facts and source digests the signer attests, and every machine check passing
   * again. Withdraws a superseded predecessor.
   */
  async publish({ signedAction }) {
    try {
      return await this.#atomic(async () => {
        const authorised = await this.#authoriseSigned(signedAction, 'publish');
        const { payload } = authorised;
        const actorId = payload.checkerId;
        const row = await this.#row(payload.submissionId);
        if (!row) throw notFound();
        if (row.collected_by === actorId) throw coded('SELF_REVIEW_REFUSED', 'The person who collected a source cannot publish it.', 403);
        if (row.state !== 'checked') throw coded('SUBMISSION_STATE_CONFLICT', `A ${row.state} submission cannot be published.`, 409);
        if (payload.observedSha256 !== row.content_sha256) throw coded('SOURCE_DIGEST_MISMATCH', 'The publisher\'s copy does not match the archived source.', 409);
        if (payload.factsSha256 !== sha256Hex(row.facts_json)) throw coded('FACTS_CHANGED', 'The facts are not the ones the publisher attested.', 409);
        await this.#verifyArchive(row);
        if (row.previous_id) {
          await this.database.run("UPDATE curated_product_submissions SET state = 'superseded' WHERE id = ? AND state IN ('published', 'needs_revalidation')", [row.previous_id]);
        }
        const done = await this.database.run("UPDATE curated_product_submissions SET state = 'published', published_at = ? WHERE id = ? AND state = 'checked'", [this.#now(), row.id]);
        if (done.changes !== 1) throw coded('SUBMISSION_STATE_CONFLICT', 'The submission changed.', 409);
        await this.#spendNonce(authorised, signedAction);
        await this.#event(actorId, 'curated_source.published', row.id, { uin: row.uin, sha256: row.content_sha256, supersedes: row.previous_id, keyFingerprint: keyFingerprint(authorised.grant.public_key) });
        return this.#dto(await this.#row(row.id));
      });
    } catch (error) {
      await this.#refused(signedAction, error, ['SOURCE_DIGEST_MISMATCH', 'FACTS_CHANGED']);
      throw error;
    }
  }

  /**
   * Explicit revalidation with bytes a person downloaded. Never fetches. Unchanged bytes on a usable row only record the
   * check. Otherwise the collector opens a new `collected` submission (`previous_id` set) that must go through proposal, a
   * different checker and publication again, and the old one is withdrawn from use (history kept):
   *   - different bytes (the source changed; needs a new sourceVersionId);
   *   - the same bytes whose stored text came from an older extractor or was never derived (re-derived from the bytes);
   *   - the same bytes after an operator invalidated the review (`needs_revalidation`).
   */
  async revalidate({ actorId, submissionId, bytes, sourceVersionId = null, retrievedOn = null, pageTexts = null }) {
    if (!(await this.#hasEitherRole(actorId))) throw forbidden();
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > MAX_SOURCE_BYTES) throw invalid('bytes are invalid.');
    if (normalisePageTexts(pageTexts) === undefined) throw invalid('pageTexts are invalid.');
    const sha = sha256Hex(bytes);
    const REOPENABLE = ['published', 'checked', 'candidate', 'collected', 'needs_revalidation'];
    const reopens = row => sha !== row.content_sha256 || row.state === 'needs_revalidation' || this.#textOriginBlocking(row).length > 0;
    // Text is derived only for a re-opening the actor may make, and before the write transaction (it is async).
    const before = await this.#row(submissionId);
    let derived = null;
    if (before && REOPENABLE.includes(before.state) && reopens(before) && before.collected_by === actorId && await this.activeRole(actorId, 'curator')) {
      derived = await this.#deriveText(bytes, normalisePageTexts(pageTexts));
    }
    return this.#atomic(async () => {
      const isCurator = Boolean(await this.activeRole(actorId, 'curator'));
      if (!isCurator && !(await this.activeRole(actorId, 'checker'))) throw forbidden();
      const row = await this.#row(submissionId);
      if (!row) throw notFound();
      if (!REOPENABLE.includes(row.state)) throw coded('SUBMISSION_STATE_CONFLICT', `A ${row.state} submission cannot be revalidated.`, 409);
      if (!reopens(row)) {
        await this.database.run('UPDATE curated_product_submissions SET last_revalidated_at = ? WHERE id = ?', [this.#now(), row.id]);
        await this.#event(actorId, 'curated_source.revalidated_unchanged', row.id, { sha256: sha });
        return { changed: false, submission: this.#dto(await this.#row(row.id)), next: null };
      }
      if (!isCurator || row.collected_by !== actorId) throw forbidden();
      const changedBytes = sha !== row.content_sha256;
      const identity = {
        uin: row.uin, insurer: row.insurer, productName: row.product_name, wordingVersion: row.wording_version, sourceUrl: row.source_url,
        sourceVersionId: changedBytes ? str(sourceVersionId, 'sourceVersionId', 200) : row.source_version_id,
        retrievedOn: retrievedOn ?? this.#today(), effectiveFrom: row.effective_from,
      };
      if (changedBytes && identity.sourceVersionId === row.source_version_id) throw invalid('A changed source needs a new sourceVersionId.');
      const problems = validateSourceIdentity(identity, { today: this.#today() });
      if (problems.length) throw invalid('The source identity is invalid.', problems);
      if (!derived) throw coded('SUBMISSION_STATE_CONFLICT', 'The submission changed.', 409);
      const evidence = verifySourceEvidence({ record: { uin: row.uin, wordingVersion: row.wording_version, contentSha256: sha }, bytes, pageTexts: derived.pageTexts });
      if (evidence.blocking.length) throw rejectedEvidence(evidence.blocking);
      const withdrawn = ['published', 'checked'].includes(row.state) ? 'needs_revalidation' : 'superseded';
      const withdrawal = await this.database.run('UPDATE curated_product_submissions SET state = ? WHERE id = ? AND state = ?', [withdrawn, row.id, row.state]);
      if (withdrawal.changes !== 1) throw coded('SUBMISSION_STATE_CONFLICT', 'The submission changed.', 409);
      const id = await this.#insert({ curatorId: actorId, identity, bytes, pageTexts: derived.pageTexts, extractorVersion: derived.version, previousId: row.id, sha, evidence });
      const reason = changedBytes ? 'source_changed' : row.state === 'needs_revalidation' ? 'review_invalidated' : 'text_rederived';
      await this.#event(actorId, 'curated_source.changed', row.id, { previousSha256: row.content_sha256, sha256: sha, next: id, reason });
      return { changed: true, reason, submission: this.#dto(await this.#row(row.id)), next: this.#dto(await this.#row(id)) };
    });
  }

  /**
   * Operator-only invalidation of a published review (identity compromise, fraud, a wrong attestation). Grant expiry or
   * routine revocation never calls this: an honest review stays historically valid. The review columns are not edited; the
   * state moves to `needs_revalidation`, which stops the product informing anyone until it is collected and checked again.
   */
  async invalidate({ submissionId, operatorId, reasonCode }) {
    str(operatorId, 'operatorId', 128);
    if (!['checker_compromised', 'review_found_wrong', 'source_superseded'].includes(reasonCode)) throw invalid('reasonCode is not supported.');
    return this.#atomic(async () => {
      const row = await this.#row(submissionId);
      if (!row) throw notFound();
      const done = await this.database.run("UPDATE curated_product_submissions SET state = 'needs_revalidation' WHERE id = ? AND state IN ('published', 'checked')", [row.id]);
      if (done.changes !== 1) throw coded('SUBMISSION_STATE_CONFLICT', `A ${row.state} submission cannot be invalidated.`, 409);
      await this.audit.append({ actorType: 'system', actorId: `operator:${operatorId}`.slice(0, 128), action: 'curated_source.invalidated', resourceType: 'curated_product_submission', resourceId: row.id, payload: { reasonCode, checkedBy: row.checked_by } });
      return this.#dto(await this.#row(row.id));
    });
  }

  // ---- Use ---------------------------------------------------------------------------------------------------------------

  /**
   * Machine checks re-run against the archived bytes of one row, without throwing: the digest, PDF header, printed UIN and
   * version and every quotation. Triggers keep the archive immutable, but a damaged file or an edit made outside the
   * application bypasses them, so a trusted read never relies on an earlier pass.
   */
  async #archiveBlocking(row) {
    const origin = this.#textOriginBlocking(row);
    if (origin.length) return origin;
    let pageTexts; let facts;
    try { pageTexts = row.page_texts_json ? JSON.parse(row.page_texts_json) : null; facts = JSON.parse(row.facts_json); } catch { return ['stored_json_invalid']; }
    if (!Array.isArray(facts)) return ['stored_json_invalid'];
    const bytes = await this.#archive(row.content_sha256);
    const evidence = verifySourceEvidence({
      record: { uin: row.uin, wordingVersion: row.wording_version, contentSha256: row.content_sha256 },
      bytes: bytes ? new Uint8Array(bytes) : null, pageTexts, facts,
    });
    return evidence.blocking;
  }

  #parsedFacts(row) { try { const facts = JSON.parse(row.facts_json); return Array.isArray(facts) ? facts : null; } catch { return null; } }

  /**
   * Operator check of every published submission's archive (CLI `verify-archives`). Re-runs the machine checks and derives the
   * page text again from the archived bytes, so stored text edited outside the application is caught. Reports, never repairs.
   */
  async verifyPublishedArchives() {
    const rows = await this.database.many("SELECT * FROM curated_product_submissions WHERE state = 'published' ORDER BY uin, wording_version");
    const out = [];
    for (const row of rows) {
      const blocking = [...(await this.#archiveBlocking(row))];
      const bytes = await this.#archive(row.content_sha256);
      // Re-derivation only adds information when the stored checks still pass.
      if (bytes && blocking.length === 0) {
        try {
          const derived = await this.#deriveText(new Uint8Array(bytes), null);
          if (derived.version !== row.text_extractor_version) blocking.push('extractor_version_changed');
          else if (JSON.stringify(derived.pageTexts) !== row.page_texts_json) blocking.push('derived_text_changed');
        } catch (error) {
          blocking.push(...(error?.details ?? ['page_text_unestablished']).slice(0, 1));
        }
      }
      out.push({ submissionId: row.id, uin: row.uin, ok: blocking.length === 0, blocking, textOrigin: row.page_text_origin, extractor: row.text_extractor_version });
    }
    return out;
  }

  /**
   * Read-only `verified-product-records/v1` view (WP4) of every submission. Values come only from listVerified; every other
   * row is at most unverified. No household data exists in these tables. Not exposed by any route.
   */
  async productRecords({ today = this.#today(), requested = [] } = {}) {
    const verified = await this.listVerified({ today });
    const verifiedIds = new Set(verified.map(product => product.verification.submissionId));
    const submissions = (await this.database.many('SELECT * FROM curated_product_submissions ORDER BY uin, wording_version, created_at, id'))
      .filter(row => !verifiedIds.has(row.id))
      .map(row => {
        const facts = this.#parsedFacts(row);
        const dto = this.#dto({ ...row, facts_json: facts ? row.facts_json : '[]', machine_checks_json: '{}' });
        const { pageTexts: _text, collectedBy: _collector, checkedBy: _checker, ...view } = dto;
        // A published row that listVerified refused (stale text, failed archive check, malformed facts) is withdrawn from
        // use: it reads as needing revalidation, never as an unverified candidate with values.
        return row.state === 'published' ? { ...view, state: 'needs_revalidation', facts: [] } : view;
      });
    return buildVerifiedProductRecords({ verified, submissions, requested, today });
  }

  /**
   * The only producer of `verified: true`. Reads PUBLISHED rows (so a checker's accepted action exists), re-hashes their
   * archived bytes and shape-validates them again. A row that fails either is left out, which reads as unknown, never as a term.
   */
  async listVerified({ today = this.#today() } = {}) {
    const rows = await this.database.many("SELECT * FROM curated_product_submissions WHERE state = 'published' ORDER BY uin, wording_version");
    const out = [];
    for (const row of rows) {
      if (!row.checked_by || !row.checked_at || row.checked_by === row.collected_by) continue;
      if ((await this.#archiveBlocking(row)).length) continue;
      const facts = this.#parsedFacts(row);
      if (!facts) continue;
      const checked = validateCuratedProduct({
        uin: row.uin, insurer: row.insurer, productName: row.product_name, wordingVersion: row.wording_version, sourceUrl: row.source_url,
        contentSha256: row.content_sha256, retrievedOn: row.retrieved_on, checkedOn: row.checked_at.slice(0, 10), effectiveFrom: row.effective_from,
        curatedBy: row.collected_by, checkedBy: row.checked_by, facts,
      }, { today });
      if (!checked.valid) continue;
      out.push(Object.freeze({ ...checked, verified: true, verification: Object.freeze({ submissionId: row.id, sourceVersionId: row.source_version_id, checkedAt: row.checked_at, pageTextOrigin: row.page_text_origin, textExtractorVersion: row.text_extractor_version }) }));
    }
    return Object.freeze(out);
  }
}

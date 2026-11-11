import { randomBytes, randomUUID } from 'node:crypto';
import { householdLock, sessionCapacityLock } from '../database/postgres/locks.js';
import { SESSION_CAPACITY_KEY } from './auth-repository.js';

// Web sessions, rotating refresh tokens and JWT signing-key rows (migration 045, ADR 0016). Nothing here logs and no audit
// payload carries a token, a hash or a key: events hold ids and counts only. Refresh tokens are 256-bit random values stored
// only as keyed HMAC hashes (the column-crypto blind index), so a database read cannot replay one.

const DAY_MS = 24 * 60 * 60 * 1000;
export const REFRESH_SLIDING_MS = 30 * DAY_MS;
export const REFRESH_ABSOLUTE_MS = 90 * DAY_MS;
export const KEY_OVERLAP_MS = 15 * 60 * 1000;
const LIST_LIMIT = 50;
export const MAX_WEB_SESSIONS_PER_ADULT = 5;
const LAST_SEEN_STALE_MS = 60_000;
const SIGN_OUT_REASONS = new Set(['sign_out', 'sign_out_all', 'refresh_reuse', 'admin', 'identity_revoked']);

const fail = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode });
const iso = date => date.toISOString();

export class AuthTokenRepository {
  constructor(database, { clock = () => new Date(), audit, columnCrypto, maxActiveWebSessions = 10_000, maxWebSessionsPerAdult = MAX_WEB_SESSIONS_PER_ADULT } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.columnCrypto = columnCrypto;
    this.maxActiveWebSessions = maxActiveWebSessions;
    this.maxWebSessionsPerAdult = maxWebSessionsPerAdult;
  }

  hashRefreshToken(token) { return this.columnCrypto.blindIndex('auth_refresh_token', token); }

  #audit(householdId, actorId, action, resourceId, payload = {}) {
    return this.audit?.append({ householdId, actorType: 'adult_user', actorId, action, resourceType: 'auth_session', resourceId, payload });
  }

  // ---- Sessions ------------------------------------------------------------------------------------------------------

  /**
   * Starts a web session and its first refresh token in one transaction (a savepoint inside the sign-in transaction). Takes the
   * household lock, then the same global capacity lock opaque sessions use, so capacity checks serialise across both kinds. Each kind has its own cap (migration 039).
   * Resolves { sessionId, refreshToken, expiresAt, absoluteExpiresAt }.
   */
  async createWebSession({ adultUserId, householdId, amr, authIdentityId = null }) {
    const db = this.database;
    return db.transaction(async () => {
      const adult = await db.one("SELECT id FROM adult_users WHERE id = ? AND account_status = 'active'", [adultUserId]);
      const household = await db.one("SELECT id FROM households WHERE id = ? AND status = 'active'", [householdId]);
      if (!adult || !household) throw fail('AUTH_SUBJECT_INVALID', 'An active adult account is required.', 403);
      const issuedAt = this.clock();
      // Web sessions have their own global cap, so they cannot use up the opaque-session cap (and the reverse).
      const { count: active } = await db.one(`SELECT count(*) AS count FROM api_sessions
        WHERE session_kind = 'web' AND revoked_at IS NULL AND julianday(expires_at) > julianday(?)`, [iso(issuedAt)]);
      if (active >= this.maxActiveWebSessions) throw fail('SESSION_CAPACITY_REACHED', 'Session capacity reached.', 429);
      // One adult keeps at most N live web sessions: the oldest ones are revoked to make room for this sign-in.
      const mine = await db.many(`SELECT id FROM api_sessions WHERE session_kind = 'web' AND adult_user_id = ? AND revoked_at IS NULL
        AND julianday(expires_at) > julianday(?) ORDER BY created_at DESC, id DESC`, [adultUserId, iso(issuedAt)]);
      for (const old of mine.slice(Math.max(0, this.maxWebSessionsPerAdult - 1))) {
        await db.run("UPDATE api_sessions SET revoked_at = ?, revoked_reason = 'session_limit' WHERE id = ? AND revoked_at IS NULL", [iso(issuedAt), old.id]);
        await this.#audit(householdId, adultUserId, 'auth.session_limit_revoked', old.id);
      }
      const absolute = new Date(issuedAt.getTime() + REFRESH_ABSOLUTE_MS);
      const expires = new Date(issuedAt.getTime() + REFRESH_SLIDING_MS);
      const sessionId = `session-${randomUUID()}`;
      await db.run(`INSERT INTO api_sessions
        (id, adult_user_id, token_sha256, issued_at, expires_at, created_at, session_kind, household_id, amr, absolute_expires_at, last_seen_at, auth_identity_id)
        VALUES (?, ?, NULL, ?, ?, ?, 'web', ?, ?, ?, ?, ?)`,
      [sessionId, adultUserId, iso(issuedAt), iso(expires), iso(issuedAt), householdId, amr, iso(absolute), iso(issuedAt), authIdentityId]);
      const refreshToken = await this.#insertRefreshToken({ sessionId, parentId: null, issuedAt, expires });
      await this.#audit(householdId, adultUserId, 'auth.session_started', sessionId, { sessionKind: 'web', amr });
      return { sessionId, refreshToken: refreshToken.token, expiresAt: iso(expires), absoluteExpiresAt: iso(absolute) };
    }, { locks: [householdLock(householdId), sessionCapacityLock(SESSION_CAPACITY_KEY)] });
  }

  async #insertRefreshToken({ sessionId, parentId, issuedAt, expires }) {
    const token = randomBytes(32).toString('base64url');
    const id = `refresh-${randomUUID()}`;
    await this.database.run(`INSERT INTO auth_refresh_tokens (id, session_id, token_hash, parent_id, issued_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`, [id, sessionId, this.hashRefreshToken(token), parentId, iso(issuedAt), iso(expires)]);
    return { id, token };
  }

  /** The live web session an access token names, or null. Revocation, expiry, the adult and the household are all re-read here. */
  async authenticateWeb({ sessionId, adultId, householdId }) {
    const now = this.clock();
    const at = iso(now);
    const session = await this.database.one(`SELECT api_sessions.id, api_sessions.expires_at, api_sessions.amr, api_sessions.last_seen_at
      FROM api_sessions
      JOIN adult_users ON adult_users.id = api_sessions.adult_user_id
      JOIN households ON households.id = api_sessions.household_id
      LEFT JOIN auth_identities ON auth_identities.id = api_sessions.auth_identity_id
      WHERE api_sessions.id = ? AND api_sessions.session_kind = 'web'
        AND api_sessions.adult_user_id = ? AND api_sessions.household_id = ?
        AND api_sessions.revoked_at IS NULL
        AND julianday(api_sessions.expires_at) > julianday(?)
        AND julianday(api_sessions.absolute_expires_at) > julianday(?)
        AND adult_users.account_status = 'active' AND households.status = 'active'
        AND (api_sessions.auth_identity_id IS NULL OR auth_identities.revoked_at IS NULL)`, [sessionId, adultId, householdId, at, at]);
    if (!session) return null;
    // last_seen_at is a coarse "recently active" marker: written at most once a minute, so a busy session is not a write per request.
    if (!session.last_seen_at || now.getTime() - Date.parse(session.last_seen_at) > LAST_SEEN_STALE_MS) {
      const touched = await this.database.run('UPDATE api_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL', [at, session.id]);
      if (touched.changes !== 1) return null;
    }
    return { sessionId: session.id, adultId, householdId, amr: session.amr, expiresAt: session.expires_at };
  }

  /**
   * Rotates a refresh token. Resolves { status: 'ok', sessionId, adultId, householdId, amr, refreshToken, expiresAt },
   * { status: 'reuse' } (a used token came back: the whole session is revoked and the revocation is committed) or
   * { status: 'invalid' } (unknown, expired, revoked session, inactive adult). Two concurrent calls with one token serialise
   * on the row lock: one rotates, the other sees a used token and counts as reuse.
   */
  async rotateRefreshToken(refreshToken) {
    const hash = this.hashRefreshToken(refreshToken);
    const db = this.database;
    // Unlocked peek for the household id, so the household lock can be taken before any row lock (lock order).
    const peek = await db.one(`SELECT api_sessions.household_id FROM auth_refresh_tokens
      JOIN api_sessions ON api_sessions.id = auth_refresh_tokens.session_id WHERE auth_refresh_tokens.token_hash = ?`, [hash]);
    if (!peek?.household_id) return { status: 'invalid' };
    const outcome = await db.transaction(async () => {
      const row = await db.one(`SELECT t.id, t.session_id, t.used_at, t.expires_at AS token_expires_at,
          s.adult_user_id, s.household_id, s.amr, s.session_kind, s.revoked_at, s.expires_at AS session_expires_at,
          s.absolute_expires_at, a.account_status, h.status AS household_status, ai.revoked_at AS identity_revoked_at
        FROM auth_refresh_tokens t
        JOIN api_sessions s ON s.id = t.session_id
        JOIN adult_users a ON a.id = s.adult_user_id
        JOIN households h ON h.id = s.household_id
        LEFT JOIN auth_identities ai ON ai.id = s.auth_identity_id
        WHERE t.token_hash = ? FOR UPDATE OF t, s`, [hash]);
      if (!row || row.session_kind !== 'web') return { status: 'invalid' };
      const now = this.clock();
      const at = iso(now);
      if (row.used_at) {
        if (row.revoked_at) return { status: 'invalid' };
        await db.run("UPDATE api_sessions SET revoked_at = ?, revoked_reason = 'refresh_reuse' WHERE id = ? AND revoked_at IS NULL", [at, row.session_id]);
        // The revocation commits with this transaction; the audit event is written afterwards, best effort (below).
        return { status: 'reuse', reuse: { householdId: row.household_id, adultId: row.adult_user_id, sessionId: row.session_id, tokenId: row.id } };
      }
      const live = !row.revoked_at && row.account_status === 'active' && row.household_status === 'active' && !row.identity_revoked_at
        && Date.parse(row.token_expires_at) > now.getTime()
        && Date.parse(row.session_expires_at) > now.getTime()
        && Date.parse(row.absolute_expires_at) > now.getTime();
      if (!live) return { status: 'invalid' };
      const expires = new Date(Math.min(now.getTime() + REFRESH_SLIDING_MS, Date.parse(row.absolute_expires_at)));
      await db.run('UPDATE auth_refresh_tokens SET used_at = ? WHERE id = ?', [at, row.id]);
      const next = await this.#insertRefreshToken({ sessionId: row.session_id, parentId: row.id, issuedAt: now, expires });
      await db.run('UPDATE api_sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?', [iso(expires), at, row.session_id]);
      await this.#audit(row.household_id, row.adult_user_id, 'auth.session_refreshed', row.session_id, { refreshTokenId: next.id, parentId: row.id });
      return { status: 'ok', sessionId: row.session_id, adultId: row.adult_user_id, householdId: row.household_id, amr: row.amr, refreshToken: next.token, expiresAt: iso(expires) };
    }, { locks: [householdLock(peek.household_id)] });
    if (outcome.reuse) {
      const { reuse } = outcome;
      // A failing audit write must not turn the 401 into a 500 or undo the revocation, which has already committed.
      try { await this.#audit(reuse.householdId, reuse.adultId, 'auth.refresh_reuse_detected', reuse.sessionId, { refreshTokenId: reuse.tokenId }); } catch { /* best effort */ }
      return { status: 'reuse' };
    }
    return outcome;
  }

  /** The adult's live sessions, newest first, ids and timestamps only. */
  async listSessions({ adultUserId }) {
    const rows = await this.database.many(`SELECT id, session_kind, amr, created_at, last_seen_at, expires_at FROM api_sessions
      WHERE adult_user_id = ? AND revoked_at IS NULL AND julianday(expires_at) > julianday(?)
      ORDER BY created_at DESC, id LIMIT ${LIST_LIMIT}`, [adultUserId, iso(this.clock())]);
    return rows.map(row => ({ id: row.id, kind: row.session_kind, amr: row.amr, createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at }));
  }

  /** Revokes one session of this adult. False when it does not exist, is not theirs or is already revoked. */
  async revokeSession({ sessionId, adultUserId, reason = 'sign_out' }) {
    if (!SIGN_OUT_REASONS.has(reason)) throw new Error('Unknown revocation reason.');
    return this.database.transaction(async () => {
      const row = await this.database.one('SELECT household_id FROM api_sessions WHERE id = ? AND adult_user_id = ?', [sessionId, adultUserId]);
      if (!row) return false;
      const revoked = await this.database.run(`UPDATE api_sessions SET revoked_at = ?, revoked_reason = ?
        WHERE id = ? AND adult_user_id = ? AND revoked_at IS NULL`, [iso(this.clock()), reason, sessionId, adultUserId]);
      if (revoked.changes !== 1) return false;
      await this.#audit(row.household_id, adultUserId, `auth.${reason}`, sessionId);
      return true;
    });
  }

  /** Revokes every live session of the adult (all kinds). Resolves the count. */
  async revokeAllSessions({ adultUserId, householdId = null, reason = 'sign_out_all' }) {
    return this.database.transaction(async () => {
      // Rows locked in id order first, so two overlapping sign-outs or a refresh cannot deadlock on them.
      await this.database.many('SELECT id FROM api_sessions WHERE adult_user_id = ? AND revoked_at IS NULL ORDER BY id FOR UPDATE', [adultUserId]);
      const revoked = await this.database.run(`UPDATE api_sessions SET revoked_at = ?, revoked_reason = ?
        WHERE adult_user_id = ? AND revoked_at IS NULL`, [iso(this.clock()), reason, adultUserId]);
      await this.#audit(householdId, adultUserId, 'auth.sign_out_all', adultUserId, { sessionsRevoked: revoked.changes });
      return revoked.changes;
    });
  }

  /**
   * Deletes what can no longer matter: refresh tokens and web sessions that expired or were revoked more than a day ago, and
   * expired challenges. Resolves the number of refresh tokens, sessions and challenges removed.
   */
  async purgeExpired() {
    const cutoff = iso(new Date(this.clock().getTime() - DAY_MS));
    const tokens = (await this.database.run('DELETE FROM auth_refresh_tokens WHERE julianday(expires_at) < julianday(?)', [cutoff])).changes;
    const sessions = (await this.database.run(`DELETE FROM api_sessions WHERE session_kind = 'web'
      AND (julianday(expires_at) < julianday(?) OR julianday(absolute_expires_at) < julianday(?) OR (revoked_at IS NOT NULL AND julianday(revoked_at) < julianday(?)))`,
    [cutoff, cutoff, cutoff])).changes;
    const challenges = (await this.database.run('DELETE FROM auth_challenges WHERE julianday(expires_at) < julianday(?)', [cutoff])).changes;
    return { tokens, sessions, challenges };
  }

  // ---- Signing keys (public halves) ---------------------------------------------------------------------------------

  async findKey(kid) { return (await this.database.one('SELECT * FROM auth_signing_keys WHERE kid = ?', [kid])) ?? null; }

  async getActiveKey() { return (await this.database.one("SELECT * FROM auth_signing_keys WHERE status = 'active'")) ?? null; }

  /** Keys a verifier may need: active, next (published ahead of activation) and retiring ones still inside their overlap. */
  async listPublishedKeys() {
    return this.database.many(`SELECT kid, alg, public_jwk FROM auth_signing_keys
      WHERE status IN ('active', 'next') OR (status = 'retiring' AND julianday(retire_after) >= julianday(?))
      ORDER BY created_at, kid`, [iso(this.clock())]);
  }

  /** Registers a public key as `next`. The private half stays in the environment. Idempotent for the same kid and key. */
  async registerKey({ kid, publicJwk }) {
    const text = JSON.stringify(publicJwk);
    const inserted = await this.database.run(`INSERT INTO auth_signing_keys (kid, public_jwk, status, created_at)
      VALUES (?, ?, 'next', ?) ON CONFLICT (kid) DO NOTHING`, [kid, text, iso(this.clock())]);
    if (inserted.changes === 0) {
      const existing = await this.findKey(kid);
      const stored = JSON.parse(existing.public_jwk);
      if (stored.x !== publicJwk.x || stored.crv !== publicJwk.crv || stored.kty !== publicJwk.kty) throw fail('AUTH_SIGNING_KEY_CONFLICT', 'That key id is already registered with another key.', 409);
    }
  }

  /** Makes a `next` key active. The previous active key becomes `retiring` and stays valid for the overlap window. */
  async activateKey(kid) {
    return this.database.transaction(async () => {
      const now = this.clock();
      const target = await this.database.one("SELECT kid FROM auth_signing_keys WHERE kid = ? AND status = 'next' FOR UPDATE", [kid]);
      if (!target) throw fail('AUTH_SIGNING_KEY_NOT_FOUND', 'No such key waiting for activation.', 404);
      await this.database.run("UPDATE auth_signing_keys SET status = 'retiring', retire_after = ? WHERE status = 'active'", [iso(new Date(now.getTime() + KEY_OVERLAP_MS))]);
      await this.database.run("UPDATE auth_signing_keys SET status = 'active', activated_at = ? WHERE kid = ?", [iso(now), kid]);
    });
  }

  /** Immediately stops accepting tokens signed with this key. */
  async revokeKey(kid) {
    const revoked = await this.database.run("UPDATE auth_signing_keys SET status = 'revoked', revoked_at = ? WHERE kid = ? AND status <> 'revoked'", [iso(this.clock()), kid]);
    return revoked.changes === 1;
  }
}

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sessionCapacityLock } from '../database/postgres/locks.js';

const digest = token => createHash('sha256').update(token).digest('hex');

// The capacity check counts every active session, so the lock that keeps it true under
// concurrent issuance is one key for all adults.
const SESSION_CAPACITY_KEY = 'global';

// Async PostgreSQL repository (S3.2).
export class AuthRepository {
  constructor(database, { clock = () => new Date(), sessionDurationMs = 8 * 60 * 60 * 1000, maxActiveSessions = 100 } = {}) {
    this.database = database;
    this.clock = clock;
    this.sessionDurationMs = sessionDurationMs;
    this.maxActiveSessions = maxActiveSessions;
  }

  async issueSession({ adultUserId, durationMs = this.sessionDurationMs }) {
    return this.database.transaction(async () => {
      const adult = await this.database.one("SELECT id FROM adult_users WHERE id = ? AND account_status = 'active'", [adultUserId]);
      if (!adult) throw Object.assign(new Error('An active adult account is required.'), { code: 'AUTH_SUBJECT_INVALID', statusCode: 403 });
      if (!Number.isSafeInteger(durationMs) || durationMs < 60_000 || durationMs > 24 * 60 * 60 * 1000) {
        throw new Error('Session duration must be between one minute and 24 hours.');
      }
      const issuedAt = this.clock();
      const { count: activeSessions } = await this.database.one(`SELECT count(*) AS count FROM api_sessions
        WHERE revoked_at IS NULL AND julianday(expires_at) > julianday(?)`, [issuedAt.toISOString()]);
      if (activeSessions >= this.maxActiveSessions) {
        throw Object.assign(new Error('Session capacity reached.'), { code: 'SESSION_CAPACITY_REACHED', statusCode: 429 });
      }
      const expiresAt = new Date(issuedAt.getTime() + durationMs);
      const token = randomBytes(32).toString('base64url');
      const sessionId = `session-${randomUUID()}`;
      await this.database.run(`INSERT INTO api_sessions
        (id, adult_user_id, token_sha256, issued_at, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      [sessionId, adultUserId, digest(token), issuedAt.toISOString(), expiresAt.toISOString(), issuedAt.toISOString()]);
      return { token, sessionId, adultUserId, expiresAt: expiresAt.toISOString() };
    }, { locks: [sessionCapacityLock(SESSION_CAPACITY_KEY)] });
  }

  async authenticate(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
    const at = this.clock().toISOString();
    const session = await this.database.one(`SELECT api_sessions.*, adult_users.account_status
      FROM api_sessions JOIN adult_users ON adult_users.id = api_sessions.adult_user_id
      WHERE api_sessions.token_sha256 = ?
        AND api_sessions.revoked_at IS NULL
        AND julianday(api_sessions.expires_at) > julianday(?)
        AND adult_users.account_status = 'active'`, [digest(token), at]);
    if (!session) return null;
    // A revocation that commits between the read and this update wins: the session is not
    // refreshed and the request is not authenticated.
    const touched = await this.database.run('UPDATE api_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL', [at, session.id]);
    if (touched.changes !== 1) return null;
    return { sessionId: session.id, adultId: session.adult_user_id, expiresAt: session.expires_at };
  }

  async revokeSession({ sessionId, adultUserId }) {
    const at = this.clock().toISOString();
    const revoked = await this.database.run(`UPDATE api_sessions SET revoked_at = ?
      WHERE id = ? AND adult_user_id = ? AND revoked_at IS NULL`, [at, sessionId, adultUserId]);
    return revoked.changes === 1;
  }
}

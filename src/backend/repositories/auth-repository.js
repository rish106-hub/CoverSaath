import { createHash, randomBytes, randomUUID } from 'node:crypto';

const digest = token => createHash('sha256').update(token).digest('hex');

export class AuthRepository {
  constructor(database, { clock = () => new Date(), sessionDurationMs = 8 * 60 * 60 * 1000, maxActiveSessions = 100 } = {}) {
    this.database = database;
    this.clock = clock;
    this.sessionDurationMs = sessionDurationMs;
    this.maxActiveSessions = maxActiveSessions;
  }

  issueSession({ adultUserId, durationMs = this.sessionDurationMs }) {
    const adult = this.database.prepare("SELECT id FROM adult_users WHERE id = ? AND account_status = 'active'").get(adultUserId);
    if (!adult) throw Object.assign(new Error('An active adult account is required.'), { code: 'AUTH_SUBJECT_INVALID', statusCode: 403 });
    if (!Number.isSafeInteger(durationMs) || durationMs < 60_000 || durationMs > 24 * 60 * 60 * 1000) {
      throw new Error('Session duration must be between one minute and 24 hours.');
    }
    const issuedAt = this.clock();
    const activeSessions = this.database.prepare(`SELECT count(*) AS count FROM api_sessions
      WHERE revoked_at IS NULL AND julianday(expires_at) > julianday(?)`).get(issuedAt.toISOString()).count;
    if (activeSessions >= this.maxActiveSessions) {
      throw Object.assign(new Error('Session capacity reached.'), { code: 'SESSION_CAPACITY_REACHED', statusCode: 429 });
    }
    const expiresAt = new Date(issuedAt.getTime() + durationMs);
    const token = randomBytes(32).toString('base64url');
    const sessionId = `session-${randomUUID()}`;
    this.database.prepare(`INSERT INTO api_sessions
      (id, adult_user_id, token_sha256, issued_at, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sessionId, adultUserId, digest(token), issuedAt.toISOString(), expiresAt.toISOString(), issuedAt.toISOString());
    return { token, sessionId, adultUserId, expiresAt: expiresAt.toISOString() };
  }

  authenticate(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
    const at = this.clock().toISOString();
    const session = this.database.prepare(`SELECT api_sessions.*, adult_users.account_status
      FROM api_sessions JOIN adult_users ON adult_users.id = api_sessions.adult_user_id
      WHERE api_sessions.token_sha256 = ?
        AND api_sessions.revoked_at IS NULL
        AND julianday(api_sessions.expires_at) > julianday(?)
        AND adult_users.account_status = 'active'`).get(digest(token), at);
    if (!session) return null;
    this.database.prepare('UPDATE api_sessions SET last_seen_at = ? WHERE id = ?').run(at, session.id);
    return { sessionId: session.id, adultId: session.adult_user_id, expiresAt: session.expires_at };
  }

  revokeSession({ sessionId, adultUserId }) {
    const at = this.clock().toISOString();
    return this.database.prepare(`UPDATE api_sessions SET revoked_at = ?
      WHERE id = ? AND adult_user_id = ? AND revoked_at IS NULL`).run(at, sessionId, adultUserId).changes === 1;
  }
}

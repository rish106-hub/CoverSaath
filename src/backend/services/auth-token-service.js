import { randomUUID } from 'node:crypto';
import { createSharedWindowLimiter } from './shared-window-limiter.js';

// Orchestrates web sessions: mint and verify access tokens, rotate refresh tokens, sign out, list and revoke sessions (ADR 0027).
// Every rejection of a credential is one generic coded error; why a refresh failed (unknown, expired, reused) is in the audit
// trail only. Nothing here logs, and no token, hash or key is ever put in an error, an audit payload or a response other than the
// one that hands the new token to its owner.

const REFRESHES_PER_MINUTE = 20;
const SESSION_CALLS_PER_MINUTE = 60;
const ISSUER_AMR = Object.freeze({ 'https://accounts.google.com': 'google', 'https://appleid.apple.com': 'apple' });

const fail = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode });
const refreshInvalid = () => fail('AUTH_REFRESH_INVALID', 'Sign in again.', 401);

/** How a sign-in issuer is recorded as the authentication method (amr). Unknown issuers are the beta-access method. */
export const amrForIssuer = issuer => ISSUER_AMR[issuer] ?? 'beta';

export function createAuthTokenService({ repository, tokens, clock = () => new Date(), limitStore = null }) {
  // Shared by every API machine through `limitStore` (ADR 0014 D9), so two machines do not double either limit.
  const refreshLimiter = createSharedWindowLimiter({ limit: REFRESHES_PER_MINUTE, store: limitStore, clock: () => clock().getTime() });
  const callLimiter = createSharedWindowLimiter({ limit: SESSION_CALLS_PER_MINUTE, store: limitStore, clock: () => clock().getTime() });
  const limit = async (limiter, key) => {
    try { await limiter.check(key); } catch { throw fail('AUTH_RATE_LIMITED', 'Too many requests. Wait a moment and try again.', 429); }
  };
  const mint = async ({ adultId, householdId, sessionId, amr }) => tokens.sign({ adultId, householdId, sessionId, amr, jti: randomUUID() });

  return Object.freeze({
    get enabled() { return tokens.configured; },

    /** 503 before any session is created when this process cannot sign (no issuer, no private key, no active key row). */
    async requireSigning() {
      if (!(await tokens.canSign())) throw fail('AUTH_NOT_CONFIGURED', 'Token sessions are not configured.', 503);
    },

    /** Access token for a session just created by sign-in (createWebSession). */
    async accessTokenFor({ adultId, householdId, sessionId, amr }) {
      const { token, expiresIn } = await mint({ adultId, householdId, sessionId, amr });
      return { accessToken: token, expiresIn };
    },

    /** Principal for a JWT access token, or a generic 401. Re-reads the session on every call, so revocation is immediate. */
    async authenticate(jwt) {
      const claims = await tokens.verify(jwt);
      const principal = await repository.authenticateWeb({ sessionId: claims.sessionId, adultId: claims.adultId, householdId: claims.householdId });
      if (!principal) throw fail('AUTHENTICATION_REQUIRED', 'Valid authentication is required.', 401);
      return { ...principal, sessionKind: 'web' };
    },

    async refresh(refreshToken) {
      if (typeof refreshToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(refreshToken)) throw refreshInvalid();
      await limit(refreshLimiter, `refresh:${repository.hashRefreshToken(refreshToken)}`);
      await this.requireSigning();
      const result = await repository.rotateRefreshToken(refreshToken);
      if (result.status !== 'ok') throw refreshInvalid();
      const { accessToken, expiresIn } = await this.accessTokenFor(result);
      return { accessToken, refreshToken: result.refreshToken, expiresIn, household: { id: result.householdId } };
    },

    async signOut(principal) {
      await limit(callLimiter, `auth:${principal.adultId}`);
      await repository.revokeSession({ sessionId: principal.sessionId, adultUserId: principal.adultId, reason: 'sign_out' });
      return { signedOut: true };
    },

    async signOutAll(principal) {
      await limit(callLimiter, `auth:${principal.adultId}`);
      const sessionsRevoked = await repository.revokeAllSessions({ adultUserId: principal.adultId, householdId: principal.householdId ?? null });
      return { signedOut: true, sessionsRevoked };
    },

    async listSessions(principal) {
      await limit(callLimiter, `auth:${principal.adultId}`);
      const sessions = await repository.listSessions({ adultUserId: principal.adultId });
      return { sessions: sessions.map(session => ({ ...session, current: session.id === principal.sessionId })) };
    },

    async revokeSession(principal, sessionId) {
      await limit(callLimiter, `auth:${principal.adultId}`);
      if (typeof sessionId !== 'string' || !/^session-[A-Za-z0-9-]{1,100}$/.test(sessionId)) throw fail('AUTH_SESSION_NOT_FOUND', 'Session not found.', 404);
      const revoked = await repository.revokeSession({ sessionId, adultUserId: principal.adultId, reason: 'sign_out' });
      if (!revoked) throw fail('AUTH_SESSION_NOT_FOUND', 'Session not found.', 404);
      return { revoked: true, current: sessionId === principal.sessionId };
    },

    /** Public JWKS: active, next and still-overlapping retiring keys. */
    async jwks() {
      const rows = await repository.listPublishedKeys();
      return { keys: rows.map(row => ({ ...JSON.parse(row.public_jwk), kid: row.kid, alg: row.alg, use: 'sig' })) };
    },
  });
}

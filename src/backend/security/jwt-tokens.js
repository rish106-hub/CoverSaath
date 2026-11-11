import { createPrivateKey, createPublicKey } from 'node:crypto';
import { SignJWT, jwtVerify, errors } from 'jose';

// Access tokens (ADR 0027). EdDSA (Ed25519) only, signed and verified with `jose`; nothing here parses or builds a JWT by hand.
// A token carries ids and a coarse scope, never a name, e-mail or phone number:
//   { iss, aud:"knowvia-bff", sub:<adult id>, hid:<household id>, sid:<session id>, jti, iat, exp, scp:["household:rw"], amr, knd:"web" }
// A valid signature is necessary, not sufficient: the caller (AuthTokenService) also checks that session `sid` is still live.
//
// Private keys come from the environment only: KNOWVIA_JWT_PRIVATE_KEY_<kid> holds the base64 PKCS#8 DER of an Ed25519 key,
// where <kid> is letters, digits and underscores (8 to 64). A private key is never written to the database, a log or an error.
// Public halves are rows in auth_signing_keys (status next, active, retiring, revoked) and are published as a JWKS.

export const ACCESS_AUDIENCE = 'knowvia-bff';
export const ACCESS_TOKEN_TYPE = 'at+jwt';
export const ACCESS_TTL_SECONDS = 600;
export const ACCESS_SCOPE = 'household:rw';
export const TOKEN_KIND = 'web';
const MAX_TOKEN_LENGTH = 2048;
const KID = /^[A-Za-z0-9_-]{8,64}$/;
const PRIVATE_KEY_ENV = /^KNOWVIA_JWT_PRIVATE_KEY_([A-Za-z0-9_]{8,64})$/;
const AMR = new Set(['beta', 'google', 'apple', 'email_otp', 'phone_otp', 'passkey', 'demo']);

function coded(code, message, statusCode, reason) {
  return Object.assign(new Error(message), { code, statusCode, ...(reason ? { reason } : {}) });
}
// One client-safe error for every rejection; `reason` is for tests and server-side diagnosis and is never serialised.
const rejected = reason => coded('AUTHENTICATION_REQUIRED', 'Valid authentication is required.', 401, reason);

/** Loads Ed25519 private keys named in `env`. Returns Map<kid, KeyObject>. Throws a coded error (no key text) when one is unusable. */
export function readJwtPrivateKeys(env = process.env) {
  const keys = new Map();
  for (const [name, value] of Object.entries(env)) {
    const match = PRIVATE_KEY_ENV.exec(name);
    if (!match || value === undefined || value === '') continue;
    try {
      const key = createPrivateKey({ key: Buffer.from(String(value).trim(), 'base64'), format: 'der', type: 'pkcs8' });
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('type');
      keys.set(match[1], key);
    } catch {
      throw coded('AUTH_SIGNING_KEY_INVALID', `${name} is not a base64 PKCS#8 Ed25519 private key.`, 500);
    }
  }
  return keys;
}

/** Issuer URL from KNOWVIA_JWT_ISSUER (https, or http on loopback for development). Null when unset. */
export function readJwtIssuer(env = process.env) {
  const value = env.KNOWVIA_JWT_ISSUER;
  if (value === undefined || value === '') return null;
  let url;
  try { url = new URL(value); } catch { throw coded('AUTH_NOT_CONFIGURED', 'KNOWVIA_JWT_ISSUER must be a URL.', 500); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) || url.search || url.hash) {
    throw coded('AUTH_NOT_CONFIGURED', 'KNOWVIA_JWT_ISSUER must be an https URL without query or fragment.', 500);
  }
  return value;
}

/** The public JWK (OKP / Ed25519) for a private key, as stored in auth_signing_keys.public_jwk. */
export function publicJwkFor(privateKey) {
  const { kty, crv, x } = createPublicKey(privateKey).export({ format: 'jwk' });
  return { kty, crv, x };
}

/**
 * keyStore: { getActive() -> row|null, find(kid) -> row|null }, rows from auth_signing_keys (kid, status, public_jwk text, retire_after).
 * privateKeys: Map<kid, KeyObject>.
 */
export function createJwtTokens({ issuer, privateKeys = new Map(), keyStore, clock = () => new Date(), ttlSeconds = ACCESS_TTL_SECONDS, audience = ACCESS_AUDIENCE }) {
  const publicKeyCache = new Map();
  const publicKey = row => {
    let key = publicKeyCache.get(row.public_jwk);
    if (!key) {
      key = createPublicKey({ key: JSON.parse(row.public_jwk), format: 'jwk' });
      if (key.asymmetricKeyType !== 'ed25519') throw rejected('key_type');
      publicKeyCache.set(row.public_jwk, key);
    }
    return key;
  };
  const verifiableAt = (row, now) => row
    && (row.status === 'active' || (row.status === 'retiring' && row.retire_after && Date.parse(row.retire_after) >= now.getTime()));

  return Object.freeze({
    issuer,
    ttlSeconds,
    /** True when an issuer is configured. Signing additionally needs an active key whose private half is in this process. */
    get configured() { return Boolean(issuer) && privateKeys.size > 0; },
    async canSign() {
      if (!this.configured) return false;
      const active = await keyStore.getActive();
      return Boolean(active && privateKeys.has(active.kid));
    },

    async sign({ adultId, householdId, sessionId, amr, jti }) {
      if (!AMR.has(amr)) throw coded('AUTH_NOT_CONFIGURED', 'Unsupported authentication method.', 500);
      const active = this.configured ? await keyStore.getActive() : null;
      const privateKey = active && privateKeys.get(active.kid);
      if (!privateKey) throw coded('AUTH_NOT_CONFIGURED', 'Token signing is not configured.', 503);
      const now = clock();
      const issuedAt = Math.floor(now.getTime() / 1000);
      const token = await new SignJWT({ hid: householdId, sid: sessionId, scp: [ACCESS_SCOPE], amr, knd: TOKEN_KIND })
        .setProtectedHeader({ alg: 'EdDSA', kid: active.kid, typ: ACCESS_TOKEN_TYPE })
        .setIssuer(issuer).setAudience(audience).setSubject(adultId).setJti(jti)
        .setIssuedAt(issuedAt).setExpirationTime(issuedAt + ttlSeconds)
        .sign(privateKey);
      return { token, expiresIn: ttlSeconds };
    },

    /** Verifies signature, algorithm, type, issuer, audience, expiry and claim shape. Resolves the claims or throws 401. */
    async verify(token) {
      if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !issuer) throw rejected('shape');
      const now = clock();
      let payload;
      try {
        ({ payload } = await jwtVerify(token, async header => {
          if (header.alg !== 'EdDSA' || typeof header.kid !== 'string' || !KID.test(header.kid)) throw rejected('header');
          const row = await keyStore.find(header.kid);
          if (!verifiableAt(row, now)) throw rejected('key');
          return publicKey(row);
        }, {
          algorithms: ['EdDSA'], issuer, audience, typ: ACCESS_TOKEN_TYPE, currentDate: now, clockTolerance: 0,
          requiredClaims: ['iss', 'aud', 'exp', 'sub', 'sid'],
        }));
      } catch (error) {
        // jose errors also carry a `reason`, so recognise our own by code.
        if (error?.code === 'AUTHENTICATION_REQUIRED') throw error;
        if (error instanceof errors.JWTExpired) throw rejected('expired');
        if (error instanceof errors.JOSEAlgNotAllowed) throw rejected('alg');
        if (error instanceof errors.JWSSignatureVerificationFailed) throw rejected('signature');
        if (error instanceof errors.JWTClaimValidationFailed) throw rejected(`claim_${error.claim ?? 'unknown'}`);
        throw rejected('invalid');
      }
      const text = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
      if (payload.knd !== TOKEN_KIND) throw rejected('claim_knd');
      if (!text(payload.sub) || !text(payload.sid) || !text(payload.hid) || !text(payload.jti)) throw rejected('claim_shape');
      if (!Array.isArray(payload.scp) || !payload.scp.includes(ACCESS_SCOPE) || !AMR.has(payload.amr)) throw rejected('claim_scope');
      return { adultId: payload.sub, householdId: payload.hid, sessionId: payload.sid, amr: payload.amr, expiresAt: new Date(payload.exp * 1000).toISOString() };
    },
  });
}

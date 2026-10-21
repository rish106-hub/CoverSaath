// Signed operator actions for the trusted insurer-source workflow (ADR 0010). Pure: node:crypto only, no clock, no store.
//
// A checker's check or publish is a JSON payload signed with the checker's own Ed25519 private key. The public key is
// registered with the checker grant, so the repository verifies who approved without trusting an id typed by whoever runs
// the tooling. The payload binds the exact submission, the facts digest the checker read and the digest of their own copy
// of the source; a single-use nonce and a short validity window stop replay. The envelope is { payload, signature }:
// `payload` is the canonical JSON string that was signed, never re-serialised by the verifier.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';

export const CURATED_ACTION_VERSION = 'curated-action/v1';
export const CURATED_ACTIONS = Object.freeze(['check', 'publish']);
export const MAX_ACTION_VALIDITY_MS = 10 * 60_000;
export const ACTION_CLOCK_SKEW_MS = 60_000;

const SHA256 = /^[0-9a-f]{64}$/;
const NONCE = /^[0-9a-f]{32}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_ENVELOPE_CHARS = 4096;

// Field order is fixed per action; the canonical string is JSON.stringify over exactly these keys in this order.
const FIELDS = Object.freeze({
  check: ['v', 'action', 'submissionId', 'checkerId', 'decision', 'reasonCode', 'observedSha256', 'factsSha256', 'quotesReviewed', 'nonce', 'issuedAt', 'expiresAt'],
  publish: ['v', 'action', 'submissionId', 'checkerId', 'observedSha256', 'factsSha256', 'nonce', 'issuedAt', 'expiresAt'],
});

export class CuratedActionError extends Error {
  constructor(code, message, statusCode) { super(message); this.code = code; this.statusCode = statusCode; }
}
const malformed = message => new CuratedActionError('SOURCE_ACTION_MALFORMED', message, 400);

function canonical(action, fields) {
  return JSON.stringify(Object.fromEntries(FIELDS[action].map(key => [key, fields[key]])));
}

function checkFields(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw malformed('The signed action payload is not an object.');
  if (payload.v !== CURATED_ACTION_VERSION) throw malformed('The signed action version is not supported.');
  if (!CURATED_ACTIONS.includes(payload.action)) throw malformed('The signed action is not supported.');
  const keys = Object.keys(payload);
  const expected = FIELDS[payload.action];
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) throw malformed('The signed action fields are not canonical.');
  if (!ID.test(String(payload.submissionId)) || !ID.test(String(payload.checkerId))) throw malformed('The signed action ids are malformed.');
  if (!NONCE.test(String(payload.nonce))) throw malformed('The signed action nonce is malformed.');
  if (!ISO_INSTANT.test(String(payload.issuedAt)) || !ISO_INSTANT.test(String(payload.expiresAt))) throw malformed('The signed action times are malformed.');
  const span = Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt);
  if (!(span > 0 && span <= MAX_ACTION_VALIDITY_MS)) throw malformed('The signed action validity window is not allowed.');
  if (payload.factsSha256 !== null && !SHA256.test(String(payload.factsSha256))) throw malformed('factsSha256 is malformed.');
  if (payload.observedSha256 !== null && !SHA256.test(String(payload.observedSha256))) throw malformed('observedSha256 is malformed.');
  if (payload.action === 'publish' && (payload.factsSha256 === null || payload.observedSha256 === null)) throw malformed('A publish action must attest the facts and source digests.');
  if (payload.action === 'check') {
    if (!['accept', 'reject'].includes(payload.decision)) throw malformed('decision is not supported.');
    if (typeof payload.reasonCode !== 'string' || payload.reasonCode.length > 60) throw malformed('reasonCode is malformed.');
    if (typeof payload.quotesReviewed !== 'boolean') throw malformed('The quotation attestation must be a boolean.');
  }
  return payload;
}

/** Ed25519 public key as base64 SPKI DER. Anything else is refused. */
export function parsePublicKey(publicKey) {
  if (typeof publicKey !== 'string' || publicKey.length < 40 || publicKey.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) return null;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') return null;
    // Round-trip so a non-canonical encoding of the same key is not stored as a different string.
    return key.export({ format: 'der', type: 'spki' }).toString('base64') === publicKey ? key : null;
  } catch { return null; }
}

export const keyFingerprint = publicKey => createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex').slice(0, 16);

/** Checker-side key generation. The private key is PKCS#8 PEM, encrypted when a passphrase is given. */
export function generateCheckerKeyPair({ passphrase = null } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export(passphrase ? { format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase } : { format: 'pem', type: 'pkcs8' });
  const publicB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return { publicKey: publicB64, privateKeyPem: privatePem, fingerprint: keyFingerprint(publicB64) };
}

/**
 * Checker-side signing. `now` is the signer's clock; validity defaults to five minutes. Returns the envelope to hand to the
 * operator. The private key never leaves the signer.
 */
export function signCuratedAction({ privateKeyPem, passphrase = null, action, now = new Date(), validityMs = 5 * 60_000, nonce = randomBytes(16).toString('hex'), ...fields }) {
  if (!CURATED_ACTIONS.includes(action)) throw malformed('The signed action is not supported.');
  const issuedAt = now.toISOString();
  const payload = canonical(action, {
    v: CURATED_ACTION_VERSION, action, nonce, issuedAt, expiresAt: new Date(now.getTime() + validityMs).toISOString(),
    observedSha256: fields.observedSha256 ?? null, factsSha256: fields.factsSha256 ?? null,
    submissionId: fields.submissionId, checkerId: fields.checkerId,
    decision: fields.decision, reasonCode: fields.reasonCode,
    quotesReviewed: fields.quotesReviewed === true,
  });
  checkFields(JSON.parse(payload));
  const key = createPrivateKey(passphrase ? { key: privateKeyPem, passphrase } : privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') throw malformed('The signing key must be Ed25519.');
  return { payload, signature: sign(null, Buffer.from(payload, 'utf8'), key).toString('base64') };
}

/** Shape-checks an envelope and returns its parsed payload. Does not verify the signature (the key comes from the grant). */
export function readCuratedAction(envelope) {
  if (!envelope || typeof envelope !== 'object' || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string'
    || envelope.payload.length > MAX_ENVELOPE_CHARS || envelope.signature.length > 200) throw malformed('The signed action envelope is malformed.');
  let payload;
  try { payload = JSON.parse(envelope.payload); } catch { throw malformed('The signed action payload is not JSON.'); }
  checkFields(payload);
  if (canonical(payload.action, payload) !== envelope.payload) throw malformed('The signed action payload is not canonical.');
  return Object.freeze(payload);
}

/** True only when `signature` is a valid Ed25519 signature by `publicKey` over the exact payload string. */
export function verifyCuratedActionSignature(publicKey, envelope) {
  const key = parsePublicKey(publicKey);
  if (!key) return false;
  try { return verify(null, Buffer.from(envelope.payload, 'utf8'), key, Buffer.from(envelope.signature, 'base64')); } catch { return false; }
}

/** Freshness against the verifier's clock: not issued in the future beyond the skew allowance, not past expiry. */
export function curatedActionTimely(payload, nowMs) {
  return Date.parse(payload.issuedAt) - ACTION_CLOCK_SKEW_MS <= nowMs && nowMs <= Date.parse(payload.expiresAt);
}

/**
 * The stored form of a fact list (as proposeFacts writes `facts_json`). Its SHA-256 is the `factsSha256` a checker signs, so
 * the signer computes it from the facts they actually reviewed instead of copying a digest from the operator.
 */
export function canonicalCuratedFacts(facts) {
  if (!Array.isArray(facts)) throw malformed('facts must be an array.');
  return JSON.stringify(facts.map(f => ({ factType: f?.factType, topic: f?.topic ?? 'general', value: f?.value, page: f?.page, quote: f?.quote })));
}

export const signatureDigest = envelope => createHash('sha256').update(envelope.signature).digest('hex');

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  ENVELOPE_PREFIX, createColumnCrypto, readDataEncryptionConfig, resolveColumnCrypto,
} from '../src/backend/security/column-crypto.js';
import { queryTerms, scoreClause, stem } from '../src/backend/repositories/clause-text-search.js';

// E1b (ADR 0013): the column-crypto module. Keys are generated here and never written anywhere. Synthetic values only.

const b64 = () => randomBytes(32).toString('base64');
const make = (extra = {}) => createColumnCrypto(readDataEncryptionConfig({ DATA_ENCRYPTION_KEY_BASE64: b64(), ...extra }));

test('round trip: seal gives an enc1 envelope, open returns the text, every call uses a fresh nonce', () => {
  const crypto = make();
  const a = crypto.seal('adult_users', 'contact_email', 'adult-1', 'asha@example.test');
  const b = crypto.seal('adult_users', 'contact_email', 'adult-1', 'asha@example.test');
  assert.match(a, /^enc1\.k1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b, 'a new nonce each time');
  assert.ok(!a.includes('asha'));
  assert.equal(crypto.open('adult_users', 'contact_email', 'adult-1', a), 'asha@example.test');
  assert.equal(crypto.seal('t', 'c', 'r', null), null);
  assert.equal(crypto.open('t', 'c', 'r', null), null);
  assert.equal(crypto.open('t', 'c', 'r', crypto.seal('t', 'c', 'r', '')), '', 'an empty string round trips');
  const unicode = 'नमस्ते Asha — ₹5,000';
  assert.equal(crypto.open('t', 'c', 'r', crypto.seal('t', 'c', 'r', unicode)), unicode);
  assert.deepEqual(crypto.openJson('t', 'c', 'r', crypto.sealJson('t', 'c', 'r', { limit: 5000, ok: false })), { limit: 5000, ok: false });
  assert.equal(crypto.sealJson('t', 'c', 'r', null), null);
  assert.equal(crypto.isSealed(a), true);
  assert.equal(crypto.isSealed('plain'), false);
});

test('a wrong table, column or row id fails to open: ciphertext cannot be moved', () => {
  const crypto = make();
  const sealed = crypto.seal('adult_users', 'display_name', 'adult-1', 'Asha Synthetic');
  for (const [table, column, row] of [['household_members', 'display_name', 'adult-1'], ['adult_users', 'contact_email', 'adult-1'], ['adult_users', 'display_name', 'adult-2']]) {
    assert.throws(() => crypto.open(table, column, row, sealed), { code: 'COLUMN_DECRYPTION_FAILED' });
  }
  assert.throws(() => crypto.seal('', 'c', 'r', 'x'), { code: 'COLUMN_ENCRYPTION_CONTEXT_INVALID' });
  assert.throws(() => crypto.seal('t', 'c', 'r', 5), { code: 'COLUMN_ENCRYPTION_CONTEXT_INVALID' });
});

test('a wrong key, a tampered part or a malformed envelope fails closed and the error carries no value', () => {
  const crypto = make();
  const sealed = crypto.seal('t', 'c', 'r', 'secret synthetic value');
  const other = make();
  assert.throws(() => other.open('t', 'c', 'r', sealed), error => error.code === 'COLUMN_DECRYPTION_FAILED' && !error.message.includes('secret'));
  const parts = sealed.split('.');
  const flip = value => (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
  for (const index of [2, 3, 4]) {
    const copy = [...parts];
    copy[index] = flip(copy[index]);
    assert.throws(() => crypto.open('t', 'c', 'r', copy.join('.')), { code: 'COLUMN_DECRYPTION_FAILED' }, `part ${index}`);
  }
  for (const bad of [`${ENVELOPE_PREFIX}k1.a.b`, `${ENVELOPE_PREFIX}k1.a.b.c.d`, `${ENVELOPE_PREFIX}k1.!!.b.c`, `${ENVELOPE_PREFIX}nokey.${parts[2]}.${parts[3]}.${parts[4]}`, ENVELOPE_PREFIX]) {
    assert.throws(() => crypto.open('t', 'c', 'r', bad), { code: 'COLUMN_DECRYPTION_FAILED' }, bad);
  }
  assert.throws(() => crypto.open('t', 'c', 'r', 42), { code: 'COLUMN_DECRYPTION_FAILED' });
});

test('key rotation: an old key id still opens, new writes use the new id, needsRotation says which to re-seal', () => {
  const oldKey = b64();
  const before = createColumnCrypto(readDataEncryptionConfig({ DATA_ENCRYPTION_KEY_BASE64: oldKey, DATA_ENCRYPTION_KEY_ID: 'k0' }));
  const legacySealed = before.seal('t', 'c', 'r', 'value');
  const after = createColumnCrypto(readDataEncryptionConfig({
    DATA_ENCRYPTION_KEY_BASE64: b64(), DATA_ENCRYPTION_KEY_ID: 'k1', DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: JSON.stringify({ k0: oldKey }),
  }));
  assert.equal(after.open('t', 'c', 'r', legacySealed), 'value');
  assert.match(after.seal('t', 'c', 'r', 'value'), /^enc1\.k1\./);
  assert.equal(after.needsRotation(legacySealed), true);
  assert.equal(after.needsRotation(after.seal('t', 'c', 'r', 'v')), false);
  assert.throws(() => before.open('t', 'c', 'r', after.seal('t', 'c', 'r', 'v')), { code: 'COLUMN_DECRYPTION_FAILED' });
  // Without the old key in the previous list the old value cannot be opened.
  const lost = createColumnCrypto(readDataEncryptionConfig({ DATA_ENCRYPTION_KEY_BASE64: b64(), DATA_ENCRYPTION_KEY_ID: 'k1' }));
  assert.throws(() => lost.open('t', 'c', 'r', legacySealed), { code: 'COLUMN_DECRYPTION_FAILED' });
});

test('legacy plaintext is readable until the backfill, and refused once DATA_ENCRYPTION_LEGACY_PLAINTEXT=false', () => {
  const crypto = make();
  assert.equal(crypto.open('t', 'c', 'r', 'plain legacy text'), 'plain legacy text');
  assert.equal(crypto.open('t', 'c', 'r', '{"a":1}'), '{"a":1}');
  assert.deepEqual(crypto.openJson('t', 'c', 'r', '{"a":1}'), { a: 1 });
  const strict = make({ DATA_ENCRYPTION_LEGACY_PLAINTEXT: 'false' });
  assert.throws(() => strict.open('t', 'c', 'r', 'plain legacy text'), { code: 'COLUMN_DECRYPTION_FAILED' });
  assert.equal(strict.open('t', 'c', 'r', strict.seal('t', 'c', 'r', 'ok')), 'ok');
});

test('configuration: the key is required in production and when DATA_ENCRYPTION_REQUIRED=true; bad values fail at startup', () => {
  assert.throws(() => readDataEncryptionConfig({ NODE_ENV: 'production' }), { code: 'DATA_ENCRYPTION_KEY_REQUIRED' });
  assert.throws(() => readDataEncryptionConfig({ DATA_ENCRYPTION_REQUIRED: 'true' }), { code: 'DATA_ENCRYPTION_KEY_REQUIRED' });
  assert.ok(readDataEncryptionConfig({ NODE_ENV: 'production', DATA_ENCRYPTION_KEY_BASE64: b64() }));
  for (const env of [
    { DATA_ENCRYPTION_KEY_BASE64: 'not base64 at all!!' }, { DATA_ENCRYPTION_KEY_BASE64: randomBytes(16).toString('base64') },
    { DATA_ENCRYPTION_KEY_BASE64: b64(), DATA_ENCRYPTION_KEY_ID: 'has.dot' }, { DATA_ENCRYPTION_KEY_BASE64: b64(), DATA_ENCRYPTION_KEY_ID: '' , DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: '[]' },
    { DATA_ENCRYPTION_KEY_BASE64: b64(), DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: '{bad' },
    { DATA_ENCRYPTION_KEY_BASE64: b64(), DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: JSON.stringify({ k1: b64() }) },
    { DATA_ENCRYPTION_KEY_BASE64: b64(), DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: JSON.stringify({ k0: 'short' }) },
    { DATA_ENCRYPTION_REQUIRED: 'yes' }, { DATA_ENCRYPTION_LEGACY_PLAINTEXT: 'no' },
  ]) {
    assert.throws(() => readDataEncryptionConfig(env), error => /^DATA_ENCRYPTION_KEY_/.test(error.code), JSON.stringify(Object.keys(env)));
  }
  // The development key is only for non-production runs without a key, and says so.
  const dev = createColumnCrypto(readDataEncryptionConfig({}));
  assert.equal(dev.developmentKey, true);
  assert.equal(dev.keyId, 'dev');
  assert.equal(make().developmentKey, false);
  // No error message ever carries key text.
  const key = b64();
  try { readDataEncryptionConfig({ DATA_ENCRYPTION_KEY_BASE64: key, DATA_ENCRYPTION_KEY_ID: 'bad.id' }); } catch (error) {
    assert.ok(!error.message.includes(key));
  }
});

test('resolveColumnCrypto prefers an injected instance, then options.env, then the process-wide one', () => {
  const injected = make();
  assert.equal(resolveColumnCrypto({ columnCrypto: injected, env: {} }), injected);
  assert.throws(() => resolveColumnCrypto({ env: { NODE_ENV: 'production' } }), { code: 'DATA_ENCRYPTION_KEY_REQUIRED' });
  const fromEnv = resolveColumnCrypto({ env: { DATA_ENCRYPTION_KEY_BASE64: b64() } });
  assert.equal(fromEnv.developmentKey, false);
  assert.ok(resolveColumnCrypto({}).seal('t', 'c', 'r', 'x'));
});

test('openRow opens the named columns with the row id and leaves others alone', () => {
  const crypto = make();
  const row = { id: 'adult-9', display_name: crypto.seal('adult_users', 'display_name', 'adult-9', 'Asha'), contact_email: null, locale: 'en-IN' };
  assert.deepEqual(crypto.openRow('adult_users', row, ['display_name', 'contact_email', 'contact_phone']), { id: 'adult-9', display_name: 'Asha', contact_email: null, locale: 'en-IN' });
  assert.equal(crypto.openRow('adult_users', null, ['display_name']), null);
});

test('clause text search: Porter stemming, stop words, any-term ranking', () => {
  assert.equal(stem('cataracts'), stem('cataract'));
  assert.equal(stem('charges'), stem('charge'));
  assert.equal(stem('waiting'), stem('waits'));
  assert.deepEqual(queryTerms('the room rent of a plan'), [stem('room'), stem('rent'), stem('plan')]);
  assert.deepEqual(queryTerms('*** "" !| &'), []);
  assert.deepEqual(queryTerms('x'), [], 'single characters are not words');
  assert.equal(queryTerms(Array.from({ length: 50 }, (_, i) => `word${i}`).join(' '), 24).length, 24);
  const terms = queryTerms('cataract waiting');
  assert.ok(scoreClause(terms, 'Cataract surgery has a waiting period of two years.') > scoreClause(terms, 'Cataract is covered.'));
  assert.equal(scoreClause(terms, 'Maternity expenses are listed separately.'), 0);
  assert.ok(scoreClause(terms, 'unrelated text', 'Cataract waiting period') > 0, 'the title counts');
  assert.equal(scoreClause([], 'anything'), 0);
});

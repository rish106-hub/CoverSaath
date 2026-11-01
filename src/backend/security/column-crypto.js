import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Application-level column encryption (ADR 0013). Sensitive text columns hold an envelope string
//
//   enc1.<keyId>.<b64url nonce 12>.<b64url tag 16>.<b64url ciphertext>
//
// sealed with AES-256-GCM. The additional authenticated data is `table.column.rowId`, so a ciphertext cannot be moved to
// another row or column. Writes always seal. Reads accept a value without the `enc1.` prefix as legacy plaintext (rows
// written before the backfill) unless allowLegacyPlaintext is false. SQL must never search sealed columns.
//
// Keys come from the environment (names only here, never values):
//   DATA_ENCRYPTION_KEY_BASE64            32 bytes, base64. Required in production or when DATA_ENCRYPTION_REQUIRED=true.
//   DATA_ENCRYPTION_KEY_ID                id of that key, default k1 (letters, digits, - and _ , 1-16 chars).
//   DATA_ENCRYPTION_PREVIOUS_KEYS_JSON    {"k0":"<base64 32 bytes>"} older keys that can still decrypt (rotation).
//   DATA_ENCRYPTION_REQUIRED              "true" forces the key even outside production.
//   DATA_ENCRYPTION_LEGACY_PLAINTEXT      "false" refuses unprefixed values on read (after the backfill).
// Outside production, with no key and no requirement, a fixed development key is used. It is public in this repository,
// so it protects nothing; it exists so local runs and tests need no setup. Production never reaches that branch.

export const ENVELOPE_PREFIX = 'enc1.';
const KEY_ID = /^[A-Za-z0-9_-]{1,16}$/;
const B64URL = /^[A-Za-z0-9_-]*$/;
const DEV_KEY_ID = 'dev';

function coded(code, message, statusCode = 500) {
  return Object.assign(new Error(message), { code, statusCode });
}

function decodeKey(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw coded('DATA_ENCRYPTION_KEY_INVALID', `${name} is invalid.`);
  const key = Buffer.from(value.trim(), 'base64');
  if (key.length !== 32) throw coded('DATA_ENCRYPTION_KEY_INVALID', `${name} must decode to 32 bytes.`);
  return key;
}

/** Reads and validates the settings. Throws a coded error at startup when they are unusable. Never returns key text. */
export function readDataEncryptionConfig(env = process.env) {
  const required = env.NODE_ENV === 'production' || env.DATA_ENCRYPTION_REQUIRED === 'true';
  if (env.DATA_ENCRYPTION_REQUIRED !== undefined && !['true', 'false'].includes(env.DATA_ENCRYPTION_REQUIRED)) {
    throw coded('DATA_ENCRYPTION_KEY_INVALID', 'Invalid DATA_ENCRYPTION_REQUIRED.');
  }
  if (env.DATA_ENCRYPTION_LEGACY_PLAINTEXT !== undefined && !['true', 'false'].includes(env.DATA_ENCRYPTION_LEGACY_PLAINTEXT)) {
    throw coded('DATA_ENCRYPTION_KEY_INVALID', 'Invalid DATA_ENCRYPTION_LEGACY_PLAINTEXT.');
  }
  const allowLegacyPlaintext = env.DATA_ENCRYPTION_LEGACY_PLAINTEXT !== 'false';
  const configured = env.DATA_ENCRYPTION_KEY_BASE64 || null;
  const keys = new Map();
  let currentId;
  if (configured) {
    currentId = env.DATA_ENCRYPTION_KEY_ID || 'k1';
    if (!KEY_ID.test(currentId)) throw coded('DATA_ENCRYPTION_KEY_INVALID', 'Invalid DATA_ENCRYPTION_KEY_ID.');
    keys.set(currentId, decodeKey(configured, 'DATA_ENCRYPTION_KEY_BASE64'));
  } else if (required) {
    throw coded('DATA_ENCRYPTION_KEY_REQUIRED', 'A data encryption key is required (DATA_ENCRYPTION_KEY_BASE64).');
  } else {
    currentId = DEV_KEY_ID;
    keys.set(DEV_KEY_ID, createHash('sha256').update('cover-saath development column key, not a secret').digest());
  }
  if (env.DATA_ENCRYPTION_PREVIOUS_KEYS_JSON) {
    let previous;
    try { previous = JSON.parse(env.DATA_ENCRYPTION_PREVIOUS_KEYS_JSON); } catch {
      throw coded('DATA_ENCRYPTION_KEY_INVALID', 'Invalid DATA_ENCRYPTION_PREVIOUS_KEYS_JSON.');
    }
    if (previous === null || typeof previous !== 'object' || Array.isArray(previous)) {
      throw coded('DATA_ENCRYPTION_KEY_INVALID', 'Invalid DATA_ENCRYPTION_PREVIOUS_KEYS_JSON.');
    }
    for (const [id, value] of Object.entries(previous)) {
      if (!KEY_ID.test(id) || keys.has(id)) throw coded('DATA_ENCRYPTION_KEY_INVALID', 'Invalid DATA_ENCRYPTION_PREVIOUS_KEYS_JSON.');
      keys.set(id, decodeKey(value, 'DATA_ENCRYPTION_PREVIOUS_KEYS_JSON'));
    }
  }
  return Object.freeze({ currentId, keys, allowLegacyPlaintext, developmentKey: !configured });
}

const aad = (table, column, rowId) => {
  if (typeof table !== 'string' || typeof column !== 'string' || typeof rowId !== 'string' || !table || !column || !rowId) {
    throw coded('COLUMN_ENCRYPTION_CONTEXT_INVALID', 'Column encryption needs a table, a column and a row id.');
  }
  return Buffer.from(`${table}.${column}.${rowId}`);
};

/** Builds the sealer/opener. `config` comes from readDataEncryptionConfig. */
export function createColumnCrypto(config = readDataEncryptionConfig()) {
  const { currentId, keys, allowLegacyPlaintext } = config;
  const currentKey = keys.get(currentId);

  function seal(table, column, rowId, plaintext) {
    if (plaintext === null || plaintext === undefined) return null;
    if (typeof plaintext !== 'string') throw coded('COLUMN_ENCRYPTION_CONTEXT_INVALID', 'Only text can be sealed.');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', currentKey, nonce);
    cipher.setAAD(aad(table, column, rowId));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `${ENVELOPE_PREFIX}${currentId}.${nonce.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
  }

  const failed = () => coded('COLUMN_DECRYPTION_FAILED', 'A stored value could not be decrypted.');

  function open(table, column, rowId, stored) {
    if (stored === null || stored === undefined) return null;
    if (typeof stored !== 'string') throw failed();
    if (!stored.startsWith(ENVELOPE_PREFIX)) {
      if (allowLegacyPlaintext) return stored;
      throw failed();
    }
    const parts = stored.slice(ENVELOPE_PREFIX.length).split('.');
    if (parts.length !== 4 || !parts.every(part => B64URL.test(part))) throw failed();
    const key = keys.get(parts[0]);
    if (!key) throw failed();
    try {
      const nonce = Buffer.from(parts[1], 'base64url');
      const tag = Buffer.from(parts[2], 'base64url');
      if (nonce.length !== 12 || tag.length !== 16) throw new Error('shape');
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(aad(table, column, rowId));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw failed();
    }
  }

  return Object.freeze({
    keyId: currentId,
    developmentKey: config.developmentKey === true,
    allowLegacyPlaintext,
    seal,
    open,
    sealJson: (table, column, rowId, value) => (value === null || value === undefined ? null : seal(table, column, rowId, JSON.stringify(value))),
    openJson: (table, column, rowId, stored) => {
      const text = open(table, column, rowId, stored);
      if (text === null) return null;
      try { return JSON.parse(text); } catch { throw failed(); }
    },
    isSealed: value => typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX),
    /** True when a sealed value was written under a key other than the current one (needs rotation). */
    needsRotation: value => typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX)
      && value.slice(ENVELOPE_PREFIX.length).split('.')[0] !== currentId,
    /** Copy of `row` with the named columns opened, using row[idColumn] as the row id. */
    openRow(table, row, columns, idColumn = 'id') {
      if (!row) return row;
      const copy = { ...row };
      for (const column of columns) if (column in copy) copy[column] = open(table, column, row[idColumn], row[column]);
      return copy;
    },
  });
}

let shared = null;
/** One crypto per process for callers that were not handed one (tests, scripts). */
export function sharedColumnCrypto() {
  shared ??= createColumnCrypto(readDataEncryptionConfig(process.env));
  return shared;
}

/** The crypto an options bag carries, else one built from options.env, else the process-wide one. */
export function resolveColumnCrypto(options = {}) {
  if (options.columnCrypto) return options.columnCrypto;
  if (options.env) return createColumnCrypto(readDataEncryptionConfig(options.env));
  return sharedColumnCrypto();
}

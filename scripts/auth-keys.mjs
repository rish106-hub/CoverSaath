// auth:keys: JWT signing-key lifecycle for DATABASE_URL (ADR 0016). The database only ever holds public keys.
//   node scripts/auth-keys.mjs generate <kid>   new Ed25519 key: registers the public half as `next`, prints ONE line
//                                               KNOWVIA_JWT_PRIVATE_KEY_<kid>=<base64> on stdout for `fly secrets import`.
//                                               Pipe it straight to the secret store; never paste it into a chat, ticket or log.
//   node scripts/auth-keys.mjs register <kid>   register the public half of a private key already in the environment
//   node scripts/auth-keys.mjs activate <kid>   next -> active; the previous active key stays valid for 15 minutes
//   node scripts/auth-keys.mjs revoke <kid>      stop accepting tokens signed with this key now
//   node scripts/auth-keys.mjs list              kid and status only
// <kid> is 8 to 64 letters, digits and underscores (so it can be part of an environment variable name).
import { generateKeyPairSync } from 'node:crypto';
import { createDatabase } from '../src/backend/database/postgres/db.js';
import { createPostgresPool, postgresPoolOptionsFromEnv } from '../src/backend/database/postgres/index.js';
import { AuthTokenRepository } from '../src/backend/repositories/index.js';
import { publicJwkFor, readJwtPrivateKeys } from '../src/backend/security/jwt-tokens.js';

const [command, kid] = process.argv.slice(2);
const usage = () => { process.stderr.write('Usage: auth-keys.mjs generate|register|activate|revoke <kid> | list\n'); process.exit(2); };
if (!['generate', 'register', 'activate', 'revoke', 'list'].includes(command)) usage();
if (command !== 'list' && !/^[A-Za-z0-9_]{8,64}$/.test(kid ?? '')) usage();

let pool;
try {
  pool = createPostgresPool(postgresPoolOptionsFromEnv(process.env));
  const repository = new AuthTokenRepository(createDatabase(pool), {});
  if (command === 'generate') {
    const { privateKey } = generateKeyPairSync('ed25519');
    await repository.registerKey({ kid, publicJwk: publicJwkFor(privateKey) });
    process.stdout.write(`KNOWVIA_JWT_PRIVATE_KEY_${kid}=${privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')}\n`);
  } else if (command === 'register') {
    const key = readJwtPrivateKeys(process.env).get(kid);
    if (!key) throw Object.assign(new Error('missing'), { code: 'AUTH_SIGNING_KEY_NOT_FOUND' });
    await repository.registerKey({ kid, publicJwk: publicJwkFor(key) });
    process.stdout.write(`registered ${kid} as next\n`);
  } else if (command === 'activate') {
    await repository.activateKey(kid);
    process.stdout.write(`activated ${kid}\n`);
  } else if (command === 'revoke') {
    process.stdout.write(`${(await repository.revokeKey(kid)) ? 'revoked' : 'no change'} ${kid}\n`);
  } else {
    const db = createDatabase(pool);
    for (const row of await db.many('SELECT kid, status FROM auth_signing_keys ORDER BY created_at, kid')) process.stdout.write(`${row.kid} ${row.status}\n`);
  }
} catch (error) {
  process.stderr.write(`auth-keys failed (${typeof error?.code === 'string' ? error.code : 'UNKNOWN'}).\n`);
  process.exitCode = 1;
} finally {
  await pool?.end();
}

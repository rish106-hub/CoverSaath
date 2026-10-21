// Operator tooling for the trusted insurer-source workflow. Runs against DATABASE_PATH; there is no network call:
// every document is a local file a person already downloaded. Roles are issued here and nowhere else.
//
//   node scripts/curated-source.mjs grant-role   <adultId> <curator|checker> <operatorId> <expiresAtISO>
//   node scripts/curated-source.mjs revoke-role  <grantId> <operatorId>
//   node scripts/curated-source.mjs register     <curatorAdultId> <metadata.json> <document.pdf> [pageTexts.json]
//   node scripts/curated-source.mjs propose      <curatorAdultId> <submissionId> <facts.json>
//   node scripts/curated-source.mjs revalidate   <actorAdultId> <submissionId> <document.pdf> <sourceVersionId> [pageTexts.json]
//
// metadata.json: { uin, insurer, productName, wordingVersion, sourceUrl, sourceVersionId, retrievedOn, effectiveFrom? }
import { readFileSync } from 'node:fs';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/index.js';

const [command, ...args] = process.argv.slice(2);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const database = openDatabase({ path: process.env.DATABASE_PATH || '.local/knowvia.sqlite' });
try {
  const repo = createBackendServices(database, { env: process.env }).curatedProducts;
  const need = (n, usage) => { if (args.length < n) throw new Error(`usage: ${usage}`); };
  let out;
  if (command === 'grant-role') { need(4, 'grant-role <adultId> <role> <operatorId> <expiresAt>'); out = repo.grantRole({ adultUserId: args[0], role: args[1], operatorId: args[2], expiresAt: args[3] }); }
  else if (command === 'revoke-role') { need(2, 'revoke-role <grantId> <operatorId>'); out = { revoked: repo.revokeRole({ grantId: args[0], revokedBy: args[1] }) }; }
  else if (command === 'register') {
    need(3, 'register <curatorAdultId> <metadata.json> <document.pdf> [pageTexts.json]');
    out = repo.register({ curatorId: args[0], ...json(args[1]), bytes: readFileSync(args[2]), pageTexts: args[3] ? json(args[3]) : null });
  } else if (command === 'propose') { need(3, 'propose <curatorAdultId> <submissionId> <facts.json>'); out = repo.proposeFacts({ curatorId: args[0], submissionId: args[1], facts: json(args[2]) }); }
  else if (command === 'revalidate') {
    need(4, 'revalidate <actorAdultId> <submissionId> <document.pdf> <sourceVersionId> [pageTexts.json]');
    out = repo.revalidate({ actorId: args[0], submissionId: args[1], bytes: readFileSync(args[2]), sourceVersionId: args[3], pageTexts: args[4] ? json(args[4]) : null });
  } else throw new Error('commands: grant-role, revoke-role, register, propose, revalidate');
  const { pageTexts: _omit, ...printable } = out ?? {};
  process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}${error.details ? ` ${JSON.stringify(error.details)}` : ''}\n`);
  process.exitCode = 1;
} finally {
  database.close();
}

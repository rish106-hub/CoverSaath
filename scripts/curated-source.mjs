// Operator tooling for the trusted insurer-source workflow. Runs against DATABASE_PATH; there is no network call:
// every document is a local file a person already downloaded. Roles are issued here and nowhere else.
//
// Database commands (operator, needs database access):
//   node scripts/curated-source.mjs grant-role   <adultId> <curator|checker> <operatorId> <expiresAtISO> [publicKey.b64]
//   node scripts/curated-source.mjs revoke-role  <grantId> <operatorId>
//   node scripts/curated-source.mjs register     <curatorAdultId> <metadata.json> <document.pdf> [pageTexts.json]
//   node scripts/curated-source.mjs propose      <curatorAdultId> <submissionId> <facts.json>
//   node scripts/curated-source.mjs show         <adultId> <submissionId>
//   node scripts/curated-source.mjs check        <signedAction.json>
//   node scripts/curated-source.mjs publish      <signedAction.json>
//   node scripts/curated-source.mjs invalidate   <submissionId> <operatorId> <checker_compromised|review_found_wrong|source_superseded>
//   node scripts/curated-source.mjs revalidate   <actorAdultId> <submissionId> <document.pdf> <sourceVersionId> [pageTexts.json]
//   node scripts/curated-source.mjs verify-archives
//
// Checker commands (run by the checker on their own machine; no database is opened):
//   node scripts/curated-source.mjs keygen       <privateKeyOut.pem>
//   node scripts/curated-source.mjs sign-check   <privateKey.pem> <checkerAdultId> <submissionId> <accept|reject> <reasonCode> <their-copy.pdf> <reviewed-facts.json|-> [--quotes-reviewed]
//   node scripts/curated-source.mjs sign-publish <privateKey.pem> <checkerAdultId> <submissionId> <their-copy.pdf> <reviewed-facts.json>
//
// check and publish apply an Ed25519-signed action (ADR 0010). The repository verifies it against the public key registered on
// the checker's live grant, so an operator id or checker id typed here is never enough on its own. A checker grant needs the
// base64 public key that `keygen` prints. CURATED_KEY_PASSPHRASE, when set, encrypts the private key (keygen) and unlocks it
// (sign-*). Both signed digests are computed here: the source digest from the checker's own copy and the facts digest from the
// facts file the checker reviewed (the `show` output or its `facts` array), never copied from the operator or the database.
// Without CURATED_KEY_PASSPHRASE, keygen writes an unencrypted key and warns.
//
// register and revalidate derive page text from the PDF bytes in a sandboxed child; a pageTexts.json file is optional and
// only a candidate that must agree with the derived text. verify-archives derives the text again from each archive.
//
// CURATED_SOURCE_HOSTS (comma separated exact DNS names) must be set or register refuses every source.
// metadata.json: { uin, insurer, productName, wordingVersion, sourceUrl, sourceVersionId, retrievedOn, effectiveFrom? }
import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalCuratedFacts, generateCheckerKeyPair, sha256Hex, signCuratedAction } from '../src/features/decision-catalogue/index.js';

const [command, ...args] = process.argv.slice(2);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const need = (n, usage) => { if (args.length < n) throw new Error(`usage: ${usage}`); };
const print = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const fail = error => {
  process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}${error.details ? ` ${JSON.stringify(error.details)}` : ''}\n`);
  process.exitCode = 1;
};
const passphrase = () => process.env.CURATED_KEY_PASSPHRASE || null;
// The reviewed facts file is either the `show` output or a bare facts array.
const factsDigest = path => {
  const value = json(path);
  return sha256Hex(canonicalCuratedFacts(Array.isArray(value) ? value : value?.facts));
};

function checkerCommand() {
  if (command === 'keygen') {
    need(1, 'keygen <privateKeyOut.pem>');
    const pair = generateCheckerKeyPair({ passphrase: passphrase() });
    if (!passphrase()) process.stderr.write('WARNING: CURATED_KEY_PASSPHRASE is not set; the private key is written unencrypted.\n');
    // `wx`: never overwrite an existing key file; 0600: readable by the checker only.
    writeFileSync(args[0], pair.privateKeyPem, { flag: 'wx', mode: 0o600 });
    return { publicKey: pair.publicKey, fingerprint: pair.fingerprint, encrypted: Boolean(passphrase()) };
  }
  if (command === 'sign-check') {
    need(7, 'sign-check <privateKey.pem> <checkerAdultId> <submissionId> <accept|reject> <reasonCode> <their-copy.pdf> <reviewed-facts.json|-> [--quotes-reviewed]');
    const flags = new Set(args.slice(7));
    return signCuratedAction({
      privateKeyPem: readFileSync(args[0], 'utf8'), passphrase: passphrase(), action: 'check', checkerId: args[1], submissionId: args[2],
      decision: args[3], reasonCode: args[4], observedSha256: sha256Hex(readFileSync(args[5])), factsSha256: args[6] === '-' ? null : factsDigest(args[6]),
      quotesReviewed: flags.has('--quotes-reviewed'),
    });
  }
  if (command === 'sign-publish') {
    need(5, 'sign-publish <privateKey.pem> <checkerAdultId> <submissionId> <their-copy.pdf> <reviewed-facts.json>');
    return signCuratedAction({
      privateKeyPem: readFileSync(args[0], 'utf8'), passphrase: passphrase(), action: 'publish', checkerId: args[1], submissionId: args[2],
      observedSha256: sha256Hex(readFileSync(args[3])), factsSha256: factsDigest(args[4]),
    });
  }
  return undefined;
}

async function databaseCommand() {
  const { openDatabase } = await import('../src/backend/database/index.js');
  const { createBackendServices } = await import('../src/backend/services/index.js');
  const database = openDatabase({ path: process.env.DATABASE_PATH || '.local/knowvia.sqlite' });
  try {
    const repo = createBackendServices(database, { env: process.env }).curatedProducts;
    if (command === 'grant-role') {
      need(4, 'grant-role <adultId> <role> <operatorId> <expiresAt> [publicKey.b64]');
      return repo.grantRole({ adultUserId: args[0], role: args[1], operatorId: args[2], expiresAt: args[3], publicKey: args[4] ?? null });
    }
    if (command === 'revoke-role') { need(2, 'revoke-role <grantId> <operatorId>'); return { revoked: repo.revokeRole({ grantId: args[0], revokedBy: args[1] }) }; }
    if (command === 'invalidate') { need(3, 'invalidate <submissionId> <operatorId> <reasonCode>'); return repo.invalidate({ submissionId: args[0], operatorId: args[1], reasonCode: args[2] }); }
    if (command === 'register') {
      need(3, 'register <curatorAdultId> <metadata.json> <document.pdf> [pageTexts.json]');
      return await repo.register({ curatorId: args[0], ...json(args[1]), bytes: readFileSync(args[2]), pageTexts: args[3] ? json(args[3]) : null });
    }
    if (command === 'propose') { need(3, 'propose <curatorAdultId> <submissionId> <facts.json>'); return repo.proposeFacts({ curatorId: args[0], submissionId: args[1], facts: json(args[2]) }); }
    if (command === 'show') { need(2, 'show <adultId> <submissionId>'); return repo.get({ adultId: args[0], submissionId: args[1] }); }
    if (command === 'check') { need(1, 'check <signedAction.json>'); return repo.check({ signedAction: json(args[0]) }); }
    if (command === 'publish') { need(1, 'publish <signedAction.json>'); return repo.publish({ signedAction: json(args[0]) }); }
    if (command === 'revalidate') {
      need(4, 'revalidate <actorAdultId> <submissionId> <document.pdf> <sourceVersionId> [pageTexts.json]');
      return await repo.revalidate({ actorId: args[0], submissionId: args[1], bytes: readFileSync(args[2]), sourceVersionId: args[3], pageTexts: args[4] ? json(args[4]) : null });
    }
    if (command === 'verify-archives') {
      const out = await repo.verifyPublishedArchives();
      // Exit 2 when any published archive fails, so a scheduled check can alert on the status alone.
      if (out.some(row => !row.ok)) process.exitCode = 2;
      return out;
    }
    throw new Error('commands: grant-role, revoke-role, register, propose, show, check, publish, invalidate, revalidate, verify-archives, keygen, sign-check, sign-publish');
  } finally {
    database.close();
  }
}

try {
  const out = checkerCommand() ?? await databaseCommand();
  // Page text is never printed, including inside a revalidation result's submissions.
  const strip = value => { if (!value || typeof value !== 'object' || Array.isArray(value)) return value; const { pageTexts: _omit, ...rest } = value; return rest; };
  const printable = Array.isArray(out) ? out : strip(out ?? {});
  for (const key of ['submission', 'next']) if (printable[key]) printable[key] = strip(printable[key]);
  print(printable);
} catch (error) {
  fail(error);
}

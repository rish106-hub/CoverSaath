// Seeds the synthetic "Rao family" household through the backend services (never raw SQL). Local throwaway databases only:
// it refuses unless NODE_ENV is not `production`, SEED_ALLOW=1 is set, DATABASE_URL points at loopback and the database is not
// `coversaath_dev`. Usage: `SEED_ALLOW=1 npm run seed:demo-household`. It reads DATABASE_URL from the
// process environment only (no env file is loaded), expects an already migrated database, is safe to run twice, and prints
// ids and pass/fail only. Synthetic data: every name, number and e-mail below is invented.
import { pathToFileURL } from 'node:url';
import { createPostgresPool, postgresPoolOptionsFromEnv } from '../src/backend/database/postgres/index.js';
import { createDatabase } from '../src/backend/database/postgres/db.js';
import { createBackendServices } from '../src/backend/services/index.js';

export const OWNER_EMAIL = 'meera.rao@company.com';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const PROTECTED_DATABASE = 'coversaath_dev';

const MEMBERS = Object.freeze([
  { key: 'rohan', displayName: 'Rohan Rao', memberKind: 'adult', relationshipLabel: 'Spouse', dateOfBirth: null },
  { key: 'kabir', displayName: 'Kabir Rao', memberKind: 'dependent', relationshipLabel: 'Son', dateOfBirth: '2018-05-20' },
  { key: 'lalitha', displayName: 'Lalitha Rao', memberKind: 'dependent', relationshipLabel: 'Mother', dateOfBirth: '1956-02-11' },
  { key: 'suresh', displayName: 'Suresh Rao', memberKind: 'dependent', relationshipLabel: 'Father', dateOfBirth: '1952-09-03' },
]);

const POLICIES = Object.freeze([
  { insurer: 'Northstar Health', policyKind: 'group', policyNumberMasked: 'XXXX-NS-4021', startsOn: '2026-04-01', endsOn: '2027-03-31', members: ['owner', 'rohan', 'kabir'] },
  { insurer: 'Kaveri General', policyKind: 'top_up', policyNumberMasked: 'XXXX-KG-7710', startsOn: '2026-06-15', endsOn: '2027-06-14', members: ['owner', 'rohan', 'kabir'] },
  { insurer: 'Meridian Care', policyKind: 'personal', policyNumberMasked: 'XXXX-MC-3358', startsOn: '2026-03-14', endsOn: '2027-03-13', members: ['lalitha', 'suresh'] },
]);

// Throws a coded error unless the environment explicitly allows seeding.
export function assertSeedAllowed(env = {}) {
  const refuse = reason => { throw Object.assign(new Error(`Seed refused: ${reason}.`), { code: 'SEED_TARGET_REFUSED' }); };
  if (env.NODE_ENV === 'production') refuse('NODE_ENV is production');
  if (env.SEED_ALLOW !== '1') refuse('set SEED_ALLOW=1 to run the demo seed');
}

// Throws a coded error unless the URL names a loopback database other than the development one. Never echoes the URL.
export function assertSafeSeedTarget(databaseUrl) {
  const refuse = reason => { throw Object.assign(new Error(`Seed refused: ${reason}.`), { code: 'SEED_TARGET_REFUSED' }); };
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) refuse('DATABASE_URL is not set');
  let url;
  try { url = new URL(databaseUrl); } catch { refuse('DATABASE_URL is not a valid URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) refuse('DATABASE_URL is not a PostgreSQL URL');
  if (url.searchParams.has('host') || url.searchParams.has('hostaddr')) refuse('DATABASE_URL overrides the host');
  if (!LOOPBACK.has(url.hostname.toLowerCase())) refuse('the database host is not loopback');
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name) refuse('the database name is missing');
  if (name === PROTECTED_DATABASE) refuse('this database is the owner development database');
  return { database: name };
}

export async function seedDemoHousehold(database, { env = {}, clock } = {}) {
  const services = createBackendServices(database, { env, ...(clock ? { clock } : {}) });
  const repo = services.householdApp;
  const created = [];

  let adult = await repo.findAdultByContactEmail(OWNER_EMAIL);
  if (!adult) { adult = await services.households.createAdult({ displayName: 'Meera Rao', contactEmail: OWNER_EMAIL }); created.push('owner'); }
  let householdId = await repo.ownedHouseholdId(adult.id);
  if (!householdId) {
    householdId = (await services.households.createHousehold({ displayName: 'Rao family', ownerAdultId: adult.id })).id;
    created.push('household');
  }

  const byName = new Map((await repo.listMembers(householdId)).map(member => [member.display_name, member]));
  if (!byName.has('Meera Rao')) {
    byName.set('Meera Rao', await services.households.addMember({ householdId, adultUserId: adult.id, displayName: 'Meera Rao', relationshipLabel: 'Self' }));
    created.push('member:owner');
  }
  const ids = { owner: byName.get('Meera Rao').id };
  for (const spec of MEMBERS) {
    let member = byName.get(spec.displayName);
    if (!member) {
      member = await repo.createMember({ householdId, actorAdultId: adult.id, displayName: spec.displayName, memberKind: spec.memberKind, relationshipLabel: spec.relationshipLabel, dateOfBirth: spec.dateOfBirth });
      created.push(`member:${spec.key}`);
    }
    ids[spec.key] = member.id;
  }

  const existing = await repo.listPolicies(householdId);
  for (const spec of POLICIES) {
    if (existing.some(policy => policy.insurer_name === spec.insurer && policy.policy_kind === spec.policyKind)) continue;
    const insurer = await repo.findOrCreateInsurer({ legalName: spec.insurer });
    await repo.createPolicy({
      householdId, actorAdultId: adult.id, insurerId: insurer.id, policyKind: spec.policyKind, policyNumberMasked: spec.policyNumberMasked,
      startsOn: spec.startsOn, endsOn: spec.endsOn, memberIds: spec.members.map(key => ids[key]),
    });
    created.push(`policy:${spec.policyKind}`);
  }
  const policies = await repo.listPolicies(householdId);
  const members = await repo.listMembers(householdId);
  const pass = members.length === MEMBERS.length + 1 && policies.length === POLICIES.length;
  return { pass, householdId, ownerAdultId: adult.id, memberIds: ids, policyIds: policies.map(policy => policy.id), created };
}

async function main() {
  try {
    assertSeedAllowed(process.env);
    assertSafeSeedTarget(process.env.DATABASE_URL);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const pool = createPostgresPool(postgresPoolOptionsFromEnv(process.env));
  try {
    const result = await seedDemoHousehold(createDatabase(pool), { env: process.env });
    process.stdout.write(`${JSON.stringify({ result: result.pass ? 'pass' : 'fail', householdId: result.householdId, memberIds: result.memberIds, policyIds: result.policyIds, created: result.created })}\n`);
    if (!result.pass) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Seed failed (${typeof error?.code === 'string' ? error.code : 'UNKNOWN'}).\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

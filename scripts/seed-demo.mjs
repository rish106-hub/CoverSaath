// `npm run seed:demo`: synthetic demo household, 2 insurers, 3 products, 7 PDFs, declarations and 3 premium rows.
// Everything is written through the backend services and repositories (sealed columns, consent checks, audit), never raw SQL.
// Refuses unless DATABASE_URL is a PostgreSQL URL whose host is localhost or 127.0.0.1. Never echoes the URL.
// Idempotent: a second run adds no rows. Synthetic data only; see scripts/demo/demo-data.mjs.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPostgresPool, postgresPoolOptionsFromEnv } from '../src/backend/database/postgres/index.js';
import { createDatabase } from '../src/backend/database/postgres/db.js';
import { createBackendServices } from '../src/backend/services/index.js';
import { createDocumentIntakeService, createEncryptedDatabaseByteStorage } from '../src/features/input/index.js';
import { NetworkHospitalRepository } from '../src/backend/repositories/network-hospital-repository.js';
import { DEMO_DECLARATIONS, DEMO_HOUSEHOLD, DEMO_INSURERS, DEMO_PEOPLE, DEMO_PDF_SPECS, DEMO_PRODUCTS } from './demo/demo-data.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, '..', 'tests', 'fixtures', 'demo');
const LOOPBACK = new Set(['localhost', '127.0.0.1']);

function refuse(reason) {
  throw Object.assign(new Error(`Demo seed refused: ${reason}.`), { code: 'SEED_TARGET_REFUSED' });
}

// Throws a coded error unless the URL names a loopback PostgreSQL host. Never echoes the URL.
export function assertLoopbackDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) refuse('DATABASE_URL is not set');
  let url;
  try { url = new URL(databaseUrl); } catch { refuse('DATABASE_URL is not a valid URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) refuse('DATABASE_URL is not a PostgreSQL URL');
  if (url.searchParams.has('host') || url.searchParams.has('hostaddr')) refuse('DATABASE_URL overrides the host');
  if (!LOOPBACK.has(url.hostname.toLowerCase())) refuse('the database host is not localhost or 127.0.0.1');
  return true;
}

export function readFixture(filename) {
  return readFileSync(join(FIXTURE_DIR, filename));
}

// Inserts or finds the demo rows. Returns counts of what exists afterwards (not what was created).
export async function seedDemo(database, { env = process.env, clock } = {}) {
  const services = createBackendServices(database, { env, ...(clock ? { clock } : {}) });
  const repo = services.householdApp;
  const owner = DEMO_PEOPLE.find(person => person.owner);

  let adult = await repo.findAdultByContactEmail(owner.contactEmail);
  if (!adult) adult = await services.households.createAdult({ displayName: owner.displayName, contactEmail: owner.contactEmail });
  let householdId = await repo.ownedHouseholdId(adult.id);
  if (!householdId) householdId = (await services.households.createHousehold({ displayName: DEMO_HOUSEHOLD.displayName, ownerAdultId: adult.id })).id;

  const memberByName = new Map((await repo.listMembers(householdId)).map(member => [member.display_name, member]));
  const memberIds = {};
  for (const person of DEMO_PEOPLE) {
    let member = memberByName.get(person.displayName);
    if (!member && person.owner) {
      member = await services.households.addMember({ householdId, adultUserId: adult.id, displayName: person.displayName, relationshipLabel: person.relationshipLabel });
    } else if (!member) {
      member = await repo.createMember({ householdId, actorAdultId: adult.id, displayName: person.displayName, memberKind: person.memberKind, relationshipLabel: person.relationshipLabel, dateOfBirth: person.dateOfBirth ?? null });
    }
    memberIds[person.key] = member.id;
  }

  const insurerIds = {};
  for (const legalName of DEMO_INSURERS) insurerIds[legalName] = (await repo.findOrCreateInsurer({ legalName })).id;

  // Processing consent for documents (collect, household-wide) and profile consent for premiums and declarations.
  const { consents: grants } = await services.consents.listForSubject({ householdId, subjectAdultId: adult.id, limit: 200 });
  const findGrant = purpose => grants.find(grant => grant.purpose === purpose && grant.status === 'active');
  let documentGrant = findGrant('document_processing');
  if (!documentGrant) {
    documentGrant = await services.consents.grant({
      householdId, subjectAdultId: adult.id, purpose: 'document_processing',
      scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }],
    });
  }
  let profileGrant = findGrant('profile_intake');
  if (!profileGrant) {
    profileGrant = await services.consents.grant({
      householdId, subjectAdultId: adult.id, purpose: 'profile_intake',
      scopes: [
        { resourceType: 'profile_field', action: 'collect', dataCategory: 'financial' },
        { resourceType: 'profile_field', action: 'collect', dataCategory: 'health_or_policy_content' },
      ],
    });
  }
  const documentGrantId = documentGrant.id;
  const profileGrantId = profileGrant.id;

  let caseRecord = (await services.cases.listOpenedBy({ householdId, adultId: adult.id, limit: 1 })).cases[0];
  if (!caseRecord) {
    caseRecord = await services.cases.create({
      householdId, subjectMemberId: memberIds.asha, openedByAdultId: adult.id, triggerType: 'planned_care', policyType: 'personal_health',
    });
  }
  const caseId = caseRecord.id;

  // Documents: each PDF goes through the intake service (validation, encryption, consent check, audit).
  const storage = createEncryptedDatabaseByteStorage({ database, key: env.DOCUMENT_ENCRYPTION_KEY_BASE64 });
  const intake = createDocumentIntakeService({ repository: services.documents, storage, mode: 'live' });
  const documentIds = {};
  for (const spec of DEMO_PDF_SPECS) {
    const bytes = readFixture(spec.filename);
    const contentSha256 = createHash('sha256').update(bytes).digest('hex');
    let record = await services.documents.findByHash(householdId, contentSha256);
    if (!record) {
      record = await intake.intake({
        householdId, caseId, uploadedByAdultId: adult.id, consentGrantId: documentGrantId,
        logicalDocumentId: `demo-${spec.key}`, version: 1, documentKind: spec.documentKind,
        filename: spec.filename, mimeType: 'application/pdf', bytes,
      });
    }
    if (record.malwareStatus !== 'clean') await services.documents.markScanClean(record.id, { engine: 'demo-seed-no-scanner' });
    documentIds[spec.key] = record.id;
  }

  // Policies (one per product), holdings linked to the wording document, premium rows and declarations.
  const existingPolicies = await repo.listPolicies(householdId);
  const policyIds = {};
  for (const product of DEMO_PRODUCTS) {
    const insurerId = insurerIds[product.insurer];
    let policy = existingPolicies.find(row => row.insurer_id === insurerId && row.policy_kind === product.policyKind);
    if (!policy) {
      policy = await repo.createPolicy({
        householdId, actorAdultId: adult.id, insurerId, policyKind: product.policyKind, policyNumberMasked: product.policyNumberMasked,
        startsOn: product.startsOn, endsOn: product.endsOn, memberIds: product.members.map(key => memberIds[key]),
      });
    }
    policyIds[product.key] = policy.id;
  }

  const holdings = await services.policyHoldings.list({ householdId, adultId: adult.id });
  const holdingIds = {};
  for (const product of DEMO_PRODUCTS) {
    let holding = holdings.find(row => row.policyId === policyIds[product.key]);
    if (!holding) {
      holding = await services.policyHoldings.create({
        householdId, adultId: adult.id, documentId: documentIds[`${product.key}-wording`], kind: product.kind, policyId: policyIds[product.key],
      });
    }
    holdingIds[product.key] = holding.id;
  }

  const premiumRows = await services.premiums.listPayments({ householdId, adultId: adult.id });
  if (premiumRows.length === 0) {
    for (const product of DEMO_PRODUCTS) {
      const [first] = product.premiumPaise;
      await services.premiums.recordPayment({
        householdId, adultId: adult.id, holdingId: holdingIds[product.key], amountPaise: first, paidOn: '2026-09-01',
        channel: 'upi', paidVia: 'self', consentGrantId: profileGrantId,
      });
    }
  }

  const { declarations } = await services.declarations.list({ householdId, adultId: adult.id });
  for (const spec of DEMO_DECLARATIONS) {
    if (declarations.some(row => row.label === spec.label)) continue;
    await services.declarations.create({
      householdId, adultId: adult.id, memberId: memberIds[spec.person], kind: spec.kind, label: spec.label,
      holdingId: holdingIds[spec.productKey], consentGrantId: profileGrantId,
    });
  }

  // Network hospitals (migration 057): the 30 invented hospitals. Public reference rows, upserted by id, so a second run adds none.
  // The fixture has no address or cashless flag: tier_1 is cashless, tier_2 is not (reimbursement only).
  const hospitals = JSON.parse(readFixture('hospitals.json').toString('utf8')).hospitals.map(item => ({
    id: item.id, insurerId: null, tpaId: null, name: item.name, address: `Synthetic demo address, ${item.city}`, city: item.city, pincode: item.pincode,
    lat: null, lng: null, cashless: item.networkTier === 'tier_1', sourceRef: 'demo-fixture',
  }));
  await new NetworkHospitalRepository(database).upsertMany(hospitals);

  return { householdId, adultId: adult.id, hospitalCount: hospitals.length, caseId, documentCount: Object.keys(documentIds).length, policyCount: Object.keys(policyIds).length };
}

async function main() {
  try {
    assertLoopbackDatabaseUrl(process.env.DATABASE_URL);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const pool = createPostgresPool(postgresPoolOptionsFromEnv(process.env));
  try {
    const result = await seedDemo(createDatabase(pool), { env: process.env });
    process.stdout.write(`${JSON.stringify({ result: 'pass', ...result })}\n`);
  } catch (error) {
    process.stderr.write(`Demo seed failed (${typeof error?.code === 'string' ? error.code : 'UNKNOWN'}).\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

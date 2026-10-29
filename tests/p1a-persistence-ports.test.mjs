// P1-A: persistence port interfaces. The PostgreSQL implementation satisfies them, the
// persistent service requires exactly the listed methods, and the runtime works against an
// adapter whose every method resolves on a later macrotask. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createBackendServices, createCoverageAnalysisPort } from '../src/backend/services/index.js';
import { createCoverageAnalysisRuntime, createPersistentCoverageAnalysisService } from '../src/features/coverage-analysis/index.js';
import {
  COVERAGE_ANALYSIS_PORT_METHODS,
  COVERAGE_PARAMETER_REPOSITORY_PORT_METHODS,
  CONSENT_REPOSITORY_PORT_METHODS,
  FIXTURE_RUN_STORE_PORT_METHODS,
  MODEL_DISPATCH_PORT_METHODS,
  WORKFLOW_REPOSITORY_PORT_METHODS,
  assertConsentRepositoryPort,
  AUDIT_REPOSITORY_PORT_METHODS,
  CASE_REPOSITORY_PORT_METHODS,
  assertAuditRepositoryPort,
  assertCaseRepositoryPort,
  assertCoverageAnalysisPort,
  assertCoverageParameterRepositoryPort,
  assertFixtureRunStorePort,
  assertWorkflowRepositoryPort,
} from '../src/contracts/persistence-ports.js';

const portCode = { code: 'PORT_CONTRACT_INVALID' };
const stubPort = methods => Object.fromEntries(methods.map(method => [method, async () => null]));

async function world(t) {
  const { db: database } = await freshDatabase(t);
  const services = createBackendServices(database);
  const adult = await services.households.createAdult({ id: 'adult-port', displayName: 'Synthetic adult' });
  const household = await services.households.createHousehold({ id: 'household-port', displayName: 'Synthetic household', ownerAdultId: adult.id });
  const member = await services.households.addMember({ id: 'member-port', householdId: household.id, adultUserId: adult.id, displayName: 'Synthetic adult' });
  const created = await services.cases.create({ id: 'case-port', householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'renewal' });
  const collecting = await services.cases.transition(created.id, 'collecting', { expectedRevision: created.revision });
  await services.cases.transition(created.id, 'processing', { expectedRevision: collecting.revision });
  const grant = await services.consents.grant({
    id: 'consent-port', householdId: household.id, subjectAdultId: adult.id, purpose: 'coverage_reconstruction',
    scopes: [{ resourceType: 'case', resourceId: created.id, action: 'derive', dataCategory: 'insurance_document' }],
  });
  return { database, services, caseId: created.id, grantId: grant.id };
}

test('P1-A ports: the PostgreSQL implementations satisfy every port', postgresTestOptions(), async t => {
  const { database, services } = await world(t);
  const port = createCoverageAnalysisPort({ database, services });
  assert.equal(assertCoverageAnalysisPort(port, { modelDispatch: true }), port);
  assert.equal(assertWorkflowRepositoryPort(services.workflows), services.workflows);
  assert.equal(assertCoverageParameterRepositoryPort(services.coverageParameters), services.coverageParameters);
  assert.equal(assertConsentRepositoryPort(services.consents), services.consents);
  assert.equal(assertCaseRepositoryPort(services.cases), services.cases);
  assert.equal(assertAuditRepositoryPort(services.audit), services.audit);
  assert.doesNotThrow(() => assertFixtureRunStorePort(stubPort(FIXTURE_RUN_STORE_PORT_METHODS)));
  for (const list of [COVERAGE_ANALYSIS_PORT_METHODS, MODEL_DISPATCH_PORT_METHODS, WORKFLOW_REPOSITORY_PORT_METHODS, COVERAGE_PARAMETER_REPOSITORY_PORT_METHODS, CONSENT_REPOSITORY_PORT_METHODS, FIXTURE_RUN_STORE_PORT_METHODS]) {
    assert.ok(Object.isFrozen(list));
    assert.equal(new Set(list).size, list.length);
  }
});

test('P1-A ports: assertXPort names every missing method', () => {
  assert.throws(() => assertCoverageAnalysisPort(null), portCode);
  const withoutClaim = stubPort(COVERAGE_ANALYSIS_PORT_METHODS.filter(method => method !== 'claimNext'));
  assert.throws(() => assertCoverageAnalysisPort(withoutClaim), { ...portCode, message: /missing method\(s\): claimNext\./ });
  assert.doesNotThrow(() => assertCoverageAnalysisPort(stubPort(COVERAGE_ANALYSIS_PORT_METHODS)));
  assert.throws(() => assertCoverageAnalysisPort(stubPort(COVERAGE_ANALYSIS_PORT_METHODS), { modelDispatch: true }), { ...portCode, message: /authorizeModelDispatch/ });
  assert.throws(() => assertWorkflowRepositoryPort({ getRun() {} }), { ...portCode, message: /createRun, insertTask/ });
  assert.throws(() => assertCoverageParameterRepositoryPort({}), portCode);
  assert.throws(() => assertConsentRepositoryPort({ eraseDerivedRunData: 'not a function' }), portCode);
  assert.throws(() => assertFixtureRunStorePort({ createRun() {}, loadRun() {} }), { ...portCode, message: /replaceRun/ });
});

test('P1-A ports: the persistent service requires exactly the coverage-analysis port methods', () => {
  assert.doesNotThrow(() => createPersistentCoverageAnalysisService({ port: stubPort(COVERAGE_ANALYSIS_PORT_METHODS) }));
  for (const method of COVERAGE_ANALYSIS_PORT_METHODS) {
    const incomplete = stubPort(COVERAGE_ANALYSIS_PORT_METHODS.filter(item => item !== method));
    assert.throws(() => createPersistentCoverageAnalysisService({ port: incomplete }), TypeError, method);
  }
  // The fixture runtime requires exactly the fixture run store methods.
  assert.doesNotThrow(() => createCoverageAnalysisRuntime({ port: stubPort(FIXTURE_RUN_STORE_PORT_METHODS) }));
  for (const method of FIXTURE_RUN_STORE_PORT_METHODS) {
    assert.throws(() => createCoverageAnalysisRuntime({ port: stubPort(FIXTURE_RUN_STORE_PORT_METHODS.filter(item => item !== method)) }), TypeError, method);
  }
});

test('P1-A ports: every port method the runtime calls is listed', () => {
  // Methods the port reaches on services.workflows / services.coverageParameters / services.consents.
  const portSource = readFileSync(new URL('../src/backend/services/coverage-analysis-port.js', import.meta.url), 'utf8');
  const used = (pattern) => new Set([...portSource.matchAll(pattern)].map(match => match[1]));
  for (const method of used(/services\.workflows\.([a-zA-Z]+)/g)) assert.ok(WORKFLOW_REPOSITORY_PORT_METHODS.includes(method), method);
  for (const method of used(/repository\??\.([a-zA-Z]+)/g)) assert.ok(COVERAGE_PARAMETER_REPOSITORY_PORT_METHODS.includes(method), method);
  for (const method of used(/services\.consents\??\.([a-zA-Z]+)/g)) assert.ok(CONSENT_REPOSITORY_PORT_METHODS.includes(method), method);
  for (const method of used(/services\.cases\??\.([a-zA-Z]+)/g)) assert.ok(CASE_REPOSITORY_PORT_METHODS.includes(method), method);
  for (const method of used(/services\.audit\??\.([a-zA-Z]+)/g)) assert.ok(AUDIT_REPOSITORY_PORT_METHODS.includes(method), method);
  // Nothing else on `services` is reached by the port.
  assert.deepEqual([...used(/services\.([a-zA-Z]+)/g)].sort(), ['audit', 'cases', 'consents', 'coverageParameters', 'workflows']);
  const consentSource = readFileSync(new URL('../src/backend/repositories/consent-repository.js', import.meta.url), 'utf8');
  for (const method of new Set([...consentSource.matchAll(/this\.coverageParameters\.([a-zA-Z]+)/g)].map(match => match[1]))) {
    assert.ok(COVERAGE_PARAMETER_REPOSITORY_PORT_METHODS.includes(method), method);
  }
});

test('P1-A ports: a fully asynchronous adapter runs a fixture analysis end to end', postgresTestOptions(), async t => {
  const { database, services, caseId, grantId } = await world(t);
  const base = createCoverageAnalysisPort({ database, services });
  let asyncCalls = 0;
  // Every method returns a Promise resolved on a later macrotask, as a network database would.
  const asyncPort = Object.fromEntries(COVERAGE_ANALYSIS_PORT_METHODS.map(method => [method, (...args) => new Promise((resolve, reject) => {
    asyncCalls += 1;
    setImmediate(() => { try { resolve(base[method](...args)); } catch (error) { reject(error); } });
  })]));
  const service = createPersistentCoverageAnalysisService({ port: asyncPort });
  const created = await service.createAnalysisRun({ caseId, consentGrantId: grantId, executionMode: 'fixture', idempotencyKey: 'p1a-async-port-1' });
  assert.equal(created.created, true);
  const settled = await service.runUntilSettled(created.job.id, { maxTasks: 100 });
  assert.ok(['completed', 'blocked'].includes(settled.status), settled.status);
  assert.equal(settled.workflow_version, '6');
  assert.equal(settled.tasks.length, 22);
  assert.equal(settled.tasks.filter(task => task.status === 'completed').length, 22);
  assert.ok(asyncCalls > 22);
  const replay = await service.createAnalysisRun({ caseId, consentGrantId: grantId, executionMode: 'fixture', idempotencyKey: 'p1a-async-port-1' });
  assert.deepEqual([replay.created, replay.job.id], [false, created.job.id]);
});

test('P1-B dependencies: pg is the only database package, with no ORM or query builder (ADR 0004)', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  assert.deepEqual(names.filter(name => /^(?:pg|postgres|pg-.*|@neondatabase\/.*|knex|kysely|drizzle-orm|prisma|sequelize|typeorm|mikro-orm|@prisma\/.*)$/.test(name)), ['pg']);
  assert.equal(Object.hasOwn(manifest.devDependencies ?? {}, 'pg'), false);
});

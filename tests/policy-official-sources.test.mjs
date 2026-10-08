import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  OfficialSourceContractError,
  TERMINAL_PARAMETER_OUTCOMES,
  buildSafeFetchRequest,
  classifyTerminalParameter,
  createFakeOfficialSourceAdapter,
  defineOfficialSource,
  resolveOfficialSource,
  validateArtifactProvenance,
  validateRegistryBoundFetchRequest,
  validateSafeFetchRequest,
  withTerminalOutcome,
} from '../src/modules/policy-breakdown/references/official/index.js';

const requestedAt = '2026-10-07T10:00:00.000Z';
const canonicalUrl = 'https://official.example.in/health/optima-secure-v2.pdf';
const baseIdentity = Object.freeze({
  scope: 'policy_versioned',
  legalInsurerName: 'Example General Insurance Company Limited',
  uin: 'EXAMPLEHLIP26001V022526',
  productName: 'Example Optima Secure',
  version: 'v2',
  effectiveFrom: '2026-04-01',
  effectiveTo: null,
});
const baseSource = Object.freeze({
  id: 'example.optima-secure.v2.wording',
  sourceClass: 'insurer_policy_wording',
  documentType: 'policy_wording',
  publisher: 'Example General Insurance Company Limited',
  identity: baseIdentity,
  canonicalUrl,
  allowedHosts: ['official.example.in'],
  expectedMimeTypes: ['application/pdf'],
  maxBytes: 2_000_000,
  freshnessDays: null,
  owner: 'policy-source-operations',
});
const query = Object.freeze({
  legalInsurerName: 'Example General Insurance Company Limited',
  uin: 'EXAMPLEHLIP26001V022526',
  productName: 'Example Optima Secure',
  version: 'v2',
  effectiveDate: '2026-06-17',
  documentType: 'policy_wording',
});
const request = Object.freeze({
  requestId: 'source-request-1',
  registryEntryId: baseSource.id,
  url: canonicalUrl,
  allowedHosts: ['official.example.in'],
  expectedMimeTypes: ['application/pdf'],
  maxBytes: 1_024,
  timeoutMs: 2_000,
  requestedAt,
});
const adapterSource = Object.freeze({ ...baseSource, maxBytes: request.maxBytes });
const attempt = Object.freeze({
  registryEntryId: baseSource.id,
  attemptedAt: requestedAt,
  url: canonicalUrl,
  outcome: 'fetched',
  code: null,
  httpStatus: 200,
});

const isCode = code => error => error instanceof OfficialSourceContractError && error.code === code;

test('registry and exact identity resolver return one compatible official source', () => {
  const source = defineOfficialSource(baseSource);
  assert.equal(Object.isFrozen(source), true);
  assert.equal(resolveOfficialSource(query, [source]).status, 'matched');
  // The request inherits the registry entry's byte limit; the shared `request` fixture uses a tiny limit for the oversize tests.
  assert.deepEqual(buildSafeFetchRequest({ requestId: request.requestId, source, requestedAt, timeoutMs: request.timeoutMs }), { ...request, maxBytes: baseSource.maxBytes });
});

test('resolver abstains for ambiguous, mismatched, stale-version and unavailable identities', () => {
  const duplicate = { ...baseSource, id: 'example.optima-secure.v2.wording-copy' };
  assert.equal(resolveOfficialSource(query, [baseSource, duplicate]).status, 'ambiguous');
  const mismatch = resolveOfficialSource({ ...query, version: 'v3' }, [baseSource]);
  assert.equal(mismatch.status, 'incompatible');
  assert.equal(mismatch.reason, 'uin_product_or_version_mismatch');
  assert.equal(resolveOfficialSource({ ...query, effectiveDate: '2025-12-31' }, [baseSource]).reason, 'effective_date_outside_registered_version');
  assert.equal(resolveOfficialSource({ ...query, legalInsurerName: 'Missing Insurer Limited' }, [baseSource]).status, 'not_found');
});

test('safe fetch request rejects non-HTTPS, unallowlisted hosts and private query fields', () => {
  assert.throws(() => validateSafeFetchRequest({ ...request, url: canonicalUrl.replace('https:', 'http:') }, adapterSource), isCode('OFFICIAL_SOURCE_HTTPS_REQUIRED'));
  assert.throws(() => validateSafeFetchRequest({ ...request, url: 'https://attacker.example/wording.pdf' }, adapterSource), isCode('OFFICIAL_SOURCE_HOST_NOT_ALLOWED'));
  assert.throws(() => validateSafeFetchRequest({ ...request, url: `${canonicalUrl}?patient_name=Asha` }, adapterSource), isCode('OFFICIAL_SOURCE_PRIVATE_QUERY'));
  assert.throws(() => validateSafeFetchRequest({ ...request, diagnosis: 'kidney stone' }, adapterSource), isCode('OFFICIAL_SOURCE_PRIVATE_DATA'));
  assert.throws(() => validateSafeFetchRequest({ ...request, query: { uin: baseIdentity.uin } }, adapterSource), isCode('OFFICIAL_SOURCE_PRIVATE_DATA'));
  assert.throws(() => validateSafeFetchRequest({ ...request, payload: 'raw uploaded policy text' }, adapterSource), isCode('OFFICIAL_SOURCE_PRIVATE_DATA'));
  assert.throws(() => validateSafeFetchRequest({ ...request, url: `${canonicalUrl}?product=patient%20diagnosis%20notes` }, adapterSource), isCode('OFFICIAL_SOURCE_PRIVATE_QUERY'));
  assert.throws(() => validateSafeFetchRequest(request), isCode('OFFICIAL_SOURCE_REGISTRY_REQUIRED'));
});

test('registry-bound validation rejects request-supplied host authority', () => {
  const selfAuthorised = {
    ...request,
    url: 'https://attacker.example/wording.pdf',
    allowedHosts: ['attacker.example'],
  };
  assert.throws(() => validateSafeFetchRequest(selfAuthorised), isCode('OFFICIAL_SOURCE_REGISTRY_REQUIRED'));
  assert.throws(() => validateRegistryBoundFetchRequest(selfAuthorised, adapterSource), isCode('OFFICIAL_SOURCE_REQUEST_MISMATCH'));
});

test('fake adapter never uses network and accepts a bounded allowlisted artifact', async () => {
  const body = '%PDF-1.7 synthetic official wording';
  const adapter = createFakeOfficialSourceAdapter({ registry: [adapterSource], responses: { [canonicalUrl]: { body, mimeType: 'application/pdf' } } });
  assert.equal(adapter.networkEnabled, false);
  const fetched = await adapter.fetch(request);
  assert.equal(fetched.ok, true);
  assert.equal(fetched.byteLength, new TextEncoder().encode(body).byteLength);
  assert.equal(fetched.attempts[0].outcome, 'fetched');
});

test('fake adapter rejects unallowlisted redirect, oversize and MIME mismatch', async () => {
  const redirecting = createFakeOfficialSourceAdapter({ registry: [adapterSource], responses: { [canonicalUrl]: { body: 'ok', mimeType: 'application/pdf', finalUrl: 'https://attacker.example/wording.pdf' } } });
  await assert.rejects(redirecting.fetch(request), isCode('OFFICIAL_SOURCE_HOST_NOT_ALLOWED'));

  const oversized = createFakeOfficialSourceAdapter({ registry: [adapterSource], responses: { [canonicalUrl]: { body: 'x'.repeat(1_025), mimeType: 'application/pdf' } } });
  await assert.rejects(oversized.fetch(request), isCode('OFFICIAL_SOURCE_OVERSIZE'));

  const wrongMime = createFakeOfficialSourceAdapter({ registry: [adapterSource], responses: { [canonicalUrl]: { body: '<html>', mimeType: 'text/html' } } });
  await assert.rejects(wrongMime.fetch(request), isCode('OFFICIAL_SOURCE_MIME_REJECTED'));
});

test('fake adapter records stale and unavailable attempts without inventing evidence', async () => {
  const stale = createFakeOfficialSourceAdapter({ registry: [adapterSource], responses: { [canonicalUrl]: { body: 'old', mimeType: 'application/pdf', freshUntil: '2026-10-06T00:00:00Z' } } });
  const staleResult = await stale.fetch(request);
  assert.equal(staleResult.ok, false);
  assert.equal(staleResult.attempts[0].outcome, 'stale');
  const unavailable = await createFakeOfficialSourceAdapter({ registry: [adapterSource] }).fetch(request);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.attempts[0].outcome, 'unavailable');
});

test('artifact provenance retains exact source identity, hash, freshness, citation and attempts', () => {
  const body = '%PDF-1.7 synthetic official wording';
  const rawProvenance = {
    registryEntryId: baseSource.id,
    sourceClass: baseSource.sourceClass,
    documentType: baseSource.documentType,
    canonicalUrl,
    finalUrl: canonicalUrl,
    publisher: baseSource.publisher,
    identity: baseIdentity,
    publishedOn: '2026-04-01',
    retrievedAt: requestedAt,
    contentSha256: createHash('sha256').update(body).digest('hex'),
    freshness: { status: 'not_applicable', checkedAt: requestedAt, expiresAt: null },
    citation: { locator: 'Page 18, Exclusion 02', quote: 'Specified disease waiting period: 24 months.' },
    sourceAttempts: [attempt],
  };
  const provenance = validateArtifactProvenance(rawProvenance, { expectedSource: baseSource });
  assert.equal(provenance.identity.uin, baseIdentity.uin);
  assert.equal(provenance.citation.locator, 'Page 18, Exclusion 02');
  assert.equal(provenance.sourceAttempts.length, 1);
  assert.throws(() => validateArtifactProvenance({ ...rawProvenance, registryEntryId: 'other.source' }, { expectedSource: baseSource }), isCode('OFFICIAL_SOURCE_PROVENANCE_MISMATCH'));
  assert.throws(() => validateArtifactProvenance({ ...rawProvenance, finalUrl: 'https://official.example.in/redirected.pdf' }, { expectedSource: baseSource }), isCode('OFFICIAL_SOURCE_PROVENANCE_MISMATCH'));
  assert.throws(() => validateArtifactProvenance({
    ...rawProvenance,
    sourceAttempts: [{ ...attempt, registryEntryId: 'other.source' }],
  }, { expectedSource: baseSource }), isCode('OFFICIAL_SOURCE_PROVENANCE_MISMATCH'));
});

test('terminal classifier covers the complete allowed outcome set and critical-area rules', () => {
  assert.deepEqual(TERMINAL_PARAMETER_OUTCOMES, [
    'Proven', 'Calculated', 'Reported', 'Dynamic', 'Conflicting', 'NotPermitted', 'RequiredNow',
    'RequiredForLaterJourney', 'NotApplicable', 'Unavailable',
  ]);
  const establishedStates = ['Proven', 'Calculated', 'Reported', 'Dynamic', 'Conflicting', 'NotPermitted'];
  for (const evidenceState of establishedStates) {
    assert.equal(classifyTerminalParameter({ parameterKey: 'policy_type', evidenceState, decisionArea: 'other' }).outcome, evidenceState);
  }
  assert.equal(classifyTerminalParameter({
    parameterKey: 'specified_disease_wait', evidenceState: 'Unknown', decisionArea: 'waiting_periods',
    relevance: { timing: 'later', ruleId: 'wait.required-for-procedure' },
  }).outcome, 'RequiredNow', 'critical areas cannot be deferred');
  assert.equal(classifyTerminalParameter({
    parameterKey: 'wellness_points', evidenceState: 'Unknown', decisionArea: 'other',
    relevance: { timing: 'later', ruleId: 'journey.wellness-later' },
  }).outcome, 'RequiredForLaterJourney');
  const notApplicable = classifyTerminalParameter({
    parameterKey: 'maternity_wait', evidenceState: 'Unknown', decisionArea: 'eligibility',
    relevance: { timing: 'not_applicable', ruleId: 'eligibility.procedure-not-maternity' },
  });
  assert.equal(notApplicable.outcome, 'NotApplicable');
  assert.equal(notApplicable.ruleId, 'eligibility.procedure-not-maternity');
});

test('terminal classifier downgrades stale Dynamic evidence and records exhausted source history', () => {
  const stale = classifyTerminalParameter({
    parameterKey: 'hospital_network_status', evidenceState: 'Dynamic', freshnessStatus: 'stale', decisionArea: 'hospital_access',
    relevance: { timing: 'later', ruleId: 'hospital.live-network-required' }, sourceAttempts: [{ ...attempt, outcome: 'stale', code: 'SOURCE_STALE' }],
  });
  assert.equal(stale.outcome, 'RequiredNow');
  const unavailable = classifyTerminalParameter({
    parameterKey: 'hospital_network_status', evidenceState: 'Unknown', decisionArea: 'hospital_access',
    relevance: { timing: 'now', ruleId: 'hospital.live-network-required' }, sourceAttempts: [{ ...attempt, outcome: 'unavailable', code: 'SOURCE_UNAVAILABLE', httpStatus: null }],
    unavailableReason: 'official_network_source_unavailable',
  });
  assert.equal(unavailable.outcome, 'Unavailable');
  assert.equal(unavailable.requiredNow, true);
  assert.equal(unavailable.sourceAttempts.length, 1);
});

test('service-facing terminal helper ignores persisted relevance claiming NotApplicable', () => {
  const output = withTerminalOutcome({
    key: 'maternity_wait',
    evidenceState: 'Unknown',
    terminalOutcome: 'NotApplicable',
    terminalRelevance: { timing: 'not_applicable', ruleId: 'user.supplied-not-applicable' },
  }, {
    key: 'maternity_wait',
    section: 3,
    critical: true,
  });
  assert.equal(output.terminalOutcome, 'RequiredNow');
  assert.equal(output.terminalOutcomeRuleId, 'policy-parameter.critical-required-now');
  assert.equal('terminalRelevance' in output, false);
});

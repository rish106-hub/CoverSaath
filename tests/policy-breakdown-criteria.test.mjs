import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { criteriaMatrix } from '../scripts/criteria-matrix.mjs';
import { SECTIONS } from '../src/modules/policy-breakdown/sections/index.js';
import { estimatePlannedProcedure, validateEstimateInput } from '../src/modules/policy-breakdown/consumers/estimate.js';
import { checkPlannedProcedure } from '../src/modules/policy-breakdown/consumers/procedure-check.js';
import { buildPolicyStatus } from '../src/modules/policy-breakdown/consumers/policy-status.js';
import { buildEmergencyCard, CARD_FIELDS } from '../src/modules/policy-breakdown/consumers/emergency-card.js';
import { resolveForMember, limitStatus } from '../src/modules/policy-breakdown/consumers/record-values.js';
import { loadBreakdownReferences } from '../src/modules/policy-breakdown/references/reference-store.js';
import { buildPackRecord } from './fixtures/policy-breakdown/synthetic-pack.mjs';

const asOf = '2026-10-02';
const kaushalya = { id: 'a-m4', displayName: 'Kaushalya Devi', relationship: 'mother', dateOfBirth: '1962-07-21' };
const luv = { id: 'a-m3', displayName: 'Luv Kumar', relationship: 'son', dateOfBirth: '2018-09-30' };
const kamala = { id: 'b-m3', displayName: 'Kamala Verma', relationship: 'mother', dateOfBirth: '1955-07-09' };
const vikram = { id: 'b-m2', displayName: 'Vikram Verma', relationship: 'spouse', dateOfBirth: '1983-11-20' };
const arjun = { id: 'b-m4', displayName: 'Arjun Verma', relationship: 'son', dateOfBirth: '2026-01-10' };

const packA = await buildPackRecord({ pack: 'a', household: { members: [luv, kaushalya], city: null }, asOf });
const packB = await buildPackRecord({ pack: 'b', household: { members: [vikram, kamala, arjun], city: null }, asOf });
const packC = await buildPackRecord({ pack: 'c', asOf });
const outcome = (result, id) => result.eligibility.checks.find(check => check.id === id)?.outcome;

test('criteria matrix: every one of the 314 parameters is checked by at least one consumer', () => {
  const rows = criteriaMatrix();
  assert.equal(rows.length, SECTIONS.reduce((sum, section) => sum + section.parameters.length, 0));
  assert.deepEqual(rows.filter(row => row.consumers.length === 0).map(row => row.key), []);
  // Every critical parameter reaches readiness and at least one track.
  for (const row of rows.filter(item => item.critical)) assert.ok(row.consumers.some(consumer => consumer !== 'readiness'), row.key);
  // Every parameter flagged for the emergency card is on it.
  const card = new Set(Object.values(CARD_FIELDS).flat());
  for (const section of SECTIONS) for (const parameter of section.parameters) if (parameter.emergencyCard) assert.ok(card.has(parameter.key), parameter.key);
});

test('pack A: cataract for the 64-year-old mother applies the per-eye sub-limit then the age co-pay', () => {
  const result = estimatePlannedProcedure({ parameters: packA, member: kaushalya, asOf, input: {
    procedure: 'cataract', admissionDate: '2026-11-02', stayHours: 6, condition: { name: 'cataract', preExisting: false },
    hospital: { networkStatus: 'network', zone: 'zone_b' }, billLines: [{ head: 'surgeon_fees', amountMinor: 3_000_000 }, { head: 'implants_devices', amountMinor: 3_000_000 }],
    sumInsuredAlreadyUsedMinor: 0, cumulativeBonusAccruedPercent: 0,
  } });
  // ₹60,000 bill → ₹40,000 per-eye cap → 20% age co-pay → ₹32,000.
  assert.deepEqual(result.insurerPaysMinor, { low: 3_200_000, high: 3_200_000 });
  assert.equal(outcome(result, 'specified_disease_wait'), 'met', '24 months from 2023-04-01 ended 2025-04-01');
  assert.equal(outcome(result, 'minimum_stay'), 'attention', 'a 6-hour stay is payable only as a listed day-care procedure');
  assert.equal(outcome(result, 'policy_in_force'), 'met');
  assert.notEqual(result.eligibility.verdict, 'blocker_found');
});

test('pack A: an admission after the grace period is a blocker and the least the insurer pays is nothing', () => {
  const result = estimatePlannedProcedure({ parameters: packA, member: luv, asOf, input: {
    admissionDate: '2027-06-01', stayHours: 48, condition: { name: 'dengue fever', preExisting: false },
    hospital: { networkStatus: 'network', zone: 'zone_b' }, billLines: [{ head: 'other', amountMinor: 5_000_000 }],
  } });
  assert.equal(outcome(result, 'policy_in_force'), 'not_met');
  assert.equal(result.eligibility.verdict, 'blocker_found');
  assert.equal(result.insurerPaysMinor.low, 0);
});

test('pack A: a pre-existing condition inside the PED wait is a blocker; an unknown answer asks the question', () => {
  const asked = checkPlannedProcedure({ parameters: resolveForMember(packA, kaushalya), member: kaushalya, asOf, request: validateEstimateInput({ admissionDate: '2026-11-01', condition: { name: 'hypertension' } }, { requireBill: false }) });
  const ped = asked.checks.find(check => check.id === 'ped_wait');
  assert.ok(['met', 'attention'].includes(ped.outcome));
  const early = checkPlannedProcedure({ parameters: resolveForMember(packA, kaushalya), member: kaushalya, asOf: '2024-01-01', request: validateEstimateInput({ admissionDate: '2024-06-01', condition: { name: 'hypertension', preExisting: true } }, { requireBill: false }) });
  assert.equal(early.checks.find(check => check.id === 'ped_wait').outcome, 'not_met', '36 months from 2023-04-01 runs to 2026-04-01');
  assert.ok(early.checks.some(check => check.id === 'disclosure'));
});

test('pack B: the dependent parent gets her own PED wait, parent cap, member co-pay and joint sub-limit', () => {
  const result = estimatePlannedProcedure({ parameters: packB, member: kamala, asOf, input: {
    procedure: 'joint_replacement', admissionDate: '2026-10-20', stayHours: 96, condition: { name: 'osteoarthritis knee', preExisting: true },
    hospital: { networkStatus: 'network' }, room: { ratePerDayMinor: 500_000, days: 4 },
    billLines: [{ head: 'surgeon_fees', amountMinor: 15_000_000 }, { head: 'implants_devices', amountMinor: 20_000_000 }],
    sumInsuredAlreadyUsedMinor: 0, cumulativeBonusAccruedPercent: 0, corporateBufferApproved: false,
  } });
  // ₹3,70,000 bill → ₹1,50,000 per joint → 10% co-pay for dependent parents → ₹1,35,000.
  assert.deepEqual(result.insurerPaysMinor, { low: 13_500_000, high: 13_500_000 });
  assert.equal(result.status, 'conditional', 'a co-pay stated only for another member does not unbound the range');
  assert.ok(result.steps.some(step => step.step === 'member_cap' && /3,00,000/.test(step.description)));
  const ped = result.eligibility.checks.find(check => check.id === 'ped_wait');
  assert.equal(ped.outcome, 'met');
  assert.match(ped.message, /12 months counted from 2024-04-01/);
});

test('pack B: a newborn added by endorsement is not covered before the endorsement date', () => {
  const result = estimatePlannedProcedure({ parameters: packB, member: arjun, asOf, input: { admissionDate: '2026-05-01', stayHours: 48, condition: { name: 'jaundice', preExisting: false }, hospital: { networkStatus: 'network' }, billLines: [{ head: 'other', amountMinor: 5_000_000 }] } });
  assert.equal(outcome(result, 'member_cover_started'), 'not_met');
  assert.equal(result.insurerPaysMinor.low, 0);
  assert.ok(result.eligibility.checks.some(check => check.id === 'add_ons_and_endorsements'));
});

test('pack B: a permanent exclusion for one member is raised for that member only', () => {
  const request = validateEstimateInput({ admissionDate: '2026-11-01', condition: { name: 'chronic kidney disease dialysis', preExisting: true } }, { requireBill: false });
  const forKamala = checkPlannedProcedure({ parameters: resolveForMember(packB, kamala), member: kamala, asOf, request });
  assert.equal(forKamala.checks.find(check => check.id === 'exclusions').outcome, 'attention');
  assert.match(forKamala.checks.find(check => check.id === 'exclusions').message, /permanent exclusion/);
  const forVikram = checkPlannedProcedure({ parameters: resolveForMember(packB, vikram), member: vikram, asOf, request });
  assert.doesNotMatch(forVikram.checks.find(check => check.id === 'exclusions').message, /permanent exclusion/);
});

test('pack B: a non-network admission applies the non-network co-pay and the notice rule; buffer only raises the high bound', () => {
  const result = estimatePlannedProcedure({ parameters: packB, member: vikram, asOf, input: {
    admissionDate: '2026-11-10', stayHours: 72, condition: { name: 'appendicitis', preExisting: false },
    hospital: { networkStatus: 'non_network' }, billLines: [{ head: 'other', amountMinor: 70_000_000 }], sumInsuredAlreadyUsedMinor: 0, cumulativeBonusAccruedPercent: 0,
  } });
  assert.ok(result.steps.some(step => step.step === 'copay' && step.percent === 20));
  assert.equal(outcome(result, 'cashless_route'), 'attention');
  // ₹7,00,000 bill, 20% co-pay → ₹5,60,000 claimable; SI ₹5,00,000 binds the low bound, the ₹25L buffer may lift the high.
  assert.equal(result.insurerPaysMinor.low, 50_000_000);
  assert.equal(result.insurerPaysMinor.high, 56_000_000);
});

test('pack C: a super top-up pays above its threshold and never pays what the base policy paid', () => {
  const input = { admissionDate: '2026-12-01', stayHours: 72, condition: { name: 'bypass surgery', preExisting: false }, hospital: { networkStatus: 'network' }, billLines: [{ head: 'other', amountMinor: 80_000_000 }], deductibleAlreadyMetMinor: 0, sumInsuredAlreadyUsedMinor: 0 };
  const withBase = estimatePlannedProcedure({ parameters: packC, asOf, input: { ...input, otherPolicyPaysMinor: 50_000_000 } });
  assert.deepEqual(withBase.insurerPaysMinor, { low: 30_000_000, high: 30_000_000 });
  assert.deepEqual(withBase.householdPaysMinor, { low: 0, high: 0 });
  const baseSmall = estimatePlannedProcedure({ parameters: packC, asOf, input: { ...input, otherPolicyPaysMinor: 20_000_000 } });
  assert.deepEqual(baseSmall.insurerPaysMinor, { low: 30_000_000, high: 30_000_000 }, 'the ₹5L threshold, not the ₹2L base payout, is what the top-up deducts');
  assert.deepEqual(baseSmall.householdPaysMinor, { low: 30_000_000, high: 30_000_000 });
  const metUnknown = estimatePlannedProcedure({ parameters: packC, asOf, input: { ...input, deductibleAlreadyMetMinor: undefined, otherPolicyPaysMinor: 0 } });
  assert.deepEqual(metUnknown.insurerPaysMinor, { low: 30_000_000, high: 80_000_000 }, 'aggregate threshold already met is unknown: none to all');
});

test('policy-checks accept no bill, validate dates, and never claim approval', () => {
  const result = checkPlannedProcedure({ parameters: packA, member: null, asOf, request: validateEstimateInput({ procedure: 'maternity_normal', admissionDate: '2026-12-01' }, { requireBill: false }) });
  assert.match(result.verdictNote, /not a claim decision/);
  assert.ok(result.checks.some(check => check.id === 'maternity_wait'));
  assert.ok(result.steps.some(step => step.id === 'preauthorisation'));
  assert.throws(() => validateEstimateInput({ admissionDate: '01-12-2026' }, { requireBill: false }), error => error.code === 'ESTIMATE_INPUT_INVALID');
  assert.throws(() => validateEstimateInput({ admissionDate: '2026-12-05', dischargeDate: '2026-12-01' }, { requireBill: false }), error => error.code === 'ESTIMATE_INPUT_INVALID');
  assert.throws(() => validateEstimateInput({ admissionDate: '2026-12-01' }), error => error.code === 'ESTIMATE_INPUT_INVALID', 'estimates still need a bill');
});

test('member resolution: a value stated only for other members reads as not stated, never as unknown', () => {
  assert.equal(limitStatus(resolveForMember(packB, arjun), 'copay_general_percent'), 'not_stated');
  assert.equal(limitStatus(resolveForMember(packB, kamala), 'copay_general_percent'), 'value');
  assert.equal(limitStatus(packB, 'copay_general_percent'), 'unknown', 'without a member the policy-wide value stays Unknown');
});

test('policy status: in force, grace and lapsed states with dated reminders', () => {
  assert.equal(buildPolicyStatus({ parameters: packA, asOf }).state, 'in_force');
  assert.equal(buildPolicyStatus({ parameters: packA, asOf: '2027-04-15' }).state, 'grace_period');
  assert.equal(buildPolicyStatus({ parameters: packA, asOf: '2027-06-01' }).state, 'lapsed');
  assert.equal(buildPolicyStatus({ parameters: packA, asOf: '2026-01-01' }).state, 'not_started');
  const status = buildPolicyStatus({ parameters: packB, asOf });
  assert.ok(status.reminders.some(reminder => reminder.id === 'group_conversion'));
  assert.ok(status.groups.documents.some(field => field.key === 'endorsement_list'));
  assert.ok(status.groups.membership.length > 0 && status.groups.otherBenefits.length > 0);
});

test('emergency card shows policy status, claim deadlines and member-specific values, never protected ones', () => {
  const card = buildEmergencyCard({ record: { id: 'r', status: 'needs_review' }, parameters: packB, members: [kamala, vikram], asOf });
  assert.equal(card.policyStatus.state, 'in_force');
  assert.ok(card.ifPaidFirst.length > 0);
  assert.ok(card.cashlessProcess.some(field => field.key === 'excluded_hospitals_rule'));
  const kamalaCard = card.members.find(member => member.memberId === kamala.id);
  assert.ok(kamalaCard.memberSpecific.some(field => field.key === 'parent_sum_insured_cap'));
  const protectedKeys = new Set(SECTIONS.flatMap(section => section.parameters).filter(parameter => parameter.visibility === 'protected').map(parameter => parameter.key));
  const shown = [...Object.values(card).filter(Array.isArray).flat(), ...card.members.flatMap(member => member.memberSpecific)].map(field => field.key).filter(Boolean);
  assert.deepEqual(shown.filter(key => protectedKeys.has(key)), []);
});

test('references: sections 10–12 use dated reference files and a household city; broken files are ignored', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-references-'));
  try {
    writeFileSync(join(directory, 'insurer-disclosures.json'), JSON.stringify({ entries: [
      { insurerName: 'Demo General Insurance Company Limited', metric: 'claim_settlement_ratio_count', value: 95.5, period: 'FY2025-26', publishedOn: '2026-07-01', source: 'synthetic disclosure' },
      { insurerName: 'Demo General Insurance Company Limited', metric: 'network_hospitals_in_city', value: 412, period: '2026-08', publishedOn: '2026-08-15', source: 'synthetic network list', city: 'Pune' },
    ] }));
    writeFileSync(join(directory, 'procedure-costs.json'), JSON.stringify({ version: 'synthetic-2026', source: 'synthetic cost survey', publishedOn: '2026-06-01', entries: [
      { city: 'Pune', procedure: 'joint_replacement', typicalCostMinor: 25_000_000, highCostMinor: 40_000_000 },
      { city: 'Pune', procedure: 'appendicectomy', typicalCostMinor: 12_000_000, highCostMinor: 20_000_000 },
    ] }));
    writeFileSync(join(directory, 'regulatory-floor.json'), '{ not json');
    const references = loadBreakdownReferences({ directory });
    assert.equal(references.regulatoryFloor, null);
    assert.ok(references.problems.some(problem => /regulatory-floor/.test(problem)));
    const record = await buildPackRecord({ pack: 'b', household: { members: [kamala], city: 'Pune' }, asOf, references });
    assert.equal(record.claim_settlement_ratio_count.evidenceState, 'Dynamic');
    assert.equal(record.network_hospitals_in_city.value.count, 412);
    assert.equal(record.sum_insured_adequacy.evidenceState, 'Dynamic');
    assert.match(record.sum_insured_adequacy.value.text, /joint replacement: sub-limit ₹1,50,000 is ₹1,00,000 below the typical cost/);
    const noCity = await buildPackRecord({ pack: 'b', household: { members: [kamala], city: null }, asOf, references });
    assert.equal(noCity.sum_insured_adequacy.stateReason, 'household_city_unknown');
    assert.equal(noCity.network_hospitals_in_city.evidenceState, 'Unknown');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('household layering uses the top-up threshold, not a base deductible', async () => {
  const record = await buildPackRecord({ pack: 'a', asOf, otherRecords: [packC] });
  assert.equal(record.layering_gap.evidenceState, 'Calculated');
  assert.match(record.layering_gap.value.text, /deductible ₹5,00,000 vs this policy/);
});

test('found-path coverage: every extraction parameter is Proven with its gold value in at least one synthetic pack', async () => {
  const { loadSyntheticPack } = await import('./fixtures/policy-breakdown/synthetic-pack.mjs');
  const { EXTRACTION_SECTIONS } = await import('../src/modules/policy-breakdown/sections/index.js');
  const records = { a: packA, b: packB, c: packC };
  const proven = new Set();
  const failures = [];
  for (const [name, record] of Object.entries(records)) {
    for (const items of Object.values(loadSyntheticPack({ pack: name }).gold)) {
      for (const item of items) {
        if (!item.found) continue;
        const result = record[item.key];
        const target = item.memberScope ? result?.memberVariants?.find(variant => variant.memberScope === item.memberScope) : result;
        if (target?.evidenceState === 'Proven') proven.add(item.key);
        // A deliberate contradiction in a pack must surface as Conflicting; anything else not Proven is a defect.
        else if (result?.evidenceState !== 'Conflicting') failures.push(`${name}:${item.key}${item.memberScope ? `@${item.memberScope}` : ''}=${target?.evidenceState}/${target?.stateReason}`);
      }
    }
  }
  assert.deepEqual(failures, []);
  const missing = EXTRACTION_SECTIONS.flatMap(section => section.parameters).map(parameter => parameter.key).filter(key => !proven.has(key));
  assert.deepEqual(missing, []);
});

// ---------------------------------------------------------------------------------------------------------
// Independent review findings (2026-10-02, criteria round)
// ---------------------------------------------------------------------------------------------------------

const percentValue = percent => ({ kind: 'percent', percent });
const variantOnly = (key, variants) => ({ key, label: key, section: 6, evidenceState: 'Unknown', stateReason: 'member_specific_values_only', value: null, critical: false, visibility: 'cover', review: { state: 'unreviewed' },
  memberVariants: variants.map(([memberScope, value]) => ({ memberScope, value, evidenceState: 'Proven', stateReason: 'citations_verified' })) });
const confirmedAbsent = key => ({ key, label: key, section: 6, evidenceState: 'Unknown', stateReason: 'person_confirmed_not_stated_in_pack', value: null, critical: false, visibility: 'cover', review: { state: 'confirmed_absent' } });
const provenValue = (key, value) => ({ key, label: key, section: 6, evidenceState: 'Proven', value, critical: false, visibility: 'cover', review: { state: 'unreviewed' } });
const minimalRecord = extra => ({
  sum_insured_amount: provenValue('sum_insured_amount', { kind: 'money', amountMinor: 50_000_000 }),
  insured_members: provenValue('insured_members', { kind: 'text_list', items: ['Ramesh Kumar — Father', 'Sunil Kumar — Self'] }),
  ...Object.fromEntries(['copay_general_percent', 'copay_age_percent', 'copay_zone_percent', 'copay_non_network_percent', 'deductible_amount', 'copay_ped_disease_percent'].map(key => [key, confirmedAbsent(key)])),
  ...extra,
});
const flatBill = { hospital: { networkStatus: 'network', zone: 'zone_b' }, billLines: [{ head: 'other', amountMinor: 10_000_000 }], condition: { preExisting: false } };

test('review H1: a co-pay scoped to a relationship group applies to that member; an unresolved scope stays Unknown', () => {
  const father = { id: 'f', displayName: 'Mr. Ramesh Kumar', relationship: 'father' };
  const groupScoped = minimalRecord({ copay_general_percent: variantOnly('copay_general_percent', [['Dependent Parents', percentValue(20)]]) });
  assert.equal(estimatePlannedProcedure({ parameters: groupScoped, member: father, asOf, input: flatBill }).insurerPaysMinor.high, 8_000_000);
  const unresolved = minimalRecord({ copay_general_percent: variantOnly('copay_general_percent', [['Mrs. Sunita Kumar', percentValue(20)]]) });
  assert.equal(limitStatus(resolveForMember(unresolved, father), 'copay_general_percent'), 'unknown');
  assert.equal(estimatePlannedProcedure({ parameters: unresolved, member: father, asOf, input: flatBill }).insurerPaysMinor.low, 0, 'an unresolved scope must widen the range');
  const otherInsured = minimalRecord({ copay_general_percent: variantOnly('copay_general_percent', [['Sunil Kumar', percentValue(20)]]) });
  assert.equal(limitStatus(resolveForMember(otherInsured, father), 'copay_general_percent'), 'not_stated', 'scoped to another insured person by name');
});

test('review H2: a top-up with an unusable threshold never pays what the base policy paid', () => {
  const conflicted = { ...packC, topup_deductible_amount: { ...packC.topup_deductible_amount, evidenceState: 'Conflicting', value: null, stateReason: 'values_disagree' } };
  const input = { admissionDate: '2026-12-01', condition: { name: 'bypass', preExisting: false }, hospital: { networkStatus: 'network' }, billLines: [{ head: 'other', amountMinor: 80_000_000 }], otherPolicyPaysMinor: 50_000_000, deductibleAlreadyMetMinor: 0, sumInsuredAlreadyUsedMinor: 0 };
  const result = estimatePlannedProcedure({ parameters: conflicted, asOf, input });
  assert.ok(result.insurerPaysMinor.high <= 30_000_000, JSON.stringify(result.insurerPaysMinor));
  assert.equal(result.insurerPaysMinor.low, 0);
  assert.equal(result.status, 'insufficient_evidence');
});

test('review H3: the age co-pay is judged on the admission date', () => {
  const mother = { id: 'm', displayName: 'Kaushalya Devi', relationship: 'mother', dateOfBirth: '1965-06-01' };
  const input = { ...flatBill, admissionDate: '2026-07-01', condition: { name: 'hernia', preExisting: false } };
  const result = estimatePlannedProcedure({ parameters: packA, member: mother, asOf: '2026-05-01', input });
  assert.ok(result.steps.some(step => step.step === 'copay' && step.percent === 20), 'aged 61 on admission');
  const noDate = estimatePlannedProcedure({ parameters: packA, member: mother, asOf: '2026-05-01', input: { ...flatBill, condition: { name: 'hernia', preExisting: false } } });
  assert.ok(noDate.steps.some(step => step.step === 'copay' && /may apply/.test(step.description)), 'crosses 61 before the policy ends');
});

test('review M1: with no member chosen, member co-pays and caps bound the least the insurer pays', () => {
  const record = minimalRecord({
    copay_general_percent: { ...provenValue('copay_general_percent', percentValue(10)), memberVariants: [{ memberScope: 'Parents', value: percentValue(20), evidenceState: 'Proven' }] },
    parent_sum_insured_cap: variantOnly('parent_sum_insured_cap', [['Parents', { kind: 'money', amountMinor: 3_000_000 }]]),
  });
  const result = estimatePlannedProcedure({ parameters: record, asOf, input: flatBill });
  assert.equal(result.insurerPaysMinor.low, 3_000_000, '₹1,00,000 less the 20% parent co-pay is ₹80,000, then the tightest member cap ₹30,000');
  assert.equal(result.insurerPaysMinor.high, 9_000_000, 'policy-wide 10% for the best case');
  assert.notEqual(result.status, 'estimate');
});

test('review M2/M3: disease sub-limits apply without a condition and parse lakh, percent and several items', async () => {
  const { diseaseCap } = await import('../src/modules/policy-breakdown/consumers/estimate.js');
  assert.equal(diseaseCap('Cardiac procedures ₹2 lakh', null), 20_000_000);
  assert.equal(diseaseCap('Cancer: up to 25% of sum insured, maximum Rs. 5,00,000', 50_000_000), 12_500_000);
  assert.equal(diseaseCap('Cancer: 25% of sum insured', null), null);
  const record = minimalRecord({ other_disease_sublimits: provenValue('other_disease_sublimits', { kind: 'text_list', items: ['Cardiac procedures ₹30,000', 'Cardiac stents Rs. 2,50,000'] }) });
  const unnamed = estimatePlannedProcedure({ parameters: record, asOf, input: flatBill });
  assert.equal(unnamed.insurerPaysMinor.low, 3_000_000);
  const named = estimatePlannedProcedure({ parameters: record, asOf, input: { ...flatBill, condition: { name: 'cardiac bypass', preExisting: false } } });
  assert.equal(named.insurerPaysMinor.low, 3_000_000, 'the lowest of every matching item');
});

test('review M4/M5: an inferred wait start or name formatting never becomes a blocker', () => {
  const unknownBasis = { ...packA, waiting_period_start_basis: { ...packA.waiting_period_start_basis, evidenceState: 'Unknown', value: null, stateReason: 'not_found_in_source_pack' } };
  const request = validateEstimateInput({ admissionDate: '2026-04-20', condition: { name: 'fever', preExisting: false } }, { requireBill: false });
  const result = checkPlannedProcedure({ parameters: unknownBasis, member: null, asOf: '2026-04-15', request });
  assert.notEqual(result.checks.find(check => check.id === 'initial_wait').outcome, 'not_met');
  const surgery = checkPlannedProcedure({ parameters: packA, member: null, asOf, request: validateEstimateInput({ admissionDate: '2026-11-01', condition: { name: 'hernia surgery', preExisting: false } }, { requireBill: false }) });
  assert.notEqual(surgery.checks.find(check => check.id === 'specified_disease_wait').outcome, 'not_met');
  const honorific = { ...kaushalya, displayName: 'Smt. Kaushalya Devi' };
  const named = checkPlannedProcedure({ parameters: resolveForMember(packA, honorific), member: honorific, asOf, request });
  assert.equal(named.checks.find(check => check.id === 'member_insured').outcome, 'met');
  const card = buildEmergencyCard({ record: { id: 'r', status: 'needs_review' }, parameters: packA, members: [honorific], asOf });
  assert.equal(card.members[0].namedOnPolicy, true);
});

import { ageOn, countOf, dateOf, enumOf, flagOf, formatRupees, limitStatus, listOf, moneyOf, percentOf, provenVariants, resolveForMember, textOf, usable } from './record-values.js';
import { checkPlannedProcedure } from './procedure-check.js';

// Planned-procedure bill-to-payout estimate. Deterministic. Reads only the policy record and the inputs.
// Output is always a range (insurer pays low..high, household pays low..high) with every step, every
// parameter used and every assumption. It never states that a claim will be approved.

export const BILL_HEADS = Object.freeze([
  'room_rent', 'icu_charges', 'nursing', 'doctor_fees', 'surgeon_fees', 'anaesthetist_fees', 'ot_charges',
  'medicines_pharmacy', 'consumables', 'implants_devices', 'diagnostics', 'ambulance', 'air_ambulance', 'non_payable_misc', 'other',
]);
export const PROCEDURES = Object.freeze([
  'general_inpatient', 'day_care', 'cataract', 'maternity_normal', 'maternity_csection', 'joint_replacement',
  'modern_treatment', 'ayush', 'domiciliary', 'organ_donor', 'mental_illness', 'bariatric', 'other',
]);
const TOP_UP_TYPES = ['top_up', 'super_top_up'];
const isoDate = (value, name) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) bad(`${name} must be yyyy-mm-dd.`);
  return value;
};
const triState = (value, name) => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') bad(`${name} must be true, false or null.`);
  return value;
};
const ROOM_CATEGORIES = ['general_ward', 'shared_room', 'single_private_room', 'single_private_ac_room', 'any_room'];
const ZONE_COST = { zone_a: 3, zone_b: 2, zone_c: 1 };
const ASSOCIATED_HEADS = ['nursing', 'doctor_fees', 'surgeon_fees', 'anaesthetist_fees', 'ot_charges', 'medicines_pharmacy', 'consumables', 'implants_devices', 'diagnostics', 'other'];
const CORE_ASSOCIATED = ['nursing', 'doctor_fees', 'surgeon_fees', 'anaesthetist_fees', 'ot_charges'];
const EXEMPT_PATTERNS = [
  [/pharm|medicine|drug/i, 'medicines_pharmacy'],
  [/consumable/i, 'consumables'],
  [/implant|device|stent|prosthe/i, 'implants_devices'],
  [/diagnos|investigat|laborator|radiolog|patholog/i, 'diagnostics'],
];

const UNIT = { lakh: 100_000, lakhs: 100_000, lac: 100_000, lacs: 100_000, crore: 10_000_000, crores: 10_000_000 };

/** Lowest cap in paise stated in a sub-limit text item, or null when none can be read. */
export function diseaseCap(item, sumInsuredMinor) {
  const caps = [];
  for (const match of String(item).matchAll(/(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?)?/gi)) {
    const hasCurrency = /₹|rs|inr/i.test(match[0]);
    const unit = match[2] ? UNIT[match[2].toLowerCase()] : 1;
    if (!hasCurrency && !match[2]) continue;
    const rupees = Number(match[1].replace(/,/g, '')) * unit;
    if (Number.isFinite(rupees) && rupees > 0) caps.push(Math.round(rupees * 100));
  }
  for (const match of String(item).matchAll(/(\d+(?:\.\d+)?)\s*%\s*(?:of\s+(?:the\s+)?(?:base\s+)?(?:sum\s+insured|si))?/gi)) {
    if (sumInsuredMinor == null) return null;
    caps.push(Math.floor(sumInsuredMinor * Number(match[1]) / 100));
  }
  return caps.length ? Math.min(...caps) : null;
}

export class EstimateInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EstimateInputError';
    this.code = 'ESTIMATE_INPUT_INVALID';
    this.statusCode = 400;
  }
}

const bad = message => { throw new EstimateInputError(message); };
const minor = (value, name, { optional = true, max = 10_000_000_000 } = {}) => {
  if (value === undefined || value === null) { if (optional) return null; bad(`${name} is required.`); }
  if (!Number.isInteger(value) || value < 0 || value > max) bad(`${name} must be a non-negative integer amount in paise.`);
  return value;
};
const smallInt = (value, name, { min = 0, max = 365, fallback = null } = {}) => {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) bad(`${name} must be an integer from ${min} to ${max}.`);
  return value;
};
const oneOf = (value, allowed, name, fallback) => {
  if (value === undefined || value === null) return fallback;
  if (!allowed.includes(value)) bad(`${name} must be one of ${allowed.join(', ')}.`);
  return value;
};

export function validateEstimateInput(input, { requireBill = true } = {}) {
  if (!input || typeof input !== 'object') bad('Estimate input is required.');
  const lines = Array.isArray(input.billLines) ? input.billLines : [];
  if (lines.length > 60) bad('At most 60 bill lines are allowed.');
  const billLines = lines.map((line, index) => ({
    head: (() => {
      const head = oneOf(line?.head, BILL_HEADS, `billLines[${index}].head`);
      if (head === 'room_rent' || head === 'icu_charges') bad(`billLines[${index}]: send ${head === 'room_rent' ? 'room rent through room.ratePerDayMinor and room.days' : 'ICU through icu.ratePerDayMinor and icu.days'} so daily caps can apply.`);
      return head;
    })(),
    amountMinor: minor(line?.amountMinor, `billLines[${index}].amountMinor`, { optional: false }),
  }));
  const room = input.room ?? {};
  const icu = input.icu ?? {};
  const condition = input.condition ?? {};
  if (condition.name !== undefined && condition.name !== null && (typeof condition.name !== 'string' || condition.name.length > 120)) bad('condition.name must be text of at most 120 characters.');
  const value = {
    memberId: typeof input.memberId === 'string' ? input.memberId.slice(0, 120) : null,
    admissionDate: isoDate(input.admissionDate, 'admissionDate'),
    dischargeDate: isoDate(input.dischargeDate, 'dischargeDate'),
    stayHours: smallInt(input.stayHours, 'stayHours', { max: 8_760 }),
    abroad: triState(input.abroad, 'abroad') ?? false,
    previousDeliveries: smallInt(input.previousDeliveries, 'previousDeliveries', { max: 10 }),
    condition: {
      name: typeof condition.name === 'string' ? condition.name.trim() || null : null,
      preExisting: triState(condition.preExisting, 'condition.preExisting'),
      specifiedDisease: triState(condition.specifiedDisease, 'condition.specifiedDisease'),
      accident: triState(condition.accident, 'condition.accident') ?? false,
    },
    cumulativeBonusAccruedPercent: smallInt(input.cumulativeBonusAccruedPercent, 'cumulativeBonusAccruedPercent', { max: 200 }),
    corporateBufferApproved: triState(input.corporateBufferApproved, 'corporateBufferApproved'),
    deductibleAlreadyMetMinor: minor(input.deductibleAlreadyMetMinor, 'deductibleAlreadyMetMinor'),
    otherPolicyPaysMinor: minor(input.otherPolicyPaysMinor, 'otherPolicyPaysMinor'),
    memberAgeYears: smallInt(input.memberAgeYears, 'memberAgeYears', { max: 120 }),
    procedure: oneOf(input.procedure, PROCEDURES, 'procedure', 'general_inpatient'),
    eyes: smallInt(input.eyes, 'eyes', { min: 1, max: 2, fallback: 1 }),
    joints: smallInt(input.joints, 'joints', { min: 1, max: 2, fallback: 1 }),
    hospital: {
      networkStatus: oneOf(input.hospital?.networkStatus, ['network', 'non_network', 'unknown'], 'hospital.networkStatus', 'unknown'),
      zone: oneOf(input.hospital?.zone, ['zone_a', 'zone_b', 'zone_c', 'unknown'], 'hospital.zone', 'unknown'),
      excluded: triState(input.hospital?.excluded, 'hospital.excluded'),
    },
    room: {
      category: oneOf(room.category, ROOM_CATEGORIES, 'room.category', null),
      ratePerDayMinor: minor(room.ratePerDayMinor, 'room.ratePerDayMinor'),
      days: smallInt(room.days, 'room.days', { fallback: 0 }),
      eligibleRoomRatePerDayMinor: minor(room.eligibleRoomRatePerDayMinor, 'room.eligibleRoomRatePerDayMinor'),
    },
    icu: { ratePerDayMinor: minor(icu.ratePerDayMinor, 'icu.ratePerDayMinor'), days: smallInt(icu.days, 'icu.days', { fallback: 0 }) },
    billLines,
    sumInsuredAlreadyUsedMinor: minor(input.sumInsuredAlreadyUsedMinor, 'sumInsuredAlreadyUsedMinor'),
  };
  if (value.room.days > 0 && value.room.ratePerDayMinor == null) bad('room.ratePerDayMinor is required when room.days is set.');
  if (value.icu.days > 0 && value.icu.ratePerDayMinor == null) bad('icu.ratePerDayMinor is required when icu.days is set.');
  if (requireBill && billLines.length === 0 && value.room.days === 0 && value.icu.days === 0) bad('Provide bill lines or room/ICU days.');
  if (value.admissionDate && value.dischargeDate && value.dischargeDate < value.admissionDate) bad('dischargeDate must not be before admissionDate.');
  return value;
}

function interval(amount) { return { low: amount, high: amount }; }

/**
 * Interval semantics: `low` is the least the insurer may pay, `high` the most. Any reducer whose value is
 * unknown pushes `low` to its worst case; when no worst case can be bounded, `low` becomes zero and the
 * status is `insufficient_evidence`. A value a person confirmed absent is treated as not applying.
 */
export function estimatePlannedProcedure({ parameters: recordParameters, input, member = null, asOf }) {
  const request = validateEstimateInput(input);
  const parameters = resolveForMember(recordParameters, member);
  const steps = [];
  const assumptions = [];
  const blockingUnknowns = [];
  const used = new Set();
  let unbounded = false;
  const use = key => { used.add(key); return key; };
  const status = key => { used.add(key); return limitStatus(parameters, key); };
  const flag = (key, message, { bounded = true } = {}) => {
    used.add(key);
    if (!bounded) unbounded = true;
    blockingUnknowns.push({ key, evidenceState: parameters[key]?.evidenceState ?? 'Unknown', bounded, message });
  };
  const absentNote = key => {
    if (limitStatus(parameters, key) === 'not_stated') flag(key, `${parameters[key]?.label ?? key}: not stated in the policy pack, so treated as not applying. Confirm or mark it absent in review.`);
    else assumptions.push(`${parameters[key]?.label ?? key}: a person confirmed the policy does not state this, so it is treated as not applying.`);
  };
  const notApplying = value => value === 'absent' || value === 'not_stated';

  // Bill by head.
  const heads = Object.fromEntries(BILL_HEADS.map(head => [head, 0]));
  for (const line of request.billLines) heads[line.head] += line.amountMinor;
  if (request.room.days > 0) heads.room_rent += request.room.ratePerDayMinor * request.room.days;
  if (request.icu.days > 0) heads.icu_charges += request.icu.ratePerDayMinor * request.icu.days;
  const billTotal = Object.values(heads).reduce((sum, amount) => sum + amount, 0);
  const payable = Object.fromEntries(BILL_HEADS.map(head => [head, interval(heads[head])]));
  steps.push({ step: 'bill_total', description: `Hospital bill ${formatRupees(billTotal)}.`, amountMinor: billTotal, parameterKeys: [] });

  if (heads.non_payable_misc > 0) {
    payable.non_payable_misc = interval(0);
    const rule = textOf(parameters, use('non_payable_items_rule'));
    steps.push({ step: 'non_payable_items', description: `Items marked non-payable removed (${formatRupees(heads.non_payable_misc)}).${rule ? ` Policy rule: "${rule}".` : ''}`, amountMinor: -heads.non_payable_misc, parameterKeys: rule ? ['non_payable_items_rule'] : [] });
  }
  if (heads.consumables > 0) {
    const addOn = flagOf(parameters, use('consumables_cover_addon'));
    const consumables = addOn === true ? true : flagOf(parameters, use('consumables_payable'));
    if (addOn === true) steps.push({ step: 'consumables', description: 'Consumables are paid under the consumables add-on cover.', amountMinor: 0, parameterKeys: ['consumables_cover_addon'] });
    if (consumables === false) { payable.consumables = interval(0); steps.push({ step: 'consumables', description: 'Consumables are not payable under this record.', amountMinor: -heads.consumables, parameterKeys: ['consumables_payable'] }); }
    else if (consumables === null) { payable.consumables = { low: 0, high: heads.consumables }; flag('consumables_payable', 'Whether consumables are paid is not established; the range covers both.'); }
  }

  const sumInsured = moneyOf(parameters, use('sum_insured_amount'));
  if (sumInsured == null) flag('sum_insured_amount', 'Sum insured is not established; no ceiling can be applied.', { bounded: false });

  // Room rent eligibility.
  const actualRate = request.room.ratePerDayMinor;
  let eligibleRate = null;
  if (request.room.days > 0) {
    const kindStatus = status('room_rent_limit_kind');
    const kind = kindStatus === 'value' ? enumOf(parameters, 'room_rent_limit_kind') : null;
    const percentRate = () => {
      const percent = percentOf(parameters, use('room_rent_limit_percent'));
      return percent != null && sumInsured != null ? Math.floor(sumInsured * percent / 100) : null;
    };
    const categoryRate = () => {
      const eligible = enumOf(parameters, use('room_rent_eligible_category'));
      if (!eligible || eligible === 'not_stated' || !request.room.category) return null;
      if (eligible === 'any_room') return actualRate;
      if (ROOM_CATEGORIES.indexOf(request.room.category) <= ROOM_CATEGORIES.indexOf(eligible)) return actualRate;
      return request.room.eligibleRoomRatePerDayMinor;
    };
    if (notApplying(kindStatus) || kind === 'no_limit') eligibleRate = actualRate;
    else if (kind === 'percent_of_si_per_day') eligibleRate = percentRate();
    else if (kind === 'fixed_amount_per_day') eligibleRate = moneyOf(parameters, use('room_rent_limit_amount'));
    else if (kind === 'room_category') eligibleRate = categoryRate();
    else if (kind === 'category_or_percent') eligibleRate = categoryRate() ?? percentRate();
    if (notApplying(kindStatus)) absentNote('room_rent_limit_kind');
    if (eligibleRate == null) {
      flag(kind ? 'room_rent_eligible_category' : 'room_rent_limit_kind', 'The eligible room rent for this stay is not established. Supply the room category and the hospital tariff for the eligible room, or review the room-rent parameters.', { bounded: false });
      payable.room_rent = { low: 0, high: heads.room_rent };
    } else {
      const capped = Math.min(actualRate, eligibleRate) * request.room.days;
      if (capped < heads.room_rent) steps.push({ step: 'room_rent_cap', description: `Room rent capped at ${formatRupees(eligibleRate)} per day.`, amountMinor: capped - heads.room_rent, parameterKeys: ['room_rent_limit_kind', 'room_rent_eligible_category', 'room_rent_limit_percent', 'room_rent_limit_amount'].filter(key => used.has(key)) });
      payable.room_rent = interval(capped);
    }
  }

  // Proportionate deduction.
  if (request.room.days > 0 && eligibleRate == null) {
    for (const head of ASSOCIATED_HEADS) payable[head].low = 0;
  } else if (eligibleRate != null && actualRate != null && eligibleRate < actualRate) {
    const ratio = eligibleRate / actualRate;
    const appliesStatus = status('proportionate_deduction_applies');
    const applies = appliesStatus === 'value' ? flagOf(parameters, 'proportionate_deduction_applies') : notApplying(appliesStatus) ? false : null;
    if (notApplying(appliesStatus)) absentNote('proportionate_deduction_applies');
    const exemptStatus = status('proportionate_deduction_exempt_heads');
    const exemptList = exemptStatus === 'value' ? listOf(parameters, 'proportionate_deduction_exempt_heads') : notApplying(exemptStatus) ? [] : null;
    const exempt = new Set(exemptList ? EXEMPT_PATTERNS.filter(([pattern]) => exemptList.some(item => pattern.test(item))).map(([, head]) => head) : []);
    if (applies === null) flag('proportionate_deduction_applies', 'Whether a proportionate deduction applies is not established; the range covers both.');
    if (applies !== false && exemptList === null) flag('proportionate_deduction_exempt_heads', 'The heads exempt from proportionate deduction are not established; the range covers both.');
    const lowHeads = applies === false ? [] : ASSOCIATED_HEADS.filter(head => exemptList === null || !exempt.has(head));
    const highHeads = applies === true ? (exemptList ? lowHeads : CORE_ASSOCIATED) : [];
    let reductionLow = 0;
    let reductionHigh = 0;
    for (const head of ASSOCIATED_HEADS) {
      if (lowHeads.includes(head)) { const reduced = Math.floor(payable[head].low * ratio); reductionLow += payable[head].low - reduced; payable[head].low = reduced; }
      if (highHeads.includes(head)) { const reduced = Math.floor(payable[head].high * ratio); reductionHigh += payable[head].high - reduced; payable[head].high = reduced; }
    }
    if (reductionLow > 0 || reductionHigh > 0) steps.push({ step: 'proportionate_deduction', description: `Associated charges scaled by ${(ratio * 100).toFixed(1)}% because the room exceeds the eligible room.`, amountMinor: -reductionLow, amountRangeMinor: { mostReduction: reductionLow, leastReduction: reductionHigh }, parameterKeys: ['proportionate_deduction_applies', 'proportionate_deduction_exempt_heads'] });
  }

  // ICU.
  if (heads.icu_charges > 0) {
    const icuStatus = status('icu_limit_kind');
    const icuKind = icuStatus === 'value' ? enumOf(parameters, 'icu_limit_kind') : null;
    let icuCap = null;
    if (icuKind === 'fixed_amount_per_day') icuCap = moneyOf(parameters, use('icu_limit_amount'));
    if (icuKind === 'percent_of_si_per_day') { const percent = percentOf(parameters, use('icu_limit_percent')); icuCap = percent != null && sumInsured != null ? Math.floor(sumInsured * percent / 100) : null; }
    if (notApplying(icuStatus)) absentNote('icu_limit_kind');
    else if (icuKind === null || (['fixed_amount_per_day', 'percent_of_si_per_day'].includes(icuKind) && icuCap == null)) {
      flag('icu_limit_kind', 'The ICU limit is not established.', { bounded: false });
      payable.icu_charges = { low: 0, high: heads.icu_charges };
    }
    if (icuCap != null && request.icu.ratePerDayMinor > icuCap) {
      const capped = icuCap * request.icu.days;
      steps.push({ step: 'icu_cap', description: `ICU capped at ${formatRupees(icuCap)} per day.`, amountMinor: capped - heads.icu_charges, parameterKeys: ['icu_limit_kind'] });
      payable.icu_charges = interval(capped);
    }
  }

  // Ambulance.
  if (heads.ambulance > 0) {
    const ambulanceStatus = status('road_ambulance_limit');
    const limit = moneyOf(parameters, 'road_ambulance_limit');
    if (notApplying(ambulanceStatus)) absentNote('road_ambulance_limit');
    else if (limit == null) { flag('road_ambulance_limit', 'The ambulance limit is not established.'); payable.ambulance = { low: 0, high: heads.ambulance }; }
    else if (heads.ambulance > limit) { payable.ambulance = interval(limit); steps.push({ step: 'ambulance_cap', description: `Ambulance capped at ${formatRupees(limit)}.`, amountMinor: limit - heads.ambulance, parameterKeys: ['road_ambulance_limit'] }); }
  }

  if (heads.air_ambulance > 0) {
    const airStatus = status('air_ambulance_limit');
    const limit = moneyOf(parameters, 'air_ambulance_limit');
    const covered = flagOf(parameters, use('air_ambulance_covered'));
    if (covered === false) { payable.air_ambulance = interval(0); steps.push({ step: 'air_ambulance', description: 'Air ambulance is not covered under this record.', amountMinor: -heads.air_ambulance, parameterKeys: ['air_ambulance_covered'] }); }
    else if (notApplying(airStatus) && covered === true) absentNote('air_ambulance_limit');
    else if (limit == null) { flag('air_ambulance_limit', 'Air ambulance cover or its limit is not established.'); payable.air_ambulance = { low: 0, high: heads.air_ambulance }; }
    else if (heads.air_ambulance > limit) { payable.air_ambulance = interval(limit); steps.push({ step: 'air_ambulance_cap', description: `Air ambulance capped at ${formatRupees(limit)}.`, amountMinor: limit - heads.air_ambulance, parameterKeys: ['air_ambulance_limit'] }); }
  }

  // Surgery component caps (e.g. surgeon and anaesthetist fees as a share of a package) are clause text, not a
  // single number; the least the insurer may pay for those heads is therefore nothing.
  const componentCaps = textOf(parameters, use('surgery_component_caps'));
  if (componentCaps && heads.surgeon_fees + heads.anaesthetist_fees > 0) {
    payable.surgeon_fees.low = 0;
    payable.anaesthetist_fees.low = 0;
    flag('surgery_component_caps', `The policy caps surgery components: "${componentCaps}". Surgeon and anaesthetist fees may be reduced; the range covers that.`);
  }

  let admissible = Object.values(payable).reduce((sum, value) => ({ low: sum.low + value.low, high: sum.high + value.high }), { low: 0, high: 0 });

  // Procedure sub-limits. Each component is a cap the record may state; the lowest established cap applies.
  const percentOfSum = key => { const percent = percentOf(parameters, key); return percent != null && sumInsured != null ? Math.floor(sumInsured * percent / 100) : null; };
  const SUBLIMITS = {
    cataract: [['cataract_limit_per_eye', () => moneyOf(parameters, 'cataract_limit_per_eye') * request.eyes, true]],
    joint_replacement: [['joint_replacement_limit_per_joint', () => moneyOf(parameters, 'joint_replacement_limit_per_joint') * request.joints, true]],
    maternity_normal: [['maternity_normal_limit', () => moneyOf(parameters, 'maternity_normal_limit'), true]],
    maternity_csection: [['maternity_csection_limit', () => moneyOf(parameters, 'maternity_csection_limit'), true]],
    modern_treatment: [['modern_treatment_limit_percent', () => percentOfSum('modern_treatment_limit_percent'), true]],
    organ_donor: [['organ_donor_limit_amount', () => moneyOf(parameters, 'organ_donor_limit_amount'), true]],
    domiciliary: [['domiciliary_limit_amount', () => moneyOf(parameters, 'domiciliary_limit_amount'), false], ['domiciliary_limit_percent', () => percentOfSum('domiciliary_limit_percent'), false]],
  };
  let components = SUBLIMITS[request.procedure] ?? [];
  if (request.procedure === 'ayush') {
    const kindStatus = status('ayush_limit_kind');
    const kind = enumOf(parameters, 'ayush_limit_kind');
    if (kind === 'fixed_amount') components = [['ayush_limit_amount', () => moneyOf(parameters, 'ayush_limit_amount'), true]];
    else if (kind === 'percent_of_si') { flag('ayush_limit_kind', 'AYUSH is limited to a share of the sum insured that this record does not hold as a number.', { bounded: false }); admissible = { low: 0, high: admissible.high }; }
    else if (kind !== 'up_to_sum_insured') {
      if (notApplying(kindStatus)) absentNote('ayush_limit_kind');
      else { flag('ayush_limit_kind', 'The AYUSH limit is not established.', { bounded: false }); admissible = { low: 0, high: admissible.high }; }
    }
  }
  const caps = [];
  let anyComponentUnknown = false;
  for (const [key, toCap, required] of components) {
    const componentStatus = status(key);
    if (componentStatus === 'value') { const cap = toCap(); if (cap != null) caps.push({ key, cap }); else anyComponentUnknown = true; continue; }
    if (notApplying(componentStatus)) { absentNote(key); continue; }
    if (required || components.every(([other]) => limitStatus(parameters, other) !== 'value')) anyComponentUnknown = true;
  }
  if (anyComponentUnknown && caps.length === 0) {
    const keys = components.map(([key]) => key);
    flag(keys[0], 'A sub-limit for this procedure is not established in the record.', { bounded: false });
    admissible = { low: 0, high: admissible.high };
  } else if (caps.length) {
    if (anyComponentUnknown) {
      flag(components.find(([key]) => !caps.some(item => item.key === key))[0], 'Part of this procedure\'s sub-limit is not established and may be tighter than the known part.', { bounded: false });
      admissible = { low: 0, high: admissible.high };
    }
    const tightest = caps.reduce((best, item) => (item.cap < best.cap ? item : best));
    if (admissible.high > tightest.cap || admissible.low > tightest.cap) steps.push({ step: 'procedure_sublimit', description: `Procedure sub-limit ${formatRupees(tightest.cap)}.`, amountMinor: Math.min(admissible.low, tightest.cap) - admissible.low, parameterKeys: caps.map(item => item.key) });
    admissible = { low: Math.min(admissible.low, tightest.cap), high: Math.min(admissible.high, tightest.cap) };
  }

  // Disease-wise sub-limits are listed as text ("Cardiac procedures ₹2,00,000", "25% of SI, maximum Rs. 5 lakh").
  // Every item that names the condition caps the claim at the lowest amount it states. With no condition named,
  // any listed item may apply, so the least the insurer pays drops to the lowest listed cap.
  const diseaseLimits = listOf(parameters, use('other_disease_sublimits'));
  if (diseaseLimits?.length) {
    const conditionWords = new Set((request.condition.name ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 4));
    const hits = request.condition.name
      ? diseaseLimits.filter(item => item.toLowerCase().split(/[^a-z0-9]+/).some(word => word.length >= 4 && conditionWords.has(word)))
      : diseaseLimits;
    const parsed = hits.map(item => ({ item, cap: diseaseCap(item, sumInsured) }));
    if (parsed.length) {
      const readable = parsed.filter(entry => entry.cap != null);
      const lowest = readable.length === parsed.length ? Math.min(...readable.map(entry => entry.cap)) : 0;
      const label = parsed.map(entry => `"${entry.item}"`).join('; ');
      flag('other_disease_sublimits', request.condition.name
        ? `Disease-wise sub-limits that name this condition: ${label}. A person should confirm they apply.`
        : `The policy has disease-wise sub-limits (${label}). No condition was named, so the least shown assumes the tightest one applies.`);
      if (lowest < admissible.low) steps.push({ step: 'disease_sublimit', description: `Disease-wise sub-limit ${formatRupees(lowest)} may apply (${label}).`, amountMinor: lowest - admissible.low, parameterKeys: ['other_disease_sublimits'] });
      // Only the low bound moves: whether an item truly applies needs a person.
      admissible = { low: Math.min(admissible.low, lowest), high: admissible.high };
    }
  }

  // Deductible. A top-up or super top-up uses its threshold; an aggregate threshold is reduced by what was
  // already met this year, and by what another policy pays when the wording counts that toward it.
  const policyType = enumOf(parameters, use('policy_type'));
  // An unknown policy type with a stated top-up threshold is treated as a top-up (the cautious reading).
  const isTopUp = TOP_UP_TYPES.includes(policyType) || (policyType == null && limitStatus(parameters, 'topup_deductible_amount') === 'value');
  const topUpStatus = isTopUp ? status('topup_deductible_amount') : null;
  // A top-up falls back to deductible_amount only when its own threshold is confirmed or found absent.
  const deductibleKey = isTopUp && (topUpStatus === 'value' || !notApplying(topUpStatus)) ? 'topup_deductible_amount' : 'deductible_amount';
  const deductibleStatus = status(deductibleKey);
  const deductible = moneyOf(parameters, deductibleKey);
  const deductibleKind = enumOf(parameters, use('deductible_kind'));
  let deductibleLow = deductible ?? 0; // reduction applied to the insurer low bound
  let deductibleHigh = deductible ?? 0; // reduction applied to the insurer high bound
  if (notApplying(deductibleStatus)) { absentNote(deductibleKey); deductibleLow = 0; deductibleHigh = 0; }
  else if (deductible == null) { flag(deductibleKey, 'Whether a deductible applies is not established.', { bounded: false }); deductibleHigh = 0; }
  else if (isTopUp) {
    // A top-up never pays what the base policy paid. Its threshold is reduced by what was already met this
    // year (aggregate kind). When base payouts count toward the threshold, this claim's base payout fills it;
    // when they do not, the household must also bear the threshold on top of the base payout.
    const aggregate = enumOf(parameters, use('topup_deductible_kind')) === 'aggregate_per_year';
    const counts = flagOf(parameters, use('base_payout_counts_toward_deductible'));
    const otherPays = request.otherPolicyPaysMinor ?? 0;
    const remainingNoneMet = Math.max(0, deductible - (aggregate ? request.deductibleAlreadyMetMinor ?? 0 : 0));
    const remainingAllMet = aggregate && request.deductibleAlreadyMetMinor == null ? 0 : remainingNoneMet;
    const reduction = (remaining, baseCounts) => (baseCounts ? Math.max(remaining, otherPays) : remaining + otherPays);
    deductibleLow = reduction(remainingNoneMet, counts === true);
    deductibleHigh = reduction(remainingAllMet, counts !== false);
    if (aggregate && request.deductibleAlreadyMetMinor == null) assumptions.push('The part of the yearly threshold already met was not supplied; the range covers none to all of it.');
    if (otherPays && counts == null) flag('base_payout_counts_toward_deductible', 'Whether the base policy payout counts toward this threshold is not established; the range covers both.');
    if (request.otherPolicyPaysMinor == null) assumptions.push('This is a top-up policy. Supply what the base policy pays for this stay (otherPolicyPaysMinor) for a tighter range.');
  }

  // Co-pays: each is applied to the low bound when it may apply, to the high bound only when it certainly applies.
  const lowCopays = [];
  const highCopays = [];
  const copayCheck = (key, applies, reason) => {
    // applies: true | false | null (cannot tell)
    if (applies === false) return;
    const copayStatus = status(key);
    // No member chosen: a co-pay some members carry may apply, so the highest member variant bounds the low side.
    const variants = member ? [] : provenVariants(parameters, key);
    if (variants.length) {
      const worst = variants.reduce((best, item) => (item.value.percent > best.value.percent ? item : best));
      const policyWide = copayStatus === 'value' ? percentOf(parameters, key) : 0;
      if (worst.value.percent > (policyWide ?? 0)) {
        lowCopays.push({ key, percent: worst.value.percent, reason: `${reason} for ${worst.memberScope}` });
        flag(key, `${reason}: ${worst.value.percent}% applies to ${worst.memberScope}. Choose the member for an exact range.`);
        if (copayStatus !== 'value') return;
        if (policyWide) { const copay = { key, percent: policyWide, reason }; if (applies === true) highCopays.push(copay); }
        return;
      }
    }
    if (notApplying(copayStatus)) { absentNote(key); return; }
    if (copayStatus !== 'value') { flag(key, `${reason}: the co-pay percentage is ${copayStatus === 'withheld' ? 'withheld by permission' : 'not established'}.`, { bounded: false }); return; }
    const percent = percentOf(parameters, key);
    if (!percent) return;
    const copay = { key, percent, reason };
    lowCopays.push(copay);
    if (applies === true) highCopays.push(copay);
    else flag(key, `${reason}: whether it applies to this stay is not established; the range covers both.`);
  };
  copayCheck('copay_general_percent', true, 'General co-pay');
  // Age is taken on the admission date. Without one, a member who crosses the threshold before the policy ends
  // may or may not be charged, so the co-pay counts toward the low bound only.
  const ageDate = request.admissionDate ?? asOf;
  const age = request.memberAgeYears ?? ageOn(member?.dateOfBirth ?? null, ageDate);
  const ageThreshold = countOf(parameters, use('copay_age_threshold_years'));
  const policyEnd = dateOf(parameters, 'policy_end_date');
  const crossesLater = !request.admissionDate && request.memberAgeYears == null && member?.dateOfBirth && policyEnd && ageThreshold != null && age != null && age < ageThreshold && ageOn(member.dateOfBirth, policyEnd) >= ageThreshold;
  copayCheck('copay_age_percent', age == null || ageThreshold == null || crossesLater ? null : age >= ageThreshold, age != null && ageThreshold != null ? `Member aged ${age} (threshold ${ageThreshold})` : 'Age-based co-pay');
  const policyZone = enumOf(parameters, use('policy_zone'));
  const zoneApplies = request.hospital.zone === 'unknown' || !policyZone ? null : ZONE_COST[request.hospital.zone] > (ZONE_COST[policyZone] ?? 99);
  copayCheck('copay_zone_percent', zoneApplies, 'Zone co-pay');
  // The PED co-pay is member-specific and protected. When the person has not said whether the condition is
  // pre-existing and the percentage is not readable, it is disclosed rather than allowed to unbound the range.
  if (request.condition.preExisting === true || limitStatus(parameters, 'copay_ped_disease_percent') === 'value') copayCheck('copay_ped_disease_percent', request.condition.preExisting, 'Pre-existing disease co-pay');
  else if (request.condition.preExisting !== false) { use('copay_ped_disease_percent'); assumptions.push('If this condition is pre-existing, a disease-specific co-pay may apply that this view of the record does not show. Say whether it is pre-existing for a tighter answer.'); }
  copayCheck('copay_non_network_percent', request.hospital.networkStatus === 'unknown' ? null : request.hospital.networkStatus === 'non_network', 'Non-network hospital co-pay');
  if (request.hospital.networkStatus === 'unknown') assumptions.push('Hospital network status is Dynamic and was not supplied; confirm it with the hospital desk or TPA.');

  const sequential = list => list.reduce((share, item) => share * (1 - item.percent / 100), 1);
  const additive = list => Math.max(0, 1 - list.reduce((sum, item) => sum + item.percent, 0) / 100);
  const reduce = (amount, copays, ded) => {
    const options = [sequential(copays), additive(copays)].flatMap(share => [Math.max(0, amount - ded) * share, Math.max(0, amount * share - ded)]);
    return { min: Math.floor(Math.min(...options)), max: Math.floor(Math.max(...options)) };
  };
  let insurer = { low: reduce(admissible.low, lowCopays, deductibleLow).min, high: reduce(admissible.high, highCopays, deductibleHigh).max };
  if (deductible) steps.push({ step: 'deductible', description: `${isTopUp ? 'Top-up threshold' : 'Deductible'} ${formatRupees(deductible)}${deductibleKind ? ` (${deductibleKind})` : ''}${deductibleLow !== deductible || deductibleHigh !== deductible ? `; this policy's share is reduced by ${formatRupees(deductibleHigh)} to ${formatRupees(deductibleLow)}${isTopUp && request.otherPolicyPaysMinor ? ', including what the base policy pays' : ''}` : ''}.`, amountMinor: -deductibleLow, parameterKeys: [deductibleKey, ...(deductibleKind ? ['deductible_kind'] : []), ...(isTopUp ? ['topup_deductible_kind', 'base_payout_counts_toward_deductible'] : [])] });
  for (const item of lowCopays) steps.push({ step: 'copay', description: `${item.reason}: ${item.percent}% co-pay${highCopays.includes(item) ? '' : ' (may apply)'}.`, percent: item.percent, parameterKeys: [item.key] });
  if (lowCopays.length > 1) assumptions.push('Several co-pays may apply; whether they combine additively or one after another is not stated, so the range covers both.');
  if (deductible && lowCopays.length) {
    const order = usable(parameters, use('reducer_order'));
    assumptions.push(order ? `The record states an order for deductions ("${order.value.text}"); the range still covers both orders until a person confirms it.` : 'The order of deductible and co-pay is not stated; the range covers both orders.');
  }

  // Sum-insured ceiling. Member caps lower it; bonus, restoration and a corporate buffer may raise the most the
  // insurer pays, but only what is certain raises the least.
  if (sumInsured != null) {
    const usedAlready = request.sumInsuredAlreadyUsedMinor;
    if (usedAlready == null) assumptions.push(`Sum insured already used this policy year was not supplied; assumed nothing used.${enumOf(parameters, use('sum_insured_structure')) === 'family_floater' ? ' This is a floater, so claims by other members reduce it.' : ''}`);
    const memberCaps = ['sum_insured_per_member_cap', 'parent_sum_insured_cap'].map(key => ({ key, cap: moneyOf(parameters, use(key)) })).filter(item => item.cap != null);
    const base = Math.min(sumInsured, ...memberCaps.map(item => item.cap));
    if (base < sumInsured) steps.push({ step: 'member_cap', description: `Cover for this member is capped at ${formatRupees(base)}.`, amountMinor: 0, parameterKeys: memberCaps.map(item => item.key) });
    // No member chosen: the tightest member cap bounds the least the insurer pays.
    const variantCaps = member ? [] : ['sum_insured_per_member_cap', 'parent_sum_insured_cap'].flatMap(key => provenVariants(parameters, key).map(item => ({ key, cap: item.value.amountMinor, scope: item.memberScope })));
    const tightestVariant = variantCaps.length ? variantCaps.reduce((best, item) => (item.cap < best.cap ? item : best)) : null;
    const baseLow = tightestVariant && tightestVariant.cap < base ? tightestVariant.cap : base;
    if (tightestVariant && tightestVariant.cap < base) flag(tightestVariant.key, `Cover for ${tightestVariant.scope} is capped at ${formatRupees(tightestVariant.cap)}. Choose the member for an exact ceiling.`);
    let extraLow = 0;
    let extraHigh = 0;
    const bonusMax = percentOf(parameters, use('cumulative_bonus_max_percent'));
    use('cumulative_bonus_percent_per_year'); use('cumulative_bonus_reduction_percent'); use('guaranteed_bonus_percent_per_year');
    if (request.cumulativeBonusAccruedPercent != null) {
      const percent = bonusMax != null ? Math.min(request.cumulativeBonusAccruedPercent, bonusMax) : request.cumulativeBonusAccruedPercent;
      const bonus = Math.floor(sumInsured * percent / 100);
      extraLow += bonus; extraHigh += bonus;
      if (bonus > 0) steps.push({ step: 'bonus', description: `Accrued bonus of ${percent}% adds ${formatRupees(bonus)} of cover.`, amountMinor: 0, parameterKeys: ['cumulative_bonus_max_percent'] });
    } else if (bonusMax != null || percentOf(parameters, 'guaranteed_bonus_percent_per_year') != null) {
      if (bonusMax != null) extraHigh += Math.floor(sumInsured * bonusMax / 100);
      assumptions.push(`Accrued bonus was not supplied (cumulativeBonusAccruedPercent); the least shown adds none${bonusMax != null ? `, the most adds the ${bonusMax}% maximum` : ''}.`);
    }
    const restoration = flagOf(parameters, use('restoration_available'));
    if (restoration === true && usedAlready) {
      const restorePercent = percentOf(parameters, use('restoration_percent'));
      const trigger = enumOf(parameters, use('restoration_trigger'));
      const sameIllness = flagOf(parameters, use('restoration_same_illness_allowed'));
      use('restoration_frequency_per_year'); use('restoration_conditions');
      const exhausted = usedAlready >= base;
      if (restorePercent != null && (exhausted || trigger === 'partial_or_complete_exhaustion' || trigger == null)) {
        // Restoration conditions (single-claim caps, same-illness rules) are clause text, so it only raises the
        // most the insurer may pay.
        const restored = Math.floor(sumInsured * restorePercent / 100);
        extraHigh += restored;
        assumptions.push(`Restoration of ${restorePercent}% may add up to ${formatRupees(restored)}${sameIllness === false ? ', but not for the same illness that used the cover' : ''}; the least shown does not count it.`);
      }
    }
    const buffer = moneyOf(parameters, use('corporate_buffer_amount'));
    if (buffer != null) {
      if (request.corporateBufferApproved === true) { extraLow += buffer; extraHigh += buffer; }
      else if (request.corporateBufferApproved == null) { extraHigh += buffer; assumptions.push(`A corporate buffer of ${formatRupees(buffer)} may be released with employer approval; the least shown does not count it.`); }
    }
    const inflation = percentOf(parameters, use('inflation_protection_percent'));
    if (inflation != null) assumptions.push(`Inflation protection adds ${inflation}% to the sum insured at renewal; this record's stated sum insured is used as is.`);
    const availableLow = Math.max(0, baseLow - (usedAlready ?? 0)) + extraLow;
    const availableHigh = Math.max(0, base - (usedAlready ?? 0)) + extraHigh;
    if (insurer.high > availableHigh || insurer.low > availableLow) steps.push({ step: 'sum_insured_ceiling', description: availableLow === availableHigh ? `Available sum insured ${formatRupees(availableLow)}.` : `Available sum insured ${formatRupees(availableLow)} to ${formatRupees(availableHigh)}.`, amountMinor: Math.min(insurer.low, availableLow) - insurer.low, parameterKeys: ['sum_insured_amount'] });
    insurer = { low: Math.min(insurer.low, availableLow), high: Math.min(insurer.high, availableHigh) };
  }
  if (request.otherPolicyPaysMinor && !isTopUp) {
    const order = textOf(parameters, use('claim_order_rule')) ?? textOf(parameters, use('contribution_clause'));
    assumptions.push(`Another policy also pays for this stay${order ? `; the wording says: "${order}"` : ''}. This range is for this policy alone.`);
  }

  // Benefits paid on top of the bill (daily cash, attendant allowance).
  const stayDays = request.room.days + request.icu.days;
  const additionalBenefits = [];
  if (stayDays > 0) {
    const dailyCash = moneyOf(parameters, use('hospital_daily_cash_amount'));
    const dailyCashCovered = flagOf(parameters, use('hospital_daily_cash_covered'));
    if (dailyCash != null && dailyCashCovered !== false) {
      const maxDays = countOf(parameters, use('hospital_daily_cash_max_days'));
      const days = maxDays != null ? Math.min(stayDays, maxDays) : stayDays;
      additionalBenefits.push({ key: 'hospital_daily_cash_amount', label: 'Hospital daily cash', amountMinor: dailyCash * days, certain: dailyCashCovered === true, note: `${formatRupees(dailyCash)} a day for ${days} days${textOf(parameters, use('hospital_daily_cash_conditions')) ? `; ${textOf(parameters, 'hospital_daily_cash_conditions')}` : ''}.` });
    }
    const attendant = moneyOf(parameters, use('attendant_allowance_amount'));
    if (attendant != null) additionalBenefits.push({ key: 'attendant_allowance_amount', label: 'Attendant allowance', amountMinor: attendant * stayDays, certain: false, note: `${formatRupees(attendant)} a day if its conditions are met.` });
  }

  // Clauses that can change a settlement but are not a single number: shown for a person to read.
  const clausesToRead = ['reasonable_customary_clause', 'package_rate_rule', 'icu_scope_rule', 'proportionate_deduction_formula', 'claim_order_rule', 'contribution_clause']
    .map(key => ({ key, result: usable(parameters, use(key)) }))
    .filter(item => item.result && (item.result.value.kind !== 'boolean' || item.result.value.flag))
    .map(item => ({ key: item.key, label: item.result.label, text: item.result.value.kind === 'boolean' ? 'Yes' : item.result.value.text }));

  const eligibility = checkPlannedProcedure({ parameters, request, member, asOf });
  if (eligibility.verdict === 'blocker_found') {
    insurer.low = 0;
    assumptions.push('The record states at least one blocker for this treatment (see eligibility). The least the insurer may pay is shown as nothing until a person resolves it.');
  }
  if (unbounded) insurer.low = 0;
  // A top-up never pays what the base policy paid, whatever its threshold status.
  if (isTopUp) {
    const ceiling = Math.max(0, billTotal - (request.otherPolicyPaysMinor ?? 0));
    insurer = { low: Math.min(insurer.low, ceiling), high: Math.min(insurer.high, ceiling) };
  }

  // For a top-up the base policy's payout is not the household's cost.
  const otherPaid = isTopUp ? Math.min(request.otherPolicyPaysMinor ?? 0, billTotal) : 0;
  const usedParameters = [...used].filter(key => parameters[key]).map(key => ({ key, label: parameters[key].label, evidenceState: parameters[key].evidenceState, reviewState: parameters[key].review?.state ?? 'unreviewed', memberScope: parameters[key].memberScope ?? null }));
  return {
    status: unbounded ? 'insufficient_evidence' : blockingUnknowns.length ? 'conditional' : 'estimate',
    currency: 'INR',
    billTotalMinor: billTotal,
    insurerPaysMinor: insurer,
    otherPolicyPaysMinor: otherPaid || null,
    householdPaysMinor: { low: Math.max(0, billTotal - otherPaid - insurer.high), high: Math.max(0, billTotal - otherPaid - insurer.low) },
    display: {
      householdPays: `${formatRupees(Math.max(0, billTotal - otherPaid - insurer.high))} to ${formatRupees(Math.max(0, billTotal - otherPaid - insurer.low))}`,
      insurerPays: `${formatRupees(insurer.low)} to ${formatRupees(insurer.high)}`,
    },
    steps,
    assumptions,
    blockingUnknowns,
    additionalBenefits,
    clausesToRead,
    eligibility,
    usedParameters,
    boundaries: [
      'This is a planning range from the policy record, not a claim decision. The insurer decides the final settlement.',
      unbounded ? 'At least one deduction could not be bounded, so the lowest insurer payment shown is zero. Review the listed parameters to narrow the range.' : 'Each unknown widens the range toward the household paying more.',
      'Hospital tariffs, network status and pre-authorisation outcomes are Dynamic and must be confirmed with the hospital desk or TPA.',
    ],
  };
}

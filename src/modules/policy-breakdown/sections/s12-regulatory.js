// Section 12 — Regulatory floor: where regulation may override the wording.
// Deterministic comparison of extracted policy values (sections 3, 6, 7) against a dated, versioned
// floor table. It never declares a wording illegal or a product compliant; every difference is an item
// for a qualified reviewer to verify against the current official text.

import { defineSection } from '../contracts.js';

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

/**
 * Default floor table. Values are as understood from the IRDAI Master Circular on Health Insurance
 * Business (29 May 2024). They have not been verified against the current official text and must be
 * verified before any reliance. `references.regulatoryFloor` may replace this table in full.
 */
export const REGULATORY_FLOOR = deepFreeze({
  version: 'irdai-health-master-circular-2024-as-understood-2026-10-02',
  asOf: '2026-10-02',
  effectiveFrom: '2024-05-29',
  jurisdiction: 'India',
  source: 'IRDAI Master Circular on Health Insurance Business, 29 May 2024, as understood; not verified against current official text',
  verifyBeforeUse: true,
  items: {
    ped_waiting_max_months: { limit: 36, rule: 'Pre-existing disease waiting period of at most 36 months.' },
    specified_disease_waiting_max_months: { limit: 36, rule: 'Specified disease or procedure waiting period of at most 36 months.' },
    moratorium_max_months: { limit: 60, rule: 'After 60 continuous months of cover, a claim is not contestable for non-disclosure or misrepresentation except proven fraud and permanent exclusions in the contract.' },
    free_look_min_days: { limit: 30, rule: 'Free-look period of at least 30 days from receipt of the policy document.' },
    initial_waiting_max_days: { limit: 30, rule: 'Initial waiting period of at most 30 days (accidents not subject to it).' },
    cashless_decision_max_hours: { limit: 1, rule: 'Cashless authorisation request decided within 1 hour of receipt.' },
    discharge_authorisation_max_hours: { limit: 3, rule: 'Final discharge authorisation within 3 hours of the hospital request.' },
    proportionate_deduction_exempt_heads: {
      rule: 'Proportionate deduction is not applied to ICU charges, pharmacy and consumables, implants and medical devices, or diagnostics.',
      heads: [
        { id: 'icu', label: 'ICU charges', patterns: ['\\bicu\\b', '\\biccu\\b', 'intensive care', 'critical care'] },
        { id: 'pharmacy', label: 'pharmacy', patterns: ['pharmacy', 'medicine', '\\bdrugs?\\b'] },
        { id: 'consumables', label: 'consumables', patterns: ['consumable'] },
        { id: 'implants_devices', label: 'implants and medical devices', patterns: ['implant', 'medical device', 'prosthe', 'stent'] },
        { id: 'diagnostics', label: 'diagnostics', patterns: ['diagnostic', 'investigation', 'laborator', 'pathology', 'radiology', 'imaging'] },
      ],
    },
  },
});

const PARAM_STATES_THAT_PROPAGATE = new Set(['NotPermitted', 'Conflicting']);

const LIMIT_ITEMS = [
  'ped_waiting_max_months', 'specified_disease_waiting_max_months', 'moratorium_max_months', 'free_look_min_days',
  'initial_waiting_max_days', 'cashless_decision_max_hours', 'discharge_authorisation_max_hours',
];

/** Returns an error string for an unusable floor table, or null. */
export function validateFloorTable(table) {
  if (!table || typeof table !== 'object') return 'floor_table_not_an_object';
  for (const field of ['version', 'asOf', 'source']) {
    if (typeof table[field] !== 'string' || !table[field].trim()) return `floor_table_missing_${field}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(table.asOf)) return 'floor_table_asOf_not_iso_date';
  const items = table.items;
  if (!items || typeof items !== 'object') return 'floor_table_missing_items';
  for (const name of LIMIT_ITEMS) {
    const item = items[name];
    if (!item || typeof item.limit !== 'number' || !Number.isFinite(item.limit) || item.limit < 0) return `floor_table_item_invalid_${name}`;
  }
  const heads = items.proportionate_deduction_exempt_heads?.heads;
  if (!Array.isArray(heads) || heads.length === 0) return 'floor_table_item_invalid_proportionate_deduction_exempt_heads';
  for (const head of heads) {
    if (!head || typeof head.label !== 'string' || !Array.isArray(head.patterns) || head.patterns.length === 0) {
      return 'floor_table_item_invalid_proportionate_deduction_exempt_heads';
    }
    for (const pattern of head.patterns) {
      try { new RegExp(pattern, 'i'); } catch { return 'floor_table_head_pattern_invalid'; }
    }
  }
  return null;
}

const getParam = (parameters, key) => {
  if (!parameters) return null;
  if (typeof parameters.get === 'function') return parameters.get(key) ?? null;
  return Object.prototype.hasOwnProperty.call(parameters, key) ? parameters[key] : null;
};

const COUNT_KINDS = new Set(['days', 'months', 'years', 'count']);

/**
 * Classifies one stored input. Returns { status: 'ok', value, result } or
 * { status: 'NotPermitted'|'Conflicting'|'Unknown', reason }.
 */
function readInput(parameters, key, expectedKind) {
  const result = getParam(parameters, key);
  if (!result) return { status: 'Unknown', reason: `${key}_missing` };
  const state = result.evidenceState;
  if (PARAM_STATES_THAT_PROPAGATE.has(state)) return { status: state, reason: `${key}_${state}` };
  if (state !== 'Proven') return { status: 'Unknown', reason: `${key}_not_proven_${state ?? 'no_state'}` };
  const value = result.value;
  if (!value || typeof value !== 'object') return { status: 'Unknown', reason: `${key}_proven_without_value` };
  if (expectedKind === 'count' ? !(COUNT_KINDS.has(value.kind) && Number.isInteger(value.count)) : value.kind !== expectedKind) {
    return { status: 'Unknown', reason: `${key}_value_shape_unusable` };
  }
  return { status: 'ok', value, result };
}

const bool = flag => ({ kind: 'boolean', flag });
const hours = n => `${n} ${n === 1 ? 'hour' : 'hours'}`;

export function analyzeRegulatoryFloor(context = {}) {
  const { parameters = null, references = {}, asOf = null } = context ?? {};
  const override = references?.regulatoryFloor ?? null;
  const overrideProblem = override ? validateFloorTable(override) : null;
  const floor = override && !overrideProblem ? override : REGULATORY_FLOOR;
  const floorSource = override ? (overrideProblem ? 'default_table_override_rejected' : 'override_table') : 'default_table';
  const floorUnusable = Boolean(overrideProblem);
  const floorTag = `floor ${floor.version} dated ${floor.asOf}`;
  const dynamicReason = `compared_against_${floor.version}_as_of_${floor.asOf}${asOf ? `_analysis_${asOf}` : ''}_verify_before_use`;
  const items = floor.items;

  const outputs = [];
  const deviations = [];
  const comparisonStates = [];
  const pendingChecks = [];

  const push = (key, value, evidenceState, stateReason, derivedFrom, notes) => {
    outputs.push({ key, value, evidenceState, stateReason, derivedFrom, notes });
  };

  const unusableFloor = (key, derivedFrom) => {
    comparisonStates.push('Unknown');
    pendingChecks.push(key);
    push(key, null, 'Unknown', `regulatory_floor_override_invalid_${overrideProblem}`, derivedFrom,
      'The supplied regulatory floor override could not be used, so no comparison was made.');
  };

  const propagated = (key, input, derivedFrom) => {
    comparisonStates.push(input.status);
    pendingChecks.push(key);
    push(key, null, input.status, input.reason, derivedFrom,
      input.status === 'NotPermitted' ? 'An input is withheld by permission; the comparison is not shown.'
        : input.status === 'Conflicting' ? 'The input value is conflicting; resolve it before comparing with the floor.'
          : 'The input is not proven from the policy documents; no comparison was made and no value was assumed.');
  };

  // Single-value limit comparisons.
  const limitChecks = [
    { key: 'ped_wait_within_floor', input: 'ped_waiting_period_months', item: 'ped_waiting_max_months', direction: 'max', unit: 'months', phrase: 'PED wait' },
    { key: 'specified_wait_within_floor', input: 'specified_disease_waiting_months', item: 'specified_disease_waiting_max_months', direction: 'max', unit: 'months', phrase: 'specified-disease wait' },
    { key: 'moratorium_within_floor', input: 'moratorium_period_months', item: 'moratorium_max_months', direction: 'max', unit: 'continuous months', phrase: 'moratorium period' },
    { key: 'free_look_within_floor', input: 'free_look_period_days', item: 'free_look_min_days', direction: 'min', unit: 'days', phrase: 'free-look period' },
    { key: 'initial_wait_within_floor', input: 'initial_waiting_period_days', item: 'initial_waiting_max_days', direction: 'max', unit: 'days', phrase: 'initial waiting period' },
  ];

  const describeLimit = (direction, limit, unit) => `${direction === 'max' ? 'at most' : 'at least'} ${limit} ${unit}`;
  const passes = (direction, actual, limit) => (direction === 'max' ? actual <= limit : actual >= limit);

  for (const check of limitChecks) {
    const derivedFrom = [check.input];
    if (floorUnusable) { unusableFloor(check.key, derivedFrom); continue; }
    const input = readInput(parameters, check.input, 'count');
    if (input.status !== 'ok') { propagated(check.key, input, derivedFrom); continue; }
    const actual = input.value.count;
    const limit = items[check.item].limit;
    const within = passes(check.direction, actual, limit);
    comparisonStates.push('Dynamic');
    let notes = `Wording value ${actual} ${check.unit}; ${floorTag} understood as ${describeLimit(check.direction, limit, check.unit)}.`;
    if (input.result.memberScope) notes += ` Input applies to ${input.result.memberScope} only.`;
    if (!within) {
      deviations.push(`Wording states ${actual} ${check.unit} ${check.phrase}; current floor understood as ${describeLimit(check.direction, limit, check.unit)} — verify`);
      notes += ' Worse for the insured than the floor as understood; route to a qualified reviewer. Product filing date matters.';
    }
    push(check.key, bool(within), 'Dynamic', dynamicReason, derivedFrom, notes);
  }

  // Cashless timelines: both the decision and the discharge authorisation timelines.
  {
    const key = 'cashless_timeline_within_floor';
    const derivedFrom = ['cashless_decision_hours', 'discharge_authorisation_hours'];
    if (floorUnusable) unusableFloor(key, derivedFrom);
    else {
      const parts = [
        { input: readInput(parameters, 'cashless_decision_hours', 'count'), item: 'cashless_decision_max_hours', phrase: 'cashless authorisation decision time' },
        { input: readInput(parameters, 'discharge_authorisation_hours', 'count'), item: 'discharge_authorisation_max_hours', phrase: 'final discharge authorisation time' },
      ];
      const notPermitted = parts.find(part => part.input.status === 'NotPermitted');
      const failing = parts.filter(part => part.input.status === 'ok' && part.input.value.count > items[part.item].limit);
      if (notPermitted) propagated(key, notPermitted.input, derivedFrom);
      else if (failing.length > 0) {
        comparisonStates.push('Dynamic');
        for (const part of failing) {
          deviations.push(`Wording states ${hours(part.input.value.count)} ${part.phrase}; current floor understood as at most ${hours(items[part.item].limit)} — verify`);
        }
        const unchecked = parts.filter(part => part.input.status !== 'ok').map(part => part.input.reason);
        push(key, bool(false), 'Dynamic', dynamicReason, derivedFrom,
          `At least one stated timeline is longer than the ${floorTag} as understood.${unchecked.length ? ` Not compared: ${unchecked.join(', ')}.` : ''}`);
      } else if (parts.every(part => part.input.status === 'ok')) {
        comparisonStates.push('Dynamic');
        push(key, bool(true), 'Dynamic', dynamicReason, derivedFrom,
          `Decision ${parts[0].input.value.count} h and discharge ${parts[1].input.value.count} h are within the ${floorTag} as understood.`);
      } else {
        const blocking = parts.find(part => part.input.status === 'Conflicting') ?? parts.find(part => part.input.status !== 'ok');
        propagated(key, blocking.input, derivedFrom);
      }
    }
  }

  // Proportionate deduction exemptions.
  {
    const key = 'proportionate_deduction_exemptions_within_floor';
    const derivedFrom = ['proportionate_deduction_exempt_heads', 'proportionate_deduction_applies'];
    if (floorUnusable) unusableFloor(key, derivedFrom);
    else {
      const applies = readInput(parameters, 'proportionate_deduction_applies', 'boolean');
      const heads = readInput(parameters, 'proportionate_deduction_exempt_heads', 'text_list');
      if (applies.status === 'NotPermitted') propagated(key, applies, derivedFrom);
      else if (heads.status === 'NotPermitted') propagated(key, heads, derivedFrom);
      else if (applies.status === 'ok' && applies.value.flag === false) {
        comparisonStates.push('Dynamic');
        push(key, bool(true), 'Dynamic', dynamicReason, derivedFrom,
          'The wording states no proportionate deduction applies, so no head is deducted proportionately.');
      } else if (heads.status === 'ok') {
        const stated = heads.value.items.map(entry => String(entry));
        const missing = items.proportionate_deduction_exempt_heads.heads.filter(head => {
          const patterns = head.patterns.map(pattern => new RegExp(pattern, 'i'));
          return !stated.some(entry => patterns.some(pattern => pattern.test(entry)));
        });
        const within = missing.length === 0;
        comparisonStates.push('Dynamic');
        if (!within) {
          deviations.push(`Wording lists proportionate-deduction exemptions as ${stated.join(', ')}; current floor understood to also exempt ${missing.map(head => head.label).join(', ')} — verify`);
        }
        push(key, bool(within), 'Dynamic', dynamicReason, derivedFrom,
          within ? `Stated exempt heads cover every head in the ${floorTag}.`
            : `Not found among stated exempt heads: ${missing.map(head => head.label).join(', ')}. An exemption may be stated elsewhere (for example ICU at actuals); a reviewer should check.`);
      } else {
        propagated(key, heads.status === 'Conflicting' ? heads : (applies.status === 'Conflicting' ? applies : heads), derivedFrom);
      }
    }
  }

  // Floor version record.
  push('regulatory_floor_version', { kind: 'text', text: floor.version }, 'Dynamic',
    `floor_table_dated_${floor.asOf}_${floorSource}`, [],
    `${floor.source}. Floor source: ${floorSource}${overrideProblem ? ` (${overrideProblem})` : ''}. Verify before use.`);

  // Deviation list.
  {
    const derivedFrom = outputs.filter(output => output.key.endsWith('_within_floor')).map(output => output.key);
    if (deviations.length > 0) {
      push('regulatory_deviations', { kind: 'text_list', items: deviations }, 'Dynamic', dynamicReason, derivedFrom,
        `Items to verify with a qualified reviewer against the current official text; not a finding that the wording is unlawful.${pendingChecks.length ? ` Not compared: ${pendingChecks.join(', ')}.` : ''}`);
    } else if (comparisonStates.every(state => state === 'Dynamic')) {
      push('regulatory_deviations', { kind: 'text_list', items: [] }, 'Dynamic', dynamicReason, derivedFrom,
        `No stated value is worse than the ${floorTag} as understood. This is not a compliance finding.`);
    } else {
      const state = comparisonStates.includes('NotPermitted') ? 'NotPermitted'
        : comparisonStates.includes('Conflicting') ? 'Conflicting' : 'Unknown';
      push('regulatory_deviations', null, state, `comparisons_incomplete_${pendingChecks.join('_and_')}`.slice(0, 300), derivedFrom,
        `No deviation found among compared items, but these were not compared: ${pendingChecks.join(', ')}.`);
    }
  }

  return outputs;
}

const analysisParameter = (key, label, description, valueType, derivedFrom, extra = {}) => ({
  key, label, description, valueType, derivedFrom,
  effects: ['inform'], bases: ['per_policy'], critical: false, visibility: 'cover',
  memberScoped: false, emergencyCard: false, estimateInput: false, ...extra,
});

const EXPERTISE = `Section 12 is a deterministic comparison, not an extraction. No model reads the policy for this section; code compares values already extracted and proven in sections 3, 6 and 7 with a dated, versioned regulatory floor table. Any model that summarises this section must quote only the extracted wording and the floor table, never infer a value from general knowledge or regulation, never fill a value from another policy, report each distinct deviation once, keep memberScope when an input applies to a named member only, and never give advice or declare a wording illegal, void or compliant. Every difference is an item for a qualified reviewer to verify.

The floor table (default version ${REGULATORY_FLOOR.version}) records rules as understood from the IRDAI Master Circular on Health Insurance Business dated 29 May 2024. It has not been verified against the current official text; verifyBeforeUse is true. The table can be replaced in full by a supplied override, and the version used is recorded in regulatory_floor_version.

Floor items, as understood:
1. Pre-existing disease (PED) waiting period: at most 36 months of continuous cover. Older products often stated 48 months; a stated 48 months is a deviation to verify, not proof the insured is covered earlier.
2. Specified disease or procedure waiting period (cataract, hernia, joint replacement, kidney stones and similar named lists): at most 36 months.
3. Moratorium: after 60 continuous months of cover (previously 8 years), a claim cannot be contested for non-disclosure or misrepresentation except established fraud and permanent exclusions in the contract. Continuity includes ported or migrated cover; a sum-insured increase may restart the count for the increased portion only.
4. Free-look period: at least 30 days from receipt of the policy document (previously 15 days), for new policies, not renewals.
5. Initial waiting period: at most 30 days from first inception, with accidents not subject to it.
6. Cashless: an authorisation request is decided within 1 hour of receipt, and the final discharge authorisation within 3 hours of the hospital's request. Policy wordings often stay silent on these timelines; silence is Unknown, not a deviation.
7. Proportionate deduction (when a room above the eligible category is chosen) is not applied to ICU charges, pharmacy and consumables, implants and medical devices, or diagnostics. Wordings that exempt only some heads are flagged; an ICU limit at actuals stated elsewhere does not by itself list ICU as an exempt head, so a reviewer should check.

Dates matter. A product's filing and approval date (visible in the UIN version and the wording's issue date), the policy start date and the date of the event all affect which rule applied. Products filed before 29 May 2024 may legitimately carry older terms until refiled or until a transition deadline set by the regulator; the floor may also change after the table's date. A comparison is therefore Dynamic: valid only for the dated table. Inputs that are not Proven give Unknown; Conflicting inputs stay Conflicting; inputs withheld by permission give NotPermitted.`;

export default defineSection({
  number: 12,
  id: 'section-12-regulatory',
  title: 'Regulatory floor — where regulation may override the wording',
  question: 'Which proven policy terms appear less favourable to the insured than the dated regulatory floor as understood, and so need a qualified reviewer to verify?',
  kind: 'analysis',
  expertise: EXPERTISE,
  parameters: [
    analysisParameter('regulatory_floor_version', 'Regulatory floor version used',
      'Version label of the floor table used for every comparison in this section (default or supplied override), with its date in stateReason.', 'text', []),
    analysisParameter('ped_wait_within_floor', 'PED wait within floor',
      'True when the proven PED waiting period in months is at most the floor maximum (36 months as understood).', 'boolean', ['ped_waiting_period_months']),
    analysisParameter('specified_wait_within_floor', 'Specified-disease wait within floor',
      'True when the proven specified-disease waiting period in months is at most the floor maximum (36 months as understood).', 'boolean', ['specified_disease_waiting_months']),
    analysisParameter('moratorium_within_floor', 'Moratorium within floor',
      'True when the proven moratorium period in continuous months is at most the floor (60 months as understood).', 'boolean', ['moratorium_period_months']),
    analysisParameter('free_look_within_floor', 'Free-look within floor',
      'True when the proven free-look period in days is at least the floor minimum (30 days as understood).', 'boolean', ['free_look_period_days']),
    analysisParameter('initial_wait_within_floor', 'Initial wait within floor',
      'True when the proven initial waiting period in days is at most the floor maximum (30 days as understood).', 'boolean', ['initial_waiting_period_days']),
    analysisParameter('cashless_timeline_within_floor', 'Cashless timelines within floor',
      'True when both proven cashless decision hours (floor 1 h) and final discharge authorisation hours (floor 3 h) are within the floor; false when either proven value exceeds it.', 'boolean', ['cashless_decision_hours', 'discharge_authorisation_hours']),
    analysisParameter('proportionate_deduction_exemptions_within_floor', 'Proportionate-deduction exemptions within floor',
      'True when the proven exempt heads include ICU, pharmacy, consumables, implants and medical devices, and diagnostics, or when the wording proves no proportionate deduction applies.', 'boolean', ['proportionate_deduction_exempt_heads', 'proportionate_deduction_applies']),
    analysisParameter('regulatory_deviations', 'Items to verify against the regulatory floor',
      'Human-readable list of proven wording values that look worse for the insured than the dated floor as understood, each phrased as an item to verify. Empty list only when every comparison was made.', 'text_list',
      ['ped_wait_within_floor', 'specified_wait_within_floor', 'moratorium_within_floor', 'free_look_within_floor', 'initial_wait_within_floor', 'cashless_timeline_within_floor', 'proportionate_deduction_exemptions_within_floor']),
  ],
  analyze: analyzeRegulatoryFloor,
  reviewGuidance: 'Treat every deviation as a question, not a finding. Check the floor version and date against the current official IRDAI text before relying on it, and note the product filing date (UIN version, wording issue date) and the policy start date: older products may legitimately differ. Confirm the input value and its citation in sections 3, 6 and 7 before escalating. For proportionate deduction, check whether an exemption is stated in another clause (for example ICU at actuals). Never tell the household a clause is unenforceable; route to a qualified reviewer.',
});

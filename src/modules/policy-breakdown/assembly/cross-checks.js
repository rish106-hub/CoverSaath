// Cross-section consistency rules. Each rule reads assembled parameters and returns issues. An issue that
// touches a critical parameter blocks readiness until a human resolves it.

const usable = result => result && ['Proven', 'Calculated'].includes(result.evidenceState) && result.value;

const RULES = Object.freeze([
  {
    id: 'policy_period_order',
    keys: ['policy_start_date', 'policy_end_date'],
    check: ({ policy_start_date: start, policy_end_date: end }) =>
      usable(start) && usable(end) && start.value.date >= end.value.date ? 'Policy end date is not after the start date.' : null,
  },
  {
    id: 'inception_before_period',
    keys: ['first_inception_date', 'policy_start_date'],
    check: ({ first_inception_date: inception, policy_start_date: start }) =>
      usable(inception) && usable(start) && inception.value.date > start.value.date ? 'First inception date is after the current period start.' : null,
  },
  {
    id: 'room_rent_kind_needs_value',
    keys: ['room_rent_limit_kind', 'room_rent_limit_percent', 'room_rent_limit_amount', 'room_rent_eligible_category'],
    check: ({ room_rent_limit_kind: kind, room_rent_limit_percent: percent, room_rent_limit_amount: amount, room_rent_eligible_category: category }) => {
      if (!usable(kind)) return null;
      const value = kind.value.enumValue;
      if (value === 'percent_of_si_per_day' && !usable(percent)) return 'Room rent is a percentage of sum insured but the percentage is not established.';
      if (value === 'fixed_amount_per_day' && !usable(amount)) return 'Room rent is a fixed daily amount but the amount is not established.';
      if (value === 'room_category' && !usable(category)) return 'Room rent is a room category but the category is not established.';
      if (value === 'category_or_percent' && (!usable(category) || !usable(percent))) return 'Room rent combines a category and a percentage but one of them is not established.';
      return null;
    },
  },
  {
    id: 'icu_kind_needs_value',
    keys: ['icu_limit_kind', 'icu_limit_amount', 'icu_limit_percent'],
    check: ({ icu_limit_kind: kind, icu_limit_amount: amount, icu_limit_percent: percent }) => {
      if (!usable(kind)) return null;
      if (kind.value.enumValue === 'fixed_amount_per_day' && !usable(amount)) return 'ICU is a fixed daily amount but the amount is not established.';
      if (kind.value.enumValue === 'percent_of_si_per_day' && !usable(percent)) return 'ICU is a percentage of sum insured but the percentage is not established.';
      return null;
    },
  },
  {
    id: 'age_copay_needs_threshold',
    keys: ['copay_age_percent', 'copay_age_threshold_years'],
    check: ({ copay_age_percent: percent, copay_age_threshold_years: threshold }) =>
      usable(percent) && percent.value.percent > 0 && !usable(threshold) ? 'An age co-pay is stated but the age at which it starts is not established.' : null,
  },
  {
    id: 'floater_type_matches_structure',
    keys: ['policy_type', 'sum_insured_structure'],
    check: ({ policy_type: type, sum_insured_structure: structure }) => {
      if (!usable(type) || !usable(structure)) return null;
      const t = type.value.enumValue;
      const s = structure.value.enumValue;
      if (t === 'family_floater' && s !== 'family_floater') return 'Policy type is family floater but the sum-insured structure is not floater.';
      if (t === 'individual' && s === 'family_floater') return 'Policy type is individual but the sum-insured structure is floater.';
      return null;
    },
  },
  {
    id: 'sum_insured_positive',
    keys: ['sum_insured_amount'],
    check: ({ sum_insured_amount: amount }) => usable(amount) && amount.value.amountMinor <= 0 ? 'Sum insured is zero.' : null,
  },
]);

export function runCrossChecks(parameters) {
  const issues = [];
  for (const rule of RULES) {
    const subset = Object.fromEntries(rule.keys.map(key => [key, parameters[key] ?? null]));
    const message = rule.check(subset);
    if (message) {
      issues.push({
        rule: rule.id,
        keys: rule.keys.filter(key => parameters[key]),
        critical: rule.keys.some(key => parameters[key]?.critical),
        message,
      });
    }
  }
  return issues;
}

export const CROSS_CHECK_RULES = RULES.map(rule => rule.id);

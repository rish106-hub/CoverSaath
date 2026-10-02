// Section 9 — Keeping it: what does continuing cost and what can change?
// Renewal, premium, portability, migration, withdrawal, cancellation, payment mode and tax statements.
// Scope boundary: grace-period length (days) is Section 3; money limits are Section 6; free-look is Section 3.

import { defineSection } from '../contracts.js';

const maxDays = limit => value => (value.count > limit ? `more than ${limit} days is implausible for this clause` : null);
const positiveMoneyUpTo = rupees => value => {
  if (value.amountMinor <= 0) return 'premium must be greater than zero';
  if (value.amountMinor > rupees * 100) return `premium above ₹${rupees} is implausible for one retail health policy`;
  return null;
};

const expertise = `
SECTION 9 — KEEPING IT: RENEWAL, PREMIUM, PORTABILITY, MIGRATION, WITHDRAWAL, CANCELLATION, PAYMENT MODE

What this section captures
You record, from this policy's own documents only, what it costs to continue the cover and what can change at or
between renewals: the stated renewability promise and its refusal grounds, premium amounts and revision rules,
age-band wording, sum-insured enhancement at renewal, portability and migration windows, group-to-individual
conversion, product withdrawal, cancellation by either side, payment modes and instalment lapse, cover during the
grace period, and any tax statement. You never give advice, never say whether to renew or port, and never compute
a future premium.

Where it appears in Indian health documents
- Policy schedule / premium certificate: base premium, GST, total premium, loadings, discounts, payment frequency,
  sometimes an age-band note. Loadings tied to a named member are medical underwriting outcomes: report them under
  premium_loading_rule with memberScope set to that member's name.
- Policy wording, "General Terms and Clauses" (IRDAI standard wording since 2020, carried into the 2024 master
  circular products): clauses titled "Renewal of Policy", "Possibility of Revision of Terms of the Policy including
  the Premium Rates", "Migration", "Portability", "Withdrawal of Policy", "Cancellation", "Premium Payment in
  Instalments", "Enhancement of Sum Insured", "Free Look Period" (free look belongs to Section 3 — do not record it).
- Customer Information Sheet (CIS): short restatements of renewal, cancellation, portability and tax benefits.
- Group policies (employer master policies) may contain "Conversion to individual policy", "Exit of member",
  "Continuity on leaving the group". Retail policies usually say nothing about group conversion: then found=false.

How to read each clause
- Lifelong renewal: phrases such as "renewable for life", "lifelong renewal", "shall ordinarily be renewable
  except on grounds of fraud, misrepresentation". Record lifelong_renewal=true only when the document states
  renewability without an age or term cut-off. If it states a maximum renewal age or "renewable up to age N",
  record false and put the cut-off in conditions. Record the refusal grounds separately in
  renewal_refusal_grounds, verbatim in substance (fraud, misrepresentation, non-disclosure, non-cooperation,
  moral hazard). Do not add grounds the document does not list, even though regulation permits them.
- "Renewal shall not be denied on the ground that the insured had made a claim" belongs in
  renewal_refusal_grounds as an exception. "No loading on renewal based on individual claims experience"
  belongs in premium_revision_rule.
- Premium revision: record exactly what is stated: product-wide revision with Authority (IRDAI) approval, notice
  period, application from next renewal, prohibition on individual claim-based loading. Never assume IRDAI approval
  is required if the text does not say so. Separate "revision of terms of the policy" (wording changes) into
  policy_terms_revision_rule.
- Age bands: premium tables or notes saying premium depends on the age of the eldest member or each member, and
  changes when a member enters a higher band. Record the stated basis (eldest member vs each member) and the band
  edges if listed. Do not compute which member crosses which band; that is a later deterministic step.
- Sum insured enhancement at renewal: record whether enhancement is allowed, whether underwriting applies, and
  whether waiting periods start afresh on the increased portion only. "Waiting periods apply afresh to the
  enhanced portion" is not the same as "all waiting periods restart" — quote the exact words.
- Portability window: record the number of days before renewal stated in the wording (for example "at least 45
  days before, but not earlier than 60 days"). Store the minimum lead time (45) in portability_window_days and put
  the outer limit (60) in conditions. If only "as per IRDAI guidelines" is written with no number, found=false for
  the number — never fill it from regulation you know. What carries over (waiting-period credit up to the previous
  sum insured, bonus) goes in portability_carryover_rule.
- Migration (to another product of the same insurer) has its own window, often "at least 30 days before renewal".
  Do not confuse it with portability (to another insurer).
- Product withdrawal: notice period (e.g. 90 days before expiry) in product_withdrawal_notice_days and the migration
  offer with continuity benefits in product_withdrawal_rule.
- Cancellation by the insured: enum pro_rata when the refund is proportional to the unexpired period;
  short_period_scale when a table of retention by months elapsed is given (record the table in
  cancellation_short_period_scale); no_refund when no refund is stated; not_stated otherwise. Conditions such as
  "provided no claim has been made" and the notice period go in conditions. Cancellation by the insurer: grounds,
  notice and refund effect in insurer_cancellation_grounds.
- Grace period: Section 3 owns its length in days. You own only grace_period_cover: covered when the text says
  claims during grace are payable; not_covered when it says "coverage is not available during the grace period"
  or similar; not_stated when the grace period exists but cover during it is not addressed. Do not output the day
  count as your value. Instalment-specific grace periods (e.g. 15 days per instalment) are also Section 3 numbers;
  mention them only in conditions or notes of instalment_lapse_consequence.
- Payment modes: list the frequencies the document offers (annual, half-yearly, quarterly, monthly, single premium
  multi-year). Record the frequency chosen on this schedule in premium_payment_frequency. Multi-year discounts go in
  multi_year_discount_percent only when a percentage is printed.
- Instalment lapse: what happens if an instalment is missed (cancellation, lapse, no cover until paid, all
  instalments due on a claim).
- Tax: record Section 80D or GST wording only if the document itself mentions it; otherwise found=false. Never
  state tax limits from general knowledge.

Traps
- Two grace periods may appear (renewal grace and instalment grace). Neither day count is your value.
- "Renewable" without "for life" does not make lifelong_renewal true if a maximum age is printed elsewhere.
- Premium amounts: record the rupee amount exactly as printed (valueNumber in rupees). Total premium usually
  includes GST; base premium excludes it. Do not add or subtract figures yourself.
- A loading for a named member is protected medical information: set memberScope to the member's name and keep the
  reason as written; do not generalise it to the household.
- The schedule's frequency ("Annual") differs from the list of modes the product offers.
- Group-to-individual conversion is usually absent from retail policies: answer found=false, do not import it.

Output discipline
- Quote verbatim from the page text; the quote must be an exact substring. Never infer from general knowledge or
  from IRDAI regulation, and never fill a value from another policy or insurer.
- Report each distinct value once. Use memberScope when a value applies to a named member only.
- When the document is silent, return found=false with all values null and empty lists; do not guess.
- Enum answers go in valueText as the exact enum token.
`.trim();

export default defineSection({
  number: 9,
  id: 'section-09-renewal',
  title: 'Keeping it',
  question: 'What does continuing this cover cost, and what can change at or between renewals?',
  kind: 'extraction',
  expertise,
  reviewGuidance: [
    'lifelong_renewal: confirm the wording states renewability without an age or term cut-off; check the schedule',
    'and CIS for any maximum renewal age that contradicts it.',
    'grace_period_cover: confirm the quoted sentence speaks about cover during the renewal grace period, not the',
    'free-look period or instalment grace, and that covered/not_covered matches the wording exactly.',
    'Check the portability and migration windows were not swapped and that the number is from the document, not',
    'from regulation. Check premium_loading_rule carries the right memberScope and stays protected. Check the',
    'cancellation refund basis against any short-period scale table and its no-claim condition.',
  ].join(' '),
  parameters: [
    {
      key: 'lifelong_renewal',
      label: 'Lifelong renewability',
      description: 'True when the document states the policy is renewable for life (no maximum renewal age or term). False when a maximum renewal age or fixed term is stated. Record the refusal grounds separately.',
      valueType: 'boolean',
      effects: ['inform', 'void'],
      bases: ['per_policy'],
      critical: true,
      visibility: 'cover',
      extractionHints: ['Renewal of Policy', 'renewable for life', 'lifelong renewal', 'shall ordinarily be renewable', 'maximum renewal age'],
    },
    {
      key: 'renewal_refusal_grounds',
      label: 'Grounds for refusing renewal',
      description: 'Grounds the document states for which the insurer may refuse renewal (e.g. fraud, misrepresentation), and any stated protection such as renewal not being denied because claims were made.',
      valueType: 'rule',
      effects: ['void', 'inform'],
      bases: ['per_policy'],
      visibility: 'cover',
      extractionHints: ['except on grounds of fraud', 'misrepresentation', 'Renewal shall not be denied', 'non-cooperation', 'moral hazard'],
    },
    {
      key: 'renewal_notice_rule',
      label: 'Renewal notice and request',
      description: 'What the document says about renewal notices from the insurer and the deadline by which the renewal request and premium must reach the insurer.',
      valueType: 'rule',
      effects: ['require', 'inform'],
      bases: ['per_policy'],
      visibility: 'operational',
      extractionHints: ['notice for renewal', 'not under obligation to give any notice', 'Request for renewal along with requisite premium'],
    },
    {
      key: 'grace_period_cover',
      label: 'Cover during renewal grace period',
      description: 'Whether claims arising during the renewal grace period are covered. Only the cover status; the grace-period length in days is Section 3 (grace_period_days).',
      valueType: 'enum',
      enumValues: ['covered', 'not_covered', 'not_stated'],
      effects: ['exclude', 'pay', 'inform'],
      bases: ['per_policy'],
      critical: true,
      visibility: 'cover',
      extractionHints: ['Coverage is not available during the grace period', 'Grace Period', 'continuity of benefits without break', 'no cover for the period for which no premium is received'],
    },
    {
      key: 'premium_total_amount',
      label: 'Total premium',
      description: 'Total premium for the current policy period as printed on the schedule, in rupees, including taxes if the document says so. State in conditions whether GST is included.',
      valueType: 'money',
      effects: ['inform'],
      bases: ['per_policy_year', 'per_policy'],
      visibility: 'operational',
      extractionHints: ['Total Premium', 'Premium (inclusive of GST)', 'Premium Details', 'Premium paid'],
      validate: positiveMoneyUpTo(5_000_000),
    },
    {
      key: 'premium_base_amount',
      label: 'Base premium before tax',
      description: 'Premium before GST/taxes as printed on the schedule, in rupees. Do not compute it from the total.',
      valueType: 'money',
      effects: ['inform'],
      bases: ['per_policy_year', 'per_policy'],
      visibility: 'operational',
      extractionHints: ['Base Premium', 'Net Premium', 'Premium excluding GST'],
      validate: positiveMoneyUpTo(5_000_000),
    },
    {
      key: 'premium_tax_amount',
      label: 'Tax on premium',
      description: 'GST or other tax amount printed on the schedule, in rupees, with the rate in conditions if printed.',
      valueType: 'money',
      effects: ['inform'],
      bases: ['per_policy_year', 'per_policy'],
      visibility: 'operational',
      extractionHints: ['Goods and Services Tax', 'GST @', 'IGST', 'CGST', 'SGST'],
    },
    {
      key: 'premium_loading_rule',
      label: 'Premium loading applied',
      description: 'Any loading on premium printed for this policy (percentage and reason), usually from medical underwriting. Member-specific: set memberScope to the named member. Protected.',
      valueType: 'rule',
      effects: ['inform'],
      bases: ['per_person', 'per_policy'],
      visibility: 'protected',
      memberScoped: true,
      extractionHints: ['Loading Details', 'loading of', 'applied on account of', 'medical loading', 'underwriting loading'],
    },
    {
      key: 'premium_discounts',
      label: 'Premium discounts applied',
      description: 'Discounts printed on the schedule or wording (family, long-term, online, wellness), each as a short item with its percentage if stated.',
      valueType: 'text_list',
      effects: ['inform'],
      bases: ['per_policy'],
      visibility: 'operational',
      extractionHints: ['Discount', 'family discount', 'long term discount', 'online discount'],
    },
    {
      key: 'premium_age_band_rule',
      label: 'Age-band premium rule',
      description: 'How age drives the premium: whose age counts (eldest member or each member), the stated age bands, and that premium changes when a member enters a higher band.',
      valueType: 'rule',
      effects: ['inform'],
      bases: ['per_policy', 'per_person'],
      visibility: 'cover',
      extractionHints: ['age band', 'eldest Insured Person', 'higher age band', 'premium shall change at renewal'],
    },
    {
      key: 'premium_revision_rule',
      label: 'Premium revision rule',
      description: 'Stated rules on premium revision: product-wide revision subject to regulator approval, notice period, when it applies, and any prohibition on loading an individual for their own claims. Record only what is stated.',
      valueType: 'rule',
      effects: ['inform'],
      bases: ['per_policy'],
      visibility: 'cover',
      extractionHints: ['Premium Revision', 'subject to approval of the Authority', 'No loading shall apply on renewals', 'individual claims experience'],
    },
    {
      key: 'policy_terms_revision_rule',
      label: 'Revision of policy terms',
      description: 'Stated rules on changing the wording/terms of the policy (not the premium alone): approval needed and notice given before changes take effect.',
      valueType: 'rule',
      effects: ['inform'],
      bases: ['per_policy'],
      visibility: 'cover',
      extractionHints: ['Possibility of Revision of Terms', 'revise or modify the terms of the policy', 'notified three months before'],
    },
    {
      key: 'renewal_sum_insured_change_rule',
      label: 'Sum insured change at renewal',
      description: 'Whether and how sum insured may be enhanced or reduced at renewal, underwriting requirements, and whether waiting periods apply afresh to the increased portion.',
      valueType: 'rule',
      effects: ['wait_until', 'require', 'inform'],
      bases: ['per_policy'],
      visibility: 'cover',
      extractionHints: ['Enhancement of Sum Insured', 'enhanced only at the time of renewal', 'waiting periods shall apply afresh to the enhanced portion'],
    },
    {
      key: 'portability_window_days',
      label: 'Portability application lead time',
      description: 'Minimum number of days before the renewal date by which a portability application must be made, as stated in the document. Put any outer limit (e.g. not earlier than 60 days) in conditions.',
      valueType: 'days',
      effects: ['require'],
      bases: ['not_applicable'],
      visibility: 'cover',
      extractionHints: ['Portability', 'at least 45 days before', 'not earlier than 60 days', 'port the policy to other insurers'],
      validate: maxDays(365),
    },
    {
      key: 'portability_carryover_rule',
      label: 'What carries over on portability',
      description: 'Stated continuity benefits on porting: waiting-period credit, extent (e.g. up to previous sum insured), bonus treatment, re-underwriting and whole-family porting requirement.',
      valueType: 'rule',
      effects: ['inform', 'wait_until'],
      bases: ['per_policy'],
      visibility: 'cover',
      extractionHints: ['accrued continuity benefits in waiting periods', 'to the extent of the sum insured under the previous policy', 'port the entire policy along with all the members'],
    },
    {
      key: 'migration_option',
      label: 'Migration within the same insurer',
      description: 'Option to move to another product of the same insurer: application window before renewal and continuity benefits stated.',
      valueType: 'rule',
      effects: ['require', 'inform'],
      bases: ['per_policy'],
      visibility: 'cover',
      extractionHints: ['Migration', 'migrate the policy to other health insurance products', 'at least 30 days before the policy renewal date'],
    },
    {
      key: 'group_to_individual_conversion',
      label: 'Group-to-individual conversion',
      description: 'Option for a member leaving a group/employer policy to convert to an individual policy, with any credit for group years. Usually absent from retail policies.',
      valueType: 'rule',
      effects: ['require', 'inform'],
      bases: ['per_person', 'per_policy'],
      visibility: 'cover',
      extractionHints: ['conversion to individual', 'leaving the employer', 'exit from the group', 'continuity on separation'],
    },
    {
      key: 'group_conversion_window_days',
      label: 'Group conversion application window',
      description: 'Days within which a departing group member must apply for individual conversion, as stated.',
      valueType: 'days',
      effects: ['require'],
      bases: ['not_applicable'],
      visibility: 'cover',
      extractionHints: ['within days of leaving', 'conversion window', 'date of exit from the group'],
      validate: maxDays(365),
    },
    {
      key: 'product_withdrawal_rule',
      label: 'Product withdrawal and migration offer',
      description: 'What happens if the product is withdrawn: notice to the insured, migration offer and which continuity benefits are preserved.',
      valueType: 'rule',
      effects: ['inform'],
      bases: ['per_policy'],
      visibility: 'cover',
      extractionHints: ['Withdrawal of Policy', 'product being withdrawn', 'option to migrate to a similar health insurance product'],
    },
    {
      key: 'product_withdrawal_notice_days',
      label: 'Product withdrawal notice',
      description: 'Number of days of notice the insurer states it will give before withdrawing the product.',
      valueType: 'days',
      effects: ['inform'],
      bases: ['not_applicable'],
      visibility: 'cover',
      extractionHints: ['intimate the Insured Person', 'days prior to expiry of the policy', 'withdrawn'],
      validate: maxDays(365),
    },
    {
      key: 'cancellation_refund_basis',
      label: 'Refund basis when the insured cancels',
      description: 'pro_rata (proportional to unexpired period), short_period_scale (retention table by elapsed period), no_refund, or not_stated. Conditions such as "no claim made" and notice period go in conditions.',
      valueType: 'enum',
      enumValues: ['pro_rata', 'short_period_scale', 'no_refund', 'not_stated'],
      effects: ['inform'],
      bases: ['per_policy'],
      visibility: 'cover',
      extractionHints: ['Cancellation', 'refund premium on pro-rata basis', 'short period scale', 'unexpired policy period'],
    },
    {
      key: 'cancellation_short_period_scale',
      label: 'Short-period refund scale',
      description: 'The retention/refund table by period elapsed when the insured cancels, if the document prints one.',
      valueType: 'rule',
      effects: ['inform'],
      bases: ['per_policy'],
      visibility: 'cover',
      extractionHints: ['short period scale', 'Period on risk', 'Rate of premium refunded', 'up to 3 months'],
    },
    {
      key: 'insurer_cancellation_grounds',
      label: 'Grounds for cancellation by the insurer',
      description: 'Grounds on which the insurer may cancel during the policy period, notice given, and refund consequence.',
      valueType: 'rule',
      effects: ['void', 'inform'],
      bases: ['per_policy'],
      visibility: 'cover',
      extractionHints: ['The Company may cancel the policy', 'on grounds of misrepresentation', 'no refund of premium on cancellation'],
    },
    {
      key: 'premium_payment_frequency',
      label: 'Premium frequency on this schedule',
      description: 'The payment frequency chosen for this policy as printed on the schedule.',
      valueType: 'enum',
      enumValues: ['annual', 'half_yearly', 'quarterly', 'monthly', 'single_premium_multi_year', 'not_stated'],
      effects: ['inform'],
      bases: ['per_policy'],
      visibility: 'operational',
      extractionHints: ['Premium Payment Frequency', 'Payment Mode', 'Instalment frequency'],
    },
    {
      key: 'premium_payment_modes',
      label: 'Premium payment modes offered',
      description: 'Payment frequencies the document says the product offers (annual, half-yearly, quarterly, monthly, multi-year).',
      valueType: 'text_list',
      effects: ['inform'],
      bases: ['per_policy'],
      visibility: 'operational',
      extractionHints: ['instalment basis', 'half-yearly, quarterly or monthly', 'long term policy', 'multi-year'],
    },
    {
      key: 'multi_year_discount_percent',
      label: 'Multi-year premium discount',
      description: 'Discount percentage stated for paying a multi-year (long-term) premium upfront. Only when a figure is printed.',
      valueType: 'percent',
      effects: ['inform'],
      bases: ['per_policy'],
      visibility: 'operational',
      extractionHints: ['long term discount', '2 year policy', '3 year policy', 'multi-year discount'],
    },
    {
      key: 'instalment_lapse_consequence',
      label: 'Missed instalment consequence',
      description: 'What happens if an instalment premium is missed: lapse/cancellation, cover gap until receipt, continuity treatment, and any rule that remaining instalments fall due on a claim. Instalment grace length belongs to Section 3; mention it only in conditions.',
      valueType: 'rule',
      effects: ['void', 'exclude', 'require'],
      bases: ['per_policy'],
      critical: true,
      visibility: 'cover',
      extractionHints: ['Premium Payment in Instalments', 'instalment premium due not received', 'policy will get cancelled', 'subsequent premium instalments shall immediately become due'],
    },
    {
      key: 'tax_benefit_statement',
      label: 'Tax statement on premium',
      description: 'What the document itself says about tax deduction on premium (e.g. Section 80D, non-cash payment requirement). Only if mentioned in the document.',
      valueType: 'rule',
      effects: ['inform'],
      bases: ['per_policy_year'],
      visibility: 'cover',
      extractionHints: ['Section 80D', 'Income-tax Act', 'Tax Benefits', 'mode other than cash'],
    },
  ],
});

// Section 3 — Time: is the cover alive and has every clock run?
// Extraction section. Declares the policy period, waiting clocks, continuity and time windows.

import { defineSection } from '../contracts.js';

const MIN_YEAR = 1950;
const MAX_YEAR = 2100;

const validDate = value => {
  const year = Number(value.date.slice(0, 4));
  if (year < MIN_YEAR || year > MAX_YEAR) return `date year must be between ${MIN_YEAR} and ${MAX_YEAR}`;
  const [y, m, d] = value.date.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return 'date is not a real calendar date';
  return null;
};
const maxCount = (limit, unit) => value => (value.count > limit ? `${unit} value ${value.count} exceeds plausible maximum ${limit}` : null);

const DATE_EFFECTS = ['inform'];
const DATE_BASES = ['per_policy', 'not_applicable'];
const WAIT_EFFECTS = ['wait_until', 'exclude'];
const WAIT_BASES = ['per_person', 'per_illness', 'per_policy', 'not_applicable'];

const expertise = `
SECTION 3 — TIME. Your job is to find, in this policy's own documents, when cover starts and ends, and every
clock that must run before a benefit is payable. Gates answered here: "Is the policy alive on the event date?"
and "Has every waiting clock run for this member and this condition?"

WHERE IT APPEARS
- Policy Schedule / Certificate of Insurance: "Period of Insurance", "Policy Period", "From ... To ...",
  "Date of First Inception", "Policy inception date", "Member since", "Insured since", "Continuous coverage
  since", sometimes a summary table of waiting periods.
- Policy Wording: IRDAI-standardised exclusions "Code-Excl01" (pre-existing diseases), "Code-Excl02"
  (specified disease/procedure waiting period), "Code-Excl03" (30-day / initial waiting period); a maternity
  benefit clause; general terms titled "Moratorium Period", "Free Look Period", "Renewal of Policy", "Grace
  Period", "Portability", "Migration", "Continuity of benefits"; sometimes a definition of "Relapse" or a
  clause "Recurrence of illness" in the claims or sum-insured sections.
- Customer Information Sheet (CIS): a "Waiting period" row that summarises the wording. If the CIS and the
  wording disagree, report both values separately (two items for the same key), each with its own quote.

DATES
- Convert every date to ISO yyyy-mm-dd in valueText. Indian documents almost always write dd/mm/yyyy or
  dd-mm-yyyy or "1st April 2026": 01/04/2026 is 1 April 2026, i.e. 2026-04-01, never 4 January. Only treat a
  date as mm/dd when the document itself says so. If the day/month order is genuinely ambiguous and the
  document gives no other clue, set confidence "low" and explain in notes.
- policy_start_date and policy_end_date are the CURRENT period of insurance. "From 00:00 hrs of 01/04/2026
  To Midnight of 31/03/2027" gives start 2026-04-01 and end 2027-03-31. Do not shift the end date by a day.
- first_inception_date is the date continuous cover with this insurer first began (often "Date of First
  Inception", "Continuous coverage since", "Policy inception"). It is NOT the current start date and NOT the
  date of issue or proposal date. If only the current period is shown, first_inception_date is found=false.
- Per-member start dates ("Member since" columns) go in member_cover_start_dates. If a member has a later
  start date than others, report that member separately with memberScope set to that member's name.

WAITING PERIODS — UNITS ARE THE TRAP
- Report each period in the unit the parameter declares, but ONLY convert when the wording itself gives
  that unit. "36 months" -> 36 months. "Thirty days" -> 30 days. "Sixty continuous months" -> 60 months.
  If the wording says "2 years" and the parameter is in months, report 24 and put "wording states 2 years"
  in notes and set the unit field to the wording's unit text ("years"). Never convert days to months or
  months to days by assuming 30-day months or 365-day years; if the wording's unit cannot be expressed
  exactly in the parameter's unit, answer found=false and explain in notes.
- Initial waiting period (Code-Excl03): usually "within 30 days from the first policy commencement date
  ... except claims arising due to an accident". Report days in initial_waiting_period_days and the accident
  exception as accident_exempt_from_initial_wait=true. Also capture conditions such as "shall not apply if
  the Insured Person has Continuous Coverage for more than twelve months" in conditions/exceptions.
- PED waiting (Code-Excl01): months "of continuous coverage after the date of inception of the first
  policy with us". Common values are 48, 36, 24, 12 months, and older versions or other products may show a
  different number. Report only the number that applies to THIS policy and THIS product version. A sentence
  describing an earlier version, a marketing comparison or a regulatory maximum is not this policy's value.
- Specified disease/procedure waiting (Code-Excl02): report the months and, in specified_disease_list, each
  listed condition/procedure as a short item, in the document's order and wording. If different conditions
  carry different months (e.g. "12 months for cataract, 24 months for joint replacement"), use
  specified_disease_wait_variations for the per-condition rule and report each distinct month value as its
  own specified_disease_waiting_months item with the condition named in conditions. Accident exceptions
  ("unless necessitated by accident") belong in exceptions.
- Maternity waiting: months before delivery/maternity expenses are payable. Do not confuse with the
  newborn cover start or the number of deliveries.
- Waiting-period start basis: does the clock run from the policy's first inception, each member's own first
  inception, or the current period? Use waiting_period_start_basis.
- Sum-insured enhancement: wording such as "in case of enhancement of sum insured the exclusion shall apply
  afresh to the extent of sum insured increase" goes in waiting_reset_on_si_enhancement (rule).
- Waiting-period buy-down: an add-on or optional cover that reduces PED or specified-disease waits
  ("PED wait reduced to 12 months on payment of additional premium"). Only report it if this policy shows
  the add-on as opted/applicable; a menu of available options is not a purchased add-on.

CONTINUITY, MORATORIUM, FREE LOOK, GRACE, RELAPSE
- continuity_credit_rule: wording on portability, migration or group-to-individual continuity that reduces
  waits "to the extent of prior coverage", including any cap such as "limited to the sum insured of the
  previous policy". Do not invent credit the wording does not grant.
- moratorium_period_months: the number of continuous months after which the policy is not contestable
  except for fraud ("After completion of sixty continuous months of coverage ..."). Capture in conditions
  that it applies to enhanced sums insured only from the enhancement date, if stated.
- free_look_period_days: days "from date of receipt of the policy document"; note whether it applies only to
  new policies and not renewals.
- grace_period_days: days after expiry to renew without a break. Whether cover runs during the grace period
  is captured in conditions here as quoted text (another section stores the covered/not covered value).
- lapse_consequence_rule: what happens when renewal is not made within the grace period (termination,
  fresh waits, fresh proposal, revival terms).
- relapse_window_days: "Relapse within 45 days from the date of last consultation ... shall be treated as
  part of the same illness". Report the days only if the policy states it.

DISCIPLINE (MANDATORY)
- Quote verbatim from the page text. Every value must have a citation whose quote is copied exactly.
- Never infer a value from general knowledge, IRDAI regulations, market practice or another policy. A
  regulation-sounding number that this document does not state is found=false.
- Never fill a value from another policy, a previous year's document or a product brochure unless it is
  part of this source pack and is the operative document.
- Report each distinct value once. Report two items for a key only when the documents give genuinely
  different values (conflict, or different members/conditions).
- Use memberScope with the member's name when a value applies to a named member only (e.g. a member who
  joined later has a later inception date, or a member-specific extended wait). Otherwise memberScope=null.
- If the source pack does not state a parameter, return found=false with null values, an empty list and
  confidence "high". Do not guess and do not substitute a typical value.
- You extract only. Do not advise, recommend or judge whether a period is fair or compliant.
`.trim();

export default defineSection({
  number: 3,
  id: 'section-03-time',
  title: 'Time',
  question: 'Is the cover alive and has every clock run?',
  kind: 'extraction',
  expertise,
  parameters: [
    {
      key: 'policy_start_date',
      label: 'Policy period start date',
      description: 'Start date of the current period of insurance as ISO yyyy-mm-dd, converted from the document\'s own date format (Indian dd/mm/yyyy unless the document says otherwise). Not the first inception, issue or proposal date.',
      valueType: 'date', effects: DATE_EFFECTS, bases: DATE_BASES, critical: true, visibility: 'cover',
      extractionHints: ['Period of Insurance', 'Policy Period', 'From 00:00 hrs of', 'Policy start date', 'Cover commencement'],
      emergencyCard: true, validate: validDate,
    },
    {
      key: 'policy_end_date',
      label: 'Policy period end date',
      description: 'End date of the current period of insurance as ISO yyyy-mm-dd, exactly as stated (do not add or subtract a day).',
      valueType: 'date', effects: DATE_EFFECTS, bases: DATE_BASES, critical: true, visibility: 'cover',
      extractionHints: ['Period of Insurance', 'To Midnight of', 'Policy expiry date', 'Policy end date', 'Valid till'],
      emergencyCard: true, validate: validDate,
    },
    {
      key: 'first_inception_date',
      label: 'First inception date',
      description: 'Date continuous cover with this insurer first began, as ISO yyyy-mm-dd. Waiting periods usually run from this date. Not the current period start.',
      valueType: 'date', effects: DATE_EFFECTS, bases: DATE_BASES, visibility: 'cover',
      extractionHints: ['Date of First Inception', 'First policy inception', 'Continuous coverage since', 'Insured with us since'],
      validate: validDate,
    },
    {
      key: 'member_cover_start_dates',
      label: 'Member cover start dates',
      description: 'Per-member first inception or "member since" dates when the schedule lists them, as text with ISO dates. Use memberScope when one member differs from the rest.',
      valueType: 'rule', effects: DATE_EFFECTS, bases: ['per_person'], visibility: 'operational', memberScoped: true,
      extractionHints: ['Member Since', 'Insured since', 'Date of joining', 'Member inception date'],
    },
    {
      key: 'grace_period_days',
      label: 'Grace period (days)',
      description: 'Days after policy expiry within which renewal keeps continuity. Count in days as worded. Whether cover runs during grace is recorded verbatim in conditions.',
      valueType: 'days', effects: ['inform', 'require'], bases: ['per_policy'], visibility: 'cover',
      extractionHints: ['Grace Period', 'renewed within the Grace Period of', 'without break in policy', 'Coverage is not available during the grace period'],
      validate: maxCount(365, 'days'),
    },
    {
      key: 'lapse_consequence_rule',
      label: 'Lapse consequence',
      description: 'What the wording says happens when the policy is not renewed by the end of the policy period or the grace period: termination, loss of continuity, fresh waits, revival terms.',
      valueType: 'rule', effects: ['void', 'inform', 'require'], bases: ['per_policy'], visibility: 'cover',
      extractionHints: ['policy shall terminate', 'break in policy', 'revival', 'lapse', 'fresh proposal'],
    },
    {
      key: 'initial_waiting_period_days',
      label: 'Initial waiting period (days)',
      description: 'Days from first policy commencement during which illness claims are excluded (Code-Excl03). Days as worded; record waivers in conditions/exceptions.',
      valueType: 'days', effects: WAIT_EFFECTS, bases: WAIT_BASES, critical: true, visibility: 'cover',
      extractionHints: ['Code-Excl03', 'Initial Waiting Period', '30-day waiting period', 'within 30 days from the first policy commencement date'],
      emergencyCard: true, validate: maxCount(365, 'days'),
    },
    {
      key: 'accident_exempt_from_initial_wait',
      label: 'Accidents exempt from initial wait',
      description: 'True only if the wording states that the initial waiting period does not apply to claims arising from an accident.',
      valueType: 'boolean', effects: ['exclude', 'pay', 'inform'], bases: ['per_claim', 'not_applicable'], visibility: 'cover',
      extractionHints: ['except claims arising due to an accident', 'accidental injuries', 'not applicable to accidents'],
    },
    {
      key: 'ped_waiting_period_months',
      label: 'Pre-existing disease waiting period (months)',
      description: 'Months of continuous coverage before declared pre-existing diseases are covered (Code-Excl01), as stated for this policy and product version. Months as worded; never a figure from an earlier version or regulation.',
      valueType: 'months', effects: WAIT_EFFECTS, bases: WAIT_BASES, critical: true, visibility: 'cover', memberScoped: true,
      extractionHints: ['Code-Excl01', 'Pre-Existing Diseases', 'until the expiry of', 'months of continuous coverage after the date of inception of the first policy'],
      emergencyCard: true, validate: maxCount(120, 'months'),
    },
    {
      key: 'specified_disease_waiting_months',
      label: 'Specified disease/procedure waiting period (months)',
      description: 'Months before listed conditions/procedures are covered (Code-Excl02). If different conditions carry different months, one item per distinct value with the condition in conditions.',
      valueType: 'months', effects: WAIT_EFFECTS, bases: WAIT_BASES, critical: true, visibility: 'cover',
      extractionHints: ['Code-Excl02', 'Specified Disease/Procedure Waiting Period', 'listed Conditions, surgeries/treatments', 'specific waiting period'],
      validate: maxCount(120, 'months'),
    },
    {
      key: 'specified_disease_list',
      label: 'Specified diseases/procedures list',
      description: 'Each condition or procedure named in the specified-disease waiting list, as short items in the document\'s order and wording.',
      valueType: 'text_list', effects: WAIT_EFFECTS, bases: ['per_illness', 'not_applicable'], visibility: 'cover',
      extractionHints: ['List of specific diseases/procedures', 'Cataract', 'Hernia', 'Joint replacement', 'Kidney stones'],
    },
    {
      key: 'specified_disease_wait_variations',
      label: 'Per-condition specified-disease waits',
      description: 'Rule capturing different waiting months for different specified conditions, where the wording sets more than one period. found=false when one period applies to the whole list.',
      valueType: 'rule', effects: WAIT_EFFECTS, bases: ['per_illness'], visibility: 'cover',
      extractionHints: ['months for', 'following waiting periods shall apply', 'Group A / Group B conditions'],
    },
    {
      key: 'maternity_waiting_period_months',
      label: 'Maternity waiting period (months)',
      description: 'Months of continuous cover before maternity expenses are payable. Months as worded.',
      valueType: 'months', effects: WAIT_EFFECTS, bases: ['per_person', 'not_applicable'], visibility: 'cover',
      extractionHints: ['Maternity Waiting Period', 'Maternity Expenses shall be payable only after', 'continuously covered'],
      validate: maxCount(120, 'months'),
    },
    {
      key: 'waiting_period_start_basis',
      label: 'Waiting period start basis',
      description: 'The date from which waiting periods are counted as stated: the policy\'s first inception, each member\'s own first inception, or the current period start.',
      valueType: 'enum', enumValues: ['policy_first_inception', 'member_first_inception', 'current_period_start', 'not_stated'],
      effects: ['wait_until', 'inform'], bases: ['per_person', 'per_policy'], visibility: 'cover',
      extractionHints: ['counted from the Date of First Inception', 'from the date of inception of the first policy', 'each Insured Person'],
    },
    {
      key: 'waiting_reset_on_si_enhancement',
      label: 'Fresh waits on sum-insured increase',
      description: 'Rule stating that waiting periods apply afresh to the increased portion of sum insured on enhancement.',
      valueType: 'rule', effects: ['wait_until', 'exclude'], bases: ['per_person', 'per_policy'], visibility: 'cover',
      extractionHints: ['enhancement of sum insured', 'apply afresh', 'to the extent of sum insured increase'],
    },
    {
      key: 'waiting_period_buydown_rule',
      label: 'Waiting-period buy-down',
      description: 'Opted add-on or option on this policy that shortens PED or specified-disease waits, with the reduced months. found=false if no such add-on applies to this policy.',
      valueType: 'rule', effects: ['wait_until', 'inform'], bases: ['per_person', 'per_policy'], visibility: 'cover', memberScoped: true,
      extractionHints: ['reduction in waiting period', 'PED wait reduced to', 'waiting period waiver', 'add-on'],
    },
    {
      key: 'continuity_credit_rule',
      label: 'Continuity / portability credit',
      description: 'How prior continuous coverage (portability, migration, group cover) reduces waiting periods, and any cap such as the previous sum insured.',
      valueType: 'rule', effects: ['wait_until', 'inform'], bases: ['per_person'], visibility: 'cover', memberScoped: true,
      extractionHints: ['Portability', 'Continuity of Benefits', 'reduced to the extent of prior coverage', 'accrued continuity benefits', 'limited to the sum insured of the previous policy'],
    },
    {
      key: 'moratorium_period_months',
      label: 'Moratorium period (months)',
      description: 'Continuous months after which the policy and claims are not contestable for non-disclosure except established fraud. Months as worded ("sixty continuous months" = 60).',
      valueType: 'months', effects: ['inform'], bases: ['per_person', 'per_policy'], visibility: 'cover',
      extractionHints: ['Moratorium Period', 'After completion of sixty continuous months', 'no policy and claim shall be contestable'],
      validate: maxCount(240, 'months'),
    },
    {
      key: 'free_look_period_days',
      label: 'Free look period (days)',
      description: 'Days from receipt of the policy document during which a new policy can be returned. Days as worded; note applicability limits in conditions.',
      valueType: 'days', effects: ['inform'], bases: ['per_policy'], visibility: 'cover',
      extractionHints: ['Free Look Period', 'from date of receipt of the policy document', 'return the same if not acceptable'],
      validate: maxCount(365, 'days'),
    },
    {
      key: 'relapse_window_days',
      label: 'Relapse window (days)',
      description: 'Days within which a recurrence is treated as the same illness, as stated in this policy. found=false if not stated.',
      valueType: 'days', effects: ['inform'], bases: ['per_illness'], visibility: 'cover',
      extractionHints: ['Relapse', 'treated as part of the same illness', 'recurrence within', 'from the date of last consultation'],
      validate: maxCount(365, 'days'),
    },
  ],
  reviewGuidance: `
Check the policy start and end dates against the schedule's "Period of Insurance" and confirm the day/month
order (Indian documents use dd/mm/yyyy). Confirm the first inception date is distinct from the current start.
For the initial, PED and specified-disease waits, confirm the number and unit come from this policy's
operative wording (not an earlier version, a CIS summary that conflicts, or a regulatory figure), that the
accident exception and any continuous-coverage waiver are captured, and that the specified-disease list is
complete. Confirm whether waits run from each member's own inception and whether any member joined later.
`.trim(),
});

// Section 7 — Where: which hospital, which process? (hospital access and cashless)
// Feeds the emergency card a human operator reads while a family is at a hospital.
// Reimbursement claims, grievance and settlement belong to Section 8.

import { defineSection } from '../contracts.js';

const MAX_NOTICE_HOURS = 24 * 90;

const hoursWithin = (max, label) => value => (
  value.count > max ? `${label} of ${value.count} hours is implausible (over ${max}).` : null
);

const looksLikePhoneNumber = value => {
  const digits = (value.text.match(/\d/g) ?? []).length;
  if (digits < 6) return 'Helpline must contain a phone number with at least 6 digits, copied verbatim.';
  if (digits > 40) return 'Helpline text holds too many digits; record one number per item.';
  return null;
};

const looksLikeEmail = value => (
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.text) ? null : 'Value must be a single e-mail address copied verbatim.'
);

const expertise = `
You read the cashless and hospital-access parts of an Indian health-insurance policy pack and record only what the
documents say. Your scope: whether cashless treatment is available at network and non-network hospitals, where the
network and excluded-hospital lists are published, pre-authorisation and intimation for cashless treatment, who
sends the request and with which documents, enhancement of the authorised amount, deposits, what happens when
cashless is denied, authorisation turnaround statements, and the helplines and contact channels for cashless.
Out of scope (Section 8): reimbursement claim intimation and document deadlines, claim settlement time, interest on
delay, grievance officers, Bima Bharosa and the Ombudsman. Out of scope (Section 6): the room-rent cap and
proportionate deduction amounts themselves.

WHERE IT APPEARS
Look for clause titles such as "Cashless Facility", "Claim Procedure", "Procedure for Availing Cashless",
"Pre-authorisation", "Network Provider", "Non-Network Provider", "Preferred Provider Network (PPN)",
"Excluded Providers", "Cashless Everywhere", "Contact Details", "TPA Details", "Helpline" and the last page
of the wording or the Customer Information Sheet (CIS), which usually lists toll-free numbers, e-mail and website.
The policy schedule often prints the TPA name and a TPA helpline. IRDAI-standardised wordings define "Network
Provider", "Non-Network Provider", "Cashless facility" and "Excluded Provider" in the definitions section; the
operative timelines are in the claim procedure section.

NETWORK VERSUS NON-NETWORK
A network provider is a hospital empanelled with the insurer or TPA for cashless. Typical wording: "Cashless
facility shall be available only at Network Providers". Some insurers offer cashless at non-network hospitals
("cashless everywhere", "cashless at any hospital") on condition of prior notice — for example "intimate at least
48 hours before a planned admission and within 48 hours of an emergency admission". Record
cashless_non_network_available=true only if the wording grants it; record it false when the wording says
cashless is not available at non-network hospitals or that they are reimbursement only. If the wording is silent
on non-network cashless, answer found=false — do not assume false. Record a non-network notice period only if it
is printed for non-network cashless specifically; do not copy the network pre-auth notice into it.
Network membership of any particular hospital is dynamic and is never in the wording. Never state whether a named
hospital is in network. Record only the reference to where the list or hospital locator is published (website
path, app, TPA), exactly as written.

PREFERRED AND EXCLUDED HOSPITALS
Preferred Provider Network (PPN) or "agreed package rate" hospitals may carry a benefit (co-pay waiver) or a
condition (package rates apply). Excluded, de-empanelled or blacklisted hospitals: IRDAI-style wording says the
insurer is not liable for claims from an Excluded Provider except in life-threatening situations or accidents up to
the stage of stabilisation. Put such exceptions in "exceptions", not in the main value. Record the place where
the excluded list is published separately.

PRE-AUTHORISATION AND INTIMATION
Planned and emergency timelines are different parameters. Typical forms: "at least 72 hours prior to the planned
date of admission", "3 days before admission", "48 hours in advance" (planned) and "within 24 hours of admission",
"within 24 hours or before discharge, whichever is earlier" (emergency). Convert days to hours only when the
wording states whole days (3 days = 72 hours) and say so in notes; keep "whichever is earlier" or "before
discharge" as conditions. Do not confuse cashless pre-authorisation or intimation with reimbursement intimation
(often a different number, e.g. 48 hours, belonging to Section 8) — if a timeline is stated only for
reimbursement claims, it is not a Section 7 value.
Who submits: in Indian cashless practice the network hospital's insurance (TPA) desk sends the pre-authorisation
request form to the TPA or insurer; record who the wording names. Record the form name and the channel (e-mail,
portal, fax) if stated. Required documents: list each document as one item in the order printed (photo ID, health
card or policy number, KYC, doctor's notes, investigation reports, cost estimate). Record the room-category
statement if the wording ties pre-authorisation to the room category requested.
Enhancement: if treatment costs exceed the authorised amount, the hospital can request an enhancement with a
revised estimate; record the rule as written. Deposit: record what the hospital may or may not collect after
authorisation (non-payables, co-pay, excess over authorised amount).
Denial: many wordings say denial of pre-authorisation is not denial of treatment or coverage, and the insured may
claim reimbursement. Record this verbatim-backed rule; do not extend it beyond what is printed.

AUTHORISATION TURNAROUND
Record a cashless decision time or discharge authorisation time only when this pack's wording states it (e.g.
"within 1 hour", "within 3 hours of the discharge request"). Never insert a number from IRDAI circulars, master
circulars, news or general knowledge, even if you know one. "Endeavour to" wording is still the stated timeline:
record the number and put "endeavour" in conditions. Record a consequence of delay (insurer bears extra hospital
charges, interest) only if printed; otherwise found=false.

HELPLINES AND CONTACTS
Copy phone numbers character for character as printed, including hyphens and spaces; never reformat, complete,
guess or invent a number, and never take a number from another policy or your memory of an insurer. Distinguish
the TPA cashless helpline, the insurer customer-care line and the grievance officer line: a grievance number is
Section 8 and must not be recorded as a cashless or customer-care helpline. Put availability ("24x7", "toll
free", office hours) in conditions. If several distinct numbers are printed for the same role, report each once
as a separate item. If no TPA is used and the insurer handles cashless in-house, record the insurer's cashless
line under insurer_helpline and leave tpa_helpline found=false unless a TPA line is printed.

TRAPS
- "Cashless facility is available at network hospitals" does not mean every hospital in a city is in network.
- A planned-admission notice and an emergency intimation printed in the same sentence are two values.
- Days versus hours: "within 1 day" is not automatically 24 hours unless the wording equates them; say so in notes.
- A timeline stated for reimbursement intimation is not a cashless timeline.
- Member-specific conditions (e.g. a named member must use a specific facility) go in memberScope with that name.
- Schedule or CIS text can differ from wording text; report both values separately, never average or choose.

OUTPUT RULES
Quote verbatim from the page text for every found value; the quote must appear exactly in the document. Never infer
a value from general knowledge, regulation or another policy, and never fill a value from another policy in the
pack. Report each distinct value once. Use memberScope only when a value applies to a named member. When the pack
does not state a parameter, answer found=false with null values — do not guess. Describe what the document says;
do not give advice or recommendations.
`.trim();

const parameters = [
  {
    key: 'cashless_network_available',
    label: 'Cashless at network hospitals',
    description: 'Whether the wording grants cashless treatment at network (empanelled) hospitals. Conditions such as "subject to pre-authorisation" go in conditions. True/false as stated; silence is found=false.',
    valueType: 'boolean',
    effects: ['pay', 'require'],
    bases: ['per_claim', 'not_applicable'],
    critical: true,
    visibility: 'cover',
    extractionHints: ['Cashless Facility', 'available only at Network Providers', 'Network Provider definition', 'cashless facility subject to pre-authorisation'],
    emergencyCard: true,
  },
  {
    key: 'cashless_non_network_available',
    label: 'Cashless at non-network hospitals',
    description: 'Whether cashless is offered at non-network hospitals ("cashless everywhere"). False only when the wording says non-network treatment is reimbursement only or cashless is not available there; silence is found=false.',
    valueType: 'boolean',
    effects: ['pay', 'require', 'exclude'],
    bases: ['per_claim', 'not_applicable'],
    critical: true,
    visibility: 'cover',
    extractionHints: ['Non-Network Provider', 'cashless everywhere', 'cashless at any hospital', 'payable only on reimbursement basis'],
    emergencyCard: true,
  },
  {
    key: 'non_network_cashless_notice_hours',
    label: 'Notice for non-network cashless (hours)',
    description: 'Hours of prior notice required to use cashless at a non-network hospital, as printed for non-network cashless specifically. Planned versus emergency difference goes in conditions. Never copy the network pre-auth notice here.',
    valueType: 'count',
    effects: ['require'],
    bases: ['per_claim'],
    visibility: 'operational',
    extractionHints: ['cashless everywhere', 'intimate at least 48 hours before', 'non-network cashless notice'],
    validate: hoursWithin(MAX_NOTICE_HOURS, 'Non-network notice'),
  },
  {
    key: 'network_list_reference',
    label: 'Where the network list is published',
    description: 'The website path, app, TPA or document the wording names as the source of the current network hospital list, copied as printed. Never a statement about whether a particular hospital is in network.',
    valueType: 'text',
    effects: ['inform'],
    bases: ['not_applicable'],
    visibility: 'operational',
    extractionHints: ['list of Network Providers is available', 'updated list on website', 'obtain from the TPA', 'network hospital list'],
    emergencyCard: true,
  },
  {
    key: 'network_hospital_locator',
    label: 'Network hospital locator',
    description: 'Any stated tool for finding a network hospital by city, pin code, distance or speciality (app, website search, helpline), as printed. Supports the distance-to-suitable-network-hospital check; the result itself is Dynamic and never in the wording.',
    valueType: 'text',
    effects: ['inform'],
    bases: ['not_applicable'],
    visibility: 'operational',
    extractionHints: ['hospital locator', 'search by pin code', 'search by city and speciality', 'mobile application'],
  },
  {
    key: 'preferred_provider_rule',
    label: 'Preferred provider network rule',
    description: 'What the wording says about preferred-provider (PPN) or agreed-package-rate hospitals: benefit, package-rate condition or co-pay waiver, as printed.',
    valueType: 'rule',
    effects: ['pay', 'pay_percent', 'cap_amount', 'inform'],
    bases: ['per_claim', 'not_applicable'],
    visibility: 'cover',
    extractionHints: ['Preferred Provider Network', 'PPN', 'agreed package rates', 'preferred hospital'],
  },
  {
    key: 'excluded_hospitals_rule',
    label: 'Excluded / de-empanelled hospitals',
    description: 'The rule for claims from excluded, de-empanelled or blacklisted hospitals, including any emergency or accident stabilisation exception (in exceptions).',
    valueType: 'rule',
    effects: ['exclude', 'pay'],
    bases: ['per_claim', 'not_applicable'],
    critical: true,
    visibility: 'cover',
    extractionHints: ['Excluded Provider', 'de-empanelled', 'blacklisted hospital', 'up to the stage of stabilisation'],
    emergencyCard: true,
  },
  {
    key: 'excluded_hospitals_list_reference',
    label: 'Where the excluded-hospital list is published',
    description: 'Website path or document named as the source of the excluded-provider list, copied as printed.',
    valueType: 'text',
    effects: ['inform'],
    bases: ['not_applicable'],
    visibility: 'operational',
    extractionHints: ['list of Excluded Providers is available', 'excluded providers website'],
  },
  {
    key: 'planned_preauth_notice_hours',
    label: 'Planned admission pre-authorisation notice (hours)',
    description: 'Minimum hours before a planned admission by which cashless pre-authorisation or intimation must be made. Whole days convert to hours only when stated in days (note it). Not a reimbursement intimation timeline.',
    valueType: 'count',
    effects: ['require'],
    bases: ['per_claim'],
    critical: true,
    visibility: 'operational',
    extractionHints: ['planned hospitalisation', 'at least 72 hours prior', 'days before admission', 'pre-authorisation request in advance'],
    emergencyCard: true,
    validate: hoursWithin(MAX_NOTICE_HOURS, 'Planned pre-auth notice'),
  },
  {
    key: 'emergency_intimation_hours',
    label: 'Emergency admission intimation (hours)',
    description: 'Hours after an emergency admission within which the TPA or insurer must be intimated for cashless. "Before discharge, whichever is earlier" goes in conditions. Not a reimbursement intimation timeline.',
    valueType: 'count',
    effects: ['require'],
    bases: ['per_claim'],
    critical: true,
    visibility: 'operational',
    extractionHints: ['emergency hospitalisation', 'within 24 hours of admission', 'whichever is earlier', 'intimate the TPA'],
    emergencyCard: true,
    validate: hoursWithin(MAX_NOTICE_HOURS, 'Emergency intimation'),
  },
  {
    key: 'preauth_submitted_by',
    label: 'Who submits the pre-authorisation request',
    description: 'Who the wording says sends the cashless pre-authorisation request: the network hospital (insurance/TPA desk), the insured person, or either.',
    valueType: 'enum',
    enumValues: ['network_hospital', 'insured_person', 'either'],
    effects: ['require'],
    bases: ['per_claim'],
    visibility: 'operational',
    extractionHints: ['Network Provider shall send', 'pre-authorisation request form', 'hospital shall submit', 'insured shall submit'],
  },
  {
    key: 'preauth_form_and_channel',
    label: 'Pre-authorisation form and channel',
    description: 'The named pre-authorisation form, who signs it, and the channel it goes by (e-mail, portal, fax), as printed.',
    valueType: 'text',
    effects: ['require'],
    bases: ['per_claim'],
    visibility: 'operational',
    extractionHints: ['pre-authorisation request form', 'signed by the treating Medical Practitioner', 'by e-mail', 'TPA portal', 'fax'],
  },
  {
    key: 'preauth_documents',
    label: 'Pre-authorisation documents',
    description: 'Documents required with the cashless pre-authorisation request, one item per document in printed order. Reimbursement claim documents belong to Section 8.',
    valueType: 'text_list',
    effects: ['require'],
    bases: ['per_claim'],
    visibility: 'operational',
    extractionHints: ['along with the following documents', 'photo identity proof', 'health card', 'KYC', 'estimate of cost'],
  },
  {
    key: 'cashless_process',
    label: 'Cashless process',
    description: 'Short normalised statement of the cashless sequence as printed: intimation, request by hospital, authorisation letter with amount, discharge authorisation.',
    valueType: 'rule',
    effects: ['require', 'inform'],
    bases: ['per_claim'],
    visibility: 'operational',
    extractionHints: ['Procedure for Availing Cashless Facility', 'authorisation letter', 'amount authorised', 'final authorisation for discharge'],
    emergencyCard: true,
  },
  {
    key: 'preauth_room_category_rule',
    label: 'Room category at pre-authorisation',
    description: 'What the wording says about the room category stated in, or authorised by, the pre-authorisation request. The cap and proportionate deduction amounts themselves are Section 6.',
    valueType: 'rule',
    effects: ['require', 'inform'],
    bases: ['per_claim'],
    visibility: 'cover',
    extractionHints: ['room category for which authorisation is sought', 'eligible category', 'higher room category'],
  },
  {
    key: 'deposit_and_estimate_rule',
    label: 'Deposit and estimate rule',
    description: 'What a network hospital may or may not collect from the insured after cashless authorisation (deposit, non-payables, co-pay, excess over authorised amount) and any estimate requirement, as printed.',
    valueType: 'rule',
    effects: ['inform', 'deduct'],
    bases: ['per_claim'],
    visibility: 'cover',
    extractionHints: ['shall not collect any deposit', 'non-payable items', 'estimate of the cost', 'in excess of the authorised amount'],
  },
  {
    key: 'enhancement_request_rule',
    label: 'Enhancement of authorised amount',
    description: 'How the hospital requests an increase of the authorised amount (revised estimate, clinical notes) and any condition, as printed.',
    valueType: 'rule',
    effects: ['require', 'inform'],
    bases: ['per_claim'],
    visibility: 'operational',
    extractionHints: ['enhancement', 'revised estimate', 'exceed the amount authorised', 'additional authorisation'],
  },
  {
    key: 'cashless_denial_rule',
    label: 'Effect of cashless denial',
    description: 'What the wording says happens when pre-authorisation is denied (e.g. not a denial of treatment or coverage; reimbursement route open), as printed.',
    valueType: 'rule',
    effects: ['inform'],
    bases: ['per_claim'],
    visibility: 'cover',
    extractionHints: ['Denial of a pre-authorisation request', 'shall in no way be construed', 'denial of treatment', 'considered on merits'],
    emergencyCard: true,
  },
  {
    key: 'cashless_decision_hours',
    label: 'Cashless decision turnaround (hours)',
    description: 'Hours the wording states for the insurer/TPA to decide a cashless pre-authorisation request. Only if printed in this pack; never a regulatory number from memory. "Endeavour" goes in conditions.',
    valueType: 'count',
    effects: ['inform'],
    bases: ['per_claim'],
    visibility: 'operational',
    extractionHints: ['decide on a cashless request within', 'within 1 hour of receipt', 'turnaround time'],
    validate: hoursWithin(720, 'Cashless decision time'),
  },
  {
    key: 'discharge_authorisation_hours',
    label: 'Discharge authorisation turnaround (hours)',
    description: 'Hours the wording states for final cashless authorisation at discharge after the hospital\'s discharge request. Only if printed; never a regulatory number from memory.',
    valueType: 'count',
    effects: ['inform'],
    bases: ['per_claim'],
    visibility: 'operational',
    extractionHints: ['final authorisation for discharge', 'within 3 hours of receipt of the discharge request', 'discharge authorisation'],
    validate: hoursWithin(720, 'Discharge authorisation time'),
  },
  {
    key: 'authorisation_delay_consequence',
    label: 'Consequence of authorisation delay',
    description: 'Any printed consequence if the insurer/TPA misses its authorisation timeline (e.g. insurer bears additional hospital charges). Only if printed in this pack.',
    valueType: 'rule',
    effects: ['pay', 'inform'],
    bases: ['per_claim'],
    visibility: 'cover',
    extractionHints: ['delay in authorisation', 'additional amount charged by the hospital', 'borne by the Company', 'beyond the timeline'],
  },
  {
    key: 'tpa_helpline',
    label: 'TPA cashless helpline',
    description: 'TPA phone number for cashless/pre-authorisation, copied character for character as printed. Availability (24x7, toll free) goes in conditions. Never a grievance number; never invented or reformatted.',
    valueType: 'text',
    effects: ['inform'],
    bases: ['not_applicable'],
    critical: true,
    visibility: 'operational',
    extractionHints: ['TPA helpline', 'TPA toll free', 'cashless helpline', 'Contact Details', 'policy schedule TPA details'],
    emergencyCard: true,
    validate: looksLikePhoneNumber,
  },
  {
    key: 'tpa_cashless_email',
    label: 'TPA cashless e-mail',
    description: 'E-mail address printed for sending cashless/pre-authorisation requests to the TPA, copied exactly.',
    valueType: 'text',
    effects: ['inform'],
    bases: ['not_applicable'],
    visibility: 'operational',
    extractionHints: ['e-mail for cashless requests', 'preauth@', 'cashless@'],
    validate: looksLikeEmail,
  },
  {
    key: 'insurer_helpline',
    label: 'Insurer customer-care helpline',
    description: 'Insurer customer-care or claims helpline, copied character for character as printed. Availability goes in conditions. A grievance-officer number is Section 8 and does not count.',
    valueType: 'text',
    effects: ['inform'],
    bases: ['not_applicable'],
    visibility: 'operational',
    extractionHints: ['customer service', 'toll free', 'call us', 'Contact Details', 'Customer Information Sheet'],
    emergencyCard: true,
    validate: looksLikePhoneNumber,
  },
];

const reviewGuidance = `
Check against the page image, not only the text layer:
- tpa_helpline and insurer_helpline: every digit and hyphen matches the printed number; the number is not the
  grievance officer's line; schedule and wording numbers agree (if not, keep both as Conflicting).
- planned_preauth_notice_hours and emergency_intimation_hours: the number belongs to cashless, not reimbursement
  intimation; days-to-hours conversion is printed as days; "whichever is earlier" or "before discharge" is in
  conditions.
- cashless_network_available and cashless_non_network_available: non-network silence is Unknown, not false;
  any "cashless everywhere" notice period is captured separately.
- excluded_hospitals_rule: the stabilisation or emergency exception is recorded as an exception.
- Turnaround hours appear in this pack's text; no value came from a regulation or circular.
- No value states whether a particular hospital is in network; that is Dynamic and needs a dated official source.
`.trim();

export default defineSection({
  number: 7,
  id: 'section-07-hospital-access',
  title: 'Where — which hospital, which process?',
  question: 'Which hospitals can the family use cashless, what must be done before or on admission, and whom do they call?',
  kind: 'extraction',
  expertise,
  parameters,
  reviewGuidance,
});

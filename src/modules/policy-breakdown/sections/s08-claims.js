import { defineSection } from '../contracts.js';

// Section 8 — Process: what must be done, by when, by whom (reimbursement claims, settlement, grievance).
// Cashless pre-authorisation and cashless intimation belong to Section 7 and are not extracted here.

const PROCESS_EFFECTS = ['require', 'inform'];
const PROCESS_BASES = ['per_claim', 'per_event', 'not_applicable'];

const maxCount = (limit, unit) => value => (value.count > limit ? `${unit} above ${limit} is implausible for a claim process clause` : null);
const positive = unit => value => (value.count === 0 ? `${unit} of zero is not a usable deadline` : null);
const both = (...checks) => value => checks.map(check => check(value)).find(Boolean) ?? null;

const expertise = `
You are extracting Section 8 of an Indian health-insurance policy: the claim PROCESS for reimbursement claims,
claim settlement, rejection and grievance redressal. You read page-tagged text from the policy wording, schedule,
Customer Information Sheet (CIS) and any annexures supplied for this one policy.

Scope boundary. Cashless facility, pre-authorisation, cashless intimation, network lists and TPA helpline belong to
Section 7. Do not extract them here. If a clause says "for cashless claims follow Section D", that is not a Section 8
value. Extract only reimbursement intimation and submission, documents, KYC at claim, who collects records, status
tracking, settlement and investigation timelines, interest on delay, rejection process, partial settlement
explanation, condonation of delay and the grievance ladder.

Where it appears. Usually a wording chapter titled "Claim Procedure", "Claims Procedure", "Procedure for Claims",
"Notification of Claim", "Claim Intimation", "Documents to be Submitted", "Necessary Documents", "Claim Settlement
(provision for Penal Interest)", "Repudiation of Claim", "Grievance Redressal Procedure", "Customer Service", and an
annexure listing Insurance Ombudsman offices. IRDAI-standardised wordings often use near-identical sentences across
insurers ("The Company shall settle or reject a claim, as the case may be, within ... days from the date of receipt
of last necessary document"). The CIS may repeat the timelines in a table. The schedule rarely contains Section 8 values.

How to read the clauses and the traps:
- Reimbursement intimation is often split: emergency hospitalisation "within N hours of admission" and planned
  hospitalisation "at least N hours / days prior to admission". These are two different parameters. Convert a stated
  number of days to hours only when the wording itself gives the number of days (e.g. "2 days" = 48 hours) and keep
  the original phrase in the quote. If one combined deadline is stated without the planned/emergency split, report it
  only for the parameter it clearly applies to and say so in notes.
- Do not confuse cashless intimation (Section 7) with reimbursement intimation. If the wording gives a single
  intimation clause for "all claims" or "any claim", it applies to reimbursement too; report it and note the shared wording.
- Submission deadline: "within N days of discharge" is the main reimbursement submission deadline. A separate,
  shorter or longer clock for post-hospitalisation bills ("within N days from completion of post-hospitalisation
  treatment") is a different parameter. Never merge them. The basis is the event that starts the clock; record it in
  conditions (e.g. "counted from date of discharge").
- Condonation: wordings often add "delay may be condoned / waived if the insured proves hardship or reasons beyond
  control". Record it as a rule; it does not change the number of days.
- Documents: list each document once as a short item, in the wording's order: claim form, discharge summary, final
  bill and receipts, investigation reports with prescriptions, pharmacy bills, OT notes, cancelled cheque or bank
  details (NEFT), ID / address proof. Conditional items ("where surgery was performed") keep their condition in the
  item text. Accident-only documents (FIR, Medico-Legal Certificate / MLC, "where conducted" / "if applicable") go in
  the accident documents parameter, not the general list. Death-claim documents are not in scope unless asked.
- KYC at claim: "CKYC number", "e-KYC", "KYC documents of the proposer", "PAN". Record exactly who must complete it
  and when (only if not completed at issuance, above a claim amount, etc.).
- Who collects records: some wordings say the insurer or TPA will obtain records directly from the hospital or will
  not reject for missing hospital records. Record it as a rule. If silent, answer found=false.
- Settlement timeline: "settle or reject within N days of receipt of the last necessary document". If an
  investigation clause gives a different number, that is a separate parameter; the ordinary figure stays the main one,
  with the investigation case recorded in exceptions.
- Interest on delay: record the rate exactly as worded ("2% above the bank rate", "bank rate plus 2%") and the period
  it runs over. Do not compute a percentage figure or define the bank rate unless the document defines it.
- Rejection process: who decides (e.g. Claims Review Committee), the form of communication (in writing), and whether
  the specific reason and policy clause must be stated. Repudiation, denial and rejection are synonyms.
- Partial settlement: whether the insurer must explain each deduction against a bill line or clause.
- Grievance ladder: list the escalation steps in the order the wording gives them (e.g. "Grievance Redressal Officer
  of the Company", "Bima Bharosa portal", "Insurance Ombudsman", "Consumer forum / court"). Include a step only if the
  wording names it. The grievance officer contact is the e-mail, phone or address the wording gives for the insurer's
  grievance cell, as written. Grievance response days are the insurer's stated resolution time, not the
  acknowledgement time.
- Insurance Ombudsman: ombudsman_available is true only when the wording names the Insurance Ombudsman as an avenue.
  Ombudsman value limits and complaint windows are reported ONLY if the wording states the figure. Mentioning the
  Insurance Ombudsman Rules, 2017 is not a statement of any limit. Never fill these from your knowledge of the rules.

Absolute rules:
- Quote verbatim. Every value must carry a quote copied character for character from the supplied page text, with
  the page number. Do not paraphrase inside quotes.
- Never infer a value from general knowledge, IRDAI regulations, master circulars, typical market practice or another
  insurer's wording. Regulatory timelines (for example a settlement or grievance timeline you remember from a circular)
  must not be inserted unless this document states them.
- Never fill a value from another policy, a previous year's wording or a sample document.
- Report each distinct value once. If two clauses in this pack state different values for the same parameter, report
  both items (each with its own quote) and explain in notes; do not choose between them.
- Use memberScope only when a value applies to a named member; claim process clauses normally apply to every insured
  person, so memberScope is usually null.
- Answer found=false, with all values null, lists empty and no citations, when the pack does not state the parameter.
  Silence is a valid answer. Do not mark found=true on the strength of a heading alone.
- Describe what the policy says. Do not advise the household what to do, whether to complain, or whether a timeline
  is fair or lawful; that is a different section's job.
`.trim();

const parameters = [
  {
    key: 'reimbursement_intimation_emergency_hours',
    label: 'Reimbursement claim intimation — emergency (hours)',
    description: 'Hours after admission within which an emergency hospitalisation must be intimated for a reimbursement claim. Integer hours; convert a stated number of days only when the wording states days. Not the cashless intimation of Section 7 unless the clause covers all claims.',
    valueType: 'count',
    effects: ['require'],
    bases: ['per_claim', 'per_event'],
    critical: true,
    visibility: 'cover',
    extractionHints: ['Notification of Claim', 'Claim Intimation', 'within 24 hours of admission', 'within 48 hours of admission', 'in case of emergency hospitalisation', 'reimbursement claims'],
    validate: both(positive('Intimation hours'), maxCount(720, 'Intimation hours')),
  },
  {
    key: 'reimbursement_intimation_planned_hours',
    label: 'Reimbursement claim intimation — planned (hours before admission)',
    description: 'Hours before a planned admission by which the claim must be intimated for a reimbursement claim. Integer hours before admission. Not the cashless pre-authorisation notice of Section 7.',
    valueType: 'count',
    effects: ['require'],
    bases: ['per_claim', 'per_event'],
    critical: true,
    visibility: 'cover',
    extractionHints: ['at least 72 hours prior to admission', 'prior to admission in case of planned hospitalisation', 'planned hospitalisation', 'Notification of Claim'],
    validate: both(positive('Intimation hours'), maxCount(2_160, 'Intimation hours')),
  },
  {
    key: 'reimbursement_submission_days',
    label: 'Reimbursement document submission deadline (days after discharge)',
    description: 'Days after discharge within which the reimbursement claim with documents must be submitted. Integer days; the starting event (discharge) goes in conditions. Post-hospitalisation bill deadlines are a separate parameter.',
    valueType: 'days',
    effects: ['require'],
    bases: ['per_claim'],
    critical: true,
    visibility: 'cover',
    extractionHints: ['Submission of Claim Documents', 'within 30 days of the date of discharge', 'within 15 days of discharge', 'Time limit for submission of documents'],
    validate: both(positive('Submission days'), maxCount(365, 'Submission days')),
  },
  {
    key: 'post_hospitalisation_claim_submission_days',
    label: 'Post-hospitalisation bills submission deadline (days)',
    description: 'Days within which post-hospitalisation expense claims must be submitted, counted from the event the wording names (usually completion of post-hospitalisation treatment). Integer days.',
    valueType: 'days',
    effects: ['require'],
    bases: ['per_claim'],
    visibility: 'cover',
    extractionHints: ['post-hospitalisation expenses shall be submitted', 'completion of post-hospitalisation treatment', 'post hospitalisation claim'],
    validate: both(positive('Submission days'), maxCount(365, 'Submission days')),
  },
  {
    key: 'delay_condonation_rule',
    label: 'Condonation of delay in intimation or submission',
    description: 'Whether and on what condition the insurer may condone or waive delay in claim intimation or document submission, as worded.',
    valueType: 'rule',
    effects: ['inform'],
    bases: ['per_claim', 'not_applicable'],
    visibility: 'cover',
    extractionHints: ['may be condoned', 'condonation of delay', 'delay may be waived', 'reasons beyond his or her control', 'hardship'],
  },
  {
    key: 'reimbursement_documents',
    label: 'Documents required for a reimbursement claim',
    description: 'Each document required for an ordinary reimbursement claim, one short item per document in wording order, with any stated condition kept in the item. Includes bank details / cancelled cheque if listed. Accident-only documents go in accident_claim_documents.',
    valueType: 'text_list',
    effects: ['require'],
    bases: ['per_claim'],
    visibility: 'operational',
    extractionHints: ['Necessary Documents', 'Documents to be submitted', 'claim form', 'discharge summary', 'final bill', 'cancelled cheque', 'NEFT'],
  },
  {
    key: 'accident_claim_documents',
    label: 'Additional documents for accident claims',
    description: 'Documents required only when hospitalisation is due to an accident (FIR, Medico-Legal Certificate / MLC), with the condition as worded (e.g. "where conducted").',
    valueType: 'text_list',
    effects: ['require'],
    bases: ['per_claim', 'per_event'],
    visibility: 'operational',
    extractionHints: ['First Information Report', 'FIR', 'Medico-Legal Certificate', 'MLC', 'in case of accident', 'where conducted'],
  },
  {
    key: 'claim_kyc_requirement',
    label: 'KYC requirement at claim',
    description: 'Whether KYC (CKYC identifier, e-KYC, KYC documents, PAN) is required at the claim stage, for whom, and on what condition, as worded.',
    valueType: 'rule',
    effects: PROCESS_EFFECTS,
    bases: ['per_claim', 'per_policy'],
    visibility: 'operational',
    extractionHints: ['KYC', 'CKYC', 'Central KYC', 'e-KYC', 'KYC documents of the proposer', 'PAN'],
  },
  {
    key: 'records_collection_rule',
    label: 'Who obtains hospital records',
    description: 'Whether the insurer or TPA must obtain medical records directly from the hospital, and any bar on rejecting for want of hospital records, as worded.',
    valueType: 'rule',
    effects: PROCESS_EFFECTS,
    bases: ['per_claim'],
    visibility: 'operational',
    extractionHints: ['obtain the medical records directly from the Hospital', 'shall not reject the claim for want of', 'TPA shall collect'],
  },
  {
    key: 'claim_status_tracking',
    label: 'Claim status tracking',
    description: 'How the wording says claim status can be tracked or is communicated (portal, website, SMS, claim reference number), and by which authority (hospital, TPA, insurer).',
    valueType: 'rule',
    effects: ['inform'],
    bases: ['per_claim'],
    visibility: 'operational',
    extractionHints: ['status of a claim', 'claim status', 'track', 'claim reference number', 'portal'],
  },
  {
    key: 'claim_settlement_days',
    label: 'Claim settlement or rejection timeline (days)',
    description: 'Days within which the insurer states it will settle or reject a claim in the ordinary case, with the starting event (usually receipt of the last necessary document) in conditions. Investigation timelines go in claim_investigation_settlement_days.',
    valueType: 'days',
    effects: ['inform'],
    bases: ['per_claim'],
    visibility: 'cover',
    extractionHints: ['settle or reject a claim', 'within 30 days of receipt of the last necessary document', 'Claim Settlement', 'provision for Penal Interest'],
    validate: both(positive('Settlement days'), maxCount(365, 'Settlement days')),
  },
  {
    key: 'claim_investigation_settlement_days',
    label: 'Settlement timeline when investigation is required (days)',
    description: 'Days within which the insurer states it will complete an investigation and settle or reject the claim, when the wording gives a separate investigation timeline.',
    valueType: 'days',
    effects: ['inform'],
    bases: ['per_claim'],
    visibility: 'cover',
    extractionHints: ['warrant an investigation', 'complete the investigation', 'within 45 days', 'investigation'],
    validate: both(positive('Investigation days'), maxCount(365, 'Investigation days')),
  },
  {
    key: 'interest_on_delayed_settlement',
    label: 'Interest on delayed claim payment',
    description: 'Interest the insurer states it will pay when payment is delayed beyond the stated timeline: the rate exactly as worded (e.g. "2% above the bank rate") and the period it runs over. Do not compute a numeric rate.',
    valueType: 'rule',
    effects: ['pay'],
    bases: ['per_claim'],
    visibility: 'cover',
    extractionHints: ['interest at a rate', 'above the bank rate', 'penal interest', 'delay in payment'],
  },
  {
    key: 'claim_rejection_process',
    label: 'Claim rejection / repudiation process',
    description: 'Who decides a rejection, how it is communicated, and whether the specific reason and policy clause must be stated, as worded.',
    valueType: 'rule',
    effects: PROCESS_EFFECTS,
    bases: ['per_claim'],
    visibility: 'cover',
    extractionHints: ['rejection of a claim', 'repudiation', 'Claims Review Committee', 'communicated in writing', 'specific reason'],
  },
  {
    key: 'rejection_review_committee_required',
    label: 'Rejection decided by a claims review committee',
    description: 'True when the wording states rejections are decided or reviewed by a named committee (e.g. Claims Review Committee); false only if the wording expressly says otherwise.',
    valueType: 'boolean',
    effects: ['require'],
    bases: ['per_claim'],
    visibility: 'cover',
    extractionHints: ['Claims Review Committee', 'claim review committee', 'decided by the committee'],
  },
  {
    key: 'partial_settlement_explanation',
    label: 'Partial settlement breakdown',
    description: 'What the insurer must explain when it pays less than claimed (deduction per bill line, policy clause relied on), as worded.',
    valueType: 'rule',
    effects: ['inform'],
    bases: ['per_claim'],
    visibility: 'cover',
    extractionHints: ['settled for less than the amount claimed', 'list each deduction', 'deductions', 'partial settlement', 'settlement letter'],
  },
  {
    key: 'grievance_officer_contact',
    label: 'Insurer grievance officer contact',
    description: 'E-mail, phone or address the wording gives for the insurer\'s grievance redressal officer or grievance cell, as written.',
    valueType: 'text',
    effects: ['inform'],
    bases: ['not_applicable'],
    visibility: 'operational',
    extractionHints: ['Grievance Redressal Officer', 'grievance cell', 'Grievance Officer', 'customer care', 'toll free'],
  },
  {
    key: 'grievance_resolution_days',
    label: 'Insurer grievance resolution time (days)',
    description: 'Days within which the insurer states it will resolve a grievance (not the acknowledgement time).',
    valueType: 'days',
    effects: ['inform'],
    bases: ['not_applicable'],
    visibility: 'cover',
    extractionHints: ['resolve it within', 'resolved within 14 days', 'disposal of grievance', 'acknowledge the grievance'],
    validate: both(positive('Grievance days'), maxCount(365, 'Grievance days')),
  },
  {
    key: 'grievance_escalation_path',
    label: 'Grievance escalation ladder',
    description: 'Escalation steps in the order the wording gives them (e.g. insurer grievance officer, Bima Bharosa, Insurance Ombudsman, consumer forum). Include only steps the wording names.',
    valueType: 'text_list',
    effects: ['inform'],
    bases: ['not_applicable'],
    visibility: 'cover',
    extractionHints: ['Grievance Redressal', 'Bima Bharosa', 'Integrated Grievance Management System', 'Insurance Ombudsman', 'consumer forum'],
  },
  {
    key: 'ombudsman_available',
    label: 'Insurance Ombudsman named as an avenue',
    description: 'True when the wording names the Insurance Ombudsman as a complaint avenue for the insured.',
    valueType: 'boolean',
    effects: ['inform'],
    bases: ['not_applicable'],
    visibility: 'cover',
    extractionHints: ['Insurance Ombudsman', 'Insurance Ombudsman Rules, 2017', 'Ombudsman offices'],
  },
  {
    key: 'ombudsman_value_limit',
    label: 'Insurance Ombudsman value limit (as stated)',
    description: 'Maximum complaint value the Ombudsman can award, in rupees, ONLY if this document states it. Never fill from the Ombudsman Rules or general knowledge.',
    valueType: 'money',
    effects: ['cap_amount'],
    bases: ['per_claim', 'not_applicable'],
    visibility: 'cover',
    extractionHints: ['Ombudsman', 'not exceeding Rs', 'value of the claim', 'compensation up to'],
  },
  {
    key: 'ombudsman_complaint_window_days',
    label: 'Time limit to approach the Ombudsman (days, as stated)',
    description: 'Days after the insurer\'s final reply or rejection within which a complaint may be made to the Ombudsman, ONLY if this document states it. Convert "one year" to 365 days only when the wording itself says one year.',
    valueType: 'days',
    effects: ['require'],
    bases: ['per_claim', 'not_applicable'],
    visibility: 'cover',
    extractionHints: ['within one year', 'after the order of the insurer', 'complaint to the Ombudsman shall be made'],
    validate: both(positive('Window days'), maxCount(1_095, 'Window days')),
  },
  {
    key: 'consumer_forum_named',
    label: 'Consumer forum / court named as an avenue',
    description: 'True when the wording names a consumer commission, consumer forum or court as a further avenue for complaints.',
    valueType: 'boolean',
    effects: ['inform'],
    bases: ['not_applicable'],
    visibility: 'cover',
    extractionHints: ['consumer forum', 'Consumer Disputes Redressal Commission', 'Consumer Protection Act', 'court of law'],
  },
];

export default defineSection({
  number: 8,
  id: 'section-08-claims',
  title: 'Process — claims, reimbursement and grievance',
  question: 'What must be done, by when and by whom to make a reimbursement claim, get it settled, and escalate a grievance?',
  kind: 'extraction',
  expertise,
  parameters,
  reviewGuidance: [
    'Critical parameters: reimbursement_intimation_emergency_hours, reimbursement_intimation_planned_hours and reimbursement_submission_days.',
    'Check each number against the quoted clause and confirm the clock\'s starting event (admission, prior to admission, discharge).',
    'Confirm the reimbursement deadlines were not taken from the cashless clause (Section 7) and that the post-hospitalisation bill deadline was not merged into the discharge deadline.',
    'If days were converted to hours, confirm the wording itself stated the days figure.',
    'For settlement, interest, Ombudsman value limit and complaint window, confirm the figure appears in this document; reject any value that only exists in regulation or general knowledge.',
    'Check the grievance ladder lists only steps the wording names, in its order.',
  ].join(' '),
});

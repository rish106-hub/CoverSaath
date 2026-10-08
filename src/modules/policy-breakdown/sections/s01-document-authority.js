// Section 1 — Document and authority: what exactly is the contract?
// Extraction section. Identifies the contract, who decides, who administers, who services it, which
// documents make up the pack and which document wins when they disagree.

import { defineSection } from '../contracts.js';

const INFORM = Object.freeze(['inform']);
const NOT_APPLICABLE = Object.freeze(['not_applicable']);

const shortText = max => value => {
  if (value?.kind === 'text' && value.text.length > max) return `text_longer_than_${max}_characters`;
  return null;
};

const identifier = value => {
  if (value?.kind !== 'text') return null;
  const text = value.text;
  if (text.length < 4 || text.length > 60) return 'identifier_length_out_of_range';
  if (/\s{2,}/.test(text)) return 'identifier_contains_repeated_whitespace';
  if (!/[0-9]/.test(text)) return 'identifier_has_no_digits';
  return null;
};

const uin = value => {
  if (value?.kind !== 'text') return null;
  const text = value.text;
  if (/\s/.test(text)) return 'uin_must_not_contain_spaces';
  if (text.length < 8 || text.length > 50) return 'uin_length_out_of_range';
  if (!/[0-9]/.test(text) || !/[A-Za-z]/.test(text)) return 'uin_must_contain_letters_and_digits';
  return null;
};

const expertise = `
SECTION 1 — DOCUMENT AND AUTHORITY. Your job is to identify the contract itself: who the insurer is, which filed
product this is, what kind of policy it is, its identifying numbers, who administers claims, who sold and services
it, which documents make up the pack, which document wins when they disagree, and which add-ons or riders are
attached as separate contracts. You do not judge whether cover is good or bad and you give no advice.

HOW AN INDIAN HEALTH POLICY PACK IS STRUCTURED
- Policy Schedule (also "Schedule of Insurance", "Policy Certificate cum Schedule", "Certificate of Insurance" for
  group members): the personalised page(s). Usually carries the policy number, policy period, insured members,
  sum insured, plan/variant, premium and tax, intermediary details, TPA name, add-ons opted, and the product UIN.
- Policy Wording (also "Policy Terms and Conditions", "Policy Document", "Prospectus" for the sales version): the
  generic filed contract text. Contains definitions, benefits, exclusions, waiting periods, claim procedure,
  general terms and clauses (including any precedence/"entire contract" clause), grievance redressal and annexures
  (list of day-care procedures, non-payable items, ombudsman addresses).
- Customer Information Sheet (CIS): the IRDAI-mandated summary in tabular form ("Title / Description / Refer to
  Policy Clause Number"). It is easy to read but it is a summary, not the contract. It normally says that the
  policy wording prevails. If the CIS and the wording or schedule state different values for the same parameter,
  report both values as separate items, each with its own quote, and say in notes that they disagree. Never
  silently pick one.
- Endorsements: later changes (member addition/deletion, sum insured change, address change, correction). An
  endorsement has its own number and effective date and changes only what it names.
- E-card / health card / member ID card: issued by the TPA or insurer per member; carries a member ID or card
  number and the TPA helpline. Card numbers identify a member's enrolment, not the contract.
- Add-on and rider wordings: optional covers bought with the base policy (for example hospital cash, OPD,
  critical illness rider, room-rent waiver, consumables cover). Each add-on is a separate contract with its own
  name, usually its own UIN, its own premium, and often its own waiting periods, sub-limits and exclusions. Never
  merge an add-on's terms into the base product's parameters and never report an add-on's UIN as the base UIN.

WHO IS WHO
- Insurer: the company that underwrites and pays ("Example ... Insurance Company Limited", "the Company", "We/Us/
  Our"). Look for the registered name with "Limited"/"Ltd.", the IRDAI registration number and the CIN. A
  standalone health insurer and a general insurer both count. Report the full legal name as written, not a brand
  shortening, unless only the brand appears.
- TPA (Third Party Administrator): a separate IRDAI-licensed company that administers cashless and claims on the
  insurer's behalf ("TPA", "Third Party Administrator", "Health Services Provider", "claims administered by").
  Some insurers handle claims in-house ("in-house claims settlement", "our own claims team"); then tpa_name is
  found=false unless a TPA is named. The TPA is never the insurer.
- Intermediary of record: the agent, broker, corporate agent (often a bank), web aggregator, point-of-sales
  person, insurance marketing firm, or the employer/HR for a group policy, shown as "Intermediary Name",
  "Agent/Broker Name", "Intermediary Code", "Channel", "Sourced by". "Direct" or "Direct Business" means no
  intermediary; report intermediary_type insurer_direct with that quote.
- Group administrator / policyholder: for a group policy the employer, association or bank is the master
  policyholder and the member gets a certificate. For an individual or family floater the proposer is the
  policyholder.

PRODUCT UIN
- The Unique Identification Number assigned to the filed product. Current IRDAI health UINs look like a run of
  letters and digits with a version marker, for example a three-letter insurer code, a line code such as HL, a
  product code, the year, a serial number, then "V" and version digits. Older products may use a slash-separated
  "IRDAI/HLT/..." style. Copy it exactly as printed, character by character; do not correct, reformat or complete
  it. Where a version is separately stated ("Version 1", "V01") report it in product_version. Do not decode the
  UIN to infer the version, year or insurer — only report what the text states.

POLICY TYPE (choose from the enum strictly from what the document states)
- individual: each insured has their own sum insured ("Individual Sum Insured", "Individual Basis").
- family_floater: one sum insured shared by all members ("Family Floater", "Floater Sum Insured").
- group: employer/association master policy, member certificates ("Group Health Insurance", "Group Mediclaim").
- top_up: pays above a per-claim deductible/threshold. super_top_up: pays above an aggregate deductible across
  the policy year. Read the threshold wording: "per claim" vs "aggregate of all claims in a policy year".
- critical_illness or fixed_benefit: pays a lump sum or a fixed amount on diagnosis/event, not the bill
  (benefit-based vs indemnity). other: government scheme or anything that does not fit.
- Trap: "Family Health Plan" in a product name does not by itself mean floater; the schedule's "Sum Insured Type"
  or "Cover Type" line decides. A floater can be bought under an individual-category product. If the schedule and
  CIS disagree, report both.

DOCUMENT PRECEDENCE
- Look for clauses titled "Entire Contract", "Construction", "Policy Documents", "Order of Precedence",
  "Conflict", or phrases like "in case of any conflict ... the Schedule shall prevail", "the English version shall
  prevail", "the terms of the Policy shall prevail over the Prospectus / CIS", "Endorsement shall prevail".
  Report document_precedence as a rule: valueText summarises the ordering in plain words, conditions list each
  ordering pair as stated. If no such clause exists, found=false; do not assume a default order.

DOCUMENT SET AND ENDORSEMENTS
- document_set lists the documents the text says form the contract ("The proposal form, the Schedule, the Policy
  wording and any Endorsements shall be read together as one contract"). Use the document names as written.
  It records what the text REFERS to. A referenced wording or proposal form is often not in the upload.
- documents_present_in_pack lists only documents actually contained in this pack. Prove each one by quoting
  its own title or heading line. Never list a document only because another document names it.
- endorsement_list lists endorsements actually issued and shown in this pack (number, date, short description).
  An endorsement clause that only says endorsements may be issued is not an issued endorsement.

GENERAL RULES
- Quote verbatim from the page text, exactly as written, including spelling and spacing. One short quote that
  proves the value is best. Never paraphrase inside a quote.
- Never infer from general knowledge, regulation, the insurer's other products, or what policies "usually" say.
  Never fill a value from another policy, a previous year's policy or an add-on.
- Report each distinct value once. If two documents in the pack state different values for the same key, report
  each distinct value as its own item with its own quote; that is a conflict, not a duplicate.
- Use memberScope with the member's name when a value applies to a named member only (for example an e-card or
  member ID). Leave memberScope null for policy-level values.
- Answer found=false with all values null when the pack does not state the parameter. A blank field, "NA", "-" or
  "Not Applicable" next to a label is found=false for that parameter (except "Direct" for intermediary, see
  above). Do not guess a TPA from a helpline number, and do not guess a policy type from the product name.
- Numbers such as policy numbers, certificate numbers, card numbers and UINs are copied exactly; never round,
  pad or reformat them.
`.trim();

export default defineSection({
  number: 1,
  id: 'section-01-document-authority',
  title: 'Document and authority',
  question: 'What exactly is the contract: which insurer, product, policy type and documents, who administers it and which document wins?',
  kind: 'extraction',
  expertise,
  parameters: [
    {
      key: 'insurer_name',
      label: 'Insurer',
      description: 'Full legal name of the insurance company that underwrites and pays under this policy, as printed (e.g. "... Insurance Company Limited"). Not the TPA, broker, bank or employer.',
      valueType: 'text',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      critical: true,
      visibility: 'cover',
      extractionHints: ['Issued by', 'the Company', 'Insurance Company Limited', 'IRDAI Reg. No.', 'CIN', 'registered office'],
      emergencyCard: true,
      validate: shortText(200),
    },
    {
      key: 'insurer_registration_number',
      label: 'Insurer IRDAI registration number',
      description: 'The insurer\'s IRDAI registration number as printed (e.g. "IRDAI Reg. No. 999"). Text, copied exactly.',
      valueType: 'text',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'cover',
      extractionHints: ['IRDAI Reg. No.', 'IRDA Registration No.', 'Registration Number'],
      validate: shortText(60),
    },
    {
      key: 'product_name',
      label: 'Product name',
      description: 'Name of the filed base product (and plan/variant if printed with it). Not the name of an add-on or rider.',
      valueType: 'text',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'cover',
      extractionHints: ['Product Name', 'Plan Name', 'Name of the Product', 'Policy Name'],
      validate: shortText(200),
    },
    {
      key: 'product_uin',
      label: 'Product UIN',
      description: 'Unique Identification Number of the base product as filed with IRDAI, copied character for character. Add-on and rider UINs are not this value.',
      valueType: 'text',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'cover',
      extractionHints: ['UIN', 'Unique Identification Number', 'Product UIN', 'UIN No.'],
      validate: uin,
    },
    {
      key: 'product_version',
      label: 'Product version',
      description: 'Version of the product wording when separately stated (e.g. "Version 01", "V.1"). Do not decode from the UIN.',
      valueType: 'text',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'cover',
      extractionHints: ['Version', 'Ver.', 'Policy Wording Version'],
      validate: shortText(40),
    },
    {
      key: 'policy_type',
      label: 'Policy type',
      description: 'Structural type of the policy as stated: individual, family floater, group, top-up (per-claim threshold), super top-up (aggregate threshold), critical illness, fixed benefit, or other (e.g. government scheme). Decided by the schedule/CIS cover-type wording, not the product name.',
      valueType: 'enum',
      enumValues: ['individual', 'family_floater', 'group', 'top_up', 'super_top_up', 'critical_illness', 'fixed_benefit', 'other'],
      effects: INFORM,
      bases: NOT_APPLICABLE,
      critical: true,
      visibility: 'cover',
      extractionHints: ['Policy Type', 'Cover Type', 'Sum Insured Type', 'Family Floater', 'Individual basis', 'Type of Policy'],
      emergencyCard: true,
      estimateInput: true,
    },
    {
      key: 'policy_number',
      label: 'Policy number',
      description: 'The policy (contract) number exactly as printed on the schedule. Not a certificate, proposal, receipt, member ID or endorsement number.',
      valueType: 'text',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      critical: true,
      visibility: 'operational',
      extractionHints: ['Policy No.', 'Policy Number', 'Master Policy Number'],
      emergencyCard: true,
      validate: identifier,
    },
    {
      key: 'previous_policy_number',
      label: 'Previous policy number',
      description: 'Expiring/previous policy number printed on a renewal schedule, as written. Supports continuity checks; not the current policy number.',
      valueType: 'text',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'operational',
      extractionHints: ['Previous Policy No.', 'Expiring Policy Number', 'Renewal of Policy No.'],
      validate: identifier,
    },
    {
      key: 'certificate_number',
      label: 'Certificate number',
      description: 'Member certificate number under a group or master policy, as printed. Found only where a certificate is issued.',
      valueType: 'text',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'operational',
      extractionHints: ['Certificate No.', 'Certificate of Insurance Number', 'COI Number'],
      validate: identifier,
    },
    {
      key: 'member_id_numbers',
      label: 'Member ID / e-card number',
      description: 'Member ID, health card or e-card number for one named insured member; one item per member with memberScope set to that member\'s name. valueText holds the ID exactly as printed.',
      valueType: 'text',
      effects: INFORM,
      bases: ['per_person'],
      visibility: 'operational',
      memberScoped: true,
      extractionHints: ['Member ID', 'Card No.', 'E-card No.', 'Health Card Number', 'TPA ID', 'Customer ID'],
      emergencyCard: true,
      validate: identifier,
    },
    {
      key: 'policyholder_name',
      label: 'Policyholder / proposer',
      description: 'Name of the policyholder: the proposer for individual and floater policies, the master policyholder (employer, bank, association) for group policies, as printed.',
      valueType: 'text',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'operational',
      extractionHints: ['Proposer Name', 'Policyholder', 'Name of the Insured', 'Master Policyholder', 'Insured Name'],
      validate: shortText(200),
    },
    {
      key: 'group_administrator_name',
      label: 'Group administrator',
      description: 'Employer, association or other administrator that runs a group policy on behalf of members (enrolment, endorsements, servicing). found=false for individual and floater policies that name none.',
      valueType: 'text',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'operational',
      extractionHints: ['Group Administrator', 'Master Policyholder', 'Employer', 'Group Name', 'HR contact'],
      validate: shortText(200),
    },
    {
      key: 'tpa_name',
      label: 'TPA',
      description: 'Name of the Third Party Administrator that services cashless and claims, as printed. found=false when claims are handled in-house and no TPA is named. Never the insurer.',
      valueType: 'text',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'cover',
      extractionHints: ['TPA', 'Third Party Administrator', 'TPA Name', 'Health Services Provider', 'claims administered by'],
      emergencyCard: true,
      validate: shortText(200),
    },
    {
      key: 'intermediary_name',
      label: 'Intermediary of record',
      description: 'Agent, broker, corporate agent (e.g. bank), web aggregator or employer through which the policy was sourced and which must service it, as printed. For direct business report the word printed (e.g. "Direct").',
      valueType: 'text',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'operational',
      extractionHints: ['Intermediary Name', 'Agent Name', 'Broker Name', 'Corporate Agent', 'Channel', 'Sourced by'],
      validate: shortText(200),
    },
    {
      key: 'intermediary_type',
      label: 'Intermediary type',
      description: 'Category of the intermediary of record as stated in the document.',
      valueType: 'enum',
      enumValues: ['individual_agent', 'corporate_agent', 'broker', 'web_aggregator', 'insurance_marketing_firm', 'point_of_sales', 'employer', 'insurer_direct', 'other'],
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'operational',
      extractionHints: ['Intermediary Type', 'Corporate Agent (Banca)', 'Broker', 'Agent', 'Direct Business', 'POSP'],
    },
    {
      key: 'intermediary_code',
      label: 'Intermediary licence/code',
      description: 'Intermediary code or IRDAI licence number of the intermediary of record, exactly as printed.',
      valueType: 'text',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'operational',
      extractionHints: ['Intermediary Code', 'Agent Code', 'Licence No.', 'Broker Code', 'CA Code'],
      validate: shortText(80),
    },
    {
      key: 'document_set',
      label: 'Documents the contract refers to',
      description: 'Names of the documents that the text says together form the contract (e.g. proposal form, schedule, policy wording, endorsements, CIS, prospectus), as named in the pack. This is what the text REFERS to; it does not mean those documents are in the uploaded pack. Use documents_present_in_pack for that.',
      valueType: 'text_list',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'cover',
      extractionHints: ['Entire Contract', 'shall be read together', 'Policy Documents', 'form part of this Policy'],
    },
    {
      key: 'documents_present_in_pack',
      label: 'Documents present in the upload',
      description: 'Documents actually contained in the uploaded pack, one item per document, each proven by quoting its own title or heading line (e.g. "Policy Schedule", "Customer Information Sheet"). A document only named or referred to by another document is not present.',
      valueType: 'text_list',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'cover',
      extractionHints: ['Policy Schedule', 'Customer Information Sheet', 'Policy Wording', 'Endorsement', 'Proposal Form', 'Policy Certificate'],
    },
    {
      key: 'document_issue_date',
      label: 'Document issue date',
      description: 'Date the schedule (or the governing document in the pack) was issued/generated, as ISO yyyy-mm-dd. Not the policy start date.',
      valueType: 'date',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'operational',
      extractionHints: ['Date of Issue', 'Issue Date', 'Generated on', 'Issued on'],
    },
    {
      key: 'cis_present',
      label: 'Customer Information Sheet in pack',
      description: 'true when the pack contains a Customer Information Sheet (CIS). Only report true with a quote from the CIS heading; report false only if the text explicitly states no CIS; otherwise found=false.',
      valueType: 'boolean',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'cover',
      extractionHints: ['Customer Information Sheet', 'CIS', 'Description is illustrative and not exhaustive'],
    },
    {
      key: 'cis_precedence_statement',
      label: 'CIS precedence statement',
      description: 'The statement in the CIS or wording about how the CIS relates to the policy wording (e.g. that the wording prevails in case of dispute).',
      valueType: 'rule',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'cover',
      extractionHints: ['In case of dispute, English version of Policy bond shall be final', 'policy wording shall prevail', 'CIS is a summary'],
    },
    {
      key: 'document_precedence',
      label: 'Document precedence',
      description: 'Rule stating which document prevails when schedule, wording, endorsements, CIS, prospectus or translations disagree. valueText summarises the order; conditions list each stated ordering. found=false if no such clause.',
      valueType: 'rule',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'cover',
      extractionHints: ['in case of any conflict', 'shall prevail', 'Order of Precedence', 'Construction', 'Entire Contract', 'Endorsement shall prevail'],
    },
    {
      key: 'endorsement_list',
      label: 'Endorsements issued',
      description: 'Endorsements actually issued and present in the pack: number, effective date and short description each. A clause that merely allows endorsements is not an issued endorsement.',
      valueType: 'text_list',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'cover',
      extractionHints: ['Endorsement No.', 'Endorsement Schedule', 'Endorsement effective from', 'Nil Endorsement'],
    },
    {
      key: 'add_on_covers',
      label: 'Add-ons and riders',
      description: 'Names of each optional add-on or rider attached to this policy, one item each, as named (include its UIN in the item if printed beside it). Base product benefits are not add-ons.',
      valueType: 'text_list',
      effects: INFORM,
      bases: NOT_APPLICABLE,
      visibility: 'cover',
      extractionHints: ['Add-on', 'Optional Cover', 'Rider', 'Add-on Covers Opted', 'Optional Benefits'],
    },
    {
      key: 'add_on_terms',
      label: 'Add-on separate terms',
      description: 'Rule capturing what the text says about add-ons being separate contracts: own premium, own term, own waiting period, own exclusions, or that base exclusions apply. One item per add-on where terms differ; conditions list each stated term.',
      valueType: 'rule',
      effects: ['inform', 'wait_until', 'exclude', 'require'],
      bases: ['per_policy', 'per_policy_year', 'not_applicable'],
      visibility: 'cover',
      extractionHints: ['Add-on wording', 'shall be governed by', 'waiting period for this Add-on', 'base policy terms apply'],
    },
  ],
  reviewGuidance: `
Check against the schedule page itself, not the CIS or a broker summary:
- insurer_name is the underwriting company (with "Limited"), not the TPA, the bank/broker or the employer.
- policy_number matches the schedule character for character; it is not the proposal, receipt, certificate,
  member ID or endorsement number. Prefer the latest schedule/endorsement in the pack.
- policy_type is taken from the schedule's cover-type / sum-insured-type line. Floater vs individual changes how
  much money each member can use; top-up vs super top-up changes when the policy starts paying. If the CIS
  disagrees with the schedule, keep both and mark Conflicting.
- product_uin belongs to the base product, not an add-on; copy exactly.
- Confirm add-ons are listed separately and their terms were not merged into base parameters.
- Note source quality (original insurer PDF, portal export, screenshot, forwarded copy) and the issue date;
  a screenshot or forward lowers confidence for every parameter in the pack.
`.trim(),
});

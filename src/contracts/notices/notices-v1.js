// Itemised privacy notices, version 1 (DPDP Act 2023 s5; ADR 0018). One notice per processing purpose, each listing the
// data it covers, why, who else receives it, how long it is kept and how to withdraw.
//
// FOR LEGAL REVIEW: every word in this file is draft engineering text. It is not final consent, privacy or legal wording
// and must not be shown to a real person until counsel has approved it and `legalReview` is changed by a reviewed commit.
// Retention periods are not decided (docs/adr/0018-privacy-risk-acceptance.md, Q1); notices say "until you withdraw or the
// household is closed, then removed on the schedule in the retention policy" and carry no number.
//
// `items[].categories` must match the personal-data categories the purpose registry
// (src/contracts/data-purposes.js) records for that purpose; tests/data-purposes.test.mjs enforces it, so a notice cannot
// drift from what is stored. No personal data lives in this file.

export const NOTICE_LANGUAGE = 'en-IN';

const dependentNote = 'If the person this concerns is a child or cannot decide for themselves, a parent or lawful guardian gives or withdraws permission for them.';
const withdrawNote = 'You can withdraw permission at any time. Withdrawing is as easy as giving it, and we then stop and erase the related stored data.';

export const NOTICES_V1 = Object.freeze([
  {
    id: 'notice_account_access',
    purposeId: 'account_access',
    title: 'Your account and sign-in',
    summary: 'We keep the details needed to recognise you and keep your household private.',
    items: [
      { categories: ['identity'], data: 'Your name and your household name', use: 'To show you your own household and address you correctly.' },
      { categories: ['contact', 'derived_identifier'], data: 'Your email address and phone number, and a scrambled fingerprint of each', use: 'To sign you in and to recognise you if you come back, without storing the same contact twice.' },
      { categories: ['credential_hash', 'derived_identifier'], data: 'A fingerprint of your sign-in token, of your sign-in provider identity and of any one-time sign-in code, and the public part of any passkey you add', use: 'To check it is you on each request. We never keep the token itself.' },
      { categories: ['behavioural'], data: 'A scrambled fingerprint of your browser type and of your network address for each sign-in session', use: 'To notice a stolen sign-in and to limit repeated sign-in attempts. Never your name or contact.' },
      { categories: ['free_text'], data: 'The names you give to your devices and passkeys (stored sealed)', use: 'To let you tell your devices apart and remove one you no longer use.' },
      { categories: ['preference'], data: 'Your language setting', use: 'To show the service in the language you chose.' },
      { categories: ['relationship'], data: 'Your role in the household (for example owner or member)', use: 'To decide who in the household may see or change what.' },
    ],
    recipients: ['Our hosting and database providers, who store it for us and may not use it for any other purpose.'],
    retention: 'Until you close your account, then removed on the retention schedule.',
    withdrawal: 'Close your account to have this removed.',
    guardianNote: null,
  },
  {
    id: 'notice_profile_intake',
    purposeId: 'profile_intake',
    title: 'Your household profile',
    summary: 'We keep what you tell us about the people your insurance covers.',
    items: [
      { categories: ['identity', 'demographic'], data: 'Name and date of birth of each household member', use: 'To work out who is covered, and the age-based rules that apply to them.' },
      { categories: ['relationship'], data: 'How each member is related to you, and whether the member is an adult or a dependant', use: 'To match cover to the right person and to know who must give permission.' },
      { categories: ['profile_answer'], data: 'Your answers to profile questions (who is covered, city and state, renewal month, which policies you have)', use: 'To tailor the questions and checks we show you.' },
      { categories: ['contact', 'derived_identifier'], data: 'Mobile number, email address and preferred contact channel of a household member', use: 'To reach the right person about their cover. FOR LEGAL REVIEW.' },
      { categories: ['health_or_policy_content'], data: 'Health context, nominees, emergency contacts, advisers and notes you choose to add about a person', use: 'To keep the cover picture complete. Withdrawing permission erases them. FOR LEGAL REVIEW.' },
      { categories: ['financial'], data: 'Premiums you paid or owe on each policy, the dates, and who you paid through (FOR LEGAL REVIEW)', use: 'To show what you pay, remind you of due dates and help you plan. We do not use them for anything else.' },
      { categories: ['preference'], data: 'Your settings and how far you got through set-up', use: 'To remember your choices and not ask twice.' },
    ],
    recipients: ['Our hosting and database providers, as above.'],
    retention: 'Until you withdraw or the household is closed, then removed on the retention schedule.',
    withdrawal: withdrawNote,
    guardianNote: dependentNote,
  },
  {
    id: 'notice_affordability_planning',
    purposeId: 'affordability_planning',
    title: 'Your what-if scenarios',
    summary: 'We save the figures you type into planning tools so you can come back to them.',
    items: [
      { categories: ['financial'], data: 'Amounts you enter in tools such as the tax, premium rise and hospital bill calculators', use: 'To redo the calculation and show you the result later. We do not use them for anything else.' },
    ],
    recipients: ['Our hosting and database providers, as above.'],
    retention: 'Until you delete the scenario, withdraw, or the household is closed, then removed on the retention schedule.',
    withdrawal: withdrawNote,
    guardianNote: dependentNote,
  },
  {
    id: 'notice_device_and_location',
    purposeId: 'device_and_location',
    title: 'Device permissions and places',
    summary: 'We only use your device features or location if you say yes, and you can say no and still use the service.',
    items: [
      { categories: ['preference'], data: 'Whether you allowed or refused each device permission (location, notifications, contacts and so on)', use: 'To respect your choice and not ask again too soon.' },
      { categories: ['location'], data: 'Addresses and places you save, and your current location if you share it', use: 'To find hospitals and services near you. Current location is kept only for a short time.' },
    ],
    recipients: ['Our hosting and database providers, as above.'],
    retention: 'Current location for a short time only; saved places until you remove them or the household is closed.',
    withdrawal: withdrawNote,
    guardianNote: dependentNote,
  },
  {
    id: 'notice_document_processing',
    purposeId: 'document_processing',
    title: 'Your uploaded documents',
    summary: 'We store the policy papers you upload and read them to find the facts in them.',
    items: [
      { categories: ['free_text', 'derived_digest'], data: 'The file name and a fingerprint of each uploaded file', use: 'To list your documents and spot a repeated upload.' },
      { categories: ['health_or_policy_content'], data: 'The file itself, in locked form, and the text read from each page', use: 'To read your policy and show you what it says, with the page it came from.' },
    ],
    recipients: [
      'A text-reading (OCR) provider that reads your pages for us.',
      'Our hosting and storage providers, who hold the locked file.',
    ],
    retention: 'Until you withdraw or the document is deleted, then removed on the retention schedule.',
    withdrawal: withdrawNote,
    guardianNote: dependentNote,
  },
  {
    id: 'notice_coverage_reconstruction',
    purposeId: 'coverage_reconstruction',
    title: 'Working out what your cover includes',
    summary: 'We turn your documents and answers into a record of what each policy covers, for each person.',
    items: [
      { categories: ['insurance_policy'], data: 'Policy details such as a masked policy number, start and end dates, and who is covered', use: 'To tell your policies apart and match them to people.' },
      { categories: ['health_or_policy_content', 'derived_content'], data: 'Facts and clauses taken from your documents, the notes and results of each check we run, and what you told us', use: 'To build your coverage picture. Anything unclear stays marked as unknown, never guessed.' },
      { categories: ['financial'], data: 'The cost estimate you give for a planned hospital stay', use: 'To compare it with what your cover would pay.' },
      { categories: ['free_text', 'derived_digest'], data: 'Error notes and fingerprints that tie a result to the exact input it was made from', use: 'To keep results traceable and repeatable.' },
    ],
    recipients: ['Our hosting and database providers, as above.'],
    retention: 'Until you withdraw or your permission ends, then erased.',
    withdrawal: withdrawNote,
    guardianNote: dependentNote,
  },
  {
    id: 'notice_ai_assisted_analysis',
    purposeId: 'ai_assisted_analysis',
    title: 'Help from an AI model',
    summary: 'With your permission we send short excerpts of your policy to an AI model to suggest facts and answer your questions. The AI only suggests; fixed rules decide.',
    items: [
      { categories: ['free_text'], data: 'Questions you ask about your policy', use: 'To answer them from your policy text.' },
      { categories: ['health_or_policy_content', 'derived_digest'], data: 'Excerpts of policy text sent to the AI model, and the suggestions that come back', use: 'To suggest values for you to check. Suggestions are labelled as unverified until a person confirms them.' },
    ],
    recipients: [
      'Google (Gemini), an AI model provider, which receives the excerpts. It may process them outside India; where the provider runs is not yet decided.',
    ],
    retention: 'Excerpts we store are erased when your permission is withdrawn or ends. How long the provider keeps them is set by its terms and is not yet confirmed.',
    withdrawal: withdrawNote,
    guardianNote: dependentNote,
  },
  {
    id: 'notice_human_review',
    purposeId: 'human_review',
    title: 'Review by a person',
    summary: 'A trained reviewer may check a result before it is shown as confirmed.',
    items: [
      { categories: ['free_text', 'health_or_policy_content', 'derived_digest'], data: 'The reviewer\'s notes, the fact they checked and a fingerprint of what they approved', use: 'To record who confirmed what, so a confirmed result can be trusted.' },
    ],
    recipients: ['Our reviewers, who see only what the review needs.'],
    retention: 'Until you withdraw or your permission ends, then erased; the record that a review happened is kept as an audit record.',
    withdrawal: withdrawNote,
    guardianNote: dependentNote,
  },
  {
    id: 'notice_consent_and_audit_record',
    purposeId: 'consent_and_audit_record',
    title: 'Records of your permissions and our actions',
    summary: 'We keep a tamper-evident record of what you allowed, what you withdrew and what we did, so you and we can show it later.',
    items: [
      { categories: ['free_text'], data: 'The reason you give when you withdraw a permission', use: 'To record the withdrawal.' },
      { categories: ['derived_content'], data: 'Counts, codes and fingerprints describing actions taken on your data (never the content itself)', use: 'To prove what happened and when, and to investigate a problem.' },
    ],
    recipients: ['Our hosting and database providers, as above.'],
    retention: 'For the period the law requires. That period is not yet decided.',
    withdrawal: 'These records are what proves your withdrawal happened, so they are kept after you withdraw; they hold no document content.',
    guardianNote: dependentNote,
  },
  {
    id: 'notice_analytics',
    purposeId: 'analytics',
    title: 'Understanding how the service is used',
    summary: 'With your permission we count which steps people use, to improve the service. We send short event records to our analytics provider. They never hold names, policy numbers, amounts or anything you type.',
    items: [
      { categories: ['derived_identifier'], data: 'A scrambled fingerprint of your household, so events from one household can be counted together without showing who it is', use: 'To count how many households use each step.' },
      { categories: ['derived_content'], data: 'The name of a step (for example "cover uploaded") and a few fixed words or small counts about it, such as the kind of document or how many facts were read', use: 'To see which steps work and which fail.' },
    ],
    recipients: ['PostHog, our analytics provider. Where it processes the records is not yet decided.'],
    retention: 'Records waiting to be sent are erased when your permission is withdrawn or ends. How long the provider keeps what it received is set by its terms and is not yet confirmed.',
    withdrawal: withdrawNote,
    guardianNote: null,
  },
  {
    id: 'notice_service_operations',
    purposeId: 'service_operations',
    title: 'Keeping the service safe and working',
    summary: 'We keep short-lived technical records to stop abuse, find faults and avoid doing the same request twice.',
    items: [
      { categories: ['behavioural'], data: 'Which feature was used, when and how it ended, and a scrambled fingerprint of your network address', use: 'To spot faults and abuse and to limit request rates. Never your name or contact.' },
      { categories: ['derived_content', 'derived_digest', 'derived_identifier'], data: 'A saved copy of the answer to a request, a fingerprint of the request and a scrambled fingerprint of the document it concerned', use: 'So that a retry after a network drop gives the same answer.' },
    ],
    recipients: ['Our hosting and database providers, as above.'],
    retention: 'A short period measured in days, then removed automatically.',
    withdrawal: 'These records are needed to run the service safely and are not optional; they expire on their own.',
    guardianNote: null,
  },
]);

export const NOTICE_SET_VERSION = 1;
// Set to 'approved' only by a reviewed commit that records who approved it. Nothing here is approved.
export const NOTICE_LEGAL_REVIEW_STATUS = 'pending';

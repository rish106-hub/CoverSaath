// Synthetic evidence framework for the Block 3 scenario matrix. Every insurer, product, UIN, policy number, member and
// date below is invented; nothing is copied from a real policy. Each PDF page prints SYNTHETIC_BANNER.
//
// The PDFs are real bytes built with pdf-lib, and byte-for-byte deterministic (fixed metadata and dates, no object
// streams). `pageTexts` are the exact lines this generator DREW on each page, supplied by the generator. They are NOT
// extracted from the PDF: creating a synthetic PDF proves nothing about extracting text from real insurer PDFs.
//
// The manifest (SCENARIOS) is pure data: documents, the fact batches fed to the catalogue, and the outputs the CURRENT
// code is expected to produce. Policy ids written 'P1'/'P2' are symbolic: when a policy names an `anchor` document,
// the matrix test replaces the key with the logical id that associateDocuments derives for that document.
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';

export const SYNTHETIC_BANNER = 'SYNTHETIC TEST DATA - NOT A REAL POLICY';
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// ---- Fictional identities ------------------------------------------------------------------------------------------
export const UINS = Object.freeze({
  shield: 'SYNTHHLIP26001V012526', // Synthetic Assurance Ltd - Synthetic Health Shield
  topUp: 'SYNTHHLIP26007V012526', // Synthetic Assurance Ltd - Synthetic Super Top-Up
  family: 'FICTHLIP25014V022425', // Fictional General Insurance Co - Fictional Family Care
  group: 'IMAGHGP26003V012526', // Imaginary Mutual Health Ltd - group mediclaim
  absent: 'SYNTHHLIP26099V012526', // printed nowhere: used for the wrong-UIN check
});
export const POLICY_NUMBERS = Object.freeze({
  shield: 'SYN/HS/2026/000101',
  topUp: 'SYN/TU/2026/000202',
  topUpNoDeductible: 'SYN/TU/2026/000303',
  individualB: 'FGI-FC-2025-778812',
  floater: 'FGI-FF-2026-889900',
  group: 'IMH/GRP/2026/4455',
});
export const WORDING_VERSIONS = Object.freeze({ '1': 'SHS-W-2026.1', '2': 'SHS-W-2026.2' });

// ---- Document templates: pages of lines (banner added by the generator) --------------------------------------------
const wording = version => [
  [
    'Synthetic Assurance Ltd - Synthetic Health Shield - Policy Wording',
    `UIN: ${UINS.shield}`,
    `Wording version: ${WORDING_VERSIONS[version]}`,
    'Section 1.1 In-patient hospitalisation expenses are covered up to the sum insured.',
    'Section 1.2 Room rent: as specified in the Policy Schedule.',
    'Section 1.3 ICU charges: at actuals.',
    'Section 1.4 Co-payment: 20% of every admissible claim.',
  ],
  [
    'Section 3.1 Initial waiting period: 30 days from the first policy start date, except accidents.',
    `Section 3.2 Pre-existing diseases: waiting period of ${version === '1' ? 48 : 36} months of continuous coverage.`,
    'Section 3.3 Specified diseases: waiting period of 24 months (cataract, hernia, joint replacement).',
    'Section 4.1 Permanent exclusion: cosmetic or plastic surgery, except reconstruction following an accident.',
    'Section 4.2 Permanent exclusion: treatment taken outside India.',
  ],
  [
    'Section 5.1 Restoration: 100% of the sum insured, once per policy year, for an unrelated illness.',
    'Section 5.2 No-claim bonus: 10% of the sum insured for each claim-free year, up to 50%.',
    ...(version === '1' ? ['Section 5.3 Cataract: Rs 40,000 per eye.'] : []),
    'Section 6.1 Grievances: contact the insurer grievance cell within 30 days.',
  ],
];

export const TEMPLATES = Object.freeze({
  scheduleA: {
    sourceType: 'issued_schedule', title: 'Synthetic Health Shield - Policy Schedule', policyNumbers: [POLICY_NUMBERS.shield], uins: [UINS.shield],
    pages: () => [[
      'Synthetic Assurance Ltd',
      'Policy Schedule - Synthetic Health Shield (Individual)',
      `Policy Number: ${POLICY_NUMBERS.shield}`,
      `UIN: ${UINS.shield}`,
      'Policy Period: 2026-04-01 to 2027-03-31',
      'Insured Member: Member A (Self), age 34',
      'Sum Insured: Rs 5,00,000',
      'Room rent: Rs 5,000 per day',
      'ICU charges: at actuals',
      'Co-payment: 10% of every admissible claim',
      'Add-on Maternity Cover: Not Opted',
      'Add-on Critical Illness Rider: Not Opted',
      'Previous insurance: none declared',
    ]],
  },
  scheduleAReissue: {
    sourceType: 'issued_schedule', title: 'Synthetic Health Shield - Reissued Schedule', policyNumbers: [POLICY_NUMBERS.shield], uins: [UINS.shield],
    pages: () => [[
      'Synthetic Assurance Ltd',
      'Duplicate Policy Schedule (reissued) - Synthetic Health Shield',
      `Policy Number: ${POLICY_NUMBERS.shield}`,
      `UIN: ${UINS.shield}`,
      'Co-payment: 15% of every admissible claim',
    ]],
  },
  wordingA: { sourceType: 'policy_wording', title: 'Synthetic Health Shield - Policy Wording', policyNumbers: [], uins: [UINS.shield], pages: wording },
  endorsementA: {
    sourceType: 'endorsement', title: 'Synthetic Health Shield - Endorsement 1', policyNumbers: [POLICY_NUMBERS.shield], uins: [],
    pages: () => [[
      'Synthetic Assurance Ltd - Endorsement No. 1',
      `Policy Number: ${POLICY_NUMBERS.shield}`,
      'Effective from: 2026-07-01',
      'Room rent limit revised to Rs 7,000 per day.',
      'All other terms remain unchanged.',
    ]],
  },
  staleEndorsementA: {
    sourceType: 'endorsement', title: 'Synthetic Health Shield - Endorsement 0', policyNumbers: [POLICY_NUMBERS.shield], uins: [],
    pages: () => [[
      'Synthetic Assurance Ltd - Endorsement No. 0 (previous policy year)',
      `Policy Number: ${POLICY_NUMBERS.shield}`,
      'Effective: 2025-04-01 to 2026-03-31',
      'Room rent limit: Rs 4,000 per day.',
    ]],
  },
  renewalHistoryA: {
    sourceType: 'issued_schedule', title: 'Synthetic Health Shield - Renewal History', policyNumbers: [POLICY_NUMBERS.shield], uins: [],
    pages: () => [[
      'Synthetic Assurance Ltd - Renewal history',
      `Policy Number: ${POLICY_NUMBERS.shield}`,
      'Cover held 2021-04-01 to 2023-03-31.',
      'Break in cover 2023-04-01 to 2023-05-14 (renewal premium not received).',
      'Renewed 2023-05-15 and continuous since then.',
    ]],
  },
  scheduleB: {
    sourceType: 'issued_schedule', title: 'Fictional Family Care - Policy Schedule', policyNumbers: [POLICY_NUMBERS.individualB], uins: [UINS.family],
    pages: () => [[
      'Fictional General Insurance Co',
      'Policy Schedule - Fictional Family Care (Individual)',
      `Policy Number: ${POLICY_NUMBERS.individualB}`,
      `UIN: ${UINS.family}`,
      'Policy Period: 2025-11-01 to 2026-10-31',
      'Insured Member: Member B (Self), age 41',
      'Sum Insured: Rs 3,00,000',
      'Room rent: 3000 per day',
    ]],
  },
  floaterSchedule: {
    sourceType: 'issued_schedule', title: 'Fictional Family Care - Floater Schedule', policyNumbers: [POLICY_NUMBERS.floater], uins: [UINS.family],
    pages: () => [[
      'Fictional General Insurance Co',
      'Policy Schedule - Fictional Family Care (Family Floater)',
      `Policy Number: ${POLICY_NUMBERS.floater}`,
      `UIN: ${UINS.family}`,
      'Policy Period: 2026-02-01 to 2027-01-31',
      'Insured members: Member A (Self, 40), Member B (Spouse, 62), Member C (Child, 9)',
      'Floater Sum Insured: Rs 10,00,000 shared by all insured members',
      'Room rent for Member A and Member C: Rs 6,000 per day',
      'Room rent for Member B: Rs 4,000 per day',
      'Co-payment: 10% of every admissible claim',
      'Co-payment for Member B: 20% of every admissible claim',
    ]],
  },
  groupCertificate: {
    sourceType: 'certificate_of_insurance', title: 'Imaginary Mutual - Group Certificate', policyNumbers: [POLICY_NUMBERS.group], uins: [UINS.group],
    pages: () => [[
      'Imaginary Mutual Health Ltd',
      'Group Health Certificate of Insurance',
      `Master Policy Number: ${POLICY_NUMBERS.group}`,
      `UIN: ${UINS.group}`,
      'Policyholder: Imaginary Employer Pvt Ltd',
      'Certificate period: 2026-01-01 to 2026-12-31',
      'Covered members: Member A (Employee), Member B (Spouse)',
      'Family floater sum insured: Rs 3,00,000',
      'Room rent: 1% of sum insured per day',
      'Pre-existing diseases waiting period: waived (cover from day one)',
    ]],
  },
  topUpSchedule: {
    sourceType: 'issued_schedule', title: 'Synthetic Super Top-Up - Policy Schedule', policyNumbers: [POLICY_NUMBERS.topUp], uins: [UINS.topUp],
    pages: () => [[
      'Synthetic Assurance Ltd',
      'Policy Schedule - Synthetic Super Top-Up',
      `Policy Number: ${POLICY_NUMBERS.topUp}`,
      `UIN: ${UINS.topUp}`,
      'Policy Period: 2026-04-01 to 2027-03-31',
      'Insured Member: Member A (Self)',
      'Super top-up sum insured: Rs 20,00,000',
      'Aggregate deductible: Rs 3,00,000 per policy year',
      'Responds only after the deductible is exhausted by admissible claims in the policy year.',
    ]],
  },
  topUpScheduleNoDeductible: {
    sourceType: 'issued_schedule', title: 'Synthetic Super Top-Up - Schedule (deductible not printed)', policyNumbers: [POLICY_NUMBERS.topUpNoDeductible], uins: [UINS.topUp],
    pages: () => [[
      'Synthetic Assurance Ltd',
      'Policy Schedule - Synthetic Super Top-Up',
      `Policy Number: ${POLICY_NUMBERS.topUpNoDeductible}`,
      `UIN: ${UINS.topUp}`,
      'Super top-up sum insured: Rs 10,00,000',
      'Deductible: refer to the policy wording.',
    ]],
  },
  multiUinBrochure: {
    sourceType: 'customer_information_sheet', title: 'Synthetic Assurance Ltd - Combined Brochure', policyNumbers: [], uins: [UINS.shield, UINS.topUp],
    pages: () => [[
      'Synthetic Assurance Ltd - combined product brochure',
      `UIN: ${UINS.shield} (Synthetic Health Shield)`,
      `UIN: ${UINS.topUp} (Synthetic Super Top-Up)`,
      `Wording version: ${WORDING_VERSIONS['1']}`,
    ]],
  },
});

// ---- Deterministic PDF generator -----------------------------------------------------------------------------------
/** @returns {{ bytes: Uint8Array, pageTexts: string[], sha256: string }} pageTexts are generator-supplied, not extracted. */
export async function buildSyntheticPdf({ title, pages }) {
  const document = await PDFDocument.create({ updateMetadata: false });
  const font = await document.embedFont(StandardFonts.Helvetica);
  const pageTexts = [];
  for (const lines of pages) {
    const drawn = [SYNTHETIC_BANNER, ...lines, SYNTHETIC_BANNER];
    const page = document.addPage([595, 842]);
    drawn.forEach((line, i) => page.drawText(line, { x: 36, y: 800 - i * 14, size: 9, font }));
    pageTexts.push(drawn.join('\n'));
  }
  document.setTitle(`${title} (synthetic)`);
  document.setAuthor('CoverSaath synthetic fixtures');
  document.setSubject(SYNTHETIC_BANNER);
  document.setProducer('coversaath-synthetic-policies/1');
  document.setCreator('coversaath-synthetic-policies/1');
  document.setCreationDate(FIXED_DATE);
  document.setModificationDate(FIXED_DATE);
  const bytes = await document.save({ useObjectStreams: false });
  return { bytes, pageTexts, sha256: sha256(bytes) };
}

export function generateTemplate(template, sourceVersion = '1') {
  const spec = TEMPLATES[template];
  if (!spec) throw new TypeError(`Unknown synthetic template ${template}.`);
  return buildSyntheticPdf({ title: spec.title, pages: spec.pages(sourceVersion) });
}

export const clauseId = (documentId, sourceVersion, page) => `${documentId}@${sourceVersion}#p${page}`;

/** One clause row per page (ClauseRepository shape plus text). Text is the generator's own page text. */
export function clauseRowsFor(documentId, sourceVersion, generated) {
  return generated.pageTexts.map((text, i) => ({
    id: clauseId(documentId, sourceVersion, i + 1), clauseId: clauseId(documentId, sourceVersion, i + 1),
    documentId, sourceVersion, page: i + 1, digest: sha256(text), text,
  }));
}

// ---- Manifest helpers ----------------------------------------------------------------------------------------------
const doc = (documentId, template, sourceVersion = '1') => ({ documentId, template, sourceVersion });
const D = {
  schedA: doc('doc-a-schedule', 'scheduleA'),
  schedA2: doc('doc-a-schedule-reissue', 'scheduleAReissue'),
  wordA: doc('doc-a-wording', 'wordingA', '1'),
  wordA2: doc('doc-a-wording', 'wordingA', '2'),
  endA: doc('doc-a-endorsement', 'endorsementA'),
  staleEndA: doc('doc-a-endorsement-0', 'staleEndorsementA'),
  renewA: doc('doc-a-renewals', 'renewalHistoryA'),
  schedB: doc('doc-b-schedule', 'scheduleB'),
  floater: doc('doc-f-schedule', 'floaterSchedule'),
  group: doc('doc-g-certificate', 'groupCertificate'),
  topUp: doc('doc-t-schedule', 'topUpSchedule'),
  topUpNoDed: doc('doc-t2-schedule', 'topUpScheduleNoDeductible'),
  brochure: doc('doc-brochure', 'multiUinBrochure'),
};
const reviewedFact = (d, page, over) => ({
  policyId: 'P1', policyAssociation: { basis: 'printed_policy_number' }, documentId: d.documentId, sourceVersion: d.sourceVersion,
  sourceType: TEMPLATES[d.template].sourceType, clauseIds: [clauseId(d.documentId, d.sourceVersion, page)], topic: '', ...over,
});
// A model channel may not claim contractual standing: its facts are user statements whatever the upload label said.
const modelFact = (d, page, over) => ({ ...reviewedFact(d, page, over), sourceType: 'user_statement', declaredSourceType: TEMPLATES[d.template].sourceType });
const reviewed = (candidates, verifiedPolicyIds = ['P1']) => ({ origin: 'human_review', reviewStatus: 'accepted', verifiedPolicyIds, candidates });
const model = candidates => ({ origin: 'model', reviewStatus: 'not_reviewed', verifiedPolicyIds: [], candidates });
const inr = rupees => ({ amountMinor: rupees * 100, currency: 'INR' });
const perDay = rupees => ({ kind: 'amount', ...inr(rupees), basis: 'day' });
const member = memberId => ({ memberId, scope: 'member' });

/**
 * Expectation vocabulary (per view, per symbolic policy key, keyed 'rule' or 'rule/topic'):
 *   a string is the handoff state; an object may add value, candidateValue, reason, conflictingCount, discrepancyCount,
 *   conditional, exceptionsCount, completion (partial match), excludedReasons (catalogue rule result `excluded` reasons).
 */
export const SCENARIOS = Object.freeze([
  {
    id: 'S01', title: 'single valid policy: schedule and wording with reviewed facts',
    documents: [D.schedA, D.wordA],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }],
    batches: [reviewed([
      reviewedFact(D.schedA, 1, { factType: 'sum_insured', value: inr(500000) }),
      reviewedFact(D.schedA, 1, { factType: 'room_rent_limit', value: perDay(5000) }),
      reviewedFact(D.schedA, 1, { factType: 'copay', value: { basisPoints: 1000 } }),
      reviewedFact(D.wordA, 1, { factType: 'icu_limit', value: { kind: 'actuals' } }),
      reviewedFact(D.schedA, 1, { factType: 'add_on', topic: 'maternity cover', selection: 'not_opted', value: { name: 'Maternity Cover' } }),
      reviewedFact(D.wordA, 2, { factType: 'waiting_period', topic: 'pre-existing diseases', value: { months: 48 } }),
      reviewedFact(D.schedA, 1, { factType: 'policy_period', value: { start: '2026-04-01', end: '2027-03-31' } }),
    ])],
    views: [{ asOf: '2026-06-01', memberId: null, expect: { P1: {
      sum_insured: { state: 'known', value: inr(500000) },
      room_rent_limit: { state: 'known', value: perDay(5000) },
      copay: { state: 'known', value: { basisPoints: 1000 } },
      icu_limit: { state: 'known', value: { kind: 'actuals' } },
      'add_on/maternity cover': { state: 'not_selected', value: null },
      'waiting_period/pre-existing diseases': { state: 'known', value: { months: 48 }, completion: { state: 'unknown', reason: 'continuity_not_evidenced' } },
      deductible: { state: 'missing', reason: 'no_applicable_evidence' },
      member_enrolment: 'missing',
      continuous_cover: 'missing',
    } } }],
    association: { status: { 'doc-a-schedule': 'candidate', 'doc-a-wording': 'unestablished' } },
    source: [{ name: 'matching record with quotes on their pages', document: D.wordA, record: { uin: UINS.shield, wordingVersion: WORDING_VERSIONS['1'] },
      facts: [{ page: 2, quote: 'waiting period of 48 months of continuous coverage' }, { page: 3, quote: 'Rs 40,000 per eye' }], expect: { blocking: [], humanReview: [] } }],
  },
  {
    id: 'S02', title: 'two unrelated policies from different insurers stay separate',
    documents: [D.schedA, D.schedB],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }, { key: 'P2', kind: 'personal', coverBasis: 'individual', anchor: D.schedB.documentId }],
    batches: [reviewed([
      reviewedFact(D.schedA, 1, { factType: 'sum_insured', value: inr(500000) }),
      reviewedFact(D.schedB, 1, { policyId: 'P2', factType: 'sum_insured', value: inr(300000) }),
    ], ['P1', 'P2'])],
    views: [{ asOf: '2026-06-01', memberId: null, expect: {
      P1: { sum_insured: { state: 'known', value: inr(500000) } },
      P2: { sum_insured: { state: 'known', value: inr(300000) } },
    } }],
    coordination: { state: 'unresolved', notes: [] },
    association: { status: { 'doc-a-schedule': 'candidate', 'doc-b-schedule': 'candidate' }, different: [['doc-a-schedule', 'doc-b-schedule']] },
  },
  {
    id: 'S03', title: 'personal policy and corporate group certificate stay separate layers',
    documents: [D.schedA, D.group],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }, { key: 'P2', kind: 'group', coverBasis: 'shared', anchor: D.group.documentId }],
    batches: [reviewed([
      reviewedFact(D.schedA, 1, { factType: 'sum_insured', value: inr(500000) }),
      reviewedFact(D.schedA, 1, { factType: 'room_rent_limit', value: perDay(5000) }),
      reviewedFact(D.group, 1, { policyId: 'P2', factType: 'sum_insured', value: inr(300000) }),
      reviewedFact(D.group, 1, { policyId: 'P2', factType: 'room_rent_limit', value: { kind: 'percent_of_sum_insured', basisPoints: 100 } }),
      reviewedFact(D.group, 1, { policyId: 'P2', factType: 'waiting_period', topic: 'pre-existing diseases', value: { months: 0 } }),
    ], ['P1', 'P2'])],
    views: [{ asOf: '2026-06-01', memberId: null, expect: {
      P1: { sum_insured: { state: 'known', value: inr(500000) }, room_rent_limit: { state: 'known', value: perDay(5000) }, 'waiting_period/pre-existing diseases': undefined },
      P2: { sum_insured: { state: 'known', value: inr(300000) }, room_rent_limit: { state: 'known', value: { kind: 'percent_of_sum_insured', basisPoints: 100 } },
        'waiting_period/pre-existing diseases': { state: 'known', value: { months: 0 }, completion: { state: 'unknown', reason: 'continuity_not_evidenced' } } },
    } }],
    coordination: { state: 'unresolved', notes: [] },
    association: { status: { 'doc-a-schedule': 'candidate', 'doc-g-certificate': 'candidate' }, different: [['doc-a-schedule', 'doc-g-certificate']] },
  },
  {
    id: 'S04', title: 'family floater: per-member enrolment, shared sum insured',
    documents: [D.floater],
    policies: [{ key: 'P1', kind: 'family_floater', coverBasis: 'shared', anchor: D.floater.documentId, insuredMembers: ['member-a', 'member-b', 'member-c'] }],
    batches: [reviewed([
      reviewedFact(D.floater, 1, { factType: 'sum_insured', value: inr(1000000) }),
      ...['member-a', 'member-b', 'member-c'].map(m => reviewedFact(D.floater, 1, { factType: 'member_enrolment', subject: member(m), value: { status: 'enrolled' } })),
    ])],
    views: [
      { asOf: '2026-06-01', memberId: 'member-a', expect: { P1: { sum_insured: { state: 'known', value: inr(1000000) }, member_enrolment: { state: 'known', value: { status: 'enrolled' } } } } },
      { asOf: '2026-06-01', memberId: 'member-c', expect: { P1: { member_enrolment: { state: 'known', value: { status: 'enrolled' } } } } },
      { asOf: '2026-06-01', memberId: null, expect: { P1: { sum_insured: 'known', member_enrolment: { state: 'missing', reason: 'no_applicable_evidence', excludedReasons: ['other_member'] } } } },
    ],
    association: { status: { 'doc-f-schedule': 'candidate' } },
  },
  {
    id: 'S05', title: 'base policy plus super top-up with an aggregate deductible',
    documents: [D.schedA, D.topUp],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }, { key: 'P2', kind: 'top_up', coverBasis: 'individual', anchor: D.topUp.documentId }],
    batches: [reviewed([
      reviewedFact(D.schedA, 1, { factType: 'sum_insured', value: inr(500000) }),
      reviewedFact(D.topUp, 1, { policyId: 'P2', factType: 'sum_insured', value: inr(2000000) }),
      reviewedFact(D.topUp, 1, { policyId: 'P2', factType: 'deductible', value: { ...inr(300000), type: 'annual_aggregate' } }),
    ], ['P1', 'P2'])],
    views: [{ asOf: '2026-06-01', memberId: null, expect: {
      P1: { sum_insured: { state: 'known', value: inr(500000) }, deductible: 'missing' },
      P2: { sum_insured: { state: 'known', value: inr(2000000) }, deductible: { state: 'known', value: { ...inr(300000), type: 'annual_aggregate' } } },
    } }],
    coordination: { state: 'unresolved', notes: ['P2'] },
    association: { status: { 'doc-a-schedule': 'candidate', 'doc-t-schedule': 'candidate' }, different: [['doc-a-schedule', 'doc-t-schedule']] },
  },
  {
    id: 'S06', title: 'several documents for one policy: schedule, dated endorsement, wording',
    documents: [D.schedA, D.endA, D.wordA],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }],
    batches: [reviewed([
      reviewedFact(D.schedA, 1, { factType: 'room_rent_limit', value: perDay(5000) }),
      reviewedFact(D.endA, 1, { factType: 'room_rent_limit', value: perDay(7000), effective: { from: '2026-07-01' } }),
      reviewedFact(D.wordA, 1, { factType: 'icu_limit', value: { kind: 'actuals' } }),
    ])],
    views: [
      { asOf: '2026-05-01', memberId: null, expect: { P1: { room_rent_limit: { state: 'known', value: perDay(5000), excludedReasons: ['not_in_effect'] }, icu_limit: 'known' } } },
      { asOf: '2026-08-01', memberId: null, expect: { P1: { room_rent_limit: { state: 'known', value: perDay(7000), discrepancyCount: 1 } } } },
    ],
    association: { status: { 'doc-a-schedule': 'candidate', 'doc-a-endorsement': 'candidate', 'doc-a-wording': 'unestablished' }, same: [['doc-a-schedule', 'doc-a-endorsement']] },
  },
  {
    id: 'S07', title: 'schedule and wording contradict on co-pay: schedule layer controls, wording kept as a discrepancy',
    documents: [D.schedA, D.wordA],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }],
    batches: [reviewed([
      reviewedFact(D.schedA, 1, { factType: 'copay', value: { basisPoints: 1000 } }),
      reviewedFact(D.wordA, 1, { factType: 'copay', value: { basisPoints: 2000 } }),
    ])],
    views: [{ asOf: '2026-06-01', memberId: null, expect: { P1: { copay: { state: 'known', value: { basisPoints: 1000 }, discrepancyCount: 1 } } } }],
  },
  {
    id: 'S08', title: 'waiting period with unknown continuity: start date and model-reported continuity do not complete it',
    documents: [D.schedA, D.wordA],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }],
    batches: [
      reviewed([
        reviewedFact(D.wordA, 2, { factType: 'waiting_period', topic: 'pre-existing diseases', value: { months: 48 } }),
        reviewedFact(D.schedA, 1, { factType: 'policy_period', value: { start: '2026-04-01', end: '2027-03-31' } }),
      ]),
      model([modelFact(D.schedA, 1, { factType: 'continuous_cover', subject: { memberId: 'member-a', scope: 'member' }, value: { since: '2019-04-01', uninterrupted: true } })]),
    ],
    views: [
      { asOf: '2026-06-01', memberId: 'member-a', expect: { P1: {
        'waiting_period/pre-existing diseases': { state: 'known', completion: { state: 'unknown', reason: 'continuity_not_evidenced' } },
        continuous_cover: { state: 'missing', reason: 'only_non_contractual_sources', candidateValue: null, discrepancyCount: 1 },
      } } },
      { asOf: null, memberId: null, expect: { P1: { 'waiting_period/pre-existing diseases': { state: 'known', completion: { state: 'unknown', reason: 'as_of_date_missing' } } } } },
    ],
  },
  {
    id: 'S09', title: 'member-specific limits in a floater stay per member; a member co-pay beside a general co-pay is a conflict',
    documents: [D.floater],
    policies: [{ key: 'P1', kind: 'family_floater', coverBasis: 'shared', anchor: D.floater.documentId }],
    batches: [reviewed([
      reviewedFact(D.floater, 1, { factType: 'room_rent_limit', subject: member('member-a'), value: perDay(6000) }),
      reviewedFact(D.floater, 1, { factType: 'room_rent_limit', subject: member('member-c'), value: perDay(6000) }),
      reviewedFact(D.floater, 1, { factType: 'room_rent_limit', subject: member('member-b'), value: perDay(4000) }),
      reviewedFact(D.floater, 1, { factType: 'copay', value: { basisPoints: 1000 } }),
      reviewedFact(D.floater, 1, { factType: 'copay', subject: member('member-b'), value: { basisPoints: 2000 } }),
    ])],
    views: [
      { asOf: '2026-06-01', memberId: 'member-a', expect: { P1: { room_rent_limit: { state: 'known', value: perDay(6000) }, copay: { state: 'known', value: { basisPoints: 1000 } } } } },
      { asOf: '2026-06-01', memberId: 'member-b', expect: { P1: { room_rent_limit: { state: 'known', value: perDay(4000) }, copay: { state: 'conflicting', value: null, conflictingCount: 2 } } } },
      { asOf: '2026-06-01', memberId: null, expect: { P1: { room_rent_limit: { state: 'missing', reason: 'no_applicable_evidence' }, copay: { state: 'known', value: { basisPoints: 1000 } } } } },
    ],
  },
  {
    id: 'S10', title: 'wrong UIN: the record names a UIN the source does not print',
    documents: [D.wordA],
    source: [{ name: 'record UIN differs from the printed UIN', document: D.wordA, record: { uin: UINS.absent, wordingVersion: WORDING_VERSIONS['1'] }, facts: [], expect: { blocking: ['uin_mismatch'], humanReview: [] } }],
  },
  {
    id: 'S11', title: 'several printed UINs in one document',
    documents: [D.brochure],
    policies: [],
    batches: [],
    views: [{ asOf: '2026-06-01', memberId: null, expect: {} }],
    curatedComparison: { 'doc-brochure': 'several_uins' },
    association: { status: { 'doc-brochure': 'unestablished' } },
    source: [{ name: 'brochure prints two UINs', document: D.brochure, record: { uin: UINS.shield, wordingVersion: WORDING_VERSIONS['1'] }, facts: [], expect: { blocking: ['several_uins'], humanReview: [] } }],
  },
  {
    id: 'S12', title: 'missing quotation or source page: nothing passes silently',
    documents: [D.schedA, D.wordA],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }],
    // Page 4 of the schedule does not exist, so no live clause backs the fact.
    batches: [reviewed([{ ...reviewedFact(D.schedA, 1, { factType: 'sum_insured', value: inr(500000) }), clauseIds: [clauseId(D.schedA.documentId, '1', 4)] }])],
    views: [{ asOf: '2026-06-01', memberId: null, expect: { P1: { sum_insured: { state: 'missing', value: null } } } }],
    rejected: ['EVIDENCE_NOT_LIVE'],
    source: [
      { name: 'quotation the source never prints', document: D.wordA, record: { uin: UINS.shield, wordingVersion: WORDING_VERSIONS['1'] }, facts: [{ page: 2, quote: 'waiting period of 12 months for all diseases' }], expect: { blocking: ['quote_not_on_page:0'], humanReview: [] } },
      { name: 'right quotation on the wrong page', document: D.wordA, record: { uin: UINS.shield, wordingVersion: WORDING_VERSIONS['1'] }, facts: [{ page: 1, quote: 'waiting period of 48 months of continuous coverage' }], expect: { blocking: ['quote_not_on_page:0'], humanReview: [] } },
      { name: 'cited page out of range', document: D.wordA, record: { uin: UINS.shield, wordingVersion: WORDING_VERSIONS['1'] }, facts: [{ page: 2, quote: 'waiting period of 48 months' }, { page: 9, quote: 'waiting period of 48 months' }], expect: { blocking: ['page_out_of_range:1'], humanReview: [] } },
      { name: 'no page text supplied', document: D.wordA, record: { uin: UINS.shield, wordingVersion: WORDING_VERSIONS['1'] }, pageTexts: 'none', facts: [{ page: 2, quote: 'waiting period of 48 months' }],
        expect: { blocking: [], humanReview: ['page_text_unavailable', 'uin_not_machine_checked', 'wording_version_not_machine_checked', 'quotes_not_machine_checked'] } },
      { name: 'one byte changed after archiving', document: D.wordA, mutate: 'flip_byte', record: { uin: UINS.shield, wordingVersion: WORDING_VERSIONS['1'] }, facts: [], expect: { blocking: ['digest_mismatch'], humanReview: [] } },
      { name: 'bytes are not a PDF', document: D.wordA, mutate: 'not_pdf', record: { uin: UINS.shield, wordingVersion: WORDING_VERSIONS['1'] }, digestOf: 'mutated', facts: [], expect: { blocking: ['not_a_pdf'], humanReview: [] } },
    ],
  },
  {
    id: 'S13', title: 'superseded wording: the newer version of the same document controls',
    documents: [D.schedA, D.wordA, D.wordA2],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }],
    batches: [reviewed([
      reviewedFact(D.wordA, 2, { factType: 'waiting_period', topic: 'pre-existing diseases', value: { months: 48 } }),
      reviewedFact(D.wordA2, 2, { factType: 'waiting_period', topic: 'pre-existing diseases', value: { months: 36 } }),
    ])],
    views: [{ asOf: '2026-06-01', memberId: null, expect: { P1: { 'waiting_period/pre-existing diseases': { state: 'known', value: { months: 36 }, excludedReasons: ['older_version'] } } } }],
    source: [{ name: 'old wording bytes checked against the new wording record', document: D.wordA, record: { uin: UINS.shield, wordingVersion: WORDING_VERSIONS['2'] }, digestOf: D.wordA2, facts: [],
      expect: { blocking: ['digest_mismatch', 'wording_version_not_printed'], humanReview: [] } }],
    freshness: [{ record: { retrievedOn: '2026-04-01', supersededBy: 'SHS-W-2026.2' }, today: '2026-10-21', expect: 'superseded' }],
  },
  {
    id: 'S14', title: 'outdated evidence: a previous-year endorsement is not in effect; an old curated retrieval is stale',
    documents: [D.schedA, D.staleEndA],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }],
    batches: [reviewed([
      reviewedFact(D.schedA, 1, { factType: 'room_rent_limit', value: perDay(5000) }),
      reviewedFact(D.staleEndA, 1, { factType: 'room_rent_limit', value: perDay(4000), effective: { from: '2025-04-01', to: '2026-03-31' } }),
    ])],
    views: [
      { asOf: '2026-06-01', memberId: null, expect: { P1: { room_rent_limit: { state: 'known', value: perDay(5000), excludedReasons: ['not_in_effect'] } } } },
      { asOf: '2025-06-01', memberId: null, expect: { P1: { room_rent_limit: { state: 'known', value: perDay(4000), discrepancyCount: 1 } } } },
    ],
    association: { status: { 'doc-a-schedule': 'candidate', 'doc-a-endorsement-0': 'candidate' }, same: [['doc-a-schedule', 'doc-a-endorsement-0']] },
    freshness: [{ record: { retrievedOn: '2025-01-15' }, today: '2026-10-21', expect: 'stale' }, { record: { retrievedOn: '2026-09-01' }, today: '2026-10-21', expect: 'current' }],
  },

  // ---- Rule matrix -------------------------------------------------------------------------------------------------
  {
    id: 'R01', title: 'contradictory co-pay percentages in two schedules of the same policy stay conflicting',
    documents: [D.schedA, D.schedA2],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }],
    batches: [reviewed([
      reviewedFact(D.schedA, 1, { factType: 'copay', value: { basisPoints: 1000 } }),
      reviewedFact(D.schedA2, 1, { factType: 'copay', value: { basisPoints: 1500 } }),
    ])],
    views: [{ asOf: '2026-06-01', memberId: null, expect: { P1: { copay: { state: 'conflicting', value: null, conflictingCount: 2, reason: 'controlling_sources_disagree' } } } }],
    conflicts: [['P1', 'copay']],
    reviewRequired: true,
    association: { status: { 'doc-a-schedule': 'candidate', 'doc-a-schedule-reissue': 'candidate' }, same: [['doc-a-schedule', 'doc-a-schedule-reissue']] },
  },
  {
    id: 'R02', title: 'different room-rent limits: each policy keeps its own; a model claim is only a discrepancy',
    documents: [D.schedA, D.group],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }, { key: 'P2', kind: 'group', coverBasis: 'shared', anchor: D.group.documentId }],
    batches: [
      reviewed([
        reviewedFact(D.schedA, 1, { factType: 'room_rent_limit', value: perDay(5000) }),
        reviewedFact(D.group, 1, { policyId: 'P2', factType: 'room_rent_limit', value: { kind: 'percent_of_sum_insured', basisPoints: 100 } }),
      ], ['P1', 'P2']),
      model([modelFact(D.schedA, 1, { factType: 'room_rent_limit', value: { kind: 'actuals' } })]),
    ],
    views: [{ asOf: '2026-06-01', memberId: null, expect: {
      P1: { room_rent_limit: { state: 'known', value: perDay(5000), discrepancyCount: 1 } },
      P2: { room_rent_limit: { state: 'known', value: { kind: 'percent_of_sum_insured', basisPoints: 100 }, discrepancyCount: 0 } },
    } }],
  },
  {
    id: 'R03', title: 'missing member coverage: a member the schedule does not list stays missing',
    documents: [D.floater],
    policies: [{ key: 'P1', kind: 'family_floater', coverBasis: 'shared', anchor: D.floater.documentId, insuredMembers: ['member-a', 'member-b', 'member-c'] }],
    batches: [reviewed(['member-a', 'member-b', 'member-c'].map(m => reviewedFact(D.floater, 1, { factType: 'member_enrolment', subject: member(m), value: { status: 'enrolled' } })))],
    views: [{ asOf: '2026-06-01', memberId: 'member-d', expect: { P1: { member_enrolment: { state: 'missing', value: null, reason: 'no_applicable_evidence', excludedReasons: ['other_member'] } } } }],
  },
  {
    id: 'R04', title: 'interrupted continuous cover never completes a waiting period',
    documents: [D.wordA, D.renewA],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.renewA.documentId }],
    batches: [reviewed([
      reviewedFact(D.wordA, 2, { factType: 'waiting_period', topic: 'pre-existing diseases', value: { months: 48 } }),
      reviewedFact(D.renewA, 1, { factType: 'continuous_cover', subject: { memberId: 'member-a', scope: 'member' }, value: { since: '2021-04-01', uninterrupted: false } }),
    ])],
    // Continuity is always one member's: the record names member A and so does the query.
    views: [{ asOf: '2026-06-01', memberId: 'member-a', expect: { P1: {
      'waiting_period/pre-existing diseases': { state: 'known', completion: { state: 'unknown', reason: 'cover_interrupted' } },
      continuous_cover: { state: 'known', value: { since: '2021-04-01', uninterrupted: false } },
    } } }],
  },
  {
    id: 'R05', title: 'valid permanent exclusion with an exception is known but conditional',
    documents: [D.schedA, D.wordA],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }],
    batches: [reviewed([reviewedFact(D.wordA, 2, { factType: 'exclusion', topic: 'cosmetic or plastic surgery', value: { kind: 'permanent' }, exceptions: ['reconstruction following an accident'] })])],
    views: [{ asOf: '2026-06-01', memberId: null, expect: { P1: { 'exclusion/cosmetic or plastic surgery': { state: 'known', value: { kind: 'permanent' }, conditional: true, exceptionsCount: 1 }, exclusion: 'missing' } } }],
  },
  {
    id: 'R06', title: 'invalid restoration shapes never become known; a valid bonus does',
    documents: [D.schedA, D.wordA],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }],
    batches: [reviewed([
      reviewedFact(D.wordA, 3, { factType: 'restoration', value: { kind: 'percent_of_sum_insured', basisPoints: 0, times: 1 } }),
      reviewedFact(D.wordA, 3, { factType: 'restoration', topic: 'unrelated illness', value: { kind: 'unlimited' } }),
      reviewedFact(D.wordA, 3, { factType: 'bonus', value: { basisPointsPerYear: 1000, maxBasisPoints: 5000 } }),
    ])],
    views: [{ asOf: '2026-06-01', memberId: null, expect: { P1: {
      restoration: { state: 'unverified', value: null, candidateValue: null, reason: 'value_malformed' },
      'restoration/unrelated illness': { state: 'unverified', value: null, candidateValue: null, reason: 'value_malformed' },
      bonus: { state: 'known', value: { basisPointsPerYear: 1000, maxBasisPoints: 5000 } },
    } } }],
  },
  {
    id: 'R07', title: 'malformed monetary values are never known; a bare number yields no typed twin',
    documents: [D.schedA, D.schedB, D.wordA],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }],
    batches: [reviewed([
      reviewedFact(D.schedA, 1, { factType: 'sum_insured', value: { amountMinor: '50000000', currency: 'INR' } }),
      reviewedFact(D.schedA, 1, { factType: 'room_rent_limit', value: { kind: 'amount', amountMinor: 500000, currency: 'USD', basis: 'day' } }),
      reviewedFact(D.schedA, 1, { factType: 'icu_limit', value: { kind: 'amount', amountMinor: -100, currency: 'INR', basis: 'day' } }),
      reviewedFact(D.wordA, 3, { factType: 'sublimit', topic: 'cataract', value: { kind: 'amount', amountMinor: 4000000.5, currency: 'INR', basis: 'eye' } }),
    ])],
    views: [{ asOf: '2026-06-01', memberId: null, expect: { P1: {
      sum_insured: { state: 'unverified', value: null, reason: 'value_malformed' },
      room_rent_limit: { state: 'unverified', value: null, reason: 'value_malformed' },
      icu_limit: { state: 'unverified', value: null, reason: 'value_malformed' },
      'sublimit/cataract': { state: 'unverified', value: null, reason: 'value_malformed' },
    } } }],
    typedTwins: [
      { name: 'Rs amount with a unit becomes a typed candidate', document: D.schedA, page: 1, topic: 'room rent', expect: { factType: 'room_rent_limit', value: { kind: 'amount', amountMinor: 500000, currency: 'INR', basis: 'day' } } },
      { name: 'bare number without Rs yields nothing', document: D.schedB, page: 1, topic: 'room rent', expect: null },
    ],
  },
  {
    id: 'R08', title: 'missing deductible stays missing, never zero',
    documents: [D.topUpNoDed],
    policies: [{ key: 'P1', kind: 'top_up', coverBasis: 'individual', anchor: D.topUpNoDed.documentId }],
    batches: [reviewed([
      reviewedFact(D.topUpNoDed, 1, { factType: 'sum_insured', value: inr(1000000) }),
      reviewedFact(D.topUpNoDed, 1, { factType: 'deductible', explicitState: 'unknown' }),
    ])],
    views: [{ asOf: '2026-06-01', memberId: null, expect: { P1: { sum_insured: 'known', deductible: { state: 'missing', value: null, reason: 'fact_unknown' } } } }],
    coordination: { state: 'single_policy', notes: ['P1'] },
  },
  {
    id: 'R09', title: 'repeated and conflicting clause citations',
    documents: [D.schedA, D.wordA],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }],
    batches: [reviewed([
      reviewedFact(D.schedA, 1, { factType: 'sum_insured', value: inr(500000) }),
      reviewedFact(D.schedA, 1, { factType: 'sum_insured', value: inr(500000) }),
      { ...reviewedFact(D.schedA, 1, { factType: 'sum_insured', value: inr(500000) }), clauseIds: [clauseId('doc-a-schedule', '1', 1), clauseId('doc-a-schedule', '1', 1)] },
      reviewedFact(D.schedA, 1, { factType: 'room_rent_limit', value: perDay(5000) }),
      reviewedFact(D.schedA, 1, { factType: 'room_rent_limit', value: perDay(5500) }),
      { ...reviewedFact(D.schedA, 1, { factType: 'icu_limit', value: { kind: 'actuals' } }), clauseIds: [clauseId('doc-a-schedule', '1', 1), clauseId('doc-a-wording', '1', 1)] },
    ])],
    views: [{ asOf: '2026-06-01', memberId: null, expect: { P1: {
      sum_insured: { state: 'known', value: inr(500000) },
      room_rent_limit: { state: 'conflicting', value: null, conflictingCount: 2 },
      icu_limit: 'missing',
    } } }],
    factCount: 3,
    rejected: ['EVIDENCE_SOURCE_MISMATCH'],
    conflicts: [['P1', 'room_rent_limit']],
  },
  {
    id: 'R10', title: 'model claims an add-on is covered while the schedule says Not Opted',
    documents: [D.schedA],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }],
    batches: [
      reviewed([reviewedFact(D.schedA, 1, { factType: 'add_on', topic: 'maternity cover', selection: 'not_opted', value: { name: 'Maternity Cover' } })]),
      model([
        modelFact(D.schedA, 1, { factType: 'add_on', topic: 'maternity cover', selection: 'selected', value: { name: 'Maternity Cover' } }),
        modelFact(D.schedA, 1, { factType: 'add_on', topic: 'critical illness rider', selection: 'selected', value: { name: 'Critical Illness Rider' } }),
      ]),
    ],
    views: [{ asOf: '2026-06-01', memberId: null, expect: { P1: {
      'add_on/maternity cover': { state: 'not_selected', value: null, discrepancyCount: 1 },
      'add_on/critical illness rider': { state: 'missing', value: null, candidateValue: null, reason: 'only_non_contractual_sources' },
    } } }],
    reviewRequired: true,
    typedTwins: [{ name: 'Not Opted line yields a not_opted add-on candidate', document: D.schedA, page: 1, topic: 'critical illness rider', expect: { factType: 'add_on', selection: 'not_opted', value: { name: 'critical illness rider' } } }],
  },
  {
    id: 'R11', title: 'two policies with different applicability by member and date',
    documents: [D.schedA, D.group],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }, { key: 'P2', kind: 'group', coverBasis: 'shared', anchor: D.group.documentId }],
    batches: [reviewed([
      reviewedFact(D.schedA, 1, { factType: 'member_enrolment', subject: member('member-a'), value: { status: 'enrolled' } }),
      reviewedFact(D.group, 1, { policyId: 'P2', factType: 'member_enrolment', subject: member('member-b'), value: { status: 'enrolled' }, effective: { from: '2026-01-01', to: '2026-12-31' } }),
      reviewedFact(D.group, 1, { policyId: 'P2', factType: 'waiting_period', topic: 'pre-existing diseases', value: { months: 0 }, effective: { from: '2026-01-01', to: '2026-12-31' } }),
    ], ['P1', 'P2'])],
    views: [
      { asOf: '2026-06-01', memberId: 'member-b', expect: {
        P1: { member_enrolment: { state: 'missing', excludedReasons: ['other_member'] } },
        P2: { member_enrolment: { state: 'known', value: { status: 'enrolled' } }, 'waiting_period/pre-existing diseases': { state: 'known', value: { months: 0 } } },
      } },
      { asOf: '2027-02-01', memberId: 'member-b', expect: {
        P2: { member_enrolment: { state: 'missing', excludedReasons: ['not_in_effect'] }, 'waiting_period/pre-existing diseases': { state: 'missing', excludedReasons: ['not_in_effect'] } },
      } },
      { asOf: '2026-06-01', memberId: 'member-a', expect: { P1: { member_enrolment: 'known' }, P2: { member_enrolment: 'missing' } } },
    ],
  },
]);

/**
 * Behaviour this matrix found UNSAFE on 2026-10-21 (titles describe the old behaviour). Each entry states the SAFE
 * expectation; applicability.js was fixed and the matrix now runs these as ordinary regression tests.
 */
export const UNSAFE_FINDINGS = Object.freeze([
  {
    id: 'U01', title: 'with no as-of date a dated endorsement is dropped and the lower schedule layer reads as known',
    documents: [D.schedA, D.endA],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }],
    batches: [reviewed([
      reviewedFact(D.schedA, 1, { factType: 'room_rent_limit', value: perDay(5000) }),
      reviewedFact(D.endA, 1, { factType: 'room_rent_limit', value: perDay(7000), effective: { from: '2026-07-01' } }),
    ])],
    views: [{ asOf: null, memberId: null, expect: { P1: { room_rent_limit: { state: 'missing', reason: 'as_of_required' } } } }],
  },
  {
    id: 'U02', title: 'a superseded wording version still controls a term the newer version no longer prints',
    documents: [D.schedA, D.wordA, D.wordA2],
    policies: [{ key: 'P1', kind: 'personal', coverBasis: 'individual', anchor: D.schedA.documentId }],
    batches: [reviewed([
      reviewedFact(D.wordA, 3, { factType: 'sublimit', topic: 'cataract', value: { kind: 'amount', ...inr(40000), basis: 'eye' } }),
      reviewedFact(D.wordA2, 2, { factType: 'waiting_period', topic: 'pre-existing diseases', value: { months: 36 } }),
    ])],
    views: [{ asOf: '2026-06-01', memberId: null, expect: { P1: { 'sublimit/cataract': { state: 'missing', value: null } } } }],
  },
  {
    id: 'U03', title: 'a policy-scoped enrolment fact makes any member, even one the schedule never lists, enrolled',
    documents: [D.floater],
    policies: [{ key: 'P1', kind: 'family_floater', coverBasis: 'shared', anchor: D.floater.documentId, insuredMembers: ['member-a', 'member-b', 'member-c'] }],
    batches: [reviewed([reviewedFact(D.floater, 1, { factType: 'member_enrolment', value: { status: 'enrolled' } })])],
    views: [{ asOf: '2026-06-01', memberId: 'member-d', expect: { P1: { member_enrolment: { state: 'missing', value: null } } } }],
  },
]);

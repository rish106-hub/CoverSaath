// Invented demo data for `npm run seed:demo`. Every insurer, product, person, number and date is made up.
// No real insurer, product or policy text is used. Insurer names are the synthetic pair below only.
// Denylist of real Indian insurer brand names: tests/seed-demo.test.mjs greps this directory and the fixtures.

export const DEMO_BANNER = 'DEMO FIXTURE - INVENTED TEXT - NOT A REAL POLICY DOCUMENT';

export const DEMO_HOUSEHOLD = Object.freeze({ displayName: 'Test household (demo)' });

export const DEMO_PEOPLE = Object.freeze([
  Object.freeze({ key: 'asha', displayName: 'Asha Test', memberKind: 'adult', relationshipLabel: 'Self', contactEmail: 'asha.test@example.invalid', owner: true }),
  Object.freeze({ key: 'ravi', displayName: 'Ravi Test', memberKind: 'adult', relationshipLabel: 'Spouse', dateOfBirth: null }),
  Object.freeze({ key: 'mira', displayName: 'Mira Test', memberKind: 'dependent', relationshipLabel: 'Daughter', dateOfBirth: '2019-05-14' }),
]);

export const DEMO_INSURERS = Object.freeze(['Acme Health', 'Northstar General']);

// Three products. `policyKind` is a policies.policy_kind value; `kind` is a holding kind (policy-holding-repository HOLDING_KINDS). `members` are keys of DEMO_PEOPLE.
export const DEMO_PRODUCTS = Object.freeze([
  Object.freeze({
    key: 'acme-family-shield', insurer: 'Acme Health', name: 'Acme Family Shield', policyKind: 'personal', kind: 'retail_health',
    policyNumberMasked: 'XXXX-AH-1001', startsOn: '2026-04-01', endsOn: '2027-03-31', members: ['asha', 'ravi', 'mira'],
    sumInsuredMinor: 1000000, premiumPaise: [1250000, 1250000, 1250000],
  }),
  Object.freeze({
    key: 'northstar-group-cover', insurer: 'Northstar General', name: 'Northstar Group Cover', policyKind: 'group', kind: 'group_health',
    policyNumberMasked: 'XXXX-NG-2001', startsOn: '2026-01-01', endsOn: '2026-12-31', members: ['asha', 'ravi'],
    sumInsuredMinor: 500000, premiumPaise: [480000, 480000, 480000],
  }),
  Object.freeze({
    key: 'northstar-top-up-plus', insurer: 'Northstar General', name: 'Northstar Top-Up Plus', policyKind: 'top_up', kind: 'top_up',
    policyNumberMasked: 'XXXX-NG-3001', startsOn: '2026-06-15', endsOn: '2027-06-14', members: ['asha', 'ravi', 'mira'],
    sumInsuredMinor: 1500000, premiumPaise: [310000, 310000, 310000],
  }),
]);

// Declarations for the demo household (kind is a DECLARATION_KINDS value; labels are invented).
export const DEMO_DECLARATIONS = Object.freeze([
  Object.freeze({ person: 'asha', kind: 'occupation', label: 'Occupation: office worker (demo)', productKey: 'acme-family-shield' }),
  Object.freeze({ person: 'mira', kind: 'other', label: 'Declared by guardian (demo)', productKey: 'northstar-top-up-plus' }),
]);

// Each product gets one brochure and one wording PDF; the group cover is one PDF on the group product.
export const DEMO_PDF_SPECS = Object.freeze([
  ...DEMO_PRODUCTS.flatMap(product => [
    Object.freeze({ key: `${product.key}-brochure`, productKey: product.key, documentKind: 'other', filename: `${product.key}-brochure.pdf`, title: `Product brochure: ${product.name}`, lines: [
      `${product.insurer} (synthetic insurer). Product brochure for ${product.name}.`,
      'Sum insured options are shown for illustration only.',
      'Hospitalisation, day care and pre and post hospital expenses are summarised here.',
      'This brochure is a marketing summary. The policy wording governs all terms.',
    ] }),
    Object.freeze({ key: `${product.key}-wording`, productKey: product.key, documentKind: 'policy_wording', filename: `${product.key}-wording.pdf`, title: `Policy wording: ${product.name}`, lines: [
      `Policy wording: ${product.name} (${product.insurer}, invented).`,
      '1. Insured: a person named in the schedule of this policy.',
      '2. Waiting period: 30 days from the policy start date, except accidents.',
      '3. Room rent: capped at one per cent of the sum insured per day (invented term).',
      '4. Co-payment: 10 per cent of each admissible claim where the schedule states it.',
      '5. Exclusions: cosmetic procedures that are not caused by an accident.',
      '6. Grievances: write to the grievance cell within 30 days of the event.',
    ] }),
  ]),
  Object.freeze({ key: 'northstar-group-cover-certificate', productKey: 'northstar-group-cover', documentKind: 'policy_schedule', filename: 'northstar-group-cover-certificate.pdf', title: 'Group cover certificate', lines: [
    'Group cover certificate: Northstar Group Cover (invented).',
    'Employer group: Synthetic Employer Group 07.',
    'Covered members: Asha Test, Ravi Test.',
    'Sum insured per member: Rs. 5,00,000 (invented).',
    'This certificate is a demo sample and is not an insurer document.',
  ] }),
]);

export const DEMO_HOSPITAL_PINCODES = Object.freeze(['990001', '990002', '990003']);

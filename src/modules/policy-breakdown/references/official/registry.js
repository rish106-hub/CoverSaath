// Operator-reviewed official source registry. Every URL here was checked by a person against the publisher's own
// site; nothing in page text, model output or user input can add or change an entry. Each entry passes
// defineOfficialSource at load, so a malformed edit fails at startup rather than at fetch time.
//
// To add a product wording: open the insurer's "Policy Wordings" page, copy the PDF link for the exact UIN,
// download it once, confirm the UIN printed in the PDF equals `identity.uin`, and add an entry below.
import { defineOfficialSource } from './contracts.js';
import { INSURER_CLAIMS_SOURCES } from '../insurer-claims-sources.js';

const HDFC_ERGO = 'HDFC ERGO General Insurance Company Limited';
const HDFC_ERGO_HOSTS = ['customer-portal-assets.hdfcergo.com'];
const OWNER = 'knowvia-policy-breakdown';

export const OFFICIAL_SOURCE_REGISTRY = Object.freeze([
  {
    id: 'hdfc-ergo.my-optima-secure.wording.hdfhlip26058v082526',
    sourceClass: 'insurer_policy_wording',
    documentType: 'policy_wording',
    publisher: HDFC_ERGO,
    identity: {
      scope: 'policy_versioned',
      legalInsurerName: HDFC_ERGO,
      uin: 'HDFHLIP26058V082526',
      productName: 'my: Optima Secure',
      version: 'V08',
      // Not printed in the wording. The UIN suffix V08-2526 files version 08 in FY2025-26, so its start is the
      // earliest date this version can apply. The UIN itself is the match key; this date only bounds it.
      effectiveFrom: '2025-04-01',
      effectiveTo: null,
    },
    canonicalUrl: 'https://customer-portal-assets.hdfcergo.com/documents/PolicyWordings_myOptimaSecure-76673175551.pdf',
    allowedHosts: HDFC_ERGO_HOSTS,
    expectedMimeTypes: ['application/pdf'],
    maxBytes: 10 * 1024 * 1024,
    freshnessDays: 30,
    owner: OWNER,
  },
  {
    // Quarterly retail-health claims counts and turnaround the insurer publishes on its own site.
    id: 'hdfc-ergo.claims-data',
    sourceClass: 'insurer_disclosure',
    documentType: 'regulatory_disclosure',
    publisher: HDFC_ERGO,
    identity: { scope: 'insurer', legalInsurerName: HDFC_ERGO, uin: null, productName: null, version: null, effectiveFrom: null, effectiveTo: null },
    canonicalUrl: 'https://www.hdfcergo.com/claim/claims-data',
    allowedHosts: ['www.hdfcergo.com'],
    expectedMimeTypes: ['text/html'],
    maxBytes: 3 * 1024 * 1024,
    freshnessDays: 7,
    owner: OWNER,
  },
  // Insurer-published IRDAI Form NL-37 claims data (see ../insurer-claims-sources.js).
  ...INSURER_CLAIMS_SOURCES,
].map(defineOfficialSource));

/** Policy-versioned wording entries keyed by normalised UIN. A UIN encodes product and version. */
export function wordingSourcesByUin(registry = OFFICIAL_SOURCE_REGISTRY) {
  const byUin = new Map();
  for (const source of registry) {
    if (source.documentType !== 'policy_wording' || !source.identity.uin) continue;
    const uin = normaliseUin(source.identity.uin);
    byUin.set(uin, [...(byUin.get(uin) ?? []), source]);
  }
  return byUin;
}

export const normaliseUin = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();

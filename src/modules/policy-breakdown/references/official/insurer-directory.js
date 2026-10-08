// Reviewed directory of every insurer that sells health insurance in India (standalone health insurers, private
// general insurers and the four PSU general insurers). It is the starting point for the wording navigator: which
// insurer filed a UIN, which hosts may serve its documents, and which of its own pages list product wordings.
//
// Evidence rules (checked 2026-10-08):
// - uinPrefixes: the 3-letter company code that starts the insurer's UINs, seen on a UIN printed by the insurer's
//   own site/PDF, or on IRDAI's health-products list (irdai.gov.in/health-insurance-products) against that insurer.
// - legacyUinPrefixes: codes filed under a former name of the same company, or by a company it absorbed. Kept apart
//   so a reviewer can see why a prefix maps here. Each one appears against the predecessor on the IRDAI list.
// - irdaiRegistrationNumber: printed on the insurer's own homepage or policy wording; null when not seen there.
// - wordingIndexUrls: fetched with the KnowviaSourceFetcher/1.0 user agent, returned 200, and the HTML links
//   product wordings (or product pages that link them). Empty when the site blocks that agent, fails TLS, or
//   renders its document list with JavaScript (access says which).
// - documentPathPatterns: path regexes (source strings) for document links that do not end in ".pdf".
// Nothing here may be changed from page text, model output or user input. Unknown values are null or [].
const VERIFIED_ON = '2026-10-08';

const RAW_INSURERS = [
  // ---- Standalone health insurers ----
  {
    id: 'star-health',
    legalName: 'Star Health and Allied Insurance Company Limited',
    aliases: ['Star Health & Allied Insurance Co. Ltd.', 'Star Health and Allied Insurance Co. Ltd.', 'Star Health Insurance', 'Star Health'],
    irdaiRegistrationNumber: null,
    uinPrefixes: ['SHA'],
    legacyUinPrefixes: [],
    officialHosts: ['www.starhealth.in'],
    wordingIndexUrls: [],
    access: 'blocked',
    notes: 'Site returns 403 to the fetcher user agent.',
  },
  {
    id: 'care-health',
    legalName: 'Care Health Insurance Limited',
    aliases: ['Care Health Insurance Ltd.', 'Care Health Insurance', 'Religare Health Insurance Company Limited', 'Religare Health Insurance'],
    irdaiRegistrationNumber: null,
    uinPrefixes: ['CHI', 'RHI'], // IRDAI lists RHI filings against "Care Health Insurance Ltd." after the rename.
    legacyUinPrefixes: [],
    officialHosts: ['www.careinsurance.com'],
    wordingIndexUrls: [],
    access: 'blocked',
    notes: 'Site returns 403 to the fetcher user agent.',
  },
  {
    id: 'niva-bupa',
    legalName: 'Niva Bupa Health Insurance Company Limited',
    aliases: ['Niva Bupa Health Insurance Co. Ltd.', 'Niva Bupa', 'Max Bupa Health Insurance Company Limited', 'Max Bupa'],
    irdaiRegistrationNumber: '145',
    uinPrefixes: ['NBH'],
    legacyUinPrefixes: ['MAX'], // Max Bupa Health Insurance, renamed Niva Bupa.
    officialHosts: ['www.nivabupa.com', 'transactions.nivabupa.com'],
    wordingIndexUrls: ['https://transactions.nivabupa.com/pages/downloads.aspx'],
    access: 'server_rendered',
    notes: 'www.nivabupa.com/downloads.html redirects here. Wording links carry a ?v= cache query.',
  },
  {
    id: 'aditya-birla-health',
    legalName: 'Aditya Birla Health Insurance Co. Limited',
    aliases: ['Aditya Birla Health Insurance Co. Ltd.', 'Aditya Birla Health Insurance', 'ABHI'],
    irdaiRegistrationNumber: null,
    uinPrefixes: ['ADI'],
    legacyUinPrefixes: [],
    officialHosts: ['www.adityabirlacapital.com'],
    wordingIndexUrls: [],
    access: 'tls_error',
    notes: 'Node TLS fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE (server omits its intermediate certificate).',
  },
  {
    id: 'manipalcigna',
    legalName: 'ManipalCigna Health Insurance Company Limited',
    aliases: ['ManipalCigna Health Insurance Co. Ltd.', 'Manipal Cigna Health Insurance Company Limited', 'ManipalCigna', 'Cigna TTK Health Insurance Company Limited', 'Cigna TTK'],
    irdaiRegistrationNumber: '151',
    uinPrefixes: ['MCI'],
    legacyUinPrefixes: ['CTT'], // Cigna TTK Health Insurance, renamed ManipalCigna.
    officialHosts: ['www.manipalcigna.com'],
    wordingIndexUrls: ['https://www.manipalcigna.com/downloads/products'],
    documentPathPatterns: ['^/documents/'],
    access: 'server_rendered',
    notes: 'Two hops: product category pages, then extensionless /documents/... wording links. The UIN is printed in the page footer.',
  },
  {
    id: 'galaxy-health',
    legalName: 'Galaxy Health Insurance Company Limited',
    aliases: ['Galaxy Health Insurance Co Ltd.', 'Galaxy Health and Allied Insurance Company Limited', 'Galaxy Health'],
    irdaiRegistrationNumber: '167',
    uinPrefixes: ['GHI'],
    legacyUinPrefixes: [],
    officialHosts: ['www.galaxyhealth.com'],
    wordingIndexUrls: [],
    access: 'js_rendered',
    notes: 'Document links are rendered client-side; /downloads redirects to the homepage.',
  },
  {
    id: 'narayana-health',
    legalName: 'Narayana Health Insurance Limited',
    aliases: ['Narayana Health Insurance Ltd.', 'Narayana Health Insurance Co. Ltd', 'Narayana Health Insurance'],
    irdaiRegistrationNumber: '166',
    uinPrefixes: ['NHI'],
    legacyUinPrefixes: [],
    officialHosts: ['www.narayanahealth.insurance', 'stgaccinwbsprdlrs01.blob.core.windows.net'],
    wordingIndexUrls: ['https://www.narayanahealth.insurance/product'],
    access: 'server_rendered',
    notes: 'Wordings live on Azure Blob storage and need the signed (sv/sig) query string the page provides.',
  },
  {
    id: 'hdfc-ergo',
    legalName: 'HDFC ERGO General Insurance Company Limited',
    aliases: ['HDFC ERGO General Insurance Co. Ltd.', 'HDFC ERGO', 'HDFC ERGO Health Insurance Limited', 'Apollo Munich Health Insurance Company Limited', 'Apollo Munich'],
    irdaiRegistrationNumber: '146',
    uinPrefixes: ['HDF'],
    legacyUinPrefixes: ['APO', 'HDH'], // Apollo Munich -> HDFC ERGO Health (HDH) -> merged into HDFC ERGO General. APO is still listed on hdfcergo.com.
    officialHosts: ['www.hdfcergo.com', 'customer-portal-assets.hdfcergo.com'],
    wordingIndexUrls: ['https://www.hdfcergo.com/download/policy-wordings/health'],
    access: 'server_rendered',
    notes: 'Wording PDFs are named by product, not UIN; UINs appear in nearby page text.',
  },

  // ---- Private general insurers with health business ----
  {
    id: 'icici-lombard',
    legalName: 'ICICI Lombard General Insurance Company Limited',
    aliases: ['ICICI Lombard GIC Ltd', 'ICICI Lombard General Insurance Co. Ltd.', 'ICICI Lombard', 'Bharti AXA General Insurance Company Limited', 'Bharti AXA'],
    irdaiRegistrationNumber: null,
    uinPrefixes: ['ICI'],
    legacyUinPrefixes: ['BHA'], // Bharti AXA General's business merged into ICICI Lombard.
    officialHosts: ['www.icicilombard.com'],
    wordingIndexUrls: [],
    access: 'blocked',
    notes: 'Site returns 403 to the fetcher user agent.',
  },
  {
    id: 'bajaj-general',
    legalName: 'Bajaj General Insurance Limited',
    aliases: ['Bajaj Allianz General Insurance Co. Ltd.', 'Bajaj Allianz General Insurance Company Limited', 'Bajaj Allianz', 'Bajaj General'],
    irdaiRegistrationNumber: '113',
    uinPrefixes: ['BAJ'],
    legacyUinPrefixes: [],
    officialHosts: ['www.bajajgeneralinsurance.com'],
    wordingIndexUrls: ['https://www.bajajgeneralinsurance.com/health-insurance-plans/health-insurance-documents.html'],
    access: 'server_rendered',
    notes: 'Formerly Bajaj Allianz General Insurance.',
  },
  {
    id: 'tata-aig',
    legalName: 'Tata AIG General Insurance Company Limited',
    aliases: ['Tata AIG General Insurance Co. Ltd.', 'Tata AIG'],
    irdaiRegistrationNumber: '108',
    uinPrefixes: ['TAT'],
    legacyUinPrefixes: [],
    officialHosts: ['www.tataaig.com'],
    wordingIndexUrls: ['https://www.tataaig.com/downloads'],
    access: 'server_rendered',
    notes: 'Link text carries the UIN for most wordings.',
  },
  {
    id: 'sbi-general',
    legalName: 'SBI General Insurance Company Limited',
    aliases: ['SBI General Insurance Co. Ltd.', 'SBI General'],
    irdaiRegistrationNumber: '144',
    uinPrefixes: ['SBI'],
    legacyUinPrefixes: [],
    officialHosts: ['www.sbigeneral.in', 'content.sbigeneral.in'],
    wordingIndexUrls: ['https://www.sbigeneral.in/downloads'],
    access: 'server_rendered',
    notes: 'PDF URLs are embedded in page data rather than anchors; the navigator reads embedded document URLs.',
  },
  {
    id: 'indusind-general',
    legalName: 'IndusInd General Insurance Company Limited',
    aliases: ['Reliance General Insurance Co. Ltd.', 'Reliance General Insurance Company Limited', 'Reliance General', 'IndusInd General Insurance'],
    irdaiRegistrationNumber: '103',
    uinPrefixes: ['INI'],
    legacyUinPrefixes: ['REL'], // Reliance General Insurance, renamed IndusInd General; REL wordings are still listed.
    officialHosts: ['www.indusindinsurance.com'],
    wordingIndexUrls: ['https://www.indusindinsurance.com/download/policy-wordings'],
    documentPathPatterns: ['^/downloads/'],
    access: 'server_rendered',
    notes: 'reliancegeneral.co.in redirects here. Document links are extensionless /downloads/<slug>.',
  },
  {
    id: 'cholamandalam-ms',
    legalName: 'Cholamandalam MS General Insurance Company Limited',
    aliases: ['Cholamandalam MS General Insurance Co. Ltd.', 'Chola MS General Insurance', 'Chola MS'],
    irdaiRegistrationNumber: '123',
    uinPrefixes: ['CHO'],
    legacyUinPrefixes: [],
    officialHosts: ['www.cholainsurance.com'],
    wordingIndexUrls: ['https://www.cholainsurance.com/downloads'],
    documentPathPatterns: ['^/documents/'],
    access: 'server_rendered',
    notes: 'Document URLs end in "<name>.pdf/<uuid>".',
  },
  {
    id: 'generali-central',
    legalName: 'Generali Central Insurance Company Limited',
    aliases: ['Future Generali India Insurance Co. Ltd.', 'Future Generali India Insurance Company Limited', 'Future Generali', 'Generali Central'],
    irdaiRegistrationNumber: '132',
    uinPrefixes: ['GCI'],
    legacyUinPrefixes: ['FGI'], // Future Generali India Insurance, renamed Generali Central.
    officialHosts: ['www.generalicentralinsurance.com'],
    wordingIndexUrls: ['https://www.generalicentralinsurance.com/customer-service/downloads'],
    access: 'server_rendered',
    notes: 'general.futuregenerali.in redirects here.',
  },
  {
    id: 'go-digit',
    legalName: 'Go Digit General Insurance Limited',
    aliases: ['Go Digit General Insurance Ltd.', 'Digit Insurance', 'Go Digit'],
    irdaiRegistrationNumber: '158',
    uinPrefixes: ['GOD'],
    legacyUinPrefixes: [],
    officialHosts: ['www.godigit.com'],
    wordingIndexUrls: ['https://www.godigit.com/downloads'],
    access: 'server_rendered',
    notes: 'Link text carries the UIN for most wordings.',
  },
  {
    id: 'iffco-tokio',
    legalName: 'IFFCO Tokio General Insurance Company Limited',
    aliases: ['IFFCO Tokio General Insurance Co. Ltd.', 'IFFCO Tokio'],
    irdaiRegistrationNumber: '106',
    uinPrefixes: ['IFF'],
    legacyUinPrefixes: [],
    officialHosts: ['www.iffcotokio.co.in'],
    wordingIndexUrls: ['https://www.iffcotokio.co.in/policy-wordings'],
    access: 'server_rendered',
    notes: null,
  },
  {
    id: 'zurich-kotak',
    legalName: 'Zurich Kotak General Insurance Company (India) Limited',
    aliases: ['Zurich Kotak General Insurance Co. (India) Ltd.', 'Kotak Mahindra General Insurance Co. Ltd.', 'Kotak Mahindra General Insurance Company Limited', 'Kotak General Insurance', 'Zurich Kotak'],
    irdaiRegistrationNumber: null,
    uinPrefixes: ['KOT'],
    legacyUinPrefixes: [],
    officialHosts: ['www.zurichkotak.com'],
    wordingIndexUrls: [],
    access: 'blocked',
    notes: 'Site returns 403 to the fetcher user agent.',
  },
  {
    id: 'liberty-general',
    legalName: 'Liberty General Insurance Limited',
    aliases: ['Liberty General Insurance Ltd.', 'Liberty Videocon General Insurance Company Limited', 'Liberty General'],
    irdaiRegistrationNumber: null,
    uinPrefixes: ['LIB'],
    legacyUinPrefixes: ['LVG'], // Liberty Videocon General Insurance, renamed Liberty General.
    officialHosts: ['www.libertyinsurance.in'],
    wordingIndexUrls: [],
    access: 'blocked',
    notes: 'Site returns 403 to the fetcher user agent.',
  },
  {
    id: 'magma-general',
    legalName: 'Magma General Insurance Limited',
    aliases: ['Magma HDI General Insurance Co. Ltd.', 'Magma HDI General Insurance Company Limited', 'Magma HDI', 'Magma General Insurance Co. Ltd.'],
    irdaiRegistrationNumber: '149',
    uinPrefixes: ['MAG'],
    legacyUinPrefixes: [],
    officialHosts: ['www.magmainsurance.com'],
    wordingIndexUrls: ['https://www.magmainsurance.com/web/magmainsurance/downloads'],
    documentPathPatterns: ['^/documents/'],
    access: 'server_rendered',
    notes: 'Formerly Magma HDI General Insurance.',
  },
  {
    id: 'navi-general',
    legalName: 'Navi General Insurance Limited',
    aliases: ['Navi General Insurance Ltd.', 'DHFL General Insurance Limited', 'Navi General'],
    irdaiRegistrationNumber: null,
    uinPrefixes: ['NAV'],
    legacyUinPrefixes: ['DHF'], // DHFL General Insurance, renamed Navi General.
    officialHosts: ['navi.com'],
    wordingIndexUrls: [],
    access: 'js_rendered',
    notes: 'navi.com/insurance is a client-rendered app with no anchors in the HTML.',
  },
  {
    id: 'raheja-qbe',
    legalName: 'Raheja QBE General Insurance Company Limited',
    aliases: ['Raheja QBE General Insurance Co. Ltd.', 'Raheja QBE'],
    irdaiRegistrationNumber: '141',
    uinPrefixes: ['RQB'],
    legacyUinPrefixes: [],
    officialHosts: ['www.rahejaqbe.com'],
    wordingIndexUrls: [],
    access: 'js_rendered',
    notes: '/downloads returns 200 but its HTML carries no policy wording links.',
  },
  {
    id: 'royal-sundaram',
    legalName: 'Royal Sundaram General Insurance Co. Limited',
    aliases: ['Royal Sundaram General Insurance Co. Ltd.', 'Royal Sundaram'],
    irdaiRegistrationNumber: null,
    uinPrefixes: ['RSA'],
    legacyUinPrefixes: [],
    officialHosts: ['www.royalsundaram.in'],
    wordingIndexUrls: [],
    access: 'blocked',
    notes: 'Site returns 403 to the fetcher user agent.',
  },
  {
    id: 'shriram-general',
    legalName: 'Shriram General Insurance Company Limited',
    aliases: ['Shriram General Insurance Co. Ltd.', 'Shriram General'],
    irdaiRegistrationNumber: '137',
    uinPrefixes: ['SGL'],
    legacyUinPrefixes: [],
    officialHosts: ['www.shriramgi.com', 'cdn.shriramgi.com'],
    wordingIndexUrls: [],
    access: 'js_rendered',
    notes: '/download/policy-wordings returns 200 but its HTML carries no product wording links.',
  },
  {
    id: 'universal-sompo',
    legalName: 'Universal Sompo General Insurance Company Limited',
    aliases: ['Universal Sompo General Insurance Co. Ltd.', 'Universal Sompo'],
    irdaiRegistrationNumber: '134',
    uinPrefixes: ['UNI'],
    legacyUinPrefixes: [],
    officialHosts: ['www.universalsompo.com'],
    wordingIndexUrls: ['https://www.universalsompo.com/resources-downloads/'],
    access: 'server_rendered',
    notes: 'Wording links have empty anchor text; the URL path names the product.',
  },
  {
    id: 'zuno-general',
    legalName: 'Zuno General Insurance Limited',
    aliases: ['Zuno General Insurance Ltd.', 'Zuno General Insurance Co. Ltd.', 'Edelweiss General Insurance Company Limited', 'Edelweiss General Insurance Co. Ltd.', 'Zuno'],
    irdaiRegistrationNumber: '159',
    uinPrefixes: ['ZUN'],
    legacyUinPrefixes: ['EDL'], // Edelweiss General Insurance, renamed Zuno; EDL add-on UINs are printed in Zuno wordings.
    officialHosts: ['www.hizuno.com', 'cms.hizuno.com'],
    wordingIndexUrls: ['https://www.hizuno.com/downloads'],
    access: 'server_rendered',
    notes: null,
  },
  {
    id: 'acko-general',
    legalName: 'Acko General Insurance Limited',
    aliases: ['Acko General Insurance Ltd.', 'ACKO'],
    irdaiRegistrationNumber: '157',
    uinPrefixes: ['ACK'],
    legacyUinPrefixes: [],
    officialHosts: ['www.acko.com', 'acko-cms.ackoassets.com'],
    wordingIndexUrls: ['https://www.acko.com/gi/download/'],
    access: 'server_rendered',
    notes: null,
  },
  {
    id: 'kshema-general',
    legalName: 'Kshema General Insurance Limited',
    aliases: ['Kshema General Insurance Ltd.', 'Kshema'],
    irdaiRegistrationNumber: '162',
    uinPrefixes: ['KSG'],
    legacyUinPrefixes: [],
    officialHosts: ['kshema.co'],
    wordingIndexUrls: ['https://kshema.co/'],
    access: 'server_rendered',
    notes: 'Mostly rural/agri lines; files group and individual health products (KSGHL...). Homepage links product pages.',
  },

  // ---- Public sector general insurers ----
  {
    id: 'new-india',
    legalName: 'The New India Assurance Company Limited',
    aliases: ['The New India Assurance Co. Ltd.', 'New India Assurance'],
    irdaiRegistrationNumber: '190',
    uinPrefixes: ['NIA'],
    legacyUinPrefixes: [],
    officialHosts: ['www.newindia.co.in'],
    wordingIndexUrls: [],
    access: 'js_rendered',
    notes: 'UINs are in the server-rendered state, but wording PDF links are loaded client-side.',
  },
  {
    id: 'national-insurance',
    legalName: 'National Insurance Company Limited',
    aliases: ['National Insurance Co. Ltd.', 'National Insurance'],
    irdaiRegistrationNumber: null,
    uinPrefixes: ['NIC'],
    legacyUinPrefixes: [],
    officialHosts: ['nationalinsurance.nic.co.in'],
    wordingIndexUrls: ['https://nationalinsurance.nic.co.in/products/all-products'],
    access: 'server_rendered',
    notes: 'Two hops: product pages, each linking its "Wordings" PDF.',
  },
  {
    id: 'oriental-insurance',
    legalName: 'The Oriental Insurance Company Limited',
    aliases: ['The Oriental Insurance Co. Ltd.', 'Oriental Insurance'],
    irdaiRegistrationNumber: null,
    uinPrefixes: ['OIC'],
    legacyUinPrefixes: [],
    officialHosts: ['orientalinsurance.org.in'],
    wordingIndexUrls: [],
    access: 'js_rendered',
    notes: 'Single-page app; /download-policy-terms-conditions HTML has no document links.',
  },
  {
    id: 'united-india',
    legalName: 'United India Insurance Company Limited',
    aliases: ['United India Insurance Co. Ltd.', 'United India Insurance'],
    irdaiRegistrationNumber: null,
    uinPrefixes: ['UII'],
    legacyUinPrefixes: [],
    officialHosts: ['uiic.co.in'],
    wordingIndexUrls: ['https://uiic.co.in/web/downloadforms/downloads'],
    access: 'server_rendered',
    notes: null,
  },
];

/** Roster names (IRDAI Handbook 2024-25) that are insurers but do not sell health insurance. */
export const NON_HEALTH_INSURERS = Object.freeze([
  Object.freeze({ legalName: 'Agriculture Insurance Company of India Limited', aliases: Object.freeze(['Agriculture Insurance Company of India Ltd.']), reason: 'crop insurance only' }),
  Object.freeze({ legalName: 'ECGC Limited', aliases: Object.freeze(['ECGC Ltd.']), reason: 'export credit insurance only' }),
]);

const PREFIX_PATTERN = /^[A-Z]{3}$/;
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const ACCESS_STATES = Object.freeze(['server_rendered', 'js_rendered', 'blocked', 'tls_error']);

function freezeInsurer(raw) {
  const hosts = raw.officialHosts.map(host => host.toLowerCase());
  for (const host of hosts) if (!HOST_PATTERN.test(host)) throw new TypeError(`${raw.id}: invalid host ${host}`);
  for (const prefix of [...raw.uinPrefixes, ...raw.legacyUinPrefixes]) if (!PREFIX_PATTERN.test(prefix)) throw new TypeError(`${raw.id}: invalid UIN prefix ${prefix}`);
  for (const url of raw.wordingIndexUrls) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !hosts.includes(parsed.hostname)) throw new TypeError(`${raw.id}: index URL ${url} is not on an official host`);
  }
  if (!ACCESS_STATES.includes(raw.access)) throw new TypeError(`${raw.id}: invalid access ${raw.access}`);
  for (const pattern of raw.documentPathPatterns ?? []) new RegExp(pattern); // fail at load, not at fetch time
  return Object.freeze({
    id: raw.id,
    legalName: raw.legalName,
    aliases: Object.freeze([...raw.aliases]),
    irdaiRegistrationNumber: raw.irdaiRegistrationNumber,
    uinPrefixes: Object.freeze([...raw.uinPrefixes]),
    legacyUinPrefixes: Object.freeze([...raw.legacyUinPrefixes]),
    officialHosts: Object.freeze(hosts),
    wordingIndexUrls: Object.freeze([...raw.wordingIndexUrls]),
    documentPathPatterns: Object.freeze([...(raw.documentPathPatterns ?? [])]),
    access: raw.access,
    notes: raw.notes ?? null,
    verifiedOn: VERIFIED_ON,
  });
}

export const INSURER_DIRECTORY = Object.freeze(RAW_INSURERS.map(freezeInsurer));

/** Normalise an insurer name for matching: case, punctuation, "&"/"and", and company-form suffixes are ignored. */
export function normaliseInsurerName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\(india\)/g, ' india ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(the|company|co|ltd|limited|pvt|private|insurance|insurers?|gic|gi)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const byPrefix = new Map();
for (const insurer of INSURER_DIRECTORY) {
  for (const prefix of [...insurer.uinPrefixes, ...insurer.legacyUinPrefixes]) {
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), insurer]);
  }
}

const byName = new Map();
for (const insurer of INSURER_DIRECTORY) {
  for (const name of [insurer.legalName, ...insurer.aliases]) {
    const key = normaliseInsurerName(name);
    if (!key) continue;
    const existing = byName.get(key) ?? new Set();
    existing.add(insurer);
    byName.set(key, existing);
  }
}

const UIN_SHAPE = /^[A-Z]{3}[A-Z]{4}\d{5}V\d{6}$/;

/** The insurer that filed a UIN, by its 3-letter company code. Null when unknown or ambiguous. */
export function insurerForUin(uin) {
  const value = String(uin ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
  if (!UIN_SHAPE.test(value)) return null;
  const matches = byPrefix.get(value.slice(0, 3)) ?? [];
  return matches.length === 1 ? matches[0] : null;
}

/** Exact match on the normalised legal name or an alias. Null when unknown or ambiguous. */
export function insurerByName(name) {
  const key = normaliseInsurerName(name);
  if (!key) return null;
  const matches = byName.get(key);
  return matches && matches.size === 1 ? [...matches][0] : null;
}

export function insurerById(id) {
  return INSURER_DIRECTORY.find(insurer => insurer.id === id) ?? null;
}

// Read-only contract for externally verified insurer product records (work package 4). A pure projection of what the
// curated product repository already holds: nothing is fetched, crawled or invented, and no clock is read.
//
// Authority comes from the INPUT CHANNEL, never from a record's own fields (as in handoff.js): a typed `value` is emitted
// only for a record that arrived in `verified` (the output of CuratedProductRepository.listVerified), was checked by a
// different adult from the collector, and is current on `today`. Everything in `submissions` is at most `unverified`.
//
// Privacy: public insurer wording only. Collector and checker adult ids are NOT carried at all (they identify adults, and
// the contract only needs the fact that the check was independent, which is `independentlyChecked`). No household ids,
// policy numbers, page text beyond the cited quote, or archived bytes can enter: the builder copies named fields and the
// assertion refuses any other field.
import { RULES } from './rules.js';
import { deepFreeze, digestOf, isIsoDate, isRecord } from './contracts.js';
import { curatedFreshness } from './curated-products.js';

export const VERIFIED_RECORDS_VERSION = 'verified-product-records/v1';
export const VERIFIED_RECORD_STATES = Object.freeze(['verified', 'unverified', 'stale', 'superseded', 'conflicting', 'rejected', 'unknown']);
export const SUBMISSION_STATES = Object.freeze(['collected', 'candidate', 'checked', 'published', 'rejected', 'needs_revalidation', 'superseded']);
// Product-level terms only; household facts (sum insured, enrolment, policy period) are never curated.
const PRODUCT_FACT_TYPES = Object.freeze(['room_rent_limit', 'icu_limit', 'copay', 'deductible', 'sublimit', 'waiting_period', 'exclusion', 'restoration', 'bonus']);
const VALUE_RULE = new Map(RULES.filter(rule => PRODUCT_FACT_TYPES.includes(rule.factType)).map(rule => [rule.factType, rule]));
const LIVE_SUBMISSION_STATES = ['collected', 'candidate', 'checked', 'published'];
const SHA256 = /^[0-9a-f]{64}$/;
const UIN = /^[A-Z0-9]{12,24}$/;

const TOP_KEYS = ['contractVersion', 'readOnly', 'asOf', 'records', 'counts', 'limitations'];
const RECORD_KEYS = ['uin', 'wordingVersion', 'insurer', 'productName', 'sourceUrl', 'sourceVersionId', 'contentSha256', 'retrievedOn', 'effectiveFrom', 'checkedAt',
  'state', 'freshness', 'independentlyChecked', 'reasons', 'conflicts', 'history', 'facts'];
const FACT_KEYS = ['factType', 'topic', 'state', 'value', 'candidateValue', 'citation'];
const CITATION_KEYS = ['uin', 'wordingVersion', 'page', 'quote', 'contentSha256', 'sourceVersionId', 'retrievedOn', 'checkedAt'];
const CONFLICT_KEYS = ['kind', 'factType', 'topic', 'digests'];
const HISTORY_KEYS = ['state', 'contentSha256', 'sourceVersionId'];
// A value or any field that names a household, an adult, a policy number or document content is refused wherever it appears.
const FORBIDDEN_KEY = /household|adult|member|policy_?holder|policy_?number|user_?id|e-?mail|phone|collected_?by|checked_?by|curated_?by|page_?text|bytes|account/i;

export const VERIFIED_RECORDS_LIMITATIONS = Object.freeze([
  'Public insurer wording only. A record informs a comparison; it never overrides a household\'s own contract.',
  'An absent record means unknown, not that no such term exists.',
  'A value is present only for a record independently checked and current on asOf. Candidate values are unverified and are not to be calculated with.',
  'Legal and privacy wording is not final and needs legal review.',
]);

// isIsoDate throws on an out-of-range month; a contract check must refuse, not crash.
const isDate = value => { try { return isIsoDate(value); } catch { return false; } };
const fail = message => { throw new TypeError(`Verified product records: ${message}`); };
const keyOf = (uin, wordingVersion) => `${uin}\u0000${wordingVersion}`;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function factsOf(facts, where) {
  if (!Array.isArray(facts)) fail(`${where}.facts must be an array`);
  return facts.map((f, i) => {
    const at = `${where}.facts[${i}]`;
    if (!isRecord(f) || !VALUE_RULE.has(f.factType)) fail(`${at} has an unsupported factType`);
    const topic = f.topic ?? 'general';
    if (typeof topic !== 'string' || !topic || topic.length > 120) fail(`${at}.topic`);
    if (!isRecord(f.value) || !VALUE_RULE.get(f.factType).valid(f.value)) fail(`${at}.value is not a valid ${f.factType}`);
    if (!Number.isSafeInteger(f.page) || f.page < 1) fail(`${at}.page`);
    if (typeof f.quote !== 'string' || f.quote.trim().length < 8 || f.quote.length > 600) fail(`${at}.quote`);
    return { factType: f.factType, topic, value: structuredClone(f.value), page: f.page, quote: f.quote };
  });
}

function identity(source, where) {
  if (typeof source.uin !== 'string' || !UIN.test(source.uin)) fail(`${where}.uin`);
  if (typeof source.wordingVersion !== 'string' || !source.wordingVersion || source.wordingVersion.length > 200) fail(`${where}.wordingVersion`);
  if (typeof source.contentSha256 !== 'string' || !SHA256.test(source.contentSha256)) fail(`${where}.contentSha256`);
  if (!isDate(source.retrievedOn)) fail(`${where}.retrievedOn`);
  if (source.effectiveFrom != null && !isDate(source.effectiveFrom)) fail(`${where}.effectiveFrom`);
  for (const f of ['insurer', 'productName']) if (typeof source[f] !== 'string' || !source[f] || source[f].length > 200) fail(`${where}.${f}`);
  if (typeof source.sourceUrl !== 'string' || !source.sourceUrl.startsWith('https://') || source.sourceUrl.length > 500) fail(`${where}.sourceUrl`);
}

const pick = p => ({ uin: p.uin, wordingVersion: p.wordingVersion, insurer: p.insurer, productName: p.productName, sourceUrl: p.sourceUrl,
  contentSha256: p.contentSha256, retrievedOn: p.retrievedOn, effectiveFrom: p.effectiveFrom ?? null });

// One normalised entry per input. `lane` is how the builder treats it; it is derived from the channel and state only.
function fromVerified(entry, i, today) {
  const where = `verified[${i}]`;
  if (!isRecord(entry) || !isRecord(entry.product)) fail(`${where} is not a listVerified record`);
  const p = entry.product;
  identity(p, where);
  const facts = factsOf(p.facts, where);
  const v = entry.verification;
  const proven = entry.verified === true && isRecord(v) && typeof v.sourceVersionId === 'string' && v.sourceVersionId.length > 0
    && typeof v.checkedAt === 'string' && v.checkedAt.length > 0 && Boolean(p.checkedBy) && Boolean(p.curatedBy) && p.checkedBy !== p.curatedBy;
  if (typeof v?.sourceVersionId !== 'string' || !v.sourceVersionId) fail(`${where}.verification.sourceVersionId`);
  const base = { ...pick(p), sourceVersionId: v.sourceVersionId, checkedAt: typeof v.checkedAt === 'string' && v.checkedAt ? v.checkedAt : null, facts };
  const freshness = entry.freshness === 'superseded' ? 'superseded' : curatedFreshness(p, today);
  return proven ? { ...base, lane: 'verified', freshness }
    : { ...base, lane: 'unverified', freshness, reason: 'verified_channel_record_failed_independence_check' };
}

function fromSubmission(s, i, today) {
  const where = `submissions[${i}]`;
  if (!isRecord(s)) fail(`${where} is not a record`);
  if (!SUBMISSION_STATES.includes(s.state)) fail(`${where}.state is unknown`);
  identity(s, where);
  if (typeof s.sourceVersionId !== 'string' || !s.sourceVersionId) fail(`${where}.sourceVersionId`);
  const live = LIVE_SUBMISSION_STATES.includes(s.state);
  const facts = live ? factsOf(s.facts ?? [], where) : [];
  const checkedAt = typeof s.checkedAt === 'string' && s.checkedAt ? s.checkedAt : null;
  const freshness = s.state === 'superseded' ? 'superseded' : curatedFreshness(s, today);
  // A submission's own `verified` flag, published state or checker are deliberately ignored: only the verified channel proves.
  return { ...pick(s), sourceVersionId: s.sourceVersionId, checkedAt, facts, lane: live ? 'unverified' : s.state, freshness };
}

const citationOf = (e, f) => ({ uin: e.uin, wordingVersion: e.wordingVersion, page: f.page, quote: f.quote, contentSha256: e.contentSha256,
  sourceVersionId: e.sourceVersionId, retrievedOn: e.retrievedOn, checkedAt: e.checkedAt });

function buildRecord(entries) {
  const live = entries.filter(e => e.lane === 'verified' || e.lane === 'unverified');
  const ident = pick(entries[0]);
  const history = entries.filter(e => !live.includes(e)).map(e => ({ state: e.lane, contentSha256: e.contentSha256, sourceVersionId: e.sourceVersionId }))
    .sort((a, b) => cmp(a.state, b.state) || cmp(a.contentSha256, b.contentSha256) || cmp(a.sourceVersionId, b.sourceVersionId));
  const conflicts = [];
  let state; let reasons = []; let representative;

  const digests = [...new Set(live.map(e => e.contentSha256))].sort();
  if (digests.length > 1) conflicts.push({ kind: 'source_digest', factType: null, topic: null, digests });
  const byFact = new Map();
  for (const e of live) for (const f of e.facts) {
    const k = `${f.factType}\u0000${f.topic}`;
    byFact.set(k, [...(byFact.get(k) ?? []), digestOf(f.value)]);
  }
  for (const [k, ds] of byFact) {
    const distinct = [...new Set(ds)].sort();
    if (distinct.length > 1) { const [factType, topic] = k.split('\u0000'); conflicts.push({ kind: 'fact_value', factType, topic, digests: distinct }); }
  }
  conflicts.sort((a, b) => cmp(a.kind, b.kind) || cmp(a.factType ?? '', b.factType ?? '') || cmp(a.topic ?? '', b.topic ?? ''));

  if (live.length) {
    representative = live.find(e => e.lane === 'verified') ?? live[0];
    if (conflicts.length) { state = 'conflicting'; reasons = ['more_than_one_distinct_candidate']; }
    else if (representative.freshness === 'superseded') { state = 'superseded'; reasons = ['freshness_superseded']; }
    else if (representative.freshness !== 'current') { state = 'stale'; reasons = [`freshness_${representative.freshness}`]; }
    else if (live.some(e => e.lane === 'verified')) state = 'verified';
    else { state = 'unverified'; reasons = [...new Set(live.map(e => e.reason ?? 'not_independently_checked'))].sort(); }
  } else {
    const lane = ['needs_revalidation', 'superseded', 'rejected'].find(s => entries.some(e => e.lane === s));
    state = lane === 'needs_revalidation' ? 'stale' : lane;
    reasons = [lane];
    representative = entries.find(e => e.lane === lane);
  }

  const conflicting = state === 'conflicting';
  // A conflicting record lists every live fact (never valued) so a reader can see what disagrees.
  const listed = conflicting ? live.flatMap(e => e.facts.map(f => ({ e, f }))) : representative.facts.map(f => ({ e: representative, f }));
  const seen = new Set();
  const outFacts = [];
  for (const { e, f } of listed) {
    const d = digestOf(f.value);
    const dedupe = [f.factType, f.topic, d, f.page, f.quote, e.contentSha256].join('\u0000');
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    outFacts.push({ fact: { factType: f.factType, topic: f.topic, state, value: state === 'verified' ? structuredClone(f.value) : null,
      candidateValue: state === 'unverified' ? structuredClone(f.value) : null, citation: citationOf(e, f) }, d });
  }
  outFacts.sort((a, b) => cmp(a.fact.factType, b.fact.factType) || cmp(a.fact.topic, b.fact.topic) || cmp(a.d, b.d)
    || cmp(a.fact.citation.page, b.fact.citation.page) || cmp(a.fact.citation.contentSha256, b.fact.citation.contentSha256));
  const source = conflicting ? null : representative;
  return {
    uin: ident.uin, wordingVersion: ident.wordingVersion, insurer: ident.insurer, productName: ident.productName, sourceUrl: ident.sourceUrl,
    sourceVersionId: source?.sourceVersionId ?? null, contentSha256: source?.contentSha256 ?? null,
    retrievedOn: source?.retrievedOn ?? null, effectiveFrom: source?.effectiveFrom ?? null, checkedAt: source?.checkedAt ?? null,
    state, freshness: representative.freshness, independentlyChecked: state === 'verified', reasons, conflicts, history,
    facts: outFacts.map(x => x.fact),
  };
}

/**
 * @param verified    output of CuratedProductRepository.listVerified (the only channel that can yield a value)
 * @param submissions plain submission DTOs of any state (never yield a value)
 * @param requested   optional [{ uin, wordingVersion }] a caller asked about; one with no record becomes an `unknown` record
 * @param today       ISO date; the only notion of time
 * Fails closed on a malformed input rather than skipping it, so a bad row cannot hide a conflict.
 */
export function buildVerifiedProductRecords({ verified = [], submissions = [], requested = [], today } = {}) {
  if (!isDate(today)) throw new TypeError('today must be an ISO date.');
  if (![verified, submissions, requested].every(Array.isArray)) throw new TypeError('verified, submissions and requested must be arrays.');
  const entries = [...verified.map((e, i) => fromVerified(e, i, today)), ...submissions.map((s, i) => fromSubmission(s, i, today))];
  const groups = new Map();
  for (const e of entries) groups.set(keyOf(e.uin, e.wordingVersion), [...(groups.get(keyOf(e.uin, e.wordingVersion)) ?? []), e]);
  const records = [...groups.values()].map(buildRecord);
  requested.forEach((r, i) => {
    if (!isRecord(r) || typeof r.uin !== 'string' || !UIN.test(r.uin) || typeof r.wordingVersion !== 'string' || !r.wordingVersion) fail(`requested[${i}]`);
    if (groups.has(keyOf(r.uin, r.wordingVersion))) return;
    groups.set(keyOf(r.uin, r.wordingVersion), []);
    records.push({
      uin: r.uin, wordingVersion: r.wordingVersion, insurer: null, productName: null, sourceUrl: null, sourceVersionId: null, contentSha256: null,
      retrievedOn: null, effectiveFrom: null, checkedAt: null, state: 'unknown', freshness: 'unknown', independentlyChecked: false,
      reasons: ['no_record'], conflicts: [], history: [], facts: [],
    });
  });
  records.sort((a, b) => cmp(a.uin, b.uin) || cmp(a.wordingVersion, b.wordingVersion));
  return deepFreeze({
    contractVersion: VERIFIED_RECORDS_VERSION, readOnly: true, asOf: today, records,
    counts: Object.fromEntries(VERIFIED_RECORD_STATES.map(s => [s, records.filter(r => r.state === s).length])),
    limitations: [...VERIFIED_RECORDS_LIMITATIONS],
  });
}

const breach = message => { throw new Error(`Verified product records contract: ${message}`); };
function onlyKeys(o, allowed, where) {
  if (!isRecord(o)) breach(`${where} must be an object`);
  for (const k of Object.keys(o)) if (!allowed.includes(k)) breach(`field ${where}.${k} is not allowed`);
  for (const k of allowed) if (!Object.hasOwn(o, k)) breach(`${where}.${k} is missing`);
}
function noForbiddenKeys(value, where) {
  if (Array.isArray(value)) value.forEach((v, i) => noForbiddenKeys(v, `${where}[${i}]`));
  else if (isRecord(value)) for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEY.test(k)) breach(`forbidden field ${where}.${k}`);
    noForbiddenKeys(v, `${where}.${k}`);
  }
}

/** Contract check for a consumer or a test. Throws on the first breach. */
export function assertVerifiedProductRecordsContract(contract) {
  if (contract?.contractVersion !== VERIFIED_RECORDS_VERSION) breach('version');
  noForbiddenKeys(contract, 'contract');
  onlyKeys(contract, TOP_KEYS, 'contract');
  if (contract.readOnly !== true) breach('must be read-only');
  if (!isDate(contract.asOf)) breach('asOf');
  if (!Array.isArray(contract.records)) breach('records');
  let previous = null;
  for (const [i, r] of contract.records.entries()) {
    const at = `records[${i}]`;
    onlyKeys(r, RECORD_KEYS, at);
    if (!VERIFIED_RECORD_STATES.includes(r.state)) breach(`state ${r.state}`);
    if (typeof r.uin !== 'string' || !UIN.test(r.uin) || typeof r.wordingVersion !== 'string' || !r.wordingVersion) breach(`${at} identity`);
    const key = keyOf(r.uin, r.wordingVersion);
    if (previous !== null && cmp(previous, key) >= 0) breach('records must be sorted and unique per UIN and wording version');
    previous = key;
    if (!Array.isArray(r.reasons) || !Array.isArray(r.conflicts) || !Array.isArray(r.history) || !Array.isArray(r.facts)) breach(`${at} arrays`);
    if ((r.state === 'verified') !== (r.independentlyChecked === true)) breach(`independentlyChecked only on verified (${at})`);
    if (r.state === 'verified' && (!SHA256.test(r.contentSha256 ?? '') || !r.sourceVersionId || !r.checkedAt || !isDate(r.retrievedOn))) breach(`verified record needs source identity (${at})`);
    if (r.state === 'unknown' && r.facts.length) breach(`unknown record carries facts (${at})`);
    if ((r.state === 'conflicting') !== (r.conflicts.length > 0)) breach(`conflicts only on conflicting (${at})`);
    r.conflicts.forEach((c, j) => onlyKeys(c, CONFLICT_KEYS, `${at}.conflicts[${j}]`));
    r.history.forEach((h, j) => onlyKeys(h, HISTORY_KEYS, `${at}.history[${j}]`));
    for (const [j, f] of r.facts.entries()) {
      const fa = `${at}.facts[${j}]`;
      onlyKeys(f, FACT_KEYS, fa);
      onlyKeys(f.citation, CITATION_KEYS, `${fa}.citation`);
      if (f.state !== r.state) breach(`fact state must equal its record state (${fa})`);
      if (!VALUE_RULE.has(f.factType)) breach(`factType (${fa})`);
      if ((r.state === 'verified') !== (f.value !== null)) breach(`value only on a verified record (${fa})`);
      if (r.state !== 'unverified' && f.candidateValue !== null) breach(`candidate value leaked (${fa})`);
      if (f.value !== null && !VALUE_RULE.get(f.factType).valid(f.value)) breach(`value is not valid for ${f.factType} (${fa})`);
      if (f.candidateValue !== null && !isRecord(f.candidateValue)) breach(`candidateValue (${fa})`);
      const c = f.citation;
      const complete = Number.isSafeInteger(c.page) && c.page >= 1 && typeof c.quote === 'string' && c.quote.length >= 8 && c.quote.length <= 600
        && SHA256.test(c.contentSha256 ?? '') && Boolean(c.sourceVersionId) && c.wordingVersion === r.wordingVersion && c.uin === r.uin && isDate(c.retrievedOn);
      if (!complete) breach(`citation incomplete (${fa})`);
      if (r.state === 'verified' && !c.checkedAt) breach(`verified fact needs checkedAt (${fa})`);
    }
  }
  if (!isRecord(contract.counts) || Object.keys(contract.counts).length !== VERIFIED_RECORD_STATES.length) breach('counts has unknown states');
  for (const s of VERIFIED_RECORD_STATES) if (contract.counts[s] !== contract.records.filter(r => r.state === s).length) breach(`counts.${s}`);
  return true;
}

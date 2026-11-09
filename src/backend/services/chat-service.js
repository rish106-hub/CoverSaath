import { CHAT_MESSAGE_MAX, CHAT_PAGE_PATTERN, CHAT_REQUEST_KEYS, CHAT_ROUTES } from '../../contracts/chat.js';
import { readbackEnabled } from './policy-evidence-service.js';

// Chat v0 (P7a): a deterministic, cited lookup over what the household's own readable documents already say. No model,
// no stored history, no new table. The message is classified by fixed keyword rules; it is NEVER passed on, logged,
// audited, echoed or used to build free text. Search terms come from the fixed vocabularies below. Evidence is fetched
// through the same consent-gated read-back path as the read-facts and passages routes (PolicyEvidenceService), case by
// case, behind the route's source-pack field gate. Reference data is public context only. The reply is a template over
// retrieved text: it never states eligibility, claim approval, payable money or a consent outcome.
// Wording is DRAFT and needs legal review.

const MAX_CASES = 5;
const MAX_SOURCES = 6;
const PASSAGES_PER_CASE = 3;
const invalid = () => Object.assign(new Error('The chat request is invalid.'), { code: 'CHAT_REQUEST_INVALID', statusCode: 400 });

// Topic word in the message -> fixed passage search term and, where the extractor has one, a read-back topic.
const TOPICS = Object.freeze([
  { match: /room\s*rent/, term: 'room rent', facts: 'room_rent' },
  { match: /\bicu\b/, term: 'icu', facts: 'room_rent' },
  { match: /sum\s*insured/, term: 'sum insured', facts: 'sum_insured' },
  { match: /co-?\s?pay/, term: 'co-payment', facts: 'co_payment' },
  { match: /policy\s*(period|term)|renewal|expiry|expires?/, term: 'policy period', facts: 'policy_period' },
  { match: /ambulance/, term: 'ambulance' }, { match: /maternity|delivery|pregnan/, term: 'maternity' },
  { match: /cataract/, term: 'cataract' }, { match: /pre-?\s?existing|\bped\b/, term: 'pre-existing', facts: 'waiting_period' },
  { match: /day\s*care/, term: 'day care' }, { match: /ayush/, term: 'ayush' }, { match: /domiciliary/, term: 'domiciliary' },
  { match: /organ\s*donor/, term: 'organ donor' }, { match: /hospitali[sz]ation/, term: 'hospitalisation' },
]);
const NAVIGATION = Object.freeze([
  { match: /\bclaims?\b|reimbursement|cashless/, key: 'claims' }, { match: /hospital|network/, key: 'hospitals' },
  { match: /family|member|spouse|parent|child/, key: 'family' }, { match: /consent|privacy|settings?|delete my data|permission/, key: 'settings' },
  { match: /document|upload|policy\s*(copy|pdf)|schedule/, key: 'documents' },
]);
const DECISION = /\b(approv\w*|eligib\w*|reimburs\w*|payable|settle(?:ment|d)?|entitled|how much (?:will|can|do|would) (?:i|we)|will (?:i|we|they|it) (?:get|receive|be paid|be covered)|am i covered for sure)\b/;
const FIELD_LABELS = Object.freeze({
  insurer: 'Insurer', plan_name: 'Plan name', policy_period_start: 'Policy period start', policy_period_end: 'Policy period end',
  base_sum_insured: 'Base sum insured', room_rent_limit: 'Room rent limit', icu_limit: 'ICU limit', co_payment: 'Co-payment',
  initial_waiting_period: 'Initial waiting period', specified_disease_waiting_period: 'Specified disease waiting period', ped_waiting_period: 'Pre-existing disease waiting period',
});
const NOTICE = 'This is wording read from your documents. It is not a decision on cover, eligibility, claim approval or payment. (Draft wording, for legal review.)';

// Only a UIN-shaped token is ever sent to the reference port, never the message: no user text leaves the process.
function uinCandidate(message) {
  for (const raw of message.split(/\s+/)) {
    const token = raw.replace(/[?!,;:"')]+$/, '').replace(/^["'(]+/, '');
    if (/^[A-Za-z0-9][A-Za-z0-9./_-]{5,63}$/.test(token) && /\d/.test(token) && /[A-Za-z]{2}/.test(token)) return token;
  }
  return null;
}

/** Fixed keyword classification. Returns the intent and, where relevant, the fixed search term and read-back topic. */
export function classify(message) {
  const text = message.toLowerCase();
  if (DECISION.test(text)) return { intent: 'decision_request' };
  const topic = TOPICS.find(item => item.match.test(text)) ?? null;
  const base = { factsTopic: topic?.facts ?? null };
  if (/waiting|wait period/.test(text)) return { intent: 'waiting_period', factsTopic: base.factsTopic ?? 'waiting_period', term: topic?.term ?? 'waiting period' };
  if (/exclu|not covered|not payable|not cover\b/.test(text)) return { intent: 'exclusion', ...base, term: topic?.term ?? 'exclusion' };
  if (/sub-?\s?limit|capping|\bcap on\b|\blimits?\b/.test(text) || ['room_rent', 'co_payment', 'sum_insured'].includes(topic?.facts)) return { intent: 'sub_limit', ...base, term: topic?.term ?? 'limit' };
  if (/\bcover(?:ed|s|age)?\b|include[sd]?|\bcashless\b/.test(text) && topic) return { intent: 'covered', ...base, term: topic.term };
  if (/\b(uin|insurer|product|plan)\b/.test(text) || uinCandidate(message)) return { intent: 'product_lookup' };
  if (/\bcover(?:ed|s|age)?\b/.test(text)) return { intent: 'covered', ...base, term: null };
  return { intent: 'out_of_scope', nav: NAVIGATION.find(item => item.match.test(text))?.key ?? null };
}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
  if (Object.keys(body).some(key => !CHAT_REQUEST_KEYS.includes(key))) throw invalid();
  if (typeof body.message !== 'string') throw invalid();
  const message = body.message.trim();
  if (!message || message.length > CHAT_MESSAGE_MAX || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message)) throw invalid();
  if (body.page !== undefined && (typeof body.page !== 'string' || !CHAT_PAGE_PATTERN.test(body.page))) throw invalid();
  return { message, page: body.page };
}

const withRoute = key => (CHAT_ROUTES[key] ? { route: CHAT_ROUTES[key].route, goLabel: CHAT_ROUTES[key].goLabel } : {});
const kindLabel = kind => String(kind).replace(/_/g, ' ');

/**
 * @param services              backend services (access, cases)
 * @param getEvidenceService    async () => PolicyEvidenceService (searchPassages, readFacts)
 * @param getReferenceDataPort  async () => ReferenceDataPort (searchProducts)
 */
export function createChatService({ services, getEvidenceService, getReferenceDataPort, env = process.env }) {
  if (!services?.access || !services?.cases || typeof getEvidenceService !== 'function') throw new TypeError('services and getEvidenceService are required.');

  async function ownedCases({ principal, householdId, authorizeCase }) {
    const { cases } = await services.cases.listOpenedBy({ householdId, adultId: principal.adultId, limit: MAX_CASES });
    const usable = [];
    let blocked = 0;
    for (const listed of cases) {
      let caseRecord;
      try { caseRecord = await services.access.requireCase(principal, listed.id, { write: false }); } catch (error) {
        if (['CASE_NOT_FOUND', 'HOUSEHOLD_NOT_FOUND'].includes(error?.code)) continue;
        throw error;
      }
      if (!caseRecord || caseRecord.household_id !== householdId) continue;
      try { await authorizeCase(caseRecord); } catch (error) {
        // A case without a current source-pack grant is reported as not usable, never read.
        if (error?.statusCode === 403) { blocked += 1; continue; }
        throw error;
      }
      usable.push(caseRecord);
    }
    return { usable, blocked };
  }

  async function fromDocuments({ cases, classified }) {
    const evidence = await getEvidenceService();
    const sources = [];
    let excluded = 0;
    for (const caseRecord of cases) {
      if (sources.length >= MAX_SOURCES) break;
      if (classified.factsTopic) {
        const facts = await evidence.readFacts({ caseRecord });
        excluded += facts.excluded.length;
        for (const doc of facts.documents) {
          for (const field of doc.fields) {
            if (field.topic !== classified.factsTopic || field.state === 'unknown' || !field.value) continue;
            sources.push({
              tier: 'household_evidence', label: `${FIELD_LABELS[field.field] ?? 'Value'} in your ${kindLabel(doc.documentKind)}`,
              ...(field.page ? { page: field.page } : {}), ...(field.quote ? { quote: field.quote } : {}), evidenceId: `${doc.documentId}:${field.field}`, _value: field.value,
            });
          }
        }
      }
      if (classified.term) {
        const found = await evidence.searchPassages({ caseRecord, query: classified.term, limit: PASSAGES_PER_CASE });
        if (!classified.factsTopic) excluded += found.excluded.length;
        for (const passage of found.passages) {
          sources.push({
            tier: 'household_evidence', label: passage.title ? `${passage.title} (${kindLabel(passage.kind)})` : `Passage (${kindLabel(passage.kind)})`,
            page: passage.page, quote: passage.snippet, evidenceId: passage.clauseId,
          });
        }
      }
    }
    return { sources: sources.slice(0, MAX_SOURCES), excluded };
  }

  async function fromReference(message) {
    const uin = uinCandidate(message);
    if (!uin || typeof getReferenceDataPort !== 'function') return { sources: [], note: 'reference_not_queried' };
    try {
      const result = await (await getReferenceDataPort()).searchProducts({ uin });
      if (result.stale) return { sources: [], note: 'reference_unavailable' };
      const products = result.data?.products ?? [];
      return {
        sources: products.slice(0, 3).map(product => ({ tier: 'reference', label: `${product.productName}${product.uinRaw ? ` (UIN ${product.uinRaw})` : ''}, public reference data`, evidenceId: product.productId })),
        note: products.length ? null : 'reference_no_match', ambiguous: products.length > 1,
      };
    } catch { return { sources: [], note: 'reference_unavailable' }; }
  }

  async function answer({ principal, householdId, body, authorizeCase }) {
    if (env.CHAT_ENABLED !== 'true') throw Object.assign(new Error('Chat is not configured.'), { code: 'CHAT_NOT_CONFIGURED', statusCode: 503 });
    const { message } = validate(body);
    await services.access.requireHousehold(principal, householdId, { write: false });
    if (!readbackEnabled(env)) throw Object.assign(new Error('Reading values back is disabled.'), { code: 'READBACK_DISABLED', statusCode: 503 });
    const classified = classify(message);
    const done = (status, reply, steps, extra = {}) => {
      const { sources, ...rest } = extra;
      return {
        reply, steps, ...rest, answerStatus: status,
        sources: sources?.length ? sources : [{ tier: 'none', label: status === 'out_of_scope' ? 'No lookup made' : 'Not found in your documents' }],
        contextOnly: true,
      };
    };

    if (classified.intent === 'out_of_scope' || classified.intent === 'decision_request') {
      return done('out_of_scope',
        'I can only look up wording in your own documents and public product details. I cannot decide cover, eligibility, claim approval, payable amounts or consent. Here is where you can go next.',
        ['I read your question as outside what this assistant can look up.', 'No document or reference lookup was made.', 'Use the linked page, or ask about a waiting period, a sub-limit or an exclusion in your documents.'],
        withRoute(classified.intent === 'decision_request' ? 'claims' : (classified.nav ?? 'documents')));
    }

    if (classified.intent === 'product_lookup') {
      const ref = await fromReference(message);
      if (ref.sources.length) {
        return done('evidence_found',
          `Public reference data lists: ${ref.sources.map(s => s.label).join('; ')}.${ref.ambiguous ? ' More than one product matched, so none is chosen for you.' : ''} This is general context, not about your own policy.`,
          ['I read your question as a product lookup.', 'I searched public reference data using only the UIN you typed.', 'Reference data is context only. Check your own documents for your cover.'],
          { sources: ref.sources, ...withRoute('documents') });
      }
      const why = ref.note === 'reference_unavailable' ? 'Public product data is not available right now.'
        : ref.note === 'reference_no_match' ? 'No product matched that UIN in public reference data.'
          : 'To look up a product, type its UIN (the insurer product code, not your personal policy number).';
      return done('unknown', `${why} This was not found in your documents either.`,
        ['I read your question as a product lookup.', ref.note === 'reference_not_queried' ? 'No lookup was made without a UIN.' : 'The public reference lookup returned nothing usable.', 'Open your documents to check the policy name and UIN.'],
        withRoute('documents'));
    }

    const { usable, blocked } = await ownedCases({ principal, householdId, authorizeCase });
    const found = usable.length ? await fromDocuments({ cases: usable, classified }) : { sources: [], excluded: 0 };
    const unusable = found.excluded + blocked;
    const skipped = unusable ? ` ${unusable} document${unusable === 1 ? ' was' : 's were'} not used because reading permission is missing or the document is not read yet.` : '';
    const steps = [
      'I read your question as a lookup in your own documents.',
      `I looked through ${usable.length} of your case${usable.length === 1 ? '' : 's'} where reading is permitted.`,
      found.sources.length ? 'I am showing wording exactly as stored. Open the document to check it.' : 'Nothing matched, so I am not guessing. Open your documents to add or read a policy.',
    ];
    if (!found.sources.length) return done('unknown', `This was not found in your documents.${skipped}`, steps, withRoute('documents'));
    const lines = found.sources.map(source => (source._value
      ? `${source.label}: ${source._value}${source.page ? ` (page ${source.page})` : ''}.`
      : `${source.page ? `Page ${source.page}` : 'Your documents'}: "${source.quote}"`));
    const sources = found.sources.map(({ _value, ...rest }) => rest);
    const first = sources.find(source => source.page);
    return done('evidence_found', `From your documents. ${lines.join(' ')} ${NOTICE}${skipped}`, steps,
      { sources, ...(first ? { pageRef: `Page ${first.page}` } : {}), ...withRoute('documents') });
  }

  return Object.freeze({ answer });
}

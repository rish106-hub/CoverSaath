import { ReferenceDataError, referenceDataEnabled, referenceFailureState, noUsableFactsError } from '../../integrations/index.js';
import { matchFssVersion, MATCH_OUTCOMES } from '../../features/insurance-rules/fss-version-match.js';
import { mapFssFacts, fssEvidence } from '../../features/policy-facts/fss-fact-map.js';
import { cacheKeyFor } from './reference-data-port.js';

// The FSS reference reader (ADR 0034): the insurer tier of a holding. It plugs into the holdings service as `referenceFacts`.
//
//   refresh({ householdId, holding })     JOB ONLY (holding.fetch_reference). Matches the owner-confirmed product to exactly one FSS version
//                                         and reads that version's facts through the reference port (cache first, one lease, bounded timeout,
//                                         breaker). Never throws a ReferenceDataError: every failure becomes a closed outcome code
//                                         (REFERENCE_OUTCOMES) that the caller stores on the holding. No retry here, no retry storm.
//   forHolding({ householdId, holding })  READ SIDE (collate, queueCollate). Cache only (port.peek): it never calls FSS. Returns the four mapped
//                                         families as reference items for collate.js: { factKey, value, origin: 'reference', refId, cacheKey,
//                                         version, quote: null, reference: <sealed evidence> }. Nothing is returned until refresh has cached
//                                         the match and the facts, and an unusable or withheld family is simply absent.
//
// UIN rule: the confirmed UIN is read from policy_profiles inside this process and used only as a search parameter. It is in no return
// value, no log line (this file logs nothing), no job payload and no sealed evidence.

const MISS = Symbol('cache miss');
const LIVE_LOOKUP = Object.freeze({
  'insurers.resolve': (port, params) => port.resolveInsurer(params),
  'products.search': (port, params) => port.searchProducts(params),
  'products.versions': (port, params) => port.listVersions(params),
});

export function createFssReferenceFacts({ port, repository, env = process.env }) {
  if (!port || !repository) throw new TypeError('createFssReferenceFacts needs a reference port and a holdings repository.');
  const enabled = () => referenceDataEnabled(env);

  // The own-PDF start date (extracted_unverified): the policy period's start, else the start date fact. Null when the schedule has none.
  async function startDateOf({ householdId, holding }) {
    const document = await repository.holdingDocument({ householdId, documentId: holding.documentId });
    if (!document) return null;
    const own = await repository.ownCandidates({ householdId, documentId: holding.documentId, sourceVersion: document.sourceVersion });
    for (const key of ['policy_period', 'start_date']) {
      const fact = own.find(item => item.factKey === key && item.state === 'extracted_unverified' && item.value);
      const iso = fact?.value?.startIso ?? fact?.value?.iso;
      if (typeof iso === 'string') return iso;
    }
    return null;
  }

  async function context({ householdId, holding }) {
    const uin = holding.policyProfileId ? await repository.confirmedUin({ householdId, policyProfileId: holding.policyProfileId }) : null;
    const names = (await repository.confirmedNames({ householdId, holdings: [holding] })).get(holding.id);
    return { uin, insurerName: names?.insurerName ?? null, productName: names?.productName ?? null, startDate: await startDateOf({ householdId, holding }) };
  }

  const liveLookup = async (endpoint, params) => (await LIVE_LOOKUP[endpoint](port, params)).data;
  const cachedLookup = async (endpoint, params) => {
    const hit = await port.peek(endpoint, params);
    if (!hit) throw MISS;
    return hit.data;
  };

  function items({ facts, versionId, version }) {
    const cacheKey = cacheKeyFor('versions.facts', { versionId });
    return mapFssFacts(facts).map(({ factKey, value, fact }) => {
      const reference = fssEvidence({ fact, versionId, cacheKey });
      return { factKey, value, origin: 'reference', refId: reference.refId, cacheKey, version, quote: null, reference };
    });
  }

  return Object.freeze({
    enabled,

    /** Live check. Resolves one of REFERENCE_OUTCOMES: 'attached', or the failure state of the first step that failed. */
    async refresh({ householdId, holding }) {
      if (!enabled()) return 'disabled';
      try {
        const matched = await matchFssVersion({ lookup: liveLookup, ...await context({ householdId, holding }) });
        if (matched.outcome !== MATCH_OUTCOMES.matched) return matched.outcome;
        const { data } = await port.getAllFacts({ versionId: matched.versionId });
        if (items({ facts: data.facts, versionId: matched.versionId, version: data.wordingVersion }).length === 0) throw noUsableFactsError();
        return 'attached';
      } catch (error) {
        if (error instanceof ReferenceDataError) return referenceFailureState(error);
        throw error;
      }
    },

    /** Cache-only read for collate. Empty on a miss, when disabled, or when nothing maps. */
    async forHolding({ householdId, holding }) {
      if (!enabled()) return [];
      try {
        const matched = await matchFssVersion({ lookup: cachedLookup, ...await context({ householdId, holding }) });
        if (matched.outcome !== MATCH_OUTCOMES.matched) return [];
        const hit = await port.peekFacts({ versionId: matched.versionId });
        if (!hit) return [];
        const facts = await collectCachedPages({ port, versionId: matched.versionId, first: hit.data });
        return items({ facts: facts.facts, versionId: matched.versionId, version: facts.wordingVersion });
      } catch (error) {
        if (error === MISS || error instanceof ReferenceDataError) return [];
        throw error;
      }
    },
  });
}

// The facts of every cached page (at most 5, the integration's cap), by cursor. A missing page ends the walk: partial facts are
// still facts, and the next refresh fills the rest.
async function collectCachedPages({ port, versionId, first }) {
  let merged = { ...first, facts: [...first.facts] };
  let cursor = first.nextCursor ?? null;
  for (let page = 1; page < 5 && cursor !== null; page += 1) {
    const hit = await port.peekFacts({ versionId, cursor });
    if (!hit) break;
    merged = { ...merged, facts: [...merged.facts, ...hit.data.facts] };
    cursor = hit.data.nextCursor ?? null;
  }
  return merged;
}

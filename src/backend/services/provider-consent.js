import { findScopedGrant, requireScopedGrant } from '../repositories/holdings-common.js';
import { CHAT_CONSENT_PURPOSE, CHAT_SCOPE, EMBED_SCOPE } from '../../contracts/data-purpose-registry.js';

// Provider-call consent for chat and embedding (audit F1, invariant 2). The grant is resolved SERVER SIDE (the request never names it):
// the acting adult's newest active grant with purpose coverage_reconstruction whose scope names household / derive / insurance_question
// and exactly the recipient the call goes to (anthropic for the chat model, voyage for embeddings). No grant: nothing is sent.
// `require` re-checks the same grant right before dispatch; the commit paths (ChatRepository.appendExchange, MemoryChunkRepository.replace)
// re-check it again inside their transaction. Consent and notice wording is DRAFT and FOR LEGAL REVIEW.
export const PROVIDER_SCOPES = Object.freeze({ chat: CHAT_SCOPE, embed: EMBED_SCOPE });

export function createProviderConsent({ database, clock = () => new Date() }) {
  if (!database) throw new TypeError('A database is required.');
  const scopeOf = kind => { const scope = PROVIDER_SCOPES[kind]; if (!scope) throw new TypeError('Unknown provider consent kind.'); return scope; };
  return Object.freeze({
    /** Resolves the grant id for `kind` ('chat' | 'embed'), or null. `adultId` null (a worker) accepts any adult's grant of the household. */
    async resolve({ householdId, adultId = null, kind }) {
      return findScopedGrant(database, { householdId, purpose: CHAT_CONSENT_PURPOSE, subjectAdultId: adultId, scope: scopeOf(kind), now: clock().toISOString() });
    },
    /** Throws CONSENT_REQUIRED (403) unless the grant is current and exact for `kind`. */
    async require({ householdId, adultId = null, grantId, kind }) {
      await requireScopedGrant(database, { householdId, grantId, purpose: CHAT_CONSENT_PURPOSE, subjectAdultId: adultId, scope: scopeOf(kind), now: clock().toISOString() });
    },
  });
}

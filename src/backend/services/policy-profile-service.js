import { CURATED_PRODUCT_RECORDS, extractUins } from '../../features/decision-catalogue/index.js';
import { flattenBlock } from '../../features/ai-analysis/eval-extractor.js';
import { parseProfileStatement } from '../repositories/policy-profile-repository.js';

// Policy profile service (ADR 0024, policy facts slice 1). Off unless POLICY_FACTS_ENABLED is exactly "true".
//
// GET: what the owner confirmed (opened values only) plus deterministic proposals computed on the spot from the stored OCR text.
//      A proposal is never stored, except the public UIN and the insurer code, which are stored as 'extracted_unverified' the first
//      time a version is read. The policy name and the insurer name are never stored before the owner confirms them.
// POST confirm: the owner's own statement (state 'reported', source 'user_statement', ADR 0009), written by the repository.
// No model and no provider call happens here. The route has already proved the caller owns the document.

export const policyFactsEnabled = (env = process.env) => env.POLICY_FACTS_ENABLED === 'true';

const MAX_TEXT_CHARS = 1_000_000;
const INSURER_PREFIX = /^[A-Z]{3}/;

function coded(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

const staticLookup = uin => {
  const record = CURATED_PRODUCT_RECORDS.find(item => item.uin === uin);
  return record ? { insurerName: record.insurer ?? null, policyName: record.productName ?? null } : null;
};

const NO_PROPOSALS = Object.freeze({ uin: null, insurerCode: null, insurerName: null, policyName: null, conflicts: Object.freeze([]) });

/**
 * @param repository   PolicyProfileRepository
 * @param ocr          OcrRepository (stored pages and the consent-gated read)
 * @param curatedLookup optional (uin) => { insurerName, policyName } | null, public curated product data
 */
export function createPolicyProfileService({ repository, ocr, env = process.env, clock = () => new Date(), curatedLookup = staticLookup }) {
  const requireEnabled = () => {
    if (!policyFactsEnabled(env)) throw coded('POLICY_FACTS_DISABLED', 'Policy facts are disabled.', 503);
  };

  const requireReadyDocument = document => {
    if (document?.lifecycleState !== 'active') throw coded('POLICY_PROFILE_NOT_READY', 'The document is not available yet.', 409);
  };

  // The stored text of a document, only while every succeeded OCR job that holds its pages still has a current exact reading
  // grant (the same gate as the read-back routes). Null when the text may not be read now.
  async function readableText(document) {
    const latest = await ocr.getLatestJobForDocument(document.id);
    if (latest?.status !== 'succeeded') return null;
    const holders = await ocr.getJobsHoldingPages(document.id);
    if (!holders.length || holders.some(job => job.provider !== 'sarvam')) return null;
    const at = clock().toISOString();
    for (const job of holders) {
      const authorization = job.authorization;
      const ready = authorization?.consentGrantId && authorization.requestedByAdultId
        ? await ocr.getReadyDocument(document.id, at, { consentGrantId: authorization.consentGrantId, requestedByAdultId: authorization.requestedByAdultId, recipient: 'sarvam' })
        : null;
      if (!ready) return null;
    }
    let stored;
    try {
      stored = await ocr.getDocumentBlockPages({ documentId: document.id, householdId: document.householdId });
    } catch (error) {
      if (['OCR_PAGES_UNAVAILABLE', 'OCR_PAGES_INCOMPLETE', 'DOCUMENT_NOT_FOUND'].includes(String(error?.code))) return null;
      throw error;
    }
    let text = '';
    for (const page of stored.pages) {
      for (const block of page.blocks ?? []) {
        text += `${flattenBlock(block)}\n`;
        if (text.length > MAX_TEXT_CHARS) return text.slice(0, MAX_TEXT_CHARS);
      }
    }
    return text;
  }

  function proposalsFrom(text) {
    if (!text) return NO_PROPOSALS;
    const uins = extractUins(text);
    if (uins.length > 1) return Object.freeze({ ...NO_PROPOSALS, conflicts: Object.freeze(['uin']) });
    if (uins.length === 0) return NO_PROPOSALS;
    const [uin] = uins;
    const curated = curatedLookup(uin);
    return Object.freeze({
      uin,
      insurerCode: INSURER_PREFIX.exec(uin)?.[0] ?? null,
      insurerName: curated?.insurerName ?? null,
      policyName: curated?.policyName ?? null,
      conflicts: Object.freeze([]),
    });
  }

  const profileView = profile => (profile
    ? { states: profile.states, confirmed: profile.confirmed, confirmedAt: profile.confirmedAt }
    : null);

  async function view(document) {
    const profile = await repository.get({ householdId: document.householdId, documentId: document.id, sourceVersion: document.sourceVersion });
    return {
      documentId: document.id,
      sourceVersion: document.sourceVersion,
      version: profile?.version ?? 0,
      totalPages: await repository.pageCount({ householdId: document.householdId, documentId: document.id }),
      profile: profileView(profile),
    };
  }

  return Object.freeze({
    enabled: () => policyFactsEnabled(env),

    async get({ document }) {
      requireEnabled();
      requireReadyDocument(document);
      const text = await readableText(document);
      const proposals = proposalsFrom(text);
      if (text !== null && (proposals.uin || proposals.conflicts.includes('uin'))) {
        await repository.seedExtracted({
          householdId: document.householdId, caseId: document.caseId, documentId: document.id, sourceVersion: document.sourceVersion,
          uin: proposals.uin, uinState: proposals.uin ? 'extracted_unverified' : 'conflicting',
          insurerCode: proposals.insurerCode, insurerState: proposals.insurerCode ? 'extracted_unverified' : 'unknown',
        });
      }
      return {
        ...await view(document),
        textRead: text !== null,
        proposals: { uin: proposals.uin, insurerCode: proposals.insurerCode, insurerName: proposals.insurerName, policyName: proposals.policyName, conflicts: [...proposals.conflicts] },
      };
    },

    async confirm({ document, adultUserId, body, idempotencyKey }) {
      requireEnabled();
      const statement = parseProfileStatement(body);
      requireReadyDocument(document);
      await repository.confirm({ householdId: document.householdId, documentId: document.id, adultUserId, statement, idempotencyKey });
      return view(document);
    },
  });
}

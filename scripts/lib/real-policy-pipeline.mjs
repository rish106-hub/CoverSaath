// Owner-run mode for `eval:questions`: asks an already-running CoverSaath API (existing /api/v1 routes only) about
// documents the owner has uploaded and verified. Opt-in: refuses unless RUN_POLICY_QUESTIONS_LIVE=1. Costs whatever the
// server's provider features cost. Nothing here logs the bearer token, answers, quotes or document text.
//
// Environment (names only; values are never printed):
//   RUN_POLICY_QUESTIONS_LIVE=1     explicit opt-in
//   EVAL_BASE_URL                   e.g. http://127.0.0.1:8787 (use a controlled environment you own)
//   EVAL_BEARER_TOKEN               household bearer token
//   EVAL_HOUSEHOLD_ID               household that owns the documents
//   EVAL_DOCUMENT_IDS               comma list of kind=documentId, e.g. schedule=<id>,terms=<id>
//
// Routes used: GET /api/v1/documents/{id}/policy-facts (extraction), POST /api/v1/households/{id}/chat (answer, sources).
// Limit: the API returns only the sources cited by the answer, so "retrieved" is those cited sources. Retrieval recall
// therefore equals citation presence in this mode and cannot show a passage retrieved but not cited.

export const LIVE_FLAG = 'RUN_POLICY_QUESTIONS_LIVE';
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

export function readRealConfig(env) {
  if (env[LIVE_FLAG] !== '1') throw Object.assign(new Error(`Real mode is opt-in. Set ${LIVE_FLAG}=1 to run it against your own API and documents.`), { code: 'LIVE_NOT_ENABLED' });
  const missing = ['EVAL_BASE_URL', 'EVAL_BEARER_TOKEN', 'EVAL_HOUSEHOLD_ID', 'EVAL_DOCUMENT_IDS'].filter(name => !env[name]);
  if (missing.length) throw Object.assign(new Error(`Missing environment variables: ${missing.join(', ')}.`), { code: 'LIVE_CONFIG_MISSING' });
  const baseUrl = new URL(env.EVAL_BASE_URL);
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw Object.assign(new Error('EVAL_BASE_URL must be http or https.'), { code: 'LIVE_CONFIG_INVALID' });
  const documents = new Map();
  for (const part of env.EVAL_DOCUMENT_IDS.split(',').map(text => text.trim()).filter(Boolean)) {
    const [kind, id] = part.split('=');
    if (!kind || !id || !DOCUMENT_ID_PATTERN.test(id)) throw Object.assign(new Error('EVAL_DOCUMENT_IDS must look like kind=documentId,kind=documentId.'), { code: 'LIVE_CONFIG_INVALID' });
    documents.set(id, kind);
  }
  if (!DOCUMENT_ID_PATTERN.test(env.EVAL_HOUSEHOLD_ID)) throw Object.assign(new Error('EVAL_HOUSEHOLD_ID has an invalid shape.'), { code: 'LIVE_CONFIG_INVALID' });
  return { baseUrl: baseUrl.origin, token: env.EVAL_BEARER_TOKEN, householdId: env.EVAL_HOUSEHOLD_ID, documents };
}

const stringify = value => (value === null || value === undefined ? null : typeof value === 'object' ? JSON.stringify(value) : String(value));

/** Maps one chat reply to the harness result shape. Exported for tests; uses only fields the chat route returns. */
export function chatToResult(item, reply, documents, factValue) {
  const sources = (Array.isArray(reply?.sources) ? reply.sources : []).filter(source => source?.tier === 'household_evidence' && Number.isInteger(source.page));
  const refs = sources.map(source => {
    const documentId = String(source.evidenceId ?? '').split(':')[0];
    return documents.has(documentId) ? { documentKind: documents.get(documentId), page: source.page } : null;
  }).filter(Boolean);
  const answered = reply?.answerStatus === 'evidence_found' && refs.length > 0;
  return { id: item.id, retrieved: refs, extractedValue: factValue, answer: { value: answered ? String(reply.reply ?? '') : null, citations: answered ? refs : [] } };
}

export function createRealPipeline(config, { fetchImpl = globalThis.fetch } = {}) {
  const call = async (path, init = {}) => {
    const response = await fetchImpl(`${config.baseUrl}${path}`, { ...init, headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', ...init.headers } });
    if (!response.ok) throw Object.assign(new Error(`API call failed: ${init.method ?? 'GET'} ${path.replace(/[0-9a-f-]{16,}/gi, ':id')} returned ${response.status}.`), { code: 'LIVE_API_ERROR' });
    return response.json();
  };
  return Object.freeze({
    async run(questions) {
      const facts = new Map();
      for (const documentId of config.documents.keys()) {
        const body = await call(`/api/v1/documents/${encodeURIComponent(documentId)}/policy-facts`);
        for (const fact of body.facts ?? []) if (fact.state !== 'unknown' && !facts.has(fact.factType)) facts.set(fact.factType, stringify(fact.value));
      }
      const results = [];
      for (const item of questions) {
        const reply = await call(`/api/v1/households/${encodeURIComponent(config.householdId)}/chat`, { method: 'POST', body: JSON.stringify({ message: item.question }) });
        results.push(chatToResult(item, reply, config.documents, item.expectedFactKey ? (facts.get(item.expectedFactKey) ?? null) : null));
      }
      return results;
    },
  });
}

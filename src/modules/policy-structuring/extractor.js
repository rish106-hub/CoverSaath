// Per-chunk model extraction. The provider call is injected and already sits behind the privacy gate
// (central index.js); this module never imports an SDK or fetch. Consent is re-checked before every call,
// caps are hard, there are no retries, and every chunk ends with an outcome.
import { getPolicyParameterRegistry } from '../coverage-analysis/policy-parameter-registry.js';
import { comparisonKey, validateExtractedItems } from './validator.js';
import {
  EXTRACTION_SCHEMA, STRUCTURING_EXTRACT_TASK, STRUCTURING_INSTRUCTIONS,
} from '../ai-analysis/structuring-contract.js';

export { EXTRACTION_SCHEMA };

export const EXTRACTOR_VERSION = 'policy-structuring-extractor/v3';
export const STRUCTURING_LIMITS = Object.freeze({
  maxCallsPerDocument: 30, maxChunksPerCall: 3, maxCharsPerCall: 9000,
  maxInputTokensPerDocument: 250000, maxOutputTokensPerDocument: 150000, maxItemsPerChunk: 80,
});

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

export function registryCatalog(registryVersion) {
  let registry;
  try { registry = getPolicyParameterRegistry(registryVersion); } catch { fail('STRUCTURING_INPUT_INVALID', 'Unknown registry version.'); }
  return Object.freeze(registry.parameters.filter(entry => entry.modelExtraction.allowed)
    .map(({ key, label, valueType }) => Object.freeze({ key, label, valueType })));
}

const estimateTokens = batch => Math.ceil(batch.reduce((sum, chunk) => sum + chunk.text.length, 0) / 4);
const tokens = value => (Number.isFinite(value) && value > 0 ? value : 0);

export function errorReason(error) {
  if (/TIMEOUT/i.test(String(error?.code ?? '')) || ['AbortError', 'TimeoutError'].includes(error?.name)) return 'timeout';
  return 'provider_error';
}

function plan(chunks, limits, outcomes) {
  const batches = [];
  let current = [];
  let chars = 0;
  for (const chunk of chunks) {
    if (chunk.text.length > limits.maxCharsPerCall) { outcomes[chunk.id] = { status: 'skipped', reason: 'chunk_too_large' }; continue; }
    if (current.length && (current.length >= limits.maxChunksPerCall || chars + chunk.text.length > limits.maxCharsPerCall)) {
      batches.push(current); current = []; chars = 0;
    }
    current.push(chunk); chars += chunk.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

const dedupeKey = item => JSON.stringify([item.chunkId, item.parameterKey ?? item.proposedKey, item.value.subject, comparisonKey(item.value), item.evidenceQuote]);

function collect(json, batch, registryVersion, limits, out, outcomes) {
  const byId = new Map(batch.map(chunk => [chunk.id, []]));
  for (const item of json.items) {
    out.rawItems += 1;
    const bucket = item && typeof item === 'object' && typeof item.chunk_id === 'string' ? byId.get(item.chunk_id) : undefined;
    if (!bucket) { out.rejected.push({ reason: item && typeof item === 'object' ? 'unknown_chunk' : 'not_object', chunkId: null }); continue; }
    bucket.push(item);
  }
  for (const chunk of batch) {
    const items = byId.get(chunk.id);
    for (let extra = limits.maxItemsPerChunk; extra < items.length; extra += 1) out.rejected.push({ reason: 'item_cap', chunkId: chunk.id });
    const result = validateExtractedItems(items.slice(0, limits.maxItemsPerChunk), { chunk, registryVersion });
    for (const [list, target] of [[result.accepted, out.accepted], [result.proposals, out.proposals]]) {
      for (const item of list) {
        const key = dedupeKey(item);
        if (out.seen.has(key)) continue;
        out.seen.add(key); target.push(item);
      }
    }
    out.rejected.push(...result.rejected);
    outcomes[chunk.id] = result.accepted.length + result.proposals.length
      ? { status: 'extracted' }
      : { status: 'no_items', reason: items.length ? 'all_items_rejected' : 'none_returned' };
  }
}

function checkInput({ chunks, call, consentCheck }) {
  if (!Array.isArray(chunks) || chunks.some(chunk => !chunk || typeof chunk.id !== 'string' || typeof chunk.text !== 'string')) fail('STRUCTURING_INPUT_INVALID', 'Sectioned chunks are required.');
  if (new Set(chunks.map(chunk => chunk.id)).size !== chunks.length) fail('STRUCTURING_INPUT_INVALID', 'Chunk ids must be unique.');
  if (typeof call !== 'function') fail('STRUCTURING_INPUT_INVALID', 'A provider call is required.');
  if (typeof consentCheck !== 'function') fail('STRUCTURING_INPUT_INVALID', 'A consent check is required.');
}

export async function extractChunks({ chunks, registryVersion, call, consentCheck, limits = {} } = {}) {
  checkInput({ chunks, call, consentCheck });
  const caps = { ...STRUCTURING_LIMITS, ...limits };
  const catalog = registryCatalog(registryVersion);
  const outcomes = {};
  const out = { accepted: [], proposals: [], rejected: [], rawItems: 0, seen: new Set() };
  const usage = { inputTokens: 0, outputTokens: 0 };
  let calls = 0;
  let stop = null;
  for (const batch of plan(chunks, caps, outcomes)) {
    if (!stop && calls >= caps.maxCallsPerDocument) stop = 'call_cap';
    if (!stop && (usage.inputTokens + estimateTokens(batch) > caps.maxInputTokensPerDocument || usage.outputTokens >= caps.maxOutputTokensPerDocument)) stop = 'token_cap';
    if (stop) { for (const chunk of batch) outcomes[chunk.id] = { status: 'skipped', reason: stop }; continue; }
    await consentCheck();
    const payload = {
      registry: catalog,
      chunks: batch.map(chunk => ({ chunk_id: chunk.id, page: chunk.page, block_indexes: chunk.blockIndexes, kind: chunk.kind, title: chunk.title, text: chunk.text })),
    };
    let response;
    calls += 1;
    try { response = await call({ task: STRUCTURING_EXTRACT_TASK, system: STRUCTURING_INSTRUCTIONS[STRUCTURING_EXTRACT_TASK], payload, schema: EXTRACTION_SCHEMA }); } catch (error) {
      for (const chunk of batch) outcomes[chunk.id] = { status: 'skipped', reason: errorReason(error) };
      continue;
    }
    usage.inputTokens += tokens(response?.usage?.inputTokens);
    usage.outputTokens += tokens(response?.usage?.outputTokens);
    const json = response?.json;
    if (!json || typeof json !== 'object' || !Array.isArray(json.items)) {
      for (const chunk of batch) outcomes[chunk.id] = { status: 'skipped', reason: 'malformed_response' };
      continue;
    }
    collect(json, batch, registryVersion, caps, out, outcomes);
    if (usage.inputTokens > caps.maxInputTokensPerDocument || usage.outputTokens > caps.maxOutputTokensPerDocument) stop = 'token_cap';
  }
  return { accepted: out.accepted, proposals: out.proposals, rejected: out.rejected, rawItems: out.rawItems, chunkOutcomes: outcomes, calls, usage };
}

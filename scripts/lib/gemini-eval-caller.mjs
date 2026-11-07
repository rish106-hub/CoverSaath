// EVAL ONLY. A direct Gemini generateContent caller for the field-adjudication experiment (scripts/eval-parse.mjs and the
// opt-in tests/evals/parse-accuracy.test.mjs). It sends page snippets of a LOCAL sample document, under the owner's explicit
// --consent=gemini flag, and it does NOT pass through the privacy gate, the model-input seal, the model gateway or the budget
// ledger. It lives under scripts/ so that nothing in src/ can build a provider request (scripts/check-architecture.mjs). The
// product path is createStructuringModelCallFactory. Never import this from src/ and never point it at real household data.
import { ADJUDICATOR_LIMITS } from '../../src/features/ai-analysis/field-adjudicator.js';

function fail(code, message) { throw Object.assign(new Error(message), { code }); }

// Plain generateContent call: temperature 0, JSON schema output. The key never leaves this function.
export function createGeminiEvalCaller({ apiKey, model, fetchImpl = fetch, timeoutMs = ADJUDICATOR_LIMITS.timeoutMs }) {
  if (!apiKey || !model) fail('ADJUDICATOR_CONFIG', 'Gemini key and model are required.');
  return async ({ system, payload, schema }) => {
    const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify(payload) }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) },
      }),
    });
    if (!response.ok) fail('ADJUDICATOR_PROVIDER', `Gemini returned HTTP ${response.status}.`);
    const body = await response.json();
    const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
    let json;
    try { json = JSON.parse(text); } catch { fail('ADJUDICATOR_RESPONSE', 'Gemini output was not valid JSON.'); }
    return { json, usage: { inputTokens: body.usageMetadata?.promptTokenCount, outputTokens: body.usageMetadata?.candidatesTokenCount } };
  };
}

// Gemini's responseSchema uses upper-case type names.
function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema && typeof schema === 'object') {
    return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, key === 'type' && typeof value === 'string' ? value.toUpperCase() : toGeminiSchema(value)]));
  }
  return schema;
}

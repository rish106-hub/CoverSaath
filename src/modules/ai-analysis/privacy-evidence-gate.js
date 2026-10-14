import { createHash } from 'node:crypto';

export const PRIVACY_EVIDENCE_GATE_VERSION = 'knowvia-privacy-evidence-v1';
export const EVIDENCE_DATA_CLASSES = Object.freeze(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);

const SOURCE_STATES = new Set(['known', 'unknown', 'conflict']);
const DEFAULT_LIMITS = Object.freeze({
  maxSources: 30,
  maxRawSourceBytes: 16_000,
  maxSourceBytes: 4_000,
  maxTotalBytes: 48_000,
  maxUpstreamBytes: 12_000,
  maxStructuredDepth: 12,
  maxStructuredItems: 240,
});

function fail(code, message) {
  throw Object.assign(new Error(message), { code, statusCode: 422 });
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail('PRIVACY_GATE_MALFORMED', `${label} must be a plain object.`);
  }
}

function exactKeys(value, allowed, label) {
  plainObject(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    fail('PRIVACY_GATE_MALFORMED', `${label} contains an unsupported field.`);
  }
}

function boundedText(value, max, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    fail('PRIVACY_GATE_MALFORMED', `${label} must be bounded text.`);
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function token(kind, value) {
  return `<${kind}:${digest(String(value)).slice(0, 16)}>`;
}

function opaqueId(kind, value) {
  return `${kind}_${digest(String(value)).slice(0, 24)}`;
}

function isPaymentCard(candidate) {
  const digits = candidate.replace(/[^0-9]/g, '');
  if (digits.length < 13 || digits.length > 19 || /^0+$/.test(digits)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let number = Number(digits[index]);
    if (doubleDigit) {
      number *= 2;
      if (number > 9) number -= 9;
    }
    sum += number;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function rejectRestrictedText(value) {
  const restrictedPatterns = [
    /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/i,
    /\b(?:password|passwd|api[_ -]?key|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token)\b\s*[=:]\s*["']?[^\s,"'}]{6,}/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/i,
  ];
  if (restrictedPatterns.some(pattern => pattern.test(value))) {
    fail('RESTRICTED_EVIDENCE', 'Restricted evidence cannot be sent to a model.');
  }
  const numberCandidates = value.match(/(?:\d[ -]?){13,19}/g) ?? [];
  if (numberCandidates.some(isPaymentCard)) {
    fail('RESTRICTED_EVIDENCE', 'Restricted evidence cannot be sent to a model.');
  }
}

function redactText(value) {
  rejectRestrictedText(value);
  const reasons = new Set();
  const replace = (pattern, kind, reason) => {
    value = value.replace(pattern, match => {
      reasons.add(reason);
      return token(kind, match);
    });
  };

  replace(/\b[A-Z]{5}\d{4}[A-Z]\b/gi, 'PAN', 'DIRECT_IDENTIFIER_PAN');
  replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, 'GOV_ID', 'DIRECT_IDENTIFIER_GOVERNMENT_ID');
  replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, 'EMAIL', 'DIRECT_IDENTIFIER_EMAIL');
  replace(/(?<!\d)(?:\+91[ -]?)?[6-9]\d{9}(?!\d)/g, 'PHONE', 'DIRECT_IDENTIFIER_PHONE');

  value = value.replace(/("(?:case|subject|source|document|adult|member|household|policy|reporter|consent|upload|run)Id"\s*:\s*")([^"]+)(")/gi, (_match, prefix, identifier, suffix) => {
    reasons.add('DIRECT_IDENTIFIER_STRUCTURED_ID');
    return `${prefix}${token('ID', identifier)}${suffix}`;
  });
  value = value.replace(/\b(full\s+name|member\s+name|patient\s+name|insured\s+name|policy\s+holder|date\s+of\s+birth|dob|postal\s+address|home\s+address|policy\s+number)\s*[:=]\s*([^\n,;]{2,100})/gi, (_match, label, identifier) => {
    reasons.add('DIRECT_IDENTIFIER_LABELED_VALUE');
    return `${label}: ${token('IDENTIFIER', identifier.trim())}`;
  });
  value = value.replace(/("(?:displayName|fullName|memberName|patientName|insuredName|dateOfBirth|postalAddress|policyNumber)"\s*:\s*")([^"]+)(")/gi, (_match, prefix, identifier, suffix) => {
    reasons.add('DIRECT_IDENTIFIER_LABELED_VALUE');
    return `${prefix}${token('IDENTIFIER', identifier)}${suffix}`;
  });

  return { text: value, reasons: [...reasons].sort() };
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) end -= 1;
  return { text: value.slice(0, end), truncated: true };
}

export function sanitizeEvidenceTextForStorage(text, { maxBytes = 4_000 } = {}) {
  if (typeof text !== 'string' || text.trim() === '') fail('PRIVACY_GATE_MALFORMED', 'Evidence text must be non-empty text.');
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16_000) fail('PRIVACY_GATE_MALFORMED', 'Storage text byte limit is invalid.');
  if (Buffer.byteLength(text, 'utf8') > 64_000) fail('EVIDENCE_SOURCE_LIMIT', 'Evidence text exceeds its intake byte limit.');
  const redacted = redactText(text);
  const excerpt = truncateUtf8(redacted.text, maxBytes);
  const reasonCodes = new Set(redacted.reasons);
  if (excerpt.truncated) reasonCodes.add('TEXT_TRUNCATED');
  return Object.freeze({
    text: excerpt.text,
    digest: digest(text),
    reasonCodes: Object.freeze([...reasonCodes].sort()),
    truncated: excerpt.truncated,
  });
}

function normalizeDataClass(value, label) {
  if (typeof value !== 'string') fail('PRIVACY_GATE_MALFORMED', `${label} needs a data class.`);
  const normalized = value.toUpperCase();
  if (!EVIDENCE_DATA_CLASSES.includes(normalized)) fail('PRIVACY_GATE_MALFORMED', `${label} has an invalid data class.`);
  return normalized;
}

function resolvePolicies(parameterKeys, resolveParameterPolicy) {
  if (parameterKeys.length === 0) return [];
  if (typeof resolveParameterPolicy !== 'function') {
    fail('PARAMETER_POLICY_REQUIRED', 'A parameter policy resolver is required before model use.');
  }
  return parameterKeys.map(key => {
    const policy = resolveParameterPolicy(key);
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      fail('PARAMETER_NOT_CLASSIFIED', 'An evidence parameter is not classified for model use.');
    }
    const permitted = policy.modelExtraction === true
      || policy.modelExtraction === 'allow'
      || policy.modelExtraction?.allowed === true;
    if (!permitted) fail('PARAMETER_MODEL_DISALLOWED', 'An evidence parameter is not permitted for model extraction.');
    const dataClass = normalizeDataClass(policy.dataClass, 'Parameter policy');
    if (dataClass === 'RESTRICTED') fail('RESTRICTED_EVIDENCE', 'Restricted evidence cannot be sent to a model.');
    const registryVersion = policy.registryVersion ?? null;
    if (registryVersion !== null && (typeof registryVersion !== 'string' || !/^[A-Za-z0-9._/-]{1,120}$/.test(registryVersion))) {
      fail('PRIVACY_GATE_MALFORMED', 'Parameter registry version is invalid.');
    }
    return Object.freeze({ key, dataClass, registryVersion });
  });
}

function sanitizeStructured(value, state, key = '', depth = 0) {
  if (depth > state.limits.maxStructuredDepth) fail('PRIVACY_GATE_MALFORMED', 'Structured evidence is too deeply nested.');
  state.items += 1;
  if (state.items > state.limits.maxStructuredItems) fail('PRIVACY_GATE_MALFORMED', 'Structured evidence has too many items.');
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (typeof value === 'string') {
    if (/(?:^|_)(?:id|ids)$/i.test(key) || /Id(?:s)?$/.test(key)) {
      state.reasons.add('DIRECT_IDENTIFIER_STRUCTURED_ID');
      return token('ID', value);
    }
    const redacted = redactText(value);
    redacted.reasons.forEach(reason => state.reasons.add(reason));
    return redacted.text;
  }
  if (Array.isArray(value)) return value.map(item => sanitizeStructured(item, state, key, depth + 1));
  plainObject(value, 'Structured evidence value');
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(childKey)) fail('PRIVACY_GATE_MALFORMED', 'Structured evidence contains an unsafe key.');
    output[childKey] = sanitizeStructured(childValue, state, childKey, depth + 1);
  }
  return output;
}

function limitsWithDefaults(limits = {}) {
  exactKeys(limits, Object.keys(DEFAULT_LIMITS), 'Privacy gate limits');
  const value = { ...DEFAULT_LIMITS, ...limits };
  for (const [key, number] of Object.entries(value)) {
    if (!Number.isInteger(number) || number <= 0) fail('PRIVACY_GATE_MALFORMED', `${key} must be a positive integer.`);
  }
  if (value.maxRawSourceBytes > 64_000 || value.maxSourceBytes > 16_000 || value.maxTotalBytes > 96_000 || value.maxSources > 30) {
    fail('PRIVACY_GATE_MALFORMED', 'Privacy gate limits exceed their safety ceiling.');
  }
  return Object.freeze(value);
}

export function sanitizeEvidenceForModel(input, { task = 'model_task', resolveParameterPolicy, limits } = {}) {
  const bounded = limitsWithDefaults(limits);
  if (typeof task !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(task)) fail('PRIVACY_GATE_MALFORMED', 'Model task name is invalid.');
  exactKeys(input, ['context', 'sources', 'upstream'], 'Model evidence');
  exactKeys(input.context, ['caseId', 'subjectId', 'purpose', 'requestedFields'], 'Model evidence context');
  const caseId = boundedText(input.context.caseId, 160, 'caseId');
  const subjectId = boundedText(input.context.subjectId, 160, 'subjectId');
  const purpose = boundedText(input.context.purpose, 240, 'purpose');
  if (!Array.isArray(input.context.requestedFields) || input.context.requestedFields.length > 40) {
    fail('PRIVACY_GATE_MALFORMED', 'requestedFields must be a bounded array.');
  }
  const parameterKeys = [...new Set(input.context.requestedFields)];
  for (const key of parameterKeys) {
    if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,119}$/.test(key)) {
      fail('PRIVACY_GATE_MALFORMED', 'A requested parameter key is invalid.');
    }
  }
  const policies = resolvePolicies(parameterKeys, resolveParameterPolicy);
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > bounded.maxSources) {
    fail('EVIDENCE_SOURCE_LIMIT', 'Evidence source count is outside its safety bound.');
  }

  const policyClasses = policies.map(policy => policy.dataClass);
  const safeSources = [];
  const sourceAudit = [];
  const safeIds = new Set();
  for (const source of input.sources) {
    exactKeys(source, ['id', 'version', 'page', 'text', 'status', 'dataClass'], 'Evidence source');
    const rawId = boundedText(source.id, 200, 'source id');
    const version = boundedText(source.version, 120, 'source version');
    if (!(source.page === null || (Number.isInteger(source.page) && source.page >= 1))) fail('PRIVACY_GATE_MALFORMED', 'Source page must be null or a positive integer.');
    if (typeof source.text !== 'string' || source.text.trim() === '') fail('PRIVACY_GATE_MALFORMED', 'Source text must be non-empty text.');
    if (Buffer.byteLength(source.text, 'utf8') > bounded.maxRawSourceBytes) fail('EVIDENCE_SOURCE_LIMIT', 'Evidence source text exceeds its intake byte limit.');
    if (!SOURCE_STATES.has(source.status)) fail('PRIVACY_GATE_MALFORMED', 'Source status is invalid.');
    let dataClass = source.dataClass === undefined
      ? (policyClasses.includes('CONFIDENTIAL') ? 'CONFIDENTIAL' : 'INTERNAL')
      : normalizeDataClass(source.dataClass, 'Evidence source');
    if (dataClass === 'RESTRICTED') fail('RESTRICTED_EVIDENCE', 'Restricted evidence cannot be sent to a model.');

    const storedText = sanitizeEvidenceTextForStorage(source.text, { maxBytes: bounded.maxSourceBytes });
    const safeVersion = redactText(version);
    if (storedText.reasonCodes.length > 0 || safeVersion.reasons.length > 0) dataClass = 'CONFIDENTIAL';
    const reasons = new Set([...storedText.reasonCodes, ...safeVersion.reasons]);
    const safeId = opaqueId('source', rawId);
    if (safeIds.has(safeId)) fail('PRIVACY_GATE_MALFORMED', 'Evidence source IDs must be unique.');
    safeIds.add(safeId);
    safeSources.push({ id: safeId, version: safeVersion.text, page: source.page, text: storedText.text, status: source.status });
    sourceAudit.push(Object.freeze({ sourceId: safeId, digest: storedText.digest, dataClass, page: source.page, version: safeVersion.text, redactionReasonCodes: [...reasons].sort(), inputBytes: Buffer.byteLength(source.text, 'utf8'), outputBytes: Buffer.byteLength(storedText.text, 'utf8') }));
  }

  if (!Array.isArray(input.upstream) || input.upstream.length > 20) fail('PRIVACY_GATE_MALFORMED', 'upstream must be a bounded array.');
  const structuredState = { limits: bounded, items: 0, reasons: new Set() };
  const safeUpstream = sanitizeStructured(input.upstream, structuredState);
  if (Buffer.byteLength(JSON.stringify(safeUpstream), 'utf8') > bounded.maxUpstreamBytes) {
    fail('EVIDENCE_UPSTREAM_LIMIT', 'Structured upstream evidence exceeds its byte limit.');
  }
  const safePurpose = redactText(purpose);
  const safeInput = {
    context: {
      caseId: opaqueId('case', caseId),
      subjectId: opaqueId('subject', subjectId),
      purpose: safePurpose.text,
      requestedFields: parameterKeys,
    },
    sources: safeSources,
    upstream: safeUpstream,
  };
  const totalBytes = Buffer.byteLength(JSON.stringify(safeInput), 'utf8');
  if (totalBytes > bounded.maxTotalBytes) fail('EVIDENCE_TOTAL_LIMIT', 'Sanitized model evidence exceeds its byte limit.');

  const registryVersions = [...new Set(policies.map(policy => policy.registryVersion).filter(Boolean))].sort();
  const redactionReasonCodes = [...new Set([
    ...safePurpose.reasons,
    ...structuredState.reasons,
    ...sourceAudit.flatMap(source => source.redactionReasonCodes),
  ])].sort();
  const audit = Object.freeze({
    gateVersion: PRIVACY_EVIDENCE_GATE_VERSION,
    decision: 'allowed',
    task,
    parameterKeys: Object.freeze([...parameterKeys]),
    registryVersions: Object.freeze(registryVersions),
    sourceCount: safeSources.length,
    sources: Object.freeze(sourceAudit),
    redactionReasonCodes: Object.freeze(redactionReasonCodes),
    totalOutputBytes: totalBytes,
  });
  return Object.freeze({ input: structuredClone(safeInput), audit });
}

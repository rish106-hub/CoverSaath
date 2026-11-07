import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { safeStackFrames } from './frames.js';
import { PINO_REDACT_PATHS, REDACTED, scrubText, scrubValue } from './redact.js';

// Structured JSON logging (ADR 0016). Metadata only: a log line never carries a request or response body, a header, a
// document, OCR text, a prompt, a model output or an error message. Callers cannot add free-form text: events are named
// from a fixed pattern, helpers keep an allowlist of fields, and every line is parsed and scrubbed again just before it
// is written, so an identifier that slipped into any field is replaced instead of printed.

const LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const EVENT_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const CODE = /^[A-Za-z0-9_.-]{1,80}$/;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
// Keys a caller may never set: they belong to pino or to this module.
const RESERVED_KEYS = new Set(['level', 'time', 'service', 'event', 'msg', 'pid', 'hostname', 'v']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

export function newRequestId() {
  // Generated here and never taken from a client header, so a caller cannot put its own text into every log line.
  return `req_${randomBytes(12).toString('base64url')}`;
}

export const safeCode = value => (typeof value === 'string' && CODE.test(value) ? value : null);
const safeId = value => (typeof value === 'string' && SAFE_ID.test(value) ? value : null);
const safeInt = (value, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : null);

/**
 * The only facts about an error that may be logged or reported: its class, a machine code, an HTTP status and (for
 * unexpected failures) the top stack frames. Never its message, detail, cause, query or parameters.
 */
// An application error code: UPPER_SNAKE with at least one underscore, not a Node ERR_* code (same rule as errorResponse).
export const isApplicationCode = value => typeof value === 'string' && /^[A-Z][A-Z0-9]*_[A-Z0-9_]{1,78}$/.test(value) && !value.startsWith('ERR_');

// A startup configuration error says which setting is wrong ("Invalid PORT.") and never carries the value, so its name may be logged.
const settingOf = error => {
  const match = typeof error?.message === 'string' ? /^Invalid ([A-Z][A-Z0-9_]{2,60})\.$/.exec(error.message) : null;
  return match ? match[1] : null;
};

// An error class name is logged only when it is on this closed list: a name such as "Asha" or "ASHA_SHARMA"
// would otherwise pass a shape check and be written as errorType. Anything else is reported as plain Error.
const ERROR_CLASSES = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError', 'AggregateError', 'AbortError',
  'TimeoutError', 'DOMException', 'SystemError', 'DatabaseError', 'AssertionError',
  // This codebase's own classes (each sets this.name to a fixed string).
  'CatalogueError', 'DocumentIntakeError', 'HouseholdReasoningError', 'InsuranceRulesValidationError', 'PdfSandboxError', 'PostgresDatabaseError', 'ProfileIntakeError', 'ProviderAuthorizationError', 'ProviderUnavailableError', 'UnconfiguredConnectorError', 'UnverifiedConnectorError',
]);

export function describeError(error, { frames = false } = {}) {
  const raw = error !== null && typeof error === 'object' ? error : {};
  const setting = settingOf(raw);
  const type = typeof raw.name === 'string' && ERROR_CLASSES.has(raw.name) ? raw.name : 'Error';
  const status = safeInt(raw.statusCode ?? raw.status, 100, 599);
  return { errorType: type, errorCode: safeCode(raw.code), ...(setting ? { setting } : {}), ...(status ? { status } : {}), ...(frames ? { frames: safeStackFrames(raw.stack) } : {}) };
}

function sanitizingStream(target) {
  return {
    write(line) {
      let output;
      try {
        output = `${JSON.stringify(scrubValue(JSON.parse(line)))}\n`;
      } catch {
        // Not parseable: still never write it raw.
        output = `${JSON.stringify({ level: 'error', event: 'log_line_unparseable', detail: scrubText(String(line).slice(0, 200)) })}\n`;
      }
      target.write(output);
    },
  };
}

/**
 * @param {object} options
 * @param {object} [options.env] reads LOG_LEVEL (fatal|error|warn|info|debug|trace|silent), default info.
 * @param {{write(chunk: string): unknown}} [options.destination] defaults to standard output (synchronous).
 */
export function createLogger({ env = process.env, destination, level, service = 'knowvia-api' } = {}) {
  const chosen = level ?? env.LOG_LEVEL ?? 'info';
  if (!LEVELS.has(chosen)) throw new Error('Invalid LOG_LEVEL.');
  const target = destination ?? pino.destination({ fd: 1, sync: true });
  const base = pino({
    level: chosen,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: label => ({ level: label }) },
    redact: { paths: [...PINO_REDACT_PATHS], censor: REDACTED },
  }, sanitizingStream(target));

  // Generic events take only these keys, each with a fixed scalar shape. Anything else (a message, detail, note, url, query,
  // an error object, a nested value) is dropped, and the count of dropped keys is logged so the omission is visible.
  const FIELD_SHAPES = {
    errorCode: safeCode,
    code: safeCode,
    reason: value => (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : null),
    signal: value => (typeof value === 'string' && /^SIG[A-Z0-9]{1,12}$/.test(value) ? value : null),
    setting: value => (typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,60}$/.test(value) ? value : null),
    host: value => (typeof value === 'string' && /^[A-Za-z0-9.:-]{1,253}$/.test(value) ? value : null),
    exitCode: value => safeInt(value, -1, 255),
    port: value => safeInt(value, 1, 65_535),
    attempts: value => safeInt(value, 0, 1e6),
    count: value => safeInt(value, 0, 1e9),
  };
  const levelOf = name => (LEVELS.has(name) && name !== 'silent' ? name : 'info');
  // The one place a line is written. Reserved keys are never taken from fields; `event` is written last and validated.
  const write = (levelName, event, fields) => {
    const clean = {};
    for (const [key, value] of Object.entries(fields)) if (!RESERVED_KEYS.has(key)) clean[key] = value;
    base[levelOf(levelName)]({ ...clean, event: typeof event === 'string' && EVENT_NAME.test(event) ? event : 'invalid_event_name' });
  };
  // Free-form callers (info/warn/error/debug/log): only FIELD_SHAPES keys survive.
  const emit = (levelName, event, fields) => {
    const kept = {};
    let dropped = 0;
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (Object.hasOwn(FIELD_SHAPES, key)) kept[key] = FIELD_SHAPES[key](value);
      else dropped += 1;
    }
    write(levelName, event, dropped ? { ...kept, droppedFields: dropped } : kept);
  };

  const api = {
    level: chosen,
    /** A named event. Only the scalar keys in FIELD_SHAPES are kept; every other key is dropped and counted in droppedFields. */
    log: (levelName, event, fields = {}) => emit(levelName, event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    debug: (event, fields) => emit('debug', event, fields),
    /** One line per finished HTTP request. Route is a template; no query string, header or body ever reaches here. */
    request({ requestId, method, route, status, durationMs, errorCode, aborted }) {
      const code = safeInt(status, 100, 599);
      write(code && code >= 500 ? 'error' : 'info', 'http_request', {
        requestId: safeId(requestId), method: METHODS.has(method) ? method : null,
        route: typeof route === 'string' && /^\/[A-Za-z0-9/_:.-]{0,200}$/.test(route) ? route : null,
        status: code, durationMs: safeInt(durationMs, 0, 86_400_000), errorCode: safeCode(errorCode), ...(aborted ? { aborted: true } : {}),
      });
    },
    /** A failed request or background task: class, code, status; stack frames only for unexpected failures. */
    failure(error, { requestId, status, event = 'request_failed', level: levelName } = {}) {
      const described = describeError(error, { frames: !(status >= 100 && status < 500) });
      write(levelName ?? (status >= 500 || !status ? 'error' : 'warn'), event, { requestId: safeId(requestId), ...described, ...(status ? { status: safeInt(status, 100, 599) } : {}) });
    },
    /** One line per audit-chain append: what happened to which opaque record. The audit payload is never logged. */
    audit({ action, resourceType, resourceId, actorType, householdId, caseId } = {}) {
      write('info', 'audit_event', {
        action: safeId(action), resourceType: safeId(resourceType), resourceId: safeId(resourceId),
        actorType: safeId(actorType), householdId: safeId(householdId), caseId: safeId(caseId),
      });
    },
    /** One line per model/OCR provider call: outcome and counts only, never prompt, output or provider error text. */
    provider({ provider, task, outcome, code, latencyMs, inputTokens, outputTokens, costMicroUsd, requestId } = {}) {
      write(outcome === 'ok' ? 'info' : 'warn', 'provider_call', {
        requestId: safeId(requestId), provider: safeId(provider), task: safeId(task), outcome: safeId(String(outcome ?? '')),
        errorCode: safeCode(code), latencyMs: safeInt(Math.round(latencyMs), 0, 86_400_000),
        inputTokens: safeInt(inputTokens, 0, 1e9), outputTokens: safeInt(outputTokens, 0, 1e9), costMicroUsd: safeInt(costMicroUsd, 0, 1e12),
      });
    },
  };
  return Object.freeze(api);
}

/** A logger that writes nothing. The default for createApiServer so tests and embedders stay quiet. */
export const silentLogger = createLogger({ level: 'silent', destination: { write() {} } });

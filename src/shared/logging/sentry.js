import { relativePath, safeStackFrames } from './frames.js';
import { describeError, isApplicationCode, safeCode } from './logger.js';
import { isSensitiveKey, scrubText, scrubValue } from './redact.js';

// Error reporting (ADR 0016). Off unless SENTRY_DSN is set. The SDK is loaded only when it is on. Defence in depth:
// (1) only a sanitised stand-in for the error is ever handed to the SDK (class, code, top frames; no message),
// (2) the SDK runs with sendDefaultPii:false, no breadcrumbs, no tracing and no local variables,
// (3) beforeSend rebuilds the event from an allowlist and scrubs what it keeps.

const DSN = /^https:\/\/[A-Za-z0-9]{8,64}(?::[^@/\s]*)?@[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._-]+)*\/\d{1,12}$/;
const SAFE_TAG = /^[A-Za-z0-9_.:-]{1,64}$/;

// Codes that may appear in an event. A code is trusted only if it is on this list (plus any the host adds), looks like an
// application code (UPPER_SNAKE with an underscore) and is unchanged by scrubbing. A PAN-shaped or name-shaped value is
// therefore never trusted, and an unknown code collapses to UNEXPECTED_ERROR; the exact code is in the log line with the same requestId.
const BASE_CODES = Object.freeze([
  'UNEXPECTED_ERROR', 'DATABASE_UNAVAILABLE', 'BACKEND_UNAVAILABLE', 'BACKEND_REQUEST_FAILED', 'DOCUMENT_STORAGE_NOT_CONFIGURED',
  'PROVIDER_NOT_CONFIGURED', 'PROVIDER_CONTRACT_NOT_VERIFIED', 'PROVIDER_AUTHORIZATION_REQUIRED', 'RATE_LIMITED',
  'DATA_ENCRYPTION_KEY_REQUIRED', 'COLUMN_DECRYPTION_FAILED', 'COLUMN_ENCRYPTION_NOT_CONFIGURED', 'SENTRY_DSN_INVALID',
]);

function createCodeCheck(extra = []) {
  const known = new Set([...BASE_CODES, ...extra]);
  return value => typeof value === 'string' && known.has(value) && isApplicationCode(value) && scrubText(value) === value;
}

const defaultCodeCheck = createCodeCheck();
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function safeFrames(frames) {
  if (!Array.isArray(frames)) return undefined;
  return frames.slice(-12).map(frame => {
    const filename = relativePath(frame.filename);
    const fn = typeof frame.function === 'string' && /^[\w$.<>[\] ]{1,100}$/.test(frame.function) && scrubText(frame.function) === frame.function ? frame.function : undefined;
    // Relative file name and position only: no absolute path (home directories), no source lines, no variables.
    return {
      filename: filename && scrubText(filename) === filename ? filename : undefined, function: fn,
      lineno: Number.isInteger(frame.lineno) ? frame.lineno : undefined,
      colno: Number.isInteger(frame.colno) ? frame.colno : undefined,
      in_app: frame.in_app === true,
    };
  });
}

/** beforeSend: rebuild the event from an allowlist. Exported for the leak tests. */
export const scrubSentryEvent = event => rebuildEvent(event, defaultCodeCheck);

function rebuildEvent(event, trustedCode) {
  const safeMessage = value => (trustedCode(value) ? value : '[message removed]');
  if (event === null || typeof event !== 'object') return null;
  const out = {
    event_id: event.event_id, timestamp: event.timestamp, platform: event.platform, level: event.level,
    release: event.release, environment: event.environment, sdk: event.sdk,
  };
  if (event.exception?.values) {
    out.exception = {
      values: event.exception.values.slice(0, 5).map(item => ({
        type: typeof item.type === 'string' && SAFE_NAME.test(item.type) && scrubText(item.type) === item.type ? item.type : 'Error',
        value: safeMessage(item.value),
        ...(item.stacktrace ? { stacktrace: { frames: safeFrames(item.stacktrace.frames) } } : {}),
        ...(item.mechanism ? { mechanism: { type: SAFE_TAG.test(String(item.mechanism.type)) && scrubText(String(item.mechanism.type)) === String(item.mechanism.type) ? String(item.mechanism.type) : 'generic', handled: item.mechanism.handled === true } } : {}),
      })),
    };
  }
  if (event.message !== undefined) out.message = safeMessage(typeof event.message === 'string' ? event.message : event.message?.formatted);
  if (event.request?.method) out.request = { method: String(event.request.method).toUpperCase().slice(0, 10) };
  if (event.tags && typeof event.tags === 'object') {
    out.tags = Object.fromEntries(Object.entries(event.tags)
      .filter(([key, value]) => SAFE_TAG.test(key) && !isSensitiveKey(key) && typeof value === 'string' && SAFE_TAG.test(value) && scrubText(value) === value));
  }
  if (event.fingerprint) out.fingerprint = scrubValue(event.fingerprint);
  if (event.contexts?.trace) out.contexts = { trace: { trace_id: event.contexts.trace.trace_id, span_id: event.contexts.trace.span_id } };
  // Not copied at all: user, ip_address, server_name, breadcrumbs, extra, modules, request body/headers/cookies/url/query,
  // transaction, spans, and any other context.
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined));
}

/**
 * A stand-in for an error that carries only describeError() facts. The message is the machine code, so a driver
 * message, SQL detail or user value in the original can never reach the SDK.
 */
export function sanitizedError(error, trustedCode = defaultCodeCheck) {
  const facts = describeError(error, { frames: false });
  const stand = new Error(trustedCode(facts.errorCode) ? facts.errorCode : 'UNEXPECTED_ERROR');
  stand.name = SAFE_NAME.test(facts.errorType) && scrubText(facts.errorType) === facts.errorType ? facts.errorType : 'Error';
  stand.stack = `${stand.name}: ${stand.message}\n${safeStackFrames(error?.stack).map(frame => `    ${frame}`).join('\n')}`;
  return stand;
}

const noopReporter = Object.freeze({ enabled: false, captureError() {}, async flush() {}, async close() {} });

/**
 * @param {object} options
 * @param {object} [options.env] SENTRY_DSN (https, required to enable), SENTRY_ENVIRONMENT, SENTRY_RELEASE.
 * @param {object} [options.sentryModule] injected SDK (tests); defaults to a dynamic import of @sentry/node.
 * @param {Function} [options.transport] injected transport factory (tests).
 * @param {string[]} [options.knownCodes] application error codes allowed in an event, added to the built-in list.
 */
export async function initSentry({ env = process.env, sentryModule, transport, knownCodes = [] } = {}) {
  const dsn = typeof env.SENTRY_DSN === 'string' ? env.SENTRY_DSN.trim() : '';
  if (!dsn) return noopReporter;
  // The DSN is a credential: it is checked but never echoed.
  if (!DSN.test(dsn)) throw Object.assign(new Error('Invalid SENTRY_DSN.'), { code: 'SENTRY_DSN_INVALID' });
  const Sentry = sentryModule ?? await import('@sentry/node');
  const trustedCode = createCodeCheck(knownCodes);
  const pick = (name, fallback) => (SAFE_TAG.test(env[name] ?? '') ? env[name] : fallback);
  Sentry.init({
    dsn,
    environment: pick('SENTRY_ENVIRONMENT', env.NODE_ENV === 'production' ? 'production' : 'development'),
    ...(SAFE_TAG.test(env.SENTRY_RELEASE ?? '') ? { release: env.SENTRY_RELEASE } : {}),
    sendDefaultPii: false,
    sendClientReports: false,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSend: event => rebuildEvent(event, trustedCode),
    includeLocalVariables: false,
    tracesSampleRate: 0,
    enableLogs: false,
    enableOpenTelemetrySetup: false,
    // The process handlers in server.js log and report fatal errors themselves, through the sanitiser.
    integrations: defaults => defaults.filter(integration => !['OnUncaughtException', 'OnUnhandledRejection', 'Http', 'NodeFetch', 'Console'].includes(integration.name)),
    ...(transport ? { transport } : {}),
  });
  return Object.freeze({
    enabled: true,
    captureError(error, { requestId } = {}) {
      try {
        Sentry.withScope(scope => {
          const id = safeCode(requestId);
          if (id) scope.setTag('requestId', id);
          Sentry.captureException(sanitizedError(error, trustedCode));
        });
      } catch { /* reporting must never affect a request */ }
    },
    flush: timeoutMs => Sentry.flush(timeoutMs),
    close: timeoutMs => Sentry.close(timeoutMs),
  });
}

import { createProviderBoundary, ProviderAuthorizationError } from '../shared/index.js';
import { createSarvamDocAiTransport } from './doc-ai-transport.js';

const TRANSPORT_METHODS = Object.freeze(['createJob', 'getJob', 'cancelJob', 'normalizeResult']);

// Live use remains off until explicitly enabled. The default transport implements the
// verified modern Document AI contract and keeps the API key on this server boundary.
export function createSarvamOcrProvider({ env = process.env, transport = null, segmenter = null, fetchImpl } = {}) {
  const enabled = env?.SARVAM_OCR_ENABLED === 'true';
  const configured = typeof env?.SARVAM_API_KEY === 'string' && env.SARVAM_API_KEY.trim().length > 0;
  const boundary = createProviderBoundary({
    provider: 'Sarvam OCR',
    env,
    requiredSettings: ['SARVAM_API_KEY'],
    role: 'Consented OCR for manually uploaded documents. Extracted text remains unverified evidence.',
  });
  const resolvedTransport = transport ?? (enabled && configured && segmenter
    ? createSarvamDocAiTransport({
      apiKey: env.SARVAM_API_KEY.trim(), segmenter, fetchImpl,
      timeoutMs: env.SARVAM_OCR_TIMEOUT_MS === undefined ? 30_000 : Number(env.SARVAM_OCR_TIMEOUT_MS),
      maxConcurrent: env.SARVAM_OCR_MAX_CONCURRENT === undefined ? 2 : Number(env.SARVAM_OCR_MAX_CONCURRENT),
      maxRetries: env.SARVAM_OCR_MAX_RETRIES === undefined ? 2 : Number(env.SARVAM_OCR_MAX_RETRIES),
      retryDelayMs: env.SARVAM_OCR_RETRY_DELAY_MS === undefined ? 250 : Number(env.SARVAM_OCR_RETRY_DELAY_MS),
      maxDocumentPages: env.SARVAM_OCR_MAX_DOCUMENT_PAGES === undefined ? 100 : Number(env.SARVAM_OCR_MAX_DOCUMENT_PAGES),
    })
    : null);
  const transportVerified = resolvedTransport && TRANSPORT_METHODS.every(method => typeof resolvedTransport[method] === 'function');

  const authorized = authorization => {
    if (!enabled) throw Object.assign(new Error('Live Sarvam OCR is disabled.'), { code: 'OCR_PROVIDER_DISABLED', statusCode: 503 });
    if (!configured) return boundary.refuse({ authorization });
    const erasure = authorization?.authorized === true && authorization?.purpose === 'document_erasure';
    if (!erasure && (authorization?.authorized !== true || authorization?.recipient !== 'sarvam')) {
      throw new ProviderAuthorizationError('Sarvam OCR');
    }
    if (!transportVerified) return boundary.refuse({ authorization });
  };

  return {
    name: 'sarvam',
    mode: 'live',
    limits: Object.freeze({
      contract: 'verified_transport_required',
      maxPagesPerRequest: 10,
      rawProviderPayloadPersistence: false,
      accuracyClaimed: false,
      outputAuthority: 'unverified_evidence_only',
    }),
    capabilities: boundary.capability,
    health() {
      const base = boundary.health();
      return {
        ...base,
        enabled,
        contractVerified: Boolean(enabled && configured && transportVerified),
        status: !enabled ? 'disabled' : configured && transportVerified ? 'configured_transport_verified' : base.status,
      };
    },
    async createJob({ authorization, document, bytes, requestId, beforeSegmentSubmit } = {}) {
      authorized(authorization);
      // requestId is the durable client identity. A verified transport must use it for
      // idempotent submission and cancellation reconciliation when no provider ref returns.
      return resolvedTransport.createJob({
        authorization, document, bytes, requestId, settings: authorization.settings, beforeSegmentSubmit,
      });
    },
    async getJob({ authorization, jobRef } = {}) {
      authorized(authorization);
      return resolvedTransport.getJob({ authorization, jobRef });
    },
    async cancelJob({ authorization, jobRef, requestId } = {}) {
      if (authorization?.authorized === true && authorization?.purpose === 'document_erasure') {
        return enabled && configured && transportVerified
          ? resolvedTransport.cancelJob({ authorization, jobRef, requestId })
          : { status: 'not_supported', remoteCancellation: false };
      }
      authorized(authorization);
      return resolvedTransport.cancelJob({ authorization, jobRef, requestId });
    },
    normalizeResult(raw, expected) {
      if (!transportVerified) return boundary.refuse({ authorizationRequired: false });
      return resolvedTransport.normalizeResult(raw, expected);
    },
  };
}

import { createProviderBoundary } from '../shared/index.js';

const TRANSPORT_METHODS = Object.freeze(['createJob', 'getJob', 'cancelJob', 'normalizeResult']);

// No endpoint or payload shape is guessed here. Live use requires a separately verified,
// injected transport implementing the provider contract below.
export function createSarvamOcrProvider({ env = process.env, transport = null } = {}) {
  const configured = typeof env?.SARVAM_API_KEY === 'string' && env.SARVAM_API_KEY.trim().length > 0;
  const boundary = createProviderBoundary({
    provider: 'Sarvam OCR',
    env,
    requiredSettings: ['SARVAM_API_KEY'],
    role: 'Consented OCR for manually uploaded documents. Extracted text remains unverified evidence.',
  });
  const transportVerified = transport && TRANSPORT_METHODS.every(method => typeof transport[method] === 'function');

  const authorized = authorization => {
    if (!configured) return boundary.refuse({ authorization });
    if (authorization?.authorized !== true) return boundary.refuse({ authorization });
    if (!transportVerified) return boundary.refuse({ authorization });
  };

  return {
    name: 'sarvam',
    mode: 'live',
    limits: Object.freeze({
      contract: 'verified_transport_required',
      rawProviderPayloadPersistence: false,
      accuracyClaimed: false,
      outputAuthority: 'unverified_evidence_only',
    }),
    capabilities: boundary.capability,
    health() {
      const base = boundary.health();
      return { ...base, contractVerified: Boolean(configured && transportVerified), status: configured && transportVerified ? 'configured_transport_verified' : base.status };
    },
    async createJob({ authorization, document, bytes } = {}) {
      authorized(authorization);
      return transport.createJob({ authorization, document, bytes });
    },
    async getJob({ authorization, jobRef } = {}) {
      authorized(authorization);
      return transport.getJob({ authorization, jobRef });
    },
    async cancelJob({ authorization, jobRef } = {}) {
      authorized(authorization);
      return transport.cancelJob({ authorization, jobRef });
    },
    normalizeResult(raw, expected) {
      if (!transportVerified) return boundary.refuse({ authorizationRequired: false });
      return transport.normalizeResult(raw, expected);
    },
  };
}

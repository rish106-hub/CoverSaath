import { createProviderBoundary } from '../shared/index.js';

export function createSarvamOcrProvider({ env = process.env } = {}) {
  const boundary = createProviderBoundary({
    provider: 'Sarvam OCR',
    env,
    requiredSettings: ['SARVAM_API_KEY'],
    role: 'Consented OCR for manually uploaded documents. Extracted text remains unverified evidence.',
  });

  return {
    capabilities: boundary.capability,
    health: boundary.health,
    async createJob({ authorization } = {}) {
      return boundary.refuse({ authorization });
    },
    async getJob({ authorization } = {}) {
      return boundary.refuse({ authorization });
    },
    async cancelJob({ authorization } = {}) {
      return boundary.refuse({ authorization });
    },
    async verifyWebhook() {
      return boundary.refuse({ authorizationRequired: false });
    },
    normalizeResult() {
      return boundary.refuse({ authorizationRequired: false });
    },
  };
}

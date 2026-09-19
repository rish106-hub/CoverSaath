import { createProviderBoundary } from '../shared/index.js';

export function createGnaniVoiceProvider({ env = process.env } = {}) {
  const boundary = createProviderBoundary({
    provider: 'Gnani',
    env,
    requiredSettings: ['GNANI_API_KEY_ID'],
    role: 'Consented speech transcription and read-back. Calling and transfer are not verified capabilities.',
  });

  return {
    capabilities: boundary.capability,
    health: boundary.health,
    async transcribe({ authorization } = {}) {
      return boundary.refuse({ authorization });
    },
    async synthesize({ authorization } = {}) {
      return boundary.refuse({ authorization });
    },
    async transfer({ authorization } = {}) {
      return boundary.refuse({ authorization });
    },
    async verifyWebhook() {
      return boundary.refuse({ authorizationRequired: false });
    },
  };
}

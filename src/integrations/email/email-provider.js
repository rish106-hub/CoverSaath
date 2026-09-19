import { createProviderBoundary } from '../shared/index.js';

export function createEmailProvider({ env = process.env } = {}) {
  const boundary = createProviderBoundary({
    provider: 'Institutional email',
    env,
    requiredSettings: ['EMAIL_API_KEY', 'EMAIL_FROM'],
    role: 'Send an exact approved question to an exact recipient. Replies remain evidence, not insurer authority.',
  });

  return {
    capabilities: boundary.capability,
    health: boundary.health,
    async sendApprovedMessage({ authorization } = {}) {
      return boundary.refuse({ authorization });
    },
    async getDelivery({ authorization } = {}) {
      return boundary.refuse({ authorization });
    },
    async verifyWebhook() {
      return boundary.refuse({ authorizationRequired: false });
    },
    normalizeEvent() {
      return boundary.refuse({ authorizationRequired: false });
    },
  };
}

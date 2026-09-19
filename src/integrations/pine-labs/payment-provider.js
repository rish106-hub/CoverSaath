import { createProviderBoundary } from '../shared/index.js';

export function createPineLabsPaymentProvider({ env = process.env } = {}) {
  const boundary = createProviderBoundary({
    provider: 'Pine Labs',
    env,
    requiredSettings: ['PINE_LABS_CLIENT_ID', 'PINE_LABS_CLIENT_SECRET'],
    role: 'Explicitly approved hosted premium checkout and reconciliation. Payment is not policy issuance.',
  });

  return {
    capabilities: boundary.capability,
    health: boundary.health,
    async createHostedCheckout({ authorization } = {}) {
      return boundary.refuse({ authorization });
    },
    async getPayment({ authorization } = {}) {
      return boundary.refuse({ authorization });
    },
    async reconcile({ authorization } = {}) {
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

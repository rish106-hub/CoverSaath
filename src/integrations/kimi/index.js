import { defineModelProvider } from '../shared/model-provider.js';

// Config entry only: no SDK is installed (ADR 0030), so a route to this provider answers a typed unknown until an
// adapter is added behind the gateway runner. The model id is a placeholder, not a verified one.
export const KIMI_PROVIDER = defineModelProvider({
  id: 'kimi', sdk: null, keyEnv: 'KIMI_API_KEY', envPrefix: 'KIMI',
  models: { default: 'kimi-k2', classify: 'kimi-k2' },
});

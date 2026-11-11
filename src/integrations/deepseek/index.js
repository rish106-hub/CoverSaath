import { defineModelProvider } from '../shared/model-provider.js';

// Config entry only: no SDK is installed (ADR 0030), so a route to this provider answers a typed unknown until an
// adapter is added behind the gateway runner. The model id is a placeholder, not a verified one.
export const DEEPSEEK_PROVIDER = defineModelProvider({
  id: 'deepseek', sdk: null, keyEnv: 'DEEPSEEK_API_KEY', envPrefix: 'DEEPSEEK',
  models: { default: 'deepseek-chat', classify: 'deepseek-chat' },
});

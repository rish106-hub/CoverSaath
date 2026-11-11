import { defineModelProvider } from '../shared/model-provider.js';

// Config entry only: no SDK is installed (ADR 0030), so a route to this provider answers a typed unknown until an
// adapter is added behind the gateway runner. The model id is a placeholder, not a verified one.
export const OPENAI_PROVIDER = defineModelProvider({
  id: 'openai', sdk: null, keyEnv: 'OPENAI_API_KEY', envPrefix: 'OPENAI',
  models: { default: 'gpt-5', classify: 'gpt-5' },
});

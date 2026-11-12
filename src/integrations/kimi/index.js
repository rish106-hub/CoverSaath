import { defineModelProvider } from '../shared/model-provider.js';

// SDK adapter: @ai-sdk/moonshotai (Moonshot). Key: MOONSHOT_API_KEY. China-hosted (cross-border transfer): never in a default MODEL_PROVIDERS. FOR LEGAL REVIEW.
// Model and rate variables keep the KIMI_ prefix (KIMI_MODEL, KIMI_INPUT_USD_PER_MILLION). The model id is a placeholder.
export const KIMI_PROVIDER = defineModelProvider({
  id: 'kimi', sdk: 'moonshotai', keyEnv: 'MOONSHOT_API_KEY', envPrefix: 'KIMI',
  models: { default: 'kimi-k2', classify: 'kimi-k2' },
});

import { defineModelProvider } from '../shared/model-provider.js';

// SDK adapter: @ai-sdk/deepseek. Key: DEEPSEEK_API_KEY. China-hosted (cross-border transfer): never in a default MODEL_PROVIDERS. FOR LEGAL REVIEW.
// The model id is a placeholder: set DEEPSEEK_MODEL and the rate variables.
export const DEEPSEEK_PROVIDER = defineModelProvider({
  id: 'deepseek', sdk: 'deepseek', keyEnv: 'DEEPSEEK_API_KEY', envPrefix: 'DEEPSEEK',
  models: { default: 'deepseek-chat', classify: 'deepseek-chat' },
});

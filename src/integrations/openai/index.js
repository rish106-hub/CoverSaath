import { defineModelProvider } from '../shared/model-provider.js';

// SDK adapter: @ai-sdk/openai (ai-sdk-runner.js). Key: OPENAI_API_KEY. The model id is a placeholder: set OPENAI_MODEL and the rate variables.
export const OPENAI_PROVIDER = defineModelProvider({
  id: 'openai', sdk: 'openai', keyEnv: 'OPENAI_API_KEY', envPrefix: 'OPENAI',
  models: { default: 'gpt-5', classify: 'gpt-5' },
});

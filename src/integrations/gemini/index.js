import { defineModelProvider } from '../shared/model-provider.js';

// The existing Gemini live path (ai-analysis live runtime) keeps its own GEMINI_* settings; this entry lets the router
// name it. Its SDK adapter is the same one the runtimes use. The model id here is a placeholder; set GEMINI_MODEL.
export const GEMINI_PROVIDER = defineModelProvider({
  id: 'gemini', sdk: 'google', keyEnv: 'GEMINI_API_KEY', envPrefix: 'GEMINI',
  models: { default: 'gemini-2.5-flash', classify: 'gemini-2.5-flash' },
});

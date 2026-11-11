import { defineModelProvider } from '../shared/model-provider.js';

// Default Anthropic models (ADR 0030). Key: ANTHROPIC_API_KEY, from the environment only.
// Rates are never guessed: ANTHROPIC_INPUT_USD_PER_MILLION and ANTHROPIC_OUTPUT_USD_PER_MILLION (and the CLASSIFY_ pair
// for the classification tier) must be set from the provider's price list, else the route is not_configured.
export const ANTHROPIC_PROVIDER = defineModelProvider({
  id: 'anthropic', sdk: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', envPrefix: 'ANTHROPIC',
  models: { default: 'claude-sonnet-5-5', classify: 'claude-haiku-5-5' },
});

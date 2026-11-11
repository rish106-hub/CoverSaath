// A model provider is configuration: an id, the SDK adapter name (or null when none is installed), the environment
// variable that holds its key, and model ids per tier. No key is read here; model-routing reads the environment.
export function defineModelProvider({ id, sdk = null, keyEnv, envPrefix, models }) {
  if (!/^[a-z]+$/.test(id) || !keyEnv || !envPrefix || !models?.default) throw new TypeError('Invalid model provider definition.');
  return Object.freeze({ id, sdk, keyEnv, envPrefix, models: Object.freeze({ ...models }) });
}

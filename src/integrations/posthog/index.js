import { PostHog } from 'posthog-node';

// PostHog product analytics (ADR 0033, complete.md D6). Server side only, through the analytics outbox: the worker drains allowlisted
// events (src/contracts/analytics-events.js) and this adapter hands them to `posthog-node`. It never sees a household, a name or free text:
// the caller passes a salted-hash distinct id, an allowlisted event name and allowlisted properties.
//
// Configuration comes from the environment only: POSTHOG_API_KEY (project key) and POSTHOG_HOST (the ingestion base URL of the project's
// region; never defaulted, never guessed). With either missing the adapter is "not configured": createPosthogClient returns null and the
// drain does nothing. Policy: one attempt per event, a hard timeout, no retry inside the SDK (the outbox row stays unsent and the next
// drain tries again), GeoIP off, no person profile. Errors carry a code only, never a response body or the key.
export const POSTHOG_PROVIDER = Object.freeze({ id: 'posthog', keyEnv: 'POSTHOG_API_KEY', hostEnv: 'POSTHOG_HOST' });

const HOST = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;

/** Returns { apiKey, host } when both are set and the host is an https origin, else null. */
export function readPosthogConfig(env = process.env) {
  const apiKey = typeof env.POSTHOG_API_KEY === 'string' ? env.POSTHOG_API_KEY.trim() : '';
  const host = typeof env.POSTHOG_HOST === 'string' ? env.POSTHOG_HOST.trim().replace(/\/+$/, '') : '';
  return apiKey && HOST.test(host) ? Object.freeze({ apiKey, host }) : null;
}

/**
 * createPosthogClient({ env, clientFactory }) -> { send({ distinctId, event, properties }), close() } | null.
 * `clientFactory(apiKey, options)` is for tests (a stub that records calls); the default builds a posthog-node client.
 */
export function createPosthogClient({ env = process.env, clientFactory = (apiKey, options) => new PostHog(apiKey, options), timeoutMs = 5000 } = {}) {
  const config = readPosthogConfig(env);
  if (!config) return null;
  const client = clientFactory(config.apiKey, {
    host: config.host, flushAt: 1, flushInterval: 0, requestTimeout: timeoutMs, fetchRetryCount: 0, disableGeoip: true, enableLocalEvaluation: false,
  });
  return Object.freeze({
    async send({ distinctId, event, properties }) {
      if (typeof distinctId !== 'string' || !/^[0-9a-f]{64}$/.test(distinctId)) throw Object.assign(new Error('A hashed distinct id is required.'), { code: 'POSTHOG_INPUT_INVALID' });
      try {
        // $process_person_profile false: events only, no person profile is created for the hash.
        await client.captureImmediate({ distinctId, event, properties: { ...properties, $process_person_profile: false }, disableGeoip: true });
      } catch {
        throw Object.assign(new Error('The analytics provider could not be reached.'), { code: 'POSTHOG_SEND_FAILED' });
      }
    },
    async close() {
      try { await client.shutdown(2000); } catch { /* shutting down: nothing to report */ }
    },
  });
}

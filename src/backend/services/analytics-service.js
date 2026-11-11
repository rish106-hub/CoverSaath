import { AnalyticsOutboxRepository } from '../repositories/analytics-outbox-repository.js';

// Product analytics (ADR 0033, complete.md D6). `track` is the one call every event point makes: it never throws and never blocks a user
// flow, and it stores nothing unless ALL of these hold: ANALYTICS_ENABLED is exactly "true", ANALYTICS_DISTINCT_ID_SALT is set (16+ characters),
// and the household holds an active analytics consent grant. `drain` (the worker) sends stored rows through the PostHog adapter.
// FOR LEGAL REVIEW: the analytics purpose, its notice and its consent wording are not final.
export const analyticsEnabled = (env = process.env) => env.ANALYTICS_ENABLED === 'true';

export function createAnalyticsService({ database, repository = new AnalyticsOutboxRepository(database), env = process.env, onError = () => {} } = {}) {
  const salt = () => (typeof env.ANALYTICS_DISTINCT_ID_SALT === 'string' ? env.ANALYTICS_DISTINCT_ID_SALT : '');
  const active = () => analyticsEnabled(env) && salt().length >= 16;
  return Object.freeze({
    enabled: active,
    repository,
    /** Fire-and-forget. Resolves true when a row was stored, false otherwise (flag off, no salt, no consent, or a rejected event). */
    async track({ householdId, event, properties = {} }) {
      if (!active()) return false;
      try {
        if (!await repository.hasConsent(householdId)) return false;
        await repository.enqueue({ householdId, event, properties, salt: salt() });
        return true;
      } catch (error) {
        onError({ type: 'analytics.track_failed', code: typeof error?.code === 'string' ? error.code : 'ANALYTICS_TRACK_FAILED' });
        return false;
      }
    },
    /** One batch through `client.send`. With no client (no key or host) nothing is read or sent. */
    async drain({ client }) {
      if (!active() || !client) return Object.freeze({ sent: 0, failed: 0, dropped: 0, purged: 0, skipped: true });
      return repository.drain({ send: input => client.send(input) });
    },
  });
}

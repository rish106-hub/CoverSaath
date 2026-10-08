import { analyticsConsentCookie, readAnalyticsDecision } from './consent.js';
import { noopAnalytics, sanitizeProductEvent } from './events.js';

// PostHog, constrained for DPDP-minded beta use:
//  - the SDK is downloaded and started only after the person allows analytics (a lazy chunk), so declining or not
//    choosing costs no bytes and runs no third-party code
//  - same-origin api_host (/ingest): the server proxy forwards only with the consent cookie, to a fixed EU host
//  - no autocapture, session replay, heatmaps, surveys or remote feature flags; only allowlisted events
//  - identify() uses the internal adult ID only, never names or contact details
export const POSTHOG_CONFIG = Object.freeze({
  api_host: '/ingest',
  ui_host: 'https://eu.posthog.com',
  persistence: 'localStorage+cookie',
  person_profiles: 'identified_only',
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  capture_dead_clicks: false,
  capture_heatmaps: false,
  rageclick: false,
  disable_session_recording: true,
  disable_surveys: true,
  advanced_disable_flags: true,
  advanced_disable_decide: true,
  disable_external_dependency_loading: true,
  mask_all_text: true,
  mask_all_element_attributes: true,
  capture_exceptions: { capture_unhandled_errors: true, capture_unhandled_rejections: true, capture_console_errors: false },
});
const MAX_QUEUED_CALLS = 50;

/**
 * Returns the analytics port used by the journey controller plus the consent controls used by the banner.
 * Without a project key it is a no-op that still records the person's choice.
 */
export function createProductAnalytics({
  key = import.meta.env.VITE_POSTHOG_KEY,
  loadSdk = () => import('posthog-js').then(module => module.default),
  doc = document,
  secure = location.protocol === 'https:',
  origin = globalThis.location?.origin ?? null,
} = {}) {
  const enabled = typeof key === 'string' && key.length > 0;
  const decision = () => readAnalyticsDecision(doc.cookie);
  const capturing = () => enabled && decision() === 'granted';
  let sdk = null;
  let loading = null;
  const queue = [];

  const start = () => {
    if (!capturing() || sdk || loading) return loading;
    loading = loadSdk().then(loaded => {
      const apiHost = origin ? new URL(POSTHOG_CONFIG.api_host, origin).toString().replace(/\/$/, '') : POSTHOG_CONFIG.api_host;
      loaded.init(key, { ...POSTHOG_CONFIG, api_host: apiHost });
      sdk = loaded;
      // The consent decision may have been made while the lazy SDK chunk was loading. Apply it to the SDK before
      // replaying queued calls; otherwise an SDK/browser opt-out state can silently discard the consent event.
      if (capturing()) sdk.opt_in_capturing({ captureEventName: false });
      // Consent can be withdrawn while the chunk downloads; re-check before replaying.
      for (const call of queue.splice(0)) if (capturing()) call(sdk);
    }).catch(() => { queue.length = 0; loading = null; });
    return loading;
  };
  const withSdk = call => {
    if (!capturing()) return;
    if (sdk) call(sdk);
    else { if (queue.length < MAX_QUEUED_CALLS) queue.push(call); start(); }
  };
  start();

  return Object.freeze({
    enabled,
    decision,
    ready: () => loading ?? Promise.resolve(),
    grant() {
      doc.cookie = analyticsConsentCookie('granted', { secure });
      if (sdk) sdk.opt_in_capturing({ captureEventName: false });
      this.track('consent_granted');
    },
    deny() {
      doc.cookie = analyticsConsentCookie('denied', { secure });
      queue.length = 0;
      if (sdk) { sdk.opt_out_capturing(); sdk.reset(); }
    },
    track(event, properties) {
      const clean = sanitizeProductEvent(event, properties);
      // Product events are sparse and consent-sensitive. Send each accepted event immediately so a short visit or
      // navigation cannot leave the SDK batch queue unsent; the same-origin proxy still enforces consent again.
      if (clean) withSdk(loaded => loaded.capture(clean.event, clean.properties, { send_instantly: true }));
    },
    identify(adultId) {
      if (typeof adultId === 'string' && adultId) withSdk(loaded => loaded.identify(adultId));
    },
    reset() { if (sdk) sdk.reset(); },
  });
}

export { noopAnalytics };

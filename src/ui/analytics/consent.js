// Analytics consent is a first-party, essential cookie: knowvia_consent=v1|analytics=granted|denied.
// The server's /ingest proxy reads the same cookie and forwards nothing without "analytics=granted",
// so a client bug cannot send analytics before the person chooses.
export const CONSENT_COOKIE = 'knowvia_consent';
export const CONSENT_MAX_AGE_SECONDS = 60 * 60 * 24 * 395; // about 13 months, then ask again
const DECISIONS = Object.freeze(['granted', 'denied']);

/** Returns 'granted', 'denied' or null (not decided yet) from a document.cookie string. */
export function readAnalyticsDecision(cookieHeader = '') {
  const raw = String(cookieHeader).match(new RegExp(`(?:^|;\\s*)${CONSENT_COOKIE}=([^;]*)`))?.[1];
  if (!raw) return null;
  let value;
  try { value = decodeURIComponent(raw); } catch { return null; }
  const parts = value.split('|');
  if (parts[0] !== 'v1') return null;
  const decision = parts.find(part => part.startsWith('analytics='))?.slice('analytics='.length);
  return DECISIONS.includes(decision) ? decision : null;
}

/** The Set-Cookie style string to assign to document.cookie for a decision. */
export function analyticsConsentCookie(decision, { secure = false } = {}) {
  if (!DECISIONS.includes(decision)) throw new TypeError('Analytics decision must be granted or denied.');
  return `${CONSENT_COOKIE}=${encodeURIComponent(`v1|analytics=${decision}`)}; Path=/; Max-Age=${CONSENT_MAX_AGE_SECONDS}; SameSite=Lax${secure ? '; Secure' : ''}`;
}

// k6 load script for plan Q2: a steady 50 requests per second against a STAGING deployment. Prepared, not run.
// OWNER APPROVAL REQUIRED to run it: it creates synthetic households and sessions in the target database and sends
// real traffic to the target host. Never point it at production or at a database that holds real data.
//
//   k6 run -e BASE_URL=https://<staging-host> -e BOOTSTRAP_TOKEN=<token> scripts/load/k6-50rps.js
//
// Variables (all read with -e, never written to disk by this script):
//   BASE_URL         required, the staging origin, no trailing slash
//   BOOTSTRAP_TOKEN  required, the staging KNOWVIA_BOOTSTRAP_TOKEN (used once in setup to open synthetic households)
//   RATE             requests per second, default 50
//   DURATION         default 5m
//   HOUSEHOLDS       synthetic households to spread reads over, default 5 (the server allows 100 active sessions by default)
//   P95_MS           p95 latency threshold in ms, default 800. A placeholder, not a measured target.
//
// Staging must raise API_RATE_LIMIT_PER_MINUTE (default 600 per client address, so 50 requests per second from one
// address would be answered 429 after 12 seconds). Set it to at least 6000 on the staging app only.
// The Fly proxy sheds above 80 concurrent requests per machine (fly.toml hard_limit); a 503 here is that limit.
import http from 'k6/http';
import { check, fail } from 'k6';

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/+$/, '');
const BOOTSTRAP_TOKEN = __ENV.BOOTSTRAP_TOKEN || '';
const RATE = Number(__ENV.RATE || 50);
const HOUSEHOLDS = Number(__ENV.HOUSEHOLDS || 5);

export const options = {
  scenarios: {
    steady: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '5m',
      preAllocatedVUs: 60,
      maxVUs: 200,
    },
  },
  thresholds: {
    // Any 4xx or 5xx counts as a failure, including 429 (rate limit) and 503 (proxy shed).
    http_req_failed: ['rate<0.01'],
    http_req_duration: [`p(95)<${Number(__ENV.P95_MS || 800)}`],
    checks: ['rate>0.99'],
  },
};

const json = { 'Content-Type': 'application/json' };

// Opens synthetic households (no real names, e-mails or numbers) and returns their sessions.
export function setup() {
  if (!BASE_URL || !BOOTSTRAP_TOKEN) fail('BASE_URL and BOOTSTRAP_TOKEN are required.');
  const sessions = [];
  for (let index = 0; index < HOUSEHOLDS; index += 1) {
    const response = http.post(`${BASE_URL}/api/v1/households`, JSON.stringify({
      displayName: `Load test household ${index + 1}`,
      owner: { displayName: `Load test adult ${index + 1}` },
    }), { headers: { ...json, Authorization: `Bearer ${BOOTSTRAP_TOKEN}` } });
    if (response.status !== 201) fail(`Could not open a synthetic household (HTTP ${response.status}).`);
    const body = response.json();
    sessions.push({ householdId: body.household.id, token: body.session.token });
  }
  return { sessions };
}

// Mix per iteration: 20% health (no database), 5% ready (schema check), 50% overview and 25% members (authenticated reads).
export default function run(data) {
  const roll = Math.random();
  if (roll < 0.20) {
    check(http.get(`${BASE_URL}/api/v1/health`, { tags: { route: 'health' } }), { 'health 200': r => r.status === 200 });
    return;
  }
  if (roll < 0.25) {
    check(http.get(`${BASE_URL}/api/v1/ready`, { tags: { route: 'ready' } }), { 'ready 200': r => r.status === 200 });
    return;
  }
  const session = data.sessions[Math.floor(Math.random() * data.sessions.length)];
  const headers = { Authorization: `Bearer ${session.token}` };
  const resource = roll < 0.75 ? 'overview' : 'members';
  check(http.get(`${BASE_URL}/api/v1/households/${session.householdId}/${resource}`, { headers, tags: { route: resource } }), {
    [`${resource} 200`]: r => r.status === 200,
  });
}

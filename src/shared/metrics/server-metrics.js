import { createMetricsRegistry, oneOf, word } from './registry.js';

// The metrics this service exposes (ADR 0019, docs/runbooks/alerts.md). Callers pass only route templates, status classes and
// closed-set names; ids, bodies, headers, error messages and free text have no way in.

const METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete', 'options'];
const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx', 'aborted', 'other'];
const ROUTE = value => /^\/[a-z0-9/_:.-]{0,200}$/.test(value);
// The privacy-gate and model-use refusal codes (privacy-evidence-gate.js). Any other code is not a gate refusal.
export const PRIVACY_GATE_REFUSAL_CODES = Object.freeze([
  'PRIVACY_GATE_MALFORMED', 'PRIVACY_ADDRESS_UNCERTAIN', 'RESTRICTED_EVIDENCE', 'PARAMETER_NOT_CLASSIFIED',
  'PARAMETER_MODEL_DISALLOWED', 'PARAMETER_POLICY_REQUIRED', 'EVIDENCE_SOURCE_LIMIT',
]);
const REFUSAL_LABELS = PRIVACY_GATE_REFUSAL_CODES.map(code => code.toLowerCase());

export const statusClass = status => (Number.isInteger(status) && status >= 200 && status <= 599 ? `${Math.floor(status / 100)}xx` : 'other');

export function createServerMetrics({ maxSeries } = {}) {
  const registry = createMetricsRegistry({ maxSeries });
  const requests = registry.counter({ name: 'http_requests_total', help: 'Finished HTTP requests.', labels: { method: oneOf(METHODS), route: ROUTE, status_class: oneOf(STATUS_CLASSES) } });
  const requestSeconds = registry.histogram({ name: 'http_request_duration_seconds', help: 'HTTP request duration in seconds.', labels: { route: ROUTE } });
  const modelCalls = registry.counter({ name: 'model_calls_total', help: 'Model provider calls by task and outcome.', labels: { task: word, outcome: word } });
  const modelSeconds = registry.histogram({ name: 'model_call_duration_seconds', help: 'Model provider call duration in seconds.', labels: { task: word } });
  const modelCost = registry.counter({ name: 'model_cost_micro_usd_total', help: 'Model spend in micro-USD (one millionth of a dollar).' });
  const refusals = registry.counter({ name: 'privacy_gate_refusals_total', help: 'Requests or jobs refused by the privacy gate, by gate code.', labels: { code: oneOf(REFUSAL_LABELS) } });
  const budgetRatio = registry.gauge({ name: 'model_budget_used_ratio', help: 'Reserved plus spent model budget divided by the project cap (0 to 1).' });
  const budgetMaxUsd = registry.gauge({ name: 'model_budget_max_usd', help: 'Project model budget cap in USD.' });
  const queueDepth = registry.gauge({ name: 'document_work_queue_depth', help: 'Documents waiting for a malware scan or byte deletion.' });
  const poolConnections = registry.gauge({ name: 'db_pool_connections', help: 'Database pool connections by state.', labels: { state: oneOf(['in_use', 'idle']) } });
  const poolWaiting = registry.gauge({ name: 'db_pool_waiting_clients', help: 'Callers waiting for a database pool connection.' });
  const poolMax = registry.gauge({ name: 'db_pool_max_connections', help: 'Configured database pool size.' });
  const poolRatio = registry.gauge({ name: 'db_pool_utilisation_ratio', help: 'Connections in use divided by pool size (0 to 1).' });

  return Object.freeze({
    registry,
    render: () => registry.render(),
    /** One finished request. `route` is the logged route template; a client that left has no status. */
    recordRequest({ method, route, status, durationMs, aborted = false }) {
      const cls = aborted ? 'aborted' : statusClass(status);
      requests.inc({ method: String(method ?? '').toLowerCase(), route, status_class: cls });
      if (!aborted && Number.isFinite(durationMs)) requestSeconds.observe({ route }, durationMs / 1000);
    },
    /** One model call (the gateway's metadata-only event). */
    recordModelCall({ task, outcome, latencyMs, costUsd }) {
      const label = String(outcome ?? 'error').toLowerCase();
      modelCalls.inc({ task, outcome: label });
      if (Number.isFinite(latencyMs) && latencyMs >= 0) modelSeconds.observe({ task }, latencyMs / 1000);
      if (Number.isFinite(costUsd) && costUsd > 0) modelCost.inc({}, Math.round(costUsd * 1_000_000));
    },
    /** A refusal by the privacy gate. Only the closed set of gate codes is counted; any other code is ignored. */
    recordPrivacyRefusal(code) {
      if (PRIVACY_GATE_REFUSAL_CODES.includes(code)) refusals.inc({ code: code.toLowerCase() });
    },
    setBudget({ maxUsd, reservedUsd, spentUsd }) {
      if (![maxUsd, reservedUsd, spentUsd].every(Number.isFinite) || maxUsd <= 0) return;
      budgetMaxUsd.set({}, maxUsd);
      budgetRatio.set({}, Math.min(1, Math.max(0, (reservedUsd + spentUsd) / maxUsd)));
    },
    setQueueDepth(count) { queueDepth.set({}, count); },
    setPool({ total, idle, waiting, max }) {
      if (![total, idle, waiting, max].every(Number.isFinite) || max <= 0) return;
      const inUse = Math.max(0, total - idle);
      poolConnections.set({ state: 'in_use' }, inUse);
      poolConnections.set({ state: 'idle' }, idle);
      poolWaiting.set({}, waiting);
      poolMax.set({}, max);
      poolRatio.set({}, Math.min(1, inUse / max));
    },
  });
}

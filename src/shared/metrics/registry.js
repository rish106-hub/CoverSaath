import { scrubText } from '../logging/index.js';

// In-process metrics registry (ADR 0019). Counters, gauges and fixed-bucket histograms, rendered in the Prometheus text
// format. Only numbers and low-cardinality labels can enter, enforced in layers:
//  1. Metric and label names are fixed at registration (lower_snake). A caller cannot invent a label.
//  2. Every label value must pass its label's validator (a closed set or a narrow pattern), match a conservative character
//     set and be unchanged by the log scrubber (so a PAN, Aadhaar, phone or e-mail shape never survives). Anything else is
//     recorded as "other".
//  3. Each metric holds at most `maxSeries` label combinations. Beyond that the sample is dropped and counted in
//     metrics_series_dropped_total, so a bug that makes a label unbounded costs a counter, not memory.
// No value is ever taken from a request body, header, query string or error message; callers pass route templates,
// status classes and closed-set names.

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const LABEL_VALUE = /^[a-z0-9_:./-]{1,96}$/;
export const OTHER = 'other';
export const DEFAULT_MAX_SERIES = 500;
export const DEFAULT_BUCKETS_SECONDS = Object.freeze([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]);
const COLLECTOR_TIMEOUT_MS = 2_000;

/** A validator that accepts only the listed values. */
export const oneOf = values => { const set = new Set(values); return value => set.has(value); };
/** A validator that accepts a short lower_snake word. */
export const word = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,48}$/.test(value);

const finite = value => typeof value === 'number' && Number.isFinite(value);

function safeLabelValue(validator, raw) {
  const value = typeof raw === 'string' ? raw : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : '';
  if (!LABEL_VALUE.test(value) || !validator(value)) return OTHER;
  // Belt and braces: nothing the log scrubber would redact may become a label.
  return scrubText(value) === value ? value : OTHER;
}

const escapeLabel = value => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

export function createMetricsRegistry({ maxSeries = DEFAULT_MAX_SERIES } = {}) {
  if (!Number.isInteger(maxSeries) || maxSeries < 1 || maxSeries > 10_000) throw new TypeError('maxSeries must be an integer between 1 and 10000.');
  const metrics = new Map();
  const collectors = [];
  let dropped = null;

  function register(type, { name, help, labels = {}, buckets }) {
    if (!NAME.test(name) || metrics.has(name)) throw new TypeError(`Invalid or duplicate metric name: ${name}`);
    if (typeof help !== 'string' || !/^[ -~]{1,200}$/.test(help)) throw new TypeError(`Invalid help text for ${name}.`);
    const labelNames = Object.keys(labels);
    for (const label of labelNames) {
      if (!NAME.test(label) || label === 'le' || typeof labels[label] !== 'function') throw new TypeError(`Invalid label ${label} on ${name}.`);
    }
    if (type === 'histogram') {
      if (!Array.isArray(buckets) || buckets.length === 0 || buckets.some((b, i) => !finite(b) || b <= 0 || (i > 0 && b <= buckets[i - 1]))) throw new TypeError(`Invalid buckets for ${name}.`);
    }
    const metric = { type, name, help, labelNames, validators: labels, buckets, series: new Map() };
    metrics.set(name, metric);
    return metric;
  }

  // Resolves the series for a label set, or null when the cap is reached.
  function seriesFor(metric, labelValues, init) {
    const values = metric.labelNames.map(label => safeLabelValue(metric.validators[label], labelValues?.[label]));
    const key = values.join('\u0000');
    let series = metric.series.get(key);
    if (!series) {
      if (metric.series.size >= maxSeries) {
        dropped?.inc({ metric: metric.name });
        return null;
      }
      series = { values, ...init() };
      metric.series.set(key, series);
    }
    return series;
  }

  const counter = options => {
    const metric = register('counter', options);
    return Object.freeze({
      inc(labels, amount = 1) {
        if (!finite(amount) || amount < 0) return;
        const series = seriesFor(metric, labels, () => ({ value: 0 }));
        if (series) series.value += amount;
      },
    });
  };
  const gauge = options => {
    const metric = register('gauge', options);
    return Object.freeze({
      set(labels, value) {
        if (!finite(value)) return;
        const series = seriesFor(metric, labels, () => ({ value: 0 }));
        if (series) series.value = value;
      },
    });
  };
  const histogram = options => {
    const metric = register('histogram', { ...options, buckets: options.buckets ?? DEFAULT_BUCKETS_SECONDS });
    return Object.freeze({
      observe(labels, value) {
        if (!finite(value) || value < 0) return;
        const series = seriesFor(metric, labels, () => ({ counts: new Array(metric.buckets.length).fill(0), sum: 0, count: 0 }));
        if (!series) return;
        series.sum += value;
        series.count += 1;
        for (let i = 0; i < metric.buckets.length; i += 1) if (value <= metric.buckets[i]) series.counts[i] += 1;
      },
    });
  };

  dropped = counter({ name: 'metrics_series_dropped_total', help: 'Samples dropped because a metric reached its series cap.', labels: { metric: word } });

  const labelText = (metric, values, extra = '') => {
    const pairs = metric.labelNames.map((label, index) => `${label}="${escapeLabel(values[index])}"`);
    if (extra) pairs.push(extra);
    return pairs.length ? `{${pairs.join(',')}}` : '';
  };
  const number = value => (Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12))));

  function renderText() {
    const lines = [];
    for (const metric of metrics.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`);
      for (const series of metric.series.values()) {
        if (metric.type === 'histogram') {
          metric.buckets.forEach((bound, index) => lines.push(`${metric.name}_bucket${labelText(metric, series.values, `le="${bound}"`)} ${series.counts[index]}`));
          lines.push(`${metric.name}_bucket${labelText(metric, series.values, 'le="+Inf"')} ${series.count}`);
          lines.push(`${metric.name}_sum${labelText(metric, series.values)} ${number(series.sum)}`);
          lines.push(`${metric.name}_count${labelText(metric, series.values)} ${series.count}`);
        } else {
          lines.push(`${metric.name}${labelText(metric, series.values)} ${number(series.value)}`);
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }

  return Object.freeze({
    counter,
    gauge,
    histogram,
    /** A function run at scrape time (pool, queue and budget gauges). A throw or a slow collector is skipped, never fatal. */
    collect(fn) { collectors.push(fn); },
    /** Prometheus text exposition. */
    async render() {
      await Promise.allSettled(collectors.map(fn => {
        let timer;
        const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('collector timeout')), COLLECTOR_TIMEOUT_MS); timer.unref?.(); });
        return Promise.race([Promise.resolve().then(fn), deadline]).finally(() => clearTimeout(timer));
      }));
      return renderText();
    },
    /** Series count per metric (cardinality checks and tests). */
    seriesCounts() { return Object.fromEntries([...metrics.values()].map(metric => [metric.name, metric.series.size])); },
    maxSeries,
  });
}

// Boundary conversions between application values and Postgres column types.

/** jsonb and text reject U+0000. Strip it from text; JSON.stringify emits it as the escape \u0000. */
export const stripNul = value => (typeof value === 'string' ? value.replaceAll('\u0000', '') : value);

/** JSON text for a jsonb parameter, or null. Never throws on NUL characters inside strings. */
export function jsonParam(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value).replaceAll('\\u0000', '');
}

/** Parses a *_json column read through the adapter (raw JSON text). */
export const parseJson = value => (value == null ? null : JSON.parse(value));

/** USD amounts are stored as integer micro-USD. Callers keep seeing USD numbers. */
export const toMicroUsd = usd => (usd == null ? null : Math.round(Number(usd) * 1_000_000));
export const fromMicroUsd = micro => (micro == null ? null : Number(micro) / 1_000_000);

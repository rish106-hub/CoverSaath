// Presentation helpers only. No business rules live here.

export const EVIDENCE_STATES = Object.freeze([
  Object.freeze(['Proven', 'Quote found on the page of your document']),
  Object.freeze(['Calculated', 'Worked out from proven values']),
  Object.freeze(['Reported', 'Entered by a person, not backed by a quote']),
  Object.freeze(['Dynamic', 'True on a date; confirm it again']),
  Object.freeze(['Unknown', 'Not established. This is not a "no"']),
  Object.freeze(['Conflicting', 'The documents disagree']),
  Object.freeze(['NotPermitted', 'Withheld: you do not have permission to see it']),
]);

const TONES = Object.freeze({
  Proven: 'proven', Calculated: 'calculated', Reported: 'reported', Dynamic: 'dynamic',
  Unknown: 'unknown', Conflicting: 'conflicting', NotPermitted: 'withheld',
});

export const evidenceTone = state => TONES[state] ?? 'unknown';
export const evidenceMeaning = state => EVIDENCE_STATES.find(([name]) => name === state)?.[1] ?? 'Not established';

/** Integer paise to rupees with Indian digit grouping, for example 10000000 -> ₹1,00,000. */
export function formatPaise(minor) {
  if (!Number.isFinite(minor)) return 'Unknown';
  const rupees = minor / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2, maximumFractionDigits: 2,
  }).format(rupees);
}

export const humanize = value => String(value ?? '').replaceAll('_', ' ');

/** Renders a normalised API value ({ kind, ... }) as text. Returns null when there is nothing to show. */
export function displayValue(value, { basis } = {}) {
  if (!value || typeof value !== 'object') return null;
  const suffix = basis && basis !== 'not_applicable' ? ` (${humanize(basis)})` : '';
  switch (value.kind) {
    case 'money': return `${formatPaise(value.amountMinor)}${suffix}`;
    case 'percent': return `${value.percent}%`;
    case 'days': case 'months': case 'years': return `${value.count} ${value.kind}`;
    case 'count': return String(value.count);
    case 'boolean': return value.flag ? 'Yes' : 'No';
    case 'enum': return humanize(value.enumValue);
    case 'date': return value.date;
    case 'text': case 'rule': return value.text;
    case 'text_list': return value.items.join('; ');
    default: return null;
  }
}

/** A proposed value is either a normalised value or the raw model fields. */
export function displayProposed(proposed) {
  if (!proposed) return null;
  if (proposed.kind) return displayValue(proposed);
  if (proposed.valueText) return proposed.valueText;
  if (typeof proposed.valueNumber === 'number') return String(proposed.valueNumber);
  if (typeof proposed.valueBoolean === 'boolean') return proposed.valueBoolean ? 'Yes' : 'No';
  if (Array.isArray(proposed.valueList) && proposed.valueList.length) return proposed.valueList.join('; ');
  return null;
}

export function formatDate(value) {
  if (!value) return '';
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}

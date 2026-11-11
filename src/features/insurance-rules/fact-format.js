// Plain-language rendering of one resolved fact value (complete.md 3.3). Pure; the text is a template over the typed value, never model
// output. Returns null for a value that does not fit its type. Used for memory passages and for deterministic chat answers.

const inr = minor => {
  if (!Number.isSafeInteger(minor) || minor < 0) return null;
  const rupees = Math.trunc(minor / 100);
  const paise = minor % 100;
  return `INR ${rupees.toLocaleString('en-IN')}${paise ? `.${String(paise).padStart(2, '0')}` : ''}`;
};

export function formatFactValue(valueType, value) {
  if (!value || typeof value !== 'object') return null;
  switch (valueType) {
    case 'money': return inr(value.amountMinor);
    case 'date': return typeof value.iso === 'string' ? value.iso : null;
    case 'date_range': return typeof value.startIso === 'string' && typeof value.endIso === 'string' ? `${value.startIso} to ${value.endIso}` : null;
    case 'duration': return Number.isInteger(value.days) && value.days >= 0 ? `${value.days} days` : null;
    case 'percent': return Number.isInteger(value.bp) && value.bp >= 0 ? `${value.bp / 100}%` : null;
    case 'number': return Number.isInteger(value.n) ? String(value.n) : null;
    case 'enum': return typeof value.value === 'string' ? value.value.replace(/_/g, ' ') : null;
    case 'bool': return typeof value.value === 'boolean' ? (value.value ? 'yes' : 'no') : null;
    case 'text': return typeof value.text === 'string' && value.text.trim() ? value.text.trim().slice(0, 600) : null;
    default: return null;
  }
}

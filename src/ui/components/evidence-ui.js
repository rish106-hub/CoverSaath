import { el } from './dom.js';
import { displayValue, evidenceMeaning, evidenceTone, humanize } from './format.js';

export const evidenceTag = state => el('span', {
  class: `tag ${evidenceTone(state)}`, 'data-testid': 'evidence-state', 'data-evidence-state': state, title: evidenceMeaning(state),
}, state);

/** What to print in place of a value. Unknown stays visible and NotPermitted never reads as Unknown. */
export function valueOrReason(state, shown) {
  if (shown) return shown;
  if (state === 'NotPermitted') return 'Withheld. You do not have permission to see this value.';
  if (state === 'Conflicting') return 'Your documents disagree about this.';
  if (state === 'Unknown') return 'Unknown. This was not established from your documents.';
  return 'No value shown.';
}

/** A read-only row for the emergency card and the policy status groups. */
export function fieldRow(field) {
  const shown = field.display ?? displayValue(field.value);
  return el('div', { class: 'field-row', 'data-testid': `field-${field.key}`, 'data-evidence-state': field.evidenceState },
    el('dt', {}, field.label ?? humanize(field.key)),
    el('dd', {},
      el('span', { class: `field-value ${shown ? '' : 'field-missing'}` }, valueOrReason(field.evidenceState, shown)),
      evidenceTag(field.evidenceState),
      field.reviewState && field.reviewState !== 'unreviewed' ? el('span', { class: 'tag review' }, humanize(field.reviewState)) : null));
}

export const fieldList = (fields, testid) => el('dl', { class: 'field-list', 'data-testid': testid }, (fields ?? []).map(fieldRow));

export function textOf(item) {
  if (item === null || item === undefined) return '';
  if (typeof item === 'string') return item;
  return item.message ?? item.description ?? item.text ?? item.label ?? JSON.stringify(item);
}

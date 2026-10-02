export const ENTRY_ROUTES = Object.freeze([
  Object.freeze({
    id: 'planned_care',
    title: 'Plan a procedure',
    copy: 'Use the policy breakdown to prepare a planned admission, estimate the conditional cash exposure and identify the next action.',
  }),
  Object.freeze({
    id: 'emergency',
    title: 'Emergency help',
    copy: 'Open the permissioned policy brief and contact a human directly. Insurance work must never delay care.',
  }),
]);

export const EVIDENCE_STATES = Object.freeze([
  Object.freeze(['Proven', 'Source directly supports it']),
  Object.freeze(['Calculated', 'Derived from sourced inputs']),
  Object.freeze(['Reported', 'A person or institution said it']),
  Object.freeze(['Dynamic', 'Valid at a dated point']),
  Object.freeze(['Unknown', 'Required proof is missing']),
  Object.freeze(['Conflicting', 'Sources do not agree']),
]);

export function evidenceTone(state) {
  return ({ Proven:'proven', Calculated:'calculated', Reported:'reported', Dynamic:'dynamic', Unknown:'unknown', Conflicting:'conflicting' })[state] ?? 'unknown';
}

export function createRouteChooser({ el, activeRoute, onSelect }) {
  return el('fieldset', { class:'route-chooser' },
    el('legend', {}, 'Choose one route'),
    ENTRY_ROUTES.map(route => {
      const input = el('input', { type:'radio', name:'route-choice', id:`route-${route.id}`, value:route.id, checked:activeRoute === route.id });
      input.addEventListener('change', () => onSelect(route.id));
      return el('label', { class:`route-card ${activeRoute === route.id ? 'selected' : ''}`, for:`route-${route.id}` },
        input,
        el('span', { class:'route-title' }, route.title),
        el('span', { class:'route-copy' }, route.copy));
    }));
}

export function createEvidenceStateKey({ el, tag }) {
  const items = EVIDENCE_STATES.map(([name, description]) =>
    el('div', { class:'state-item' }, tag(name, evidenceTone(name)), el('span', {}, description)));
  return el('section', { class:'state-key', 'aria-labelledby':'state-title' },
    el('div', {}, el('p', { class:'section-label' }, 'Evidence language'), el('h2', { id:'state-title' }, 'Every answer keeps its status')),
    el('div', { class:'state-list' }, items));
}

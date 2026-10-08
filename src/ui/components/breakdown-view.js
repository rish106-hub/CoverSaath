import { el, field, hint, button, formValues } from './dom.js';
import { displayProposed, displayValue, evidenceMeaning, humanize } from './format.js';
import { evidenceTag, valueOrReason } from './evidence-ui.js';

const isEstablished = state => ['Proven', 'Calculated', 'Dynamic', 'Reported'].includes(state);
const needsAttention = parameter => parameter.evidenceState === 'Conflicting' || parameter.evidenceState === 'Unknown'
  || (parameter.critical && parameter.evidenceState !== 'NotPermitted' && (parameter.review?.state ?? 'unreviewed') === 'unreviewed');

export function countCriticalUnreviewed(sections) {
  return (sections ?? []).flatMap(section => section.parameters)
    .filter(parameter => parameter.critical && parameter.evidenceState !== 'NotPermitted' && (parameter.review?.state ?? 'unreviewed') === 'unreviewed').length;
}

function citationItem(citation, documents) {
  const name = documents.find(document => document.id === citation.documentId)?.filename;
  return el('li', { class: 'citation', 'data-testid': 'citation' },
    el('span', { class: 'citation-page' }, `${name ? `${name}, ` : ''}page ${citation.pageNumber}`),
    el('q', {}, citation.quote),
    el('span', { class: 'hint' }, citation.matched === false ? ' The quote was not found on that page.' : ' Quote found on the page.'));
}

function correctionForm({ parameter, view, controller, ui }) {
  const type = parameter.valueType;
  let valueField;
  if (type === 'boolean') valueField = field({ label: 'Correct value', name: 'value', type: 'select', required: true, testid: 'correct-value', options: [['', 'Choose'], ['yes', 'Yes'], ['no', 'No']] });
  else if (type === 'text_list') valueField = field({ label: 'Correct values, one per line', name: 'value', type: 'textarea', required: true, testid: 'correct-value' });
  else if (type === 'date') valueField = field({ label: 'Correct date', name: 'value', type: 'date', required: true, testid: 'correct-value' });
  else if (['text', 'rule'].includes(type)) valueField = field({ label: 'Correct value', name: 'value', type: 'textarea', required: true, testid: 'correct-value' });
  else if (type === 'enum') valueField = field({ label: 'Correct value', name: 'value', required: true, testid: 'correct-value', help: 'Use the wording the policy uses. Knowvia will tell you if it is not an allowed option.' });
  else valueField = field({ label: type === 'money' ? 'Correct amount in rupees' : type === 'percent' ? 'Correct percentage' : `Correct number (${type})`, name: 'value', type: 'number', min: 0, step: type === 'money' || type === 'percent' ? 'any' : 1, required: true, testid: 'correct-value' });
  return el('form', {
    class: 'correction-form', 'data-testid': 'correct-form', onSubmit: event => {
      event.preventDefault();
      void controller.reviewParameter({ key: parameter.key, valueType: type, action: 'correct', form: formValues(event.currentTarget) });
    },
  },
  valueField,
  el('fieldset', { class: 'citation-fieldset' },
    el('legend', {}, 'Where does the policy say this? (optional, makes it Proven)'),
    field({ label: 'Document', name: 'documentId', type: 'select', testid: 'correct-document', options: [['', 'No citation'], ...view.documents.map(document => [document.id, document.filename])] }),
    field({ label: 'Page number', name: 'pageNumber', type: 'number', min: 1, step: 1, testid: 'correct-page' }),
    field({ label: 'Exact words on that page', name: 'quote', type: 'textarea', testid: 'correct-quote' })),
  field({ label: 'Note (optional)', name: 'note', maxlength: 300, testid: 'correct-note' }),
  el('button', { class: 'button secondary', type: 'submit', disabled: Boolean(view.busy), 'data-testid': 'correct-submit' }, 'Save correction'));
}

function parameterItem({ parameter, view, controller, ui }) {
  const state = parameter.evidenceState;
  const shown = displayValue(parameter.value, { basis: parameter.basis });
  const proposed = displayProposed(parameter.proposedValue);
  const reviewState = parameter.review?.state ?? 'unreviewed';
  const canConfirm = isEstablished(state) && reviewState !== 'confirmed';
  const canMarkAbsent = state === 'Unknown' && !(parameter.memberVariants?.length);
  const canReview = state !== 'NotPermitted';
  const open = ui.openReview === parameter.key;

  return el('li', { class: `parameter ${parameter.critical ? 'critical' : ''}`, id: `param-${parameter.key}`, tabindex: '-1',
    'data-testid': `parameter-${parameter.key}`, 'data-evidence-state': state, 'data-critical': String(Boolean(parameter.critical)) },
  el('div', { class: 'parameter-head' },
    el('h4', {}, parameter.label ?? humanize(parameter.key), parameter.critical ? el('span', { class: 'tag critical-tag' }, 'Important') : null),
    evidenceTag(state)),
  el('p', { class: `parameter-value ${shown ? '' : 'field-missing'}`, 'data-testid': 'parameter-display' }, valueOrReason(state, shown)),
  el('p', { class: 'hint' }, evidenceMeaning(state)),
  parameter.conditions?.length ? el('p', { class: 'hint' }, `Applies when: ${parameter.conditions.join('; ')}`) : null,
  proposed && !shown ? el('p', { class: 'proposed', 'data-testid': 'proposed-value' }, el('strong', {}, 'Possible value, not verified: '), proposed, ' Check it against your policy before relying on it.') : null,
  parameter.alternatives?.length ? el('div', { class: 'alternatives' }, el('strong', {}, 'The documents give different answers:'),
    el('ul', { class: 'plain-list' }, parameter.alternatives.map(item => el('li', {}, displayValue(item.value) ?? 'No readable value')))) : null,
  parameter.memberVariants?.length ? el('div', { class: 'member-variants', 'data-testid': 'member-variants' }, el('strong', {}, 'Values for named people only:'),
    el('ul', { class: 'plain-list' }, parameter.memberVariants.map(variant => el('li', {},
      `${humanize(typeof variant.memberScope === 'string' ? variant.memberScope : variant.memberScope?.name ?? 'Named member')}: `,
      displayValue(variant.value) ?? 'Unknown', ' ', evidenceTag(variant.evidenceState))))) : null,
  parameter.citations?.length ? el('details', { class: 'citations' }, el('summary', {}, `Evidence (${parameter.citations.length})`),
    el('ul', { class: 'plain-list' }, parameter.citations.map(citation => citationItem(citation, view.documents)))) : null,
  parameter.verification?.verifier && !['not_required', 'not_run'].includes(parameter.verification.verifier)
    ? el('p', { class: 'hint' }, `Second check: ${humanize(parameter.verification.verifier)}.`) : null,
  el('p', { class: 'hint', 'data-testid': 'review-state' }, `Review: ${humanize(reviewState)}`),
  canReview ? el('div', { class: 'review-actions' },
    canConfirm ? el('button', { class: 'button small', type: 'button', disabled: Boolean(view.busy), 'data-testid': `confirm-${parameter.key}`,
      onClick: () => controller.reviewParameter({ key: parameter.key, valueType: parameter.valueType, action: 'confirm' }) }, 'Confirm this is right') : null,
    el('button', { class: 'button small secondary', type: 'button', 'aria-expanded': String(open), 'data-testid': `correct-toggle-${parameter.key}`,
      onClick: () => { ui.openReview = open ? null : parameter.key; ui.rerender(); } }, open ? 'Cancel correction' : 'Correct it'),
    canMarkAbsent ? el('button', { class: 'button small secondary', type: 'button', disabled: Boolean(view.busy), 'data-testid': `absent-${parameter.key}`,
      onClick: () => controller.reviewParameter({ key: parameter.key, valueType: parameter.valueType, action: 'mark_absent', form: {} }) }, 'This is not in my policy') : null) : null,
  canReview && open ? correctionForm({ parameter, view, controller, ui }) : null);
}

export function readinessPanel({ view, controller, ui }) {
  const remaining = countCriticalUnreviewed(view.sections);
  const readiness = view.readiness;
  const ready = view.recordStatus === 'ready';
  return el('section', { class: 'panel readiness', 'aria-labelledby': 'readiness-title', 'data-testid': 'readiness-panel' },
    el('h3', { id: 'readiness-title' }, ready ? 'Your breakdown is confirmed' : 'Confirm the important values'),
    ready
      ? el('p', { 'data-testid': 'record-ready' }, 'You confirmed every important value. The emergency card and the planning tools now treat your breakdown as reviewed.')
      : el('p', { 'data-testid': 'critical-remaining' }, remaining
        ? `${remaining} important value${remaining === 1 ? '' : 's'} still need${remaining === 1 ? 's' : ''} your review. Confirm each one, correct it, or mark it as not in your policy.`
        : 'Every important value has been reviewed. Check readiness to finish.'),
    readiness && !readiness.ready ? el('div', { class: 'warning', role: 'status', 'data-testid': 'readiness-blockers' },
      el('strong', {}, 'Not ready yet:'),
      el('ul', { class: 'plain-list' }, (readiness.blockers ?? []).map(blocker => el('li', {},
        blocker.message, ' ', blocker.key ? button('Go to it', { variant: 'small secondary', testid: `goto-${blocker.key}`, onClick: () => ui.goTo(blocker.key) }) : null)))) : null,
    ready ? null : el('button', { class: 'button', type: 'button', disabled: Boolean(view.busy), 'data-testid': 'check-readiness', onClick: () => controller.checkReadiness() }, 'Check if my breakdown is ready'));
}

export function breakdownView({ view, controller, ui }) {
  const filter = ui.filter;
  const keep = parameter => filter === 'all' || (filter === 'critical' ? parameter.critical : needsAttention(parameter));
  const sections = view.sections ?? [];
  const unknownCount = sections.flatMap(section => section.parameters).filter(parameter => parameter.evidenceState === 'Unknown').length;
  return el('div', { 'data-testid': 'breakdown-view' },
    readinessPanel({ view, controller, ui }),
    view.consistencyIssues?.length ? el('div', { class: 'warning', role: 'status', 'data-testid': 'consistency-issues' },
      el('strong', {}, 'Things that do not add up:'), el('ul', { class: 'plain-list' }, view.consistencyIssues.map(issue => el('li', {}, typeof issue === 'string' ? issue : issue.message ?? JSON.stringify(issue))))) : null,
    el('div', { class: 'toolbar' },
      field({ label: 'Show', name: 'filter', type: 'select', value: filter, testid: 'parameter-filter',
        options: [['all', 'Every value'], ['critical', 'Important values only'], ['attention', 'Needs my attention (Unknown, Conflicting, unreviewed)']],
        onChange: event => { ui.filter = event.currentTarget.value; ui.rerender(); } }),
      hint(`${unknownCount} value${unknownCount === 1 ? ' is' : 's are'} Unknown. Unknown means Knowvia could not establish it from your documents. It does not mean the policy lacks it.`)),
    sections.length ? el('div', { class: 'sections', 'data-testid': 'sections' }, sections.map(section => {
      const shown = section.parameters.filter(keep);
      const counts = { unknown: section.parameters.filter(parameter => parameter.evidenceState === 'Unknown').length, conflicting: section.parameters.filter(parameter => parameter.evidenceState === 'Conflicting').length };
      return el('details', { class: 'section', 'data-testid': `section-${section.number}`, ...(ui.openSections.has(section.number) ? { open: true } : {}),
        onToggle: event => { if (event.currentTarget.open) ui.openSections.add(section.number); else ui.openSections.delete(section.number); } },
      el('summary', {}, el('span', { class: 'section-number', 'aria-hidden': 'true' }, section.number),
        el('span', {}, el('strong', {}, section.title), el('small', {}, `${section.parameters.length} values, ${counts.unknown} Unknown${counts.conflicting ? `, ${counts.conflicting} Conflicting` : ''}`))),
      el('div', { class: 'section-body' },
        section.question ? el('p', { class: 'lede' }, section.question) : null,
        section.reviewGuidance ? hint(section.reviewGuidance) : null,
        shown.length ? el('ul', { class: 'parameter-list' }, shown.map(parameter => parameterItem({ parameter, view, controller, ui })))
          : hint('Nothing in this section matches the filter.')));
    })) : el('p', { class: 'empty-note', 'data-testid': 'sections-empty' }, 'No sections are available yet.'));
}

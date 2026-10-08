import { el, field, hint, button, formValues } from './dom.js';
import { DOCUMENT_KINDS } from '../state/request-builders.js';

export const STEP_LABELS = Object.freeze([
  ['setup', 'Household'], ['family', 'Family'], ['documents', 'Documents'], ['processing_consent', 'Permission'], ['processing', 'Breakdown'],
]);

export function stepper(stage) {
  const index = Math.max(0, STEP_LABELS.findIndex(([id]) => id === stage));
  return el('ol', { class: 'stepper', 'aria-label': 'Progress', 'data-testid': 'journey-stepper' },
    STEP_LABELS.map(([id, label], position) => el('li', {
      class: position < index ? 'done' : position === index ? 'current' : '', ...(position === index ? { 'aria-current': 'step' } : {}),
    }, el('span', { class: 'step-number', 'aria-hidden': 'true' }, position + 1), el('span', {}, label,
      position < index ? el('span', { class: 'sr-only' }, ' (done)') : null))));
}

const heading = (title, intro) => [
  el('h2', { id: 'stage-heading', tabindex: '-1', 'data-testid': 'stage-heading' }, title),
  intro ? el('p', { class: 'lede' }, intro) : null,
];

export function setupView({ view, controller }) {
  const busy = Boolean(view.busy);
  const bootstrap = el('form', {
    'data-testid': 'bootstrap-form', onSubmit: async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = formValues(form);
      await controller.bootstrap({ bootstrapToken: values.bootstrapToken, displayName: values.displayName, ownerName: values.ownerName });
      if (form.isConnected) form.elements.bootstrapToken.value = '';
    },
  },
  el('h3', {}, 'Start a new household'),
  hint('This is the development setup. The setup token is sent once to your local server and is never stored in the browser.'),
  field({ label: 'Setup token', name: 'bootstrapToken', type: 'password', required: true, minlength: 32, autocomplete: 'off', testid: 'bootstrap-token' }),
  field({ label: 'Household name', name: 'displayName', required: true, maxlength: 120, value: 'My family', testid: 'household-name' }),
  field({ label: 'Your name', name: 'ownerName', required: true, maxlength: 120, autocomplete: 'name', testid: 'owner-name' }),
  el('button', { class: 'button full', type: 'submit', disabled: busy, 'data-testid': 'bootstrap-submit' }, 'Create household'));

  const connect = el('form', {
    'data-testid': 'connect-form', onSubmit: async event => {
      event.preventDefault();
      const form = event.currentTarget;
      await controller.connect(formValues(form));
      if (form.isConnected) form.elements.sessionToken.value = '';
    },
  },
  el('h3', {}, 'Continue an existing household'),
  hint('Your session key stays in this browser tab only. Closing the tab forgets it.'),
  field({ label: 'Session token', name: 'sessionToken', type: 'password', required: true, minlength: 32, autocomplete: 'off', testid: 'connect-token' }),
  field({ label: 'Household ID', name: 'householdId', required: true, testid: 'connect-household-id' }),
  field({ label: 'Adult ID', name: 'adultId', required: true, testid: 'connect-adult-id' }),
  el('button', { class: 'button secondary full', type: 'submit', disabled: busy, 'data-testid': 'connect-submit' }, 'Continue'));

  return el('section', { 'aria-labelledby': 'stage-heading', 'data-testid': 'stage-setup' },
    ...heading('Understand your health insurance before you need it',
      'Upload your policy once. Knowvia reads every page, lists what it covers and what it does not, and shows how sure it is of each answer.'),
    el('div', { class: 'two-up' }, el('div', { class: 'panel' }, bootstrap), el('div', { class: 'panel' }, connect)));
}

export function familyView({ view, controller }) {
  const members = view.members;
  const addForm = el('form', {
    'data-testid': 'member-form', onSubmit: async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const ok = await controller.addMember(formValues(form));
      if (ok && form.isConnected) form.reset();
    },
  },
  el('h3', {}, 'Add a family member'),
  field({ label: 'Name as on the policy', name: 'displayName', required: true, maxlength: 120, testid: 'member-name' }),
  field({
    label: 'Relationship to you', name: 'relationship', type: 'select', required: true, testid: 'member-relationship',
    options: [['', 'Choose'], ['spouse', 'Spouse'], ['son', 'Son'], ['daughter', 'Daughter'], ['father', 'Father'], ['mother', 'Mother'],
      ['father-in-law', 'Father-in-law'], ['mother-in-law', 'Mother-in-law'], ['sibling', 'Sibling'], ['other', 'Other']],
  }),
  field({ label: 'Date of birth', name: 'dateOfBirth', type: 'date', required: true, max: new Date().toISOString().slice(0, 10), testid: 'member-dob',
    help: 'Used for age-based rules such as co-pay for older members. It stays inside your household.' }),
  el('button', { class: 'button secondary', type: 'submit', disabled: Boolean(view.busy), 'data-testid': 'member-submit' }, 'Add member'));

  const cityForm = el('form', {
    'data-testid': 'city-form', onSubmit: event => { event.preventDefault(); void controller.saveCity(formValues(event.currentTarget).city); },
  },
  el('h3', {}, 'City (optional)'),
  field({ label: 'City where the family lives', name: 'city', maxlength: 80, value: view.city ?? '', testid: 'city-input',
    help: 'Lets Knowvia check network hospitals and cover adequacy for your city. You can skip this.' }),
  el('button', { class: 'button secondary', type: 'submit', disabled: Boolean(view.busy), 'data-testid': 'city-submit' }, 'Save city'));

  return el('section', { 'aria-labelledby': 'stage-heading', 'data-testid': 'stage-family' },
    ...heading('Who is covered?', 'Add everyone who may be named on the policy. You are already included.'),
    el('div', { class: 'two-up' },
      el('div', { class: 'panel' },
        el('h3', {}, 'Your household'),
        members.length
          ? el('ul', { class: 'member-list', 'data-testid': 'member-list' }, members.map(member => el('li', { 'data-testid': 'member-item' },
            el('strong', {}, member.displayName), el('span', { class: 'hint' }, member.isOwner ? 'You' : member.relationship || 'Family member'))))
          : el('p', { class: 'empty-note', 'data-testid': 'members-empty' }, 'No one yet. Add your first family member.'),
        el('div', { class: 'divider' }), addForm),
      el('div', { class: 'panel' }, cityForm)),
    el('div', { class: 'actions' }, button('Continue to documents', { testid: 'family-continue', onClick: () => controller.goToStage('documents') })));
}

export function documentsView({ view, controller, ui, render }) {
  const consentId = 'consent-document-processing';
  const form = el('form', {
    'data-testid': 'upload-form', onSubmit: async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = formValues(form);
      if (!form.elements.documentConsent.checked) {
        ui.localError = 'Please tick the box to give your permission before uploading.'; render(); return;
      }
      ui.localError = '';
      const ok = await controller.uploadDocument({ file: form.elements.file.files[0], documentKind: values.documentKind });
      if (ok && form.isConnected) form.elements.file.value = '';
    },
  },
  el('div', { class: 'consent-box' },
    el('h3', { id: 'doc-consent-title' }, 'Your permission to store and check this document'),
    el('p', {}, 'If you agree, Knowvia will keep your policy PDF in encrypted storage and check that it is safe and readable. Nothing is sent to any AI service at this step.'),
    el('label', { class: 'check', for: consentId }, el('input', {
      id: consentId, name: 'documentConsent', type: 'checkbox', 'data-testid': 'consent-document-processing',
      checked: Boolean(view.documentConsentId), disabled: Boolean(view.documentConsentId),
    }), el('span', {}, 'I agree that Knowvia may store and check my policy document. I can withdraw this permission at any time.'))),
  field({ label: 'What kind of document is it?', name: 'documentKind', type: 'select', options: DOCUMENT_KINDS, testid: 'document-kind' }),
  field({ label: 'Policy PDF (up to 15 MB)', name: 'file', type: 'file', accept: 'application/pdf,.pdf', required: true, testid: 'document-file',
    help: 'Password-protected PDFs cannot be read. Upload an unprotected copy.' }),
  el('button', { class: 'button full', type: 'submit', disabled: Boolean(view.busy), 'data-testid': 'upload-submit' }, 'Upload and check'));

  const upload = view.lastUpload;
  const result = upload
    ? upload.accepted
      ? el('div', { class: 'notice', role: 'status', 'data-testid': 'upload-accepted' }, `${upload.filename} passed the safety check.`)
      : el('div', { class: 'error', role: 'alert', 'data-testid': 'upload-rejected' },
        el('strong', {}, `${upload.filename} was not accepted. `), el('span', { 'data-testid': 'upload-reject-reason' }, upload.reason ?? 'The file could not be used.'))
    : null;

  return el('section', { 'aria-labelledby': 'stage-heading', 'data-testid': 'stage-documents' },
    ...heading('Upload your policy', 'The full policy wording gives the best result. A schedule or card alone leaves many answers Unknown.'),
    el('div', { class: 'two-up' },
      el('div', { class: 'panel' }, form, ui.localError ? el('div', { class: 'error', role: 'alert', 'data-testid': 'local-error' }, ui.localError) : null, result),
      el('div', { class: 'panel' },
        el('h3', {}, 'Accepted documents'),
        view.documents.length
          ? el('ul', { class: 'member-list', 'data-testid': 'document-list' }, view.documents.map(document => el('li', { 'data-testid': 'document-item' },
            el('strong', {}, document.filename), el('span', { class: 'hint' }, document.documentKind.replaceAll('_', ' ')))))
          : el('p', { class: 'empty-note', 'data-testid': 'documents-empty' }, 'Nothing uploaded yet.'))),
    el('div', { class: 'actions' },
      button('Back', { variant: 'secondary', testid: 'documents-back', onClick: () => controller.goToStage('family') }),
      el('button', { class: 'button', type: 'button', disabled: !view.documents.length, 'data-testid': 'documents-continue', onClick: () => controller.goToStage('processing_consent') }, 'Continue')));
}

export function processingConsentView({ view, controller, ui, render }) {
  const consentId = 'consent-coverage-reconstruction';
  const form = el('form', {
    'data-testid': 'start-form', onSubmit: async event => {
      event.preventDefault();
      if (!event.currentTarget.elements.reconstructionConsent.checked) {
        ui.localError = 'Please tick the box to give your permission before we start.'; render(); return;
      }
      ui.localError = '';
      await controller.startBreakdown();
    },
  },
  el('div', { class: 'consent-box' },
    el('h3', {}, 'Your permission to read the policy with AI'),
    el('p', {}, 'To break your policy down, Knowvia sends it to two outside services. Please read this before you agree.'),
    el('ul', { class: 'plain-list' },
      el('li', {}, el('strong', {}, 'Sarvam reads the pages. '), 'Images of your policy pages go to Sarvam, a text-recognition service, which turns them into text.'),
      el('li', {}, el('strong', {}, 'Gemini studies the text. '), 'The text from those pages goes to Google Gemini, which finds the answers across 12 sections.'),
      el('li', {}, el('strong', {}, 'Every answer is checked. '), 'Each answer must point to a quote on a page. If it cannot, it is shown as Unknown rather than guessed.'),
      el('li', {}, el('strong', {}, 'You stay in charge. '), 'Nothing counts as confirmed until you review the important values yourself. You can withdraw this permission later.')),
    el('label', { class: 'check', for: consentId }, el('input', {
      id: consentId, name: 'reconstructionConsent', type: 'checkbox', required: true, 'data-testid': 'consent-coverage-reconstruction',
      checked: Boolean(view.reconstructionConsentId), disabled: Boolean(view.reconstructionConsentId),
    }), el('span', {}, 'I agree that my policy pages may be sent to Sarvam and the extracted text to Gemini to build my policy breakdown.'))),
  el('button', { class: 'button full', type: 'submit', disabled: Boolean(view.busy), 'data-testid': 'start-submit' }, 'Break down my policy'));

  return el('section', { 'aria-labelledby': 'stage-heading', 'data-testid': 'stage-processing-consent' },
    ...heading('Ready to read your policy', `You uploaded ${view.documents.length} document${view.documents.length === 1 ? '' : 's'}. This usually takes a few minutes.`),
    el('div', { class: 'panel narrow' }, form, ui.localError ? el('div', { class: 'error', role: 'alert', 'data-testid': 'local-error' }, ui.localError) : null),
    el('div', { class: 'actions' }, button('Back', { variant: 'secondary', testid: 'consent-back', onClick: () => controller.goToStage('documents') })));
}

import './styles.css';
import { createV1Client } from './api/v1-client.js';
import { createJourneyController } from './state/journey-controller.js';
import { el, field, hint, button, formValues } from './components/dom.js';
import { EVIDENCE_STATES, evidenceTone } from './components/format.js';
import { documentsView, familyView, processingConsentView, setupView, stepper } from './components/onboarding-views.js';
import { processingView } from './components/progress-view.js';
import { breakdownView } from './components/breakdown-view.js';
import { emergencyView, estimateView, procedureView, statusView } from './components/tools-views.js';
import { analyticsConsentBanner, analyticsSettingsLink } from './components/analytics-consent-view.js';
import { createProductAnalytics } from './analytics/posthog-client.js';

const root = document.querySelector('#app');
const client = createV1Client();
const analytics = createProductAnalytics();

// View-only state: what is expanded, which filter is chosen, half-typed forms. Nothing here is business data.
const ui = {
  localError: '', openReview: null, filter: 'all', openSections: new Set(), forms: {},
  billLines: [{ head: 'surgeon_fees', amount: '' }], rerender: () => render(), goTo: key => goToParameter(key),
  analyticsChoiceOpen: analytics.decision() === null,
};
let view = null;
let lastStage = null;
const controller = createJourneyController({ client, analytics, onChange(next) { view = next; render(); } });
view = controller.snapshot();

const TABS = [
  ['breakdown', 'Policy breakdown'], ['emergency', 'Emergency card'], ['procedure', 'Procedure check'],
  ['estimate', 'Cost estimate'], ['status', 'Policy status'],
];

function goToParameter(key) {
  const section = view.sections?.find(item => item.parameters.some(parameter => parameter.key === key));
  if (section) ui.openSections.add(section.number);
  ui.filter = 'all';
  if (view.tab !== 'breakdown') { controller.setTab('breakdown'); }
  render();
  const target = document.getElementById(`param-${key}`);
  if (target) { target.scrollIntoView({ block: 'center' }); target.focus(); }
}

function authExpiredPanel() {
  return el('section', { class: 'panel auth-expired', role: 'alert', 'data-testid': 'auth-expired' },
    el('h2', {}, 'Your session has ended'),
    el('p', {}, 'For your safety Knowvia signs you out after a while. Paste a new session token to carry on. Nothing you did was lost.'),
    el('form', { onSubmit: event => { event.preventDefault(); void controller.resumeSession(formValues(event.currentTarget).sessionToken); } },
      field({ label: 'New session token', name: 'sessionToken', type: 'password', required: true, minlength: 32, autocomplete: 'off', testid: 'reauth-token' }),
      el('button', { class: 'button', type: 'submit', 'data-testid': 'reauth-submit' }, 'Continue')));
}

function messages() {
  const error = view.error;
  return el('div', { class: 'messages' },
    error ? el('div', { class: 'error', role: 'alert', 'data-testid': `error-${error.kind}`, 'data-error-code': error.code },
      el('p', {}, error.message),
      el('div', { class: 'actions' },
        view.canRetry ? button('Try again', { variant: 'small', testid: 'error-retry', onClick: () => controller.retry() }) : null,
        button('Dismiss', { variant: 'small secondary', testid: 'error-dismiss', onClick: () => controller.dismissError() }))) : null,
    view.notice ? el('div', { class: 'notice', role: 'status', 'data-testid': 'notice' }, view.notice) : null,
    // Always present so assistive technology announces busy changes.
    el('p', { class: view.busy ? 'busy' : 'sr-only', role: 'status', 'aria-live': 'polite', 'data-testid': 'busy' }, view.busy ? `${view.busy}…` : ''));
}

function workspace(ctx) {
  const tabs = el('nav', { class: 'tabs', 'aria-label': 'Policy tools', 'data-testid': 'workspace-tabs' },
    TABS.map(([id, label]) => el('button', {
      class: `tab ${view.tab === id ? 'active' : ''}`, type: 'button', ...(view.tab === id ? { 'aria-current': 'page' } : {}),
      'data-testid': `tab-${id}`, onClick: () => controller.setTab(id),
    }, label)));
  const body = ({ breakdown: breakdownView, emergency: emergencyView, procedure: procedureView, estimate: estimateView, status: statusView })[view.tab](ctx);
  return el('section', { 'aria-labelledby': 'stage-heading', 'data-testid': 'stage-workspace' },
    el('div', { class: 'workspace-head' },
      el('h2', { id: 'stage-heading', tabindex: '-1', 'data-testid': 'stage-heading' }, TABS.find(([id]) => id === view.tab)[1]),
      el('span', { class: `tag record-${view.recordStatus}`, 'data-testid': 'record-status' }, view.recordStatus === 'ready' ? 'Confirmed by you' : 'Needs your review')),
    tabs, body);
}

function evidenceKey() {
  return el('details', { class: 'state-key', 'data-testid': 'evidence-key' }, el('summary', {}, 'What the evidence labels mean'),
    el('ul', { class: 'state-list' }, EVIDENCE_STATES.map(([name, meaning]) => el('li', { class: 'state-item' },
      el('span', { class: `tag ${evidenceTone(name)}` }, name), el('span', {}, meaning)))));
}

function ensureToolData() {
  if (view.stage !== 'workspace' || view.busy || view.error || view.authExpired) return;
  if (view.tab === 'emergency' && !view.emergencyCard) void controller.loadEmergencyCard();
  if (view.tab === 'status' && !view.policyStatus) void controller.loadPolicyStatus();
}

function analyticsChoice() {
  if (!ui.analyticsChoiceOpen) return null;
  const decide = choose => () => { choose(); ui.analyticsChoiceOpen = false; render(); };
  return analyticsConsentBanner({ onAllow: decide(() => analytics.grant()), onDeny: decide(() => analytics.deny()) });
}

function render() {
  const activeId = document.activeElement?.id;
  const activeScroll = window.scrollY;
  const ctx = { view, controller, ui, render };
  const stageViews = {
    setup: setupView, family: familyView, documents: documentsView,
    processing_consent: processingConsentView, processing: processingView, workspace,
  };
  const stage = view.authExpired ? null : stageViews[view.stage](ctx);
  root.replaceChildren(
    el('a', { class: 'skip-link', href: '#main' }, 'Skip to content'),
    el('header', {},
      el('div', { class: 'brand' }, el('span', { class: 'brandmark', 'aria-hidden': 'true' }, 'K'), el('span', {}, 'Knowvia', el('small', {}, 'Understand your insurance before you need it.'))),
      view.identity ? button('Sign out', { variant: 'small secondary', testid: 'sign-out', onClick: () => controller.signOut() }) : null),
    el('main', { class: 'shell', id: 'main' },
      el('div', { class: 'emergency-strip' }, el('span', {}, 'In an emergency, get treatment first. Do not wait for insurance steps.'),
        el('a', { class: 'button emergency-button small', href: 'tel:112', 'data-testid': 'global-call-112' }, 'Call 112')),
      view.stage !== 'workspace' ? stepper(view.stage) : null,
      analyticsChoice(),
      messages(),
      view.authExpired ? authExpiredPanel() : stage,
      evidenceKey(),
      hint('Knowvia explains your policy. It is not insurance advice, and it never approves or rejects a claim. The insurer decides.', { class: 'hint footer' }),
      ui.analyticsChoiceOpen ? null : el('div', { class: 'footer-actions' },
        analyticsSettingsLink({ decision: analytics.decision(), onChange: () => { ui.analyticsChoiceOpen = true; render(); } }))));
  if (lastStage !== view.stage) {
    lastStage = view.stage;
    document.getElementById('stage-heading')?.focus();
    window.scrollTo(0, 0);
  } else {
    if (activeId) document.getElementById(activeId)?.focus({ preventScroll: true });
    window.scrollTo(0, activeScroll);
  }
  ensureToolData();
}

render();
analytics.track('landing_viewed');

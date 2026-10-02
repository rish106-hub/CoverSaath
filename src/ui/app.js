import './styles.css';
import { createV1Client } from './api/v1-client.js';
import { createWorkspaceController } from './state/workspace-controller.js';
import { createEvidenceStateKey, createRouteChooser, evidenceTone } from './components/household-workspace.js';

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (['checked', 'disabled', 'hidden', 'required'].includes(key)) node[key] = Boolean(value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const root = document.querySelector('#app');
const client = createV1Client();
let view = null;
let activeRoute = 'planned_care';
let activeLayer = 'decision';
const controller = createWorkspaceController({ client, onChange(next) { view = next; render(); } });
view = controller.snapshot();

const tag = (label, tone = '') => el('span', { class:`tag ${tone}` }, label);
const hint = value => el('p', { class:'hint' }, value);
const field = (label, name, type = 'text', attrs = {}) => el('div', { class:'field' },
  el('label', { for:name }, label), el('input', { id:name, name, type, ...attrs }));
const money = minor => minor === null || minor === undefined
  ? 'Unknown'
  : new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR', maximumFractionDigits:0 }).format(minor / 100);

function emergencyBanner() {
  return el('section', { class:'emergency', 'aria-labelledby':'emergency-title' },
    el('div', {}, el('p', { class:'section-label' }, 'Emergency access'),
      el('h2', { id:'emergency-title' }, 'Admit first. Optimise later.'),
      el('p', {}, 'Get treatment first. Emergency access must go directly to a staffed human operator with a permissioned brief. Knowvia staffing and verified routing are not configured in this build.')),
    el('div', { class:'emergency-actions' },
      el('a', { class:'button emergency-button', href:'tel:112' }, 'Call 112'),
      hint('For insurance help, use a verified hospital desk, insurer or TPA number. No AI, Gnani or IVR sits in front of the call.')));
}

function setupPanel() {
  const bootstrap = el('form', { onSubmit:async event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await controller.bootstrap({
      bootstrapToken: data.get('bootstrapToken'),
      displayName: data.get('displayName'),
      ownerName: data.get('ownerName'),
    });
    event.currentTarget.elements.bootstrapToken.value = '';
  } },
  el('h2', {}, 'Create a local persistent workspace'),
  hint('Administrator setup only. The bootstrap secret is sent to the local API once, is never stored by the UI, and must be replaced by a real identity provider before deployment.'),
  field('Bootstrap token', 'bootstrapToken', 'password', { required:true, minlength:32, autocomplete:'off' }),
  field('Household name', 'displayName', 'text', { required:true, maxlength:120, value:'Synthetic household' }),
  field('Owner name', 'ownerName', 'text', { required:true, maxlength:120, value:'Synthetic owner' }),
  el('button', { class:'button full', type:'submit', disabled:view.busy }, 'Create workspace'));

  const connect = el('form', { onSubmit:event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void controller.connect(Object.fromEntries(data));
  } },
  el('h2', {}, 'Reconnect an existing workspace'),
  hint('Credentials remain in memory for this browser tab. They are not written to local storage.'),
  field('Session token', 'sessionToken', 'password', { required:true, minlength:32, autocomplete:'off' }),
  field('Household ID', 'householdId', 'text', { required:true }),
  field('Adult ID', 'adultId', 'text', { required:true }),
  field('Household member ID', 'memberId', 'text', { required:true }),
  el('button', { class:'button secondary full', type:'submit', disabled:view.busy }, 'Connect'));

  return el('section', { class:'layout setup-layout' }, el('div', { class:'panel' }, bootstrap), el('div', { class:'panel' }, connect));
}

function matrixPanel() {
  const members = view.matrix?.members ?? [];
  return el('section', { class:'matrix-panel', 'aria-labelledby':'matrix-title' },
    el('div', { class:'matrix-heading' },
      el('div', {}, el('p', { class:'section-label' }, 'Household matrix'), el('h2', { id:'matrix-title' }, 'What is known for each person')),
      tag('Persisted', 'proven')),
    el('div', { class:'matrix-table', role:'table', 'aria-label':'Household insurance status' },
      el('div', { class:'matrix-row matrix-head', role:'row' },
        ['Person', 'Policies found', 'Immediate issue', 'Evidence'].map(label => el('span', { role:'columnheader' }, label))),
      members.map(member => el('div', { class:'matrix-row', role:'row' },
        el('span', { role:'cell' }, el('strong', {}, member.displayName), el('small', {}, member.relationshipLabel ?? member.memberKind)),
        el('span', { role:'cell' }, String(member.policiesFound)),
        el('span', { role:'cell' }, member.immediateIssue?.triggerType?.replaceAll('_', ' ') ?? 'No active case'),
        el('span', { role:'cell' }, tag(member.immediateIssue ? 'Dynamic' : 'Unknown', member.immediateIssue ? 'dynamic' : 'unknown'))))));
}

function actionPanel() {
  const routeMount = el('div');
  const renderRoutes = () => routeMount.replaceChildren(createRouteChooser({
    el, activeRoute, onSelect(route) { activeRoute = route; renderRoutes(); render(); },
  }));
  renderRoutes();
  return el('form', { class:'panel', onSubmit:event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const rupees = Number(data.get('estimate'));
    void controller.createAndAnalyze({
      route: activeRoute,
      estimateMinor: Number.isFinite(rupees) && rupees > 0 ? Math.round(rupees * 100) : null,
    });
  } },
  el('h2', {}, 'Choose what is happening now'),
  hint('Both routes use the same permissioned policy record. They do not reread or reinterpret the policy from scratch.'),
  routeMount,
  activeRoute === 'planned_care'
    ? field('Hospital estimate in rupees (optional)', 'estimate', 'number', { min:1, max:100000000, step:1 })
    : hint('Opening emergency help never waits for policy analysis. The stored brief is supporting context for a human operator.'),
  el('button', { class:`button full ${activeRoute === 'emergency' ? 'emergency-button' : ''}`, type:'submit', disabled:view.busy },
    view.busy ? 'Working...' : activeRoute === 'emergency' ? 'Open emergency help' : 'Plan this procedure'));
}

function policyBreakdownPanel() {
  const tasks = view.policyJob?.tasks ?? [];
  const sections = tasks
    .filter(task => /^policy_decomposition_[a-j]$/.test(task.taskKind) && task.resultSummary?.section)
    .sort((left, right) => left.resultSummary.section.localeCompare(right.resultSummary.section));
  const ready = view.policyJob?.status === 'completed' && sections.length > 0;
  return el('section', { class:'policy-foundation', 'aria-labelledby':'policy-foundation-title' },
    el('div', { class:'policy-foundation-head' },
      el('div', {}, el('p', { class:'section-label' }, 'Policy foundation'),
        el('h2', { id:'policy-foundation-title' }, 'Break down the policy once. Use it whenever care happens.'),
        hint('Every section keeps its evidence state. Missing wording remains Unknown; conflicts stay visible.')),
      ready ? tag('Breakdown ready', 'proven') : el('button', {
        class:'button', type:'button', disabled:view.busy, onClick:() => controller.reconstructPolicy(),
      }, view.busy ? 'Working...' : 'Run synthetic breakdown')),
    ready
      ? el('div', { class:'breakdown-grid' }, sections.map(task => {
        const facts = task.resultSummary.facts ?? [];
        const supported = facts.filter(fact => !['Unknown', 'Conflicting'].includes(fact.evidenceState)).length;
        return el(
          'details',
          { class:'breakdown-section' },
          el('summary', {},
            el('span', { class:'breakdown-letter' }, task.resultSummary.section),
            el('span', {}, el('strong', {}, task.resultSummary.responsibility),
              el('small', {}, `${supported} supported, ${facts.length - supported} unresolved`))),
          el('div', { class:'breakdown-facts' }, facts.map(fact =>
            el('div', { class:'breakdown-fact' },
              el('span', {}, fact.field.replaceAll('_', ' ')),
              tag(fact.evidenceState, evidenceTone(fact.evidenceState))))),
        );
      }))
      : el('div', { class:'policy-empty' },
        el('strong', {}, 'No policy breakdown yet'),
        hint('This build can demonstrate the persisted A-J breakdown with synthetic evidence. Real PDF extraction remains disabled until protected upload, malware scanning and a verified OCR transport are connected.')));
}

const layers = [
  ['decision', 'Decision', 'What to do next'],
  ['financial', 'Financial', 'Conditional cost view'],
  ['evidence', 'Evidence', 'Sources and unresolved proof'],
  ['research', 'Research', 'Agent work and lower-order context'],
];

const routeCopy = Object.freeze({
  admit_first_human_handoff: ['Get treatment first', 'Human support operator', 'Now'],
  collect_evidence_and_human_review: ['Collect the missing proof, then review with a qualified human', 'Household operator', 'Before any purchase or renewal decision'],
  review_existing_cover_before_purchase: ['Review reconstructed existing cover before considering a purchase', 'Qualified adviser and household', 'Before checkout'],
});

function resultPanel() {
  if (!view.caseRecord) return el('section', { class:'empty' },
    el('h2', {}, 'No case yet'), hint('Choose one route. Knowvia will persist the case, consent and bounded worker run.'));
  const tasks = view.job?.tasks ?? [];
  if (view.caseRecord.trigger_type === 'emergency') return el('section', { class:'case-content' },
    el('section', { class:'case-top emergency-case' },
      el('div', {}, el('p', { class:'section-label' }, 'Emergency help'),
        el('h2', {}, 'Admit first. Optimise later.'),
        hint('The emergency record is open. No AI or document-processing step was placed before the human route.')),
      tag('Human route', 'dynamic')),
    el('div', { class:'panel' },
      el('h2', {}, 'Use a human channel now'),
      hint('Call local emergency services for urgent care. For insurance coordination, use the verified hospital desk, TPA or insurer contact stored with the policy. Knowvia does not yet operate a staffed emergency line.'),
      el('div', { class:'actions' }, el('a', { class:'button emergency-button', href:'tel:112' }, 'Call 112'))));
  const decision = tasks.find(task => task.taskKind === 'deterministic_classification')?.resultSummary;
  const evidenceReview = tasks.find(task => task.taskKind === 'evidence_review')?.resultSummary;
  const [nextAction, owner, deadline] = routeCopy[decision?.route] ?? ['Review the unresolved evidence', 'Household operator', 'Before acting'];
  const tabList = el('div', { class:'layer-tabs', role:'tablist', 'aria-label':'Case answer layers' },
    layers.map(([id, label, description]) => el('button', {
      class:`layer-tab ${activeLayer === id ? 'active' : ''}`, type:'button', role:'tab',
      'aria-selected':String(activeLayer === id), onClick:() => { activeLayer = id; render(); },
    }, el('strong', {}, label), el('span', {}, description))));
  const section = (id, ...children) => el('section', {
    class:`layer ${activeLayer === id ? 'active' : ''}`, role:'tabpanel', hidden:activeLayer !== id,
  }, ...children);
  const released = view.job?.status === 'completed';
  return el('div', { class:'case-content' },
    el('section', { class:'case-top' }, el('div', {}, el('p', { class:'section-label' }, `Case ${view.caseRecord.id.slice(0, 12)}`),
      el('h2', {}, view.caseRecord.trigger_type.replaceAll('_', ' ')), hint(`Persistent status: ${view.caseRecord.status}`)), tag(view.job?.status ?? 'created')),
    tabList,
    section('decision', el('div', { class:'panel' }, el('h2', {}, released ? nextAction : 'Analysis is not released'),
      released ? el('dl', { class:'decision-meta' },
        el('div', {}, el('dt', {}, 'Owner'), el('dd', {}, owner)),
        el('div', {}, el('dt', {}, 'Deadline'), el('dd', {}, deadline)),
        el('div', {}, el('dt', {}, 'Route'), el('dd', {}, decision?.route?.replaceAll('_', ' ') ?? 'Unknown'))) : null,
      hint(released ? 'This deterministic route still needs human approval. It does not authorise treatment, payment or a claim decision.' : 'No result is shown as ready until the deterministic release gate completes.'),
      el('button', { class:'button danger', disabled:!view.consent || view.busy, onClick:() => controller.revoke() }, 'Revoke analysis consent'))),
    section('financial', el('div', { class:'panel' }, el('h2', {}, 'Conditional cash view'),
      el('div', { class:'amount' }, money(view.caseRecord.stated_estimate_minor)),
      hint('User-stated estimate only. Confirmed payable amount, requested deposit and final personal expense remain unknown. Policy limits are not cash.'))),
    section('evidence', el('div', { class:'panel' }, el('h2', {}, 'Evidence status'),
      tag(evidenceReview?.status === 'passed' ? 'Fixture checks passed' : 'Blocked', evidenceReview?.status === 'passed' ? 'calculated' : 'unknown'),
      hint(`Deterministic evidence findings: ${evidenceReview?.findingCodes?.length ?? 0}. No real source pack was uploaded. Fixture execution proves routing and fail-closed behavior only, not document accuracy.`))),
    section('research', el('div', { class:'panel' }, el('h2', {}, 'Agent execution'),
      hint('Specialists, reviewers, primary synthesis and release gate are persisted as separate tasks.'),
      el('div', { class:'trace' }, tasks.map(task => el('div', { class:'trace-item' },
        el('div', {}, el('strong', {}, task.agentName), hint(task.taskKind)), tag(task.status)))),
      hint('Provider calls: 0. Execution mode: fixture.'))));
}

function render() {
  const messages = view.error
    ? el('div', { class:'error', role:'alert' }, view.error)
    : view.notice ? el('div', { class:'notice', role:'status' }, view.notice) : null;
  root.replaceChildren(
    el('header', {}, el('div', { class:'brand' }, el('span', { class:'brandmark', 'aria-hidden':'true' }, 'K'),
      el('span', {}, 'Knowvia', el('small', {}, 'Understand your insurance before you need it.'))),
      el('div', { class:'header-note' }, 'Household workspace')),
    el('div', { class:'prototype' }, 'LOCAL PERSISTENT PROTOTYPE. Synthetic fixture analysis only. No live providers, advice, purchase, payment or claim approval.'),
    el('main', { class:'shell' }, emergencyBanner(),
      el('section', { class:'intro' }, el('div', {}, el('p', { class:'section-label' }, 'Know what you have. Know what could go wrong. Know what to do next.'),
        el('h1', {}, 'Your policy, ready before care happens.')),
        el('p', {}, 'Break down the policy once, then use the same source-backed record for planned care or an emergency.')),
      messages,
      view.identity ? [matrixPanel(), policyBreakdownPanel(), view.policyJob?.status === 'completed'
        ? el('div', { class:'layout', id:'care-routes' }, actionPanel(), resultPanel())
        : null] : setupPanel(),
      createEvidenceStateKey({ el, tag }),
      el('p', { class:'footer' }, 'Production still requires a real identity provider, staffed human support, licensed distribution, provider credentials, legal review, backup operations and verified integrations.')));
}

render();

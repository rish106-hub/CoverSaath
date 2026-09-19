import './styles.css';

// Untrusted case values always become text nodes, never HTML.
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'checked' || key === 'disabled') node[key] = Boolean(value);
    else node.setAttribute(key, value);
  }
  children.flat(Infinity).forEach(child => { if (child !== null && child !== undefined) node.append(child instanceof Node ? child : document.createTextNode(String(child))); });
  return node;
}
const text = value => typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value ?? 'Not recorded');
const human = value => text(value).replaceAll('_', ' ');
const money = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-IN', { style:'currency', currency:'INR',maximumFractionDigits:0 }).format(Number(value)) : 'Unknown';
const array = value => Array.isArray(value) ? value : [];
const tag = (label, tone = '') => el('span', {class:`tag ${tone}`}, human(label));
const hint = value => el('p', {class:'hint'}, text(value));
const list = values => el('ul', {class:'list'}, array(values).map(value => el('li', {}, typeof value === 'object' ? value.text ?? value.action ?? value.message ?? text(value) : value)));
let current = null, busy = false, error = '', notice = '', operatorName = '';
let orchestration = null, dialAttempt = null;
const modelPermission = el('input',{type:'checkbox',id:'model-permission'});
const root = document.querySelector('#app');
const output = el('div', {class:'case-content',id:'case-output','aria-live':'polite'});
const message = el('div', {id:'messages','aria-live':'polite'});
let createButton;

async function api(path, body) {
  const response = await fetch(path, {method:body === undefined ? 'GET' : 'POST',headers:{'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message ?? data.error ?? data.message ?? `Request failed (${response.status}). Check the local case service.`);
  return data.case ?? data;
}
async function act(path, body, success) {
  busy = true; error = ''; notice = ''; render();
  try { current = await api(`/api/cases/${current.id}${path}`, body); notice = success ?? ''; }
  catch (err) { error = err.message; }
  finally {
    busy = false;
    if (current?.status === 'consent_revoked') {
      orchestration = null; dialAttempt = null; modelPermission.checked = false;
      operatorName = '';
      for (const name of ['patientName', 'procedure', 'hospital', 'estimate', 'operator']) form.elements[name].value = '';
      consent.checked = false;
    }
    render();
  }
}
function field(label, name, value, type = 'text', extra = {}) {
  const input = el('input', {id:name,name,type,value,...extra});
  return el('div', {class:'field'}, el('label', {for:name}, label), input);
}
const select = el('select', {id:'trigger',name:'trigger'}, el('option',{value:'planned_care'},'Planned treatment'), el('option',{value:'renewal'},'Renewal / buying review'), el('option',{value:'emergency'},'Emergency support'));
const emergencyBanner = () => el('section', {class:'emergency'},el('div',{class:'eyebrow'},'Care comes first'),el('h2',{},'Admit first. Optimise later.'),el('p',{},'Do not wait for this case review to seek medical care. Contact the treating hospital and your existing insurer / TPA support route. This prototype has no live emergency adviser.'),el('a',{href:'tel:112'},'Call 112 for emergency assistance'));
select.addEventListener('change', () => { document.querySelector('#intake-emergency').replaceChildren(...(select.value === 'emergency' ? [emergencyBanner()] : [])); });
const consent = el('input',{type:'checkbox',id:'consent',name:'consent',required:true});
const form = el('form',{onSubmit:async event => {
  event.preventDefault(); if (busy) return;
  const values = new FormData(event.currentTarget);
  busy = true; error = ''; notice = ''; render();
  try {
    current = await api('/api/cases',{trigger:values.get('trigger'),patientName:values.get('patientName'),procedure:values.get('procedure'),hospital:values.get('hospital'),estimate:Number(values.get('estimate')),consent:consent.checked});
    orchestration = null; dialAttempt = null; modelPermission.checked = false;
    operatorName = values.get('operator') ?? '';
    notice = 'Demo case created. Run the review to check the sample policy evidence.';
  } catch (err) { error = err.message; } finally { busy = false; render(); }
}},
  el('div',{class:'panel-head'},el('h2',{},'Open a case'),tag('Synthetic only')),
  hint('Use made-up details. This build processes sample policies, not uploaded records or live HRMS data.'),
  el('div',{id:'intake-emergency'}),
  el('div',{class:'field'},el('label',{for:'trigger'},'What needs a decision?'),select),
  field('Patient / policyholder (demo name)','patientName','Aarav Mehta','text',{required:true,maxlength:100}),
  field('Doctor-recommended procedure / buying question','procedure','Kidney stone procedure','text',{required:true,maxlength:200}),
  field('Hospital (demo)','hospital','Sample City Hospital','text',{required:true,maxlength:150}),
  field('Hospital estimate (₹)','estimate','500000','number',{required:true,min:1,max:10000000,step:1}),
  field('Named household operator (optional)','operator','', 'text',{placeholder:'Who holds the documents?',maxlength:100}),
  el('label',{class:'check',for:'consent'},consent,el('span',{},'I approve processing these synthetic details for this demo case. This does not grant permission to email anyone or process another adult’s real records.')),
  createButton = el('button',{class:'button full',type:'submit'},'Create demo case'),
  el('div',{class:'divider'}),
  el('div',{class:'eyebrow'},'Integration status'),
  el('div',{class:'rails'},el('div',{class:'rail'},el('strong',{},'Gnani · voice'),el('span',{},'Not connected')),el('div',{class:'rail'},el('strong',{},'Pine Labs · premium'),el('span',{},'Demo adapter only')),el('div',{class:'rail'},el('strong',{},'Insurer / TPA email'),el('span',{},'No email sent')),el('div',{class:'rail'},el('strong',{},'Delhivery'),el('span',{},'Not needed for MVP')))
);
root.append(el('header',{},el('div',{class:'brand'},el('span',{class:'brandmark','aria-hidden':'true'},'Cs'), 'Coversaath'),el('div',{class:'header-note'},'Household Health Treasury / case workspace')),el('div',{class:'prototype'},'LOCAL PROTOTYPE · Synthetic policies and deterministic agents. No insurance approval, live calls, emails or real payments.'),el('main',{class:'shell'},el('section',{class:'intro'},el('div',{},el('div',{class:'eyebrow'},'Known / Unknown / Next'),el('h1',{},'One case. Every answer owned.')),el('p',{},'Reconstruct existing cover before a buying decision. Use the same evidence to prepare for planned care, track institutional questions and brief the right person.')),message,el('div',{class:'layout'},el('aside',{class:'panel intake'},form),output),el('p',{class:'footer'},'This is a structure-first build, not a deployed insurance service. Real documents, per-adult permissions, licensed distribution, staffed support and institutional connections require further work.')));

function sourceSlips(sources) {
  return el('div',{class:'evidence'},array(sources).map(source => {
    if (typeof source === 'string') return el('div',{class:'evidence-slip'},el('div',{class:'eyebrow'},'Sample evidence'),el('p',{},source));
    return el('div',{class:'evidence-slip'},el('div',{class:'eyebrow'},`${source.document ?? source.documentId ?? source.policyId ?? source.file ?? 'Sample policy'} · p. ${source.page ?? source.location ?? '?'} · ${source.version ?? 'version not supplied'}`),el('p',{},source.quote ?? source.excerpt ?? source.clause ?? source.text ?? source.description ?? 'Source reference retained in the case record.'));
  }));
}
function panel(title, ...children) { return el('section',{class:'panel'},el('div',{class:'panel-head'},el('h2',{},title)),...children); }
function showPolicies() {
  return panel('Existing-cover map',hint('Sum insured is not the amount payable. Each policy remains separate; applicability still needs case-specific confirmation.'),el('div',{class:'policy-grid'},array(current.policies).map(policy => el('article',{class:'policy'},tag(policy.type ?? policy.kind ?? 'sample policy'),el('div',{class:'policy-title'},policy.name ?? policy.insurer ?? policy.id),hint(policy.policyNumber ?? policy.number ?? 'Synthetic policy reference'),el('div',{class:'amount'},money(policy.sumInsured ?? policy.coverAmount ?? policy.limit)),hint('Headline sum insured · not guaranteed cash'),sourceSlips(policy.sources ?? (policy.source ? [policy.source] : [])),hint(policy.verification ?? policy.status ?? policy.verificationStatus ?? 'Sample document only')))),array(current.findings).map(finding => el('article',{class:'finding'},el('div',{class:'finding-title'},el('h3',{},human(finding.title ?? finding.rule ?? finding.type ?? 'Policy finding')),tag(finding.status ?? finding.applicability ?? 'potential','amber')),el('p',{},finding.text ?? finding.explanation ?? finding.message ?? finding.detail ?? finding.description ?? text(finding)),sourceSlips(finding.sources ?? (finding.source ? [finding.source] : [])))));
}
function showBrief() {
  const brief = current.brief ?? {};
  const cash = brief.cashScenario ?? {};
  const data = Object.entries(cash).filter(([,v]) => typeof v === 'number');
  const labels = {estimate:'Hospital estimate',hospitalEstimate:'Hospital estimate',possibleUpfront:'Possible upfront, if nothing confirmed',potentialApplicableAmount:'Potential cover, not confirmed',potentialCover:'Potential cover, not confirmed',potentialPolicyPayable:'Potential cover, not confirmed',indicativeGap:'Conditional personal expense',indicativeOutOfPocket:'Conditional personal expense',requestedDeposit:'Requested deposit',deposit:'Requested deposit',worstCaseCash:'Cash if no payment confirmed',worstCaseExposure:'Cash if no payment confirmed',conservativeCashNeeded:'Cash if no payment confirmed'};
  const node = panel(current.input?.trigger === 'renewal' ? 'Household decision brief' : 'Admission readiness brief',el('p',{class:'brief-summary'},brief.summary ?? 'Review has not produced a brief yet.'),el('div',{class:'columns'},el('div',{},el('div',{class:'eyebrow'},'Next actions'),list(brief.nextActions)),el('div',{},el('div',{class:'eyebrow'},'Unresolved, not assumed'),list(brief.unknowns))),el('div',{class:'cash'},el('div',{class:'eyebrow'},'Conditional cash scenario · demo arithmetic'),el('div',{class:'data-grid'},data.map(([key,value]) => el('div',{class:'datum'},el('div',{class:'label'},labels[key] ?? human(key).replace(/([A-Z])/g,' $1')),el('div',{class:'value'},money(value)))),['confirmedPayable','requestedDeposit'].filter(key => cash[key] == null).map(key => el('div',{class:'datum'},el('div',{class:'label'},key === 'confirmedPayable' ? 'Confirmed payment' : 'Requested deposit'),el('div',{class:'value'},'Unknown')))),hint(cash.label ?? cash.warning ?? cash.caveat ?? cash.note ?? 'Potential cover is not a commitment. A requested deposit and final out-of-pocket cost are different. No borrowing or investment-sale recommendation is made.')));
  node.classList.add('brief'); return node;
}
function showQuestions() {
  return panel('Clarification desk',hint('Independent questions can be tracked in parallel. Approving a draft here records a simulated sharing decision only. No email leaves this app, and a reply does not mean claim approval.'),array(current.questions).map(question => {
    const reply = el('textarea',{id:`reply-${question.id}`,required:true,maxlength:3000,placeholder:'Paste a synthetic reply. No real medical records.'});
    return el('article',{class:'question'},el('div',{class:'question-head'},el('div',{},el('div',{class:'eyebrow'},question.owner),el('h3',{},question.subject)),tag(question.status,question.status === 'draft' ? 'amber' : 'teal')),hint(`Follow-up due: ${question.dueAt ? new Date(question.dueAt).toLocaleString('en-IN') : 'Not scheduled'}`),el('div',{class:'email'},question.body),sourceSlips(question.sources),question.status === 'draft' ? el('button',{class:'button secondary small',disabled:busy,onClick:() => act(`/questions/${question.id}/approve`,{},'Draft approved for demo tracking. No email sent.')},'Approve demo sharing') : null,question.reply ? el('div',{class:'reply'},el('div',{class:'eyebrow'},'Recorded reply · unverified source'),text(question.reply.text ?? question.reply)) : null,question.status !== 'draft' ? el('form',{onSubmit:event => {event.preventDefault();act(`/questions/${question.id}/reply`,{text:reply.value},'Reply recorded. Institutional authority and unresolved terms remain visible.');}},el('div',{class:'field'},el('label',{for:`reply-${question.id}`},'Record a demo response'),reply),el('button',{class:'button secondary small',type:'submit',disabled:busy,style:'margin-top:10px'},'Record response')) : null);
  }));
}
function showHandoff() {
  const handoff = current.handoff ?? {};
  return panel('Operator & human handoff',hint('Nomination is not verification. Gnani will later support permission-scoped voice intake and read-back. There is no live adviser or voice session in this build.'),el('div',{class:'operator'},el('div',{},el('h3',{},operatorName || 'No household operator nominated'),el('p',{},'Operator: not verified · Backup: not authorised · Five-minute drill: not run')),tag('Incomplete','amber')),el('h3',{},handoff.owner ?? 'Human owner not assigned'),hint('Callback number and staffed hours: not configured. No call or callback request is sent.'),list(handoff.nextActions ?? handoff.actions ?? []),el('p',{class:'hint'},handoff.summary ?? handoff.message ?? handoff.reason ?? 'A human would review sources, unresolved questions and case actions, not simply repeat the AI recommendation.'),el('details',{style:'margin-top:16px'},el('summary',{},'View handoff record'),el('div',{class:'email'},text(handoff))));
}
function showPurchase() {
  const purchase = current.purchase ?? {};
  const decision = el('select',{id:'decision','aria-label':'Household decision'},el('option',{value:'retain'},'Retain existing cover'),el('option',{value:'defer'},'Defer the decision'),el('option',{value:'buy'},'Buy through demo gate'));
  const approval = el('input',{type:'checkbox',id:'household-approval',required:true});
  const reason = el('input',{id:'decision-reason',required:true,maxlength:500,placeholder:'Record why this route was chosen'});
  return panel('Buying & continuity decision',hint('Retain and defer are valid outcomes. A new purchase must not be assumed to cover a procedure already planned. This form simulates a licensed human gate; it is not actual insurance advice.'),el('div',{class:'evidence-slip',style:'margin-top:16px'},el('div',{class:'eyebrow'},'Distribution conflict'),el('p',{},purchase.commissionDisclosure ?? 'The proposed service is funded by disclosed distribution commission through a licensed partner. No actual product, premium or commission offer exists in this demo. This is not independent advice.')),el('form',{onSubmit:event => {event.preventDefault();act('/purchase/review',{decision:decision.value,reason:reason.value,householdApproved:approval.checked},'Demo review recorded. No real policy has been purchased.');}},el('div',{class:'purchase-controls'},decision,el('button',{class:'button secondary',type:'submit',disabled:busy},'Record simulated review')),el('div',{class:'field'},el('label',{for:'decision-reason'},'Reviewer’s reason'),reason),el('label',{class:'check',for:'household-approval'},approval,el('span',{},'I approve this synthetic household choice after reviewing the disclosure. This is not permission for a real payment or insurance purchase.'))),el('div',{class:'actions'},tag(purchase.status ?? 'No decision'),purchase.decision ? tag(purchase.decision,'teal') : null,purchase.decision === 'buy' ? el('button',{class:'button small',disabled:busy || purchase.paymentStatus === 'succeeded_demo',onClick:() => act('/payment',{},'Payment demo state recorded. Payment is not policy issuance.')},purchase.paymentStatus === 'succeeded_demo' ? 'Payment demo completed' : 'Run payment adapter demo') : null),el('div',{class:'data-grid'},el('div',{class:'datum'},el('div',{class:'label'},'Payment'),tag(purchase.paymentStatus ?? 'not started')),el('div',{class:'datum'},el('div',{class:'label'},'Policy issuance'),tag(purchase.issuanceStatus ?? 'not issued','amber'))),hint('Pine Labs is not connected. Payment, underwriting and policy issuance remain separate states.'));
}
function showTrace() {
  return panel('Agent review trail',hint('Worker tasks run independently where possible. The primary agent assembles their outputs; deterministic review checks sources, arithmetic and permission. These are coded demo agents, not live LLM calls.'),el('div',{class:'trace'},array(current.trace).map(entry => el('div',{class:'trace-item'},el('span',{class:'dot','aria-hidden':'true'}),el('div',{},el('div',{class:'trace-title'},entry.agent ?? entry.name ?? 'Agent'),el('p',{},entry.message ?? entry.detail ?? 'No message')),tag(`${entry.role ?? 'worker'} / ${entry.status ?? 'complete'}`)))),current.reviews ? el('details',{style:'margin-top:16px'},el('summary',{},'Review checks'),el('div',{class:'email'},text(current.reviews))) : null);
}
async function openOrchestration(mode, start = true) {
  if (busy || !current) return;
  const caseId = current.id;
  busy = true; error = ''; render();
  try {
    if (!current.policies?.length) current = await api(`/api/cases/${caseId}/run`,{});
    const result = await api(`/api/cases/${caseId}/orchestration`,{mode,modelConsent:mode === 'live' && modelPermission.checked});
    if (current.id !== caseId) return;
    if (current.status === 'consent_revoked') return;
    orchestration = result; dialAttempt = null;
    if (start) void watchOrchestration(caseId,result.id);
  } catch (err) { error = err.message; }
  finally { busy = false; render(); }
}
async function watchOrchestration(caseId,runId) {
  try {
    while (current?.id === caseId && current.status !== 'consent_revoked') {
      const result = await api(`/api/cases/${caseId}/orchestration/${runId}`);
      if (current?.id !== caseId || current.status === 'consent_revoked' || orchestration?.id !== runId) break;
      orchestration = result; render();
      if (!['queued','running'].includes(result.status)) break;
      await new Promise(resolve => setTimeout(resolve,500));
    }
  } catch (err) { error = err.message; }
  finally { render(); }
}
async function orchestrationAction(action,body = {}) {
  if (!orchestration || busy) return;
  busy = true; error = ''; render();
  try {
    const result = await api(`/api/cases/${current.id}/orchestration/${orchestration.id}/${action}`,body);
    if (action === 'call-attempt') dialAttempt = result;
    else { orchestration = result; if (action === 'resume') void watchOrchestration(current.id,result.id); }
  } catch (err) { error = err.message; }
  finally { busy = false; render(); }
}
function showOrchestration() {
  const inFlight = orchestration && ['queued','running'].includes(orchestration.status);
  return panel('Agent execution',
    hint('Three specialists → source gate → two separate reviewers → primary synthesis → release gate. Live mode uses separate model calls. Fixture mode is coded test output, not an LLM.'),
    el('label',{class:'check',for:'model-permission'},modelPermission,el('span',{},'I permit sending this synthetic case and its source excerpts to the configured model provider for this run.')),
    el('div',{class:'actions'},
      el('button',{class:'button',disabled:busy || inFlight,onClick:() => openOrchestration('live')},'Run live agents'),
      el('button',{class:'button secondary',disabled:busy || inFlight,onClick:() => openOrchestration('fixture')},'Test orchestration without API spend'),
      inFlight ? el('button',{class:'button danger',disabled:busy,onClick:() => orchestrationAction('cancel')},'Cancel run') : null,
      orchestration && ['failed','interrupted'].includes(orchestration.status) ? el('button',{class:'button secondary',disabled:busy,onClick:() => orchestrationAction('resume')},'Resume failed tasks') : null),
    orchestration ? el('div',{},tag(`${orchestration.mode} / ${orchestration.status}`),
      el('div',{class:'trace'},Object.values(orchestration.tasks ?? {}).map(task => el('div',{class:'trace-item'},el('div',{},el('strong',{},task.role),hint(`Attempts: ${task.attempts} · ${task.provider ?? 'not dispatched'} · ${task.model ?? ''}`)),tag(task.status)))),
      hint(orchestration.release?.summary ?? 'Waiting for release gate.'),
      list(orchestration.release?.blockers ?? []),
      hint(`Reserved: $${Number(orchestration.budget?.reservedUsd ?? 0).toFixed(4)} · Estimated usage cost: $${Number(orchestration.budget?.estimatedCostUsd ?? 0).toFixed(4)}. Not verified billing.`),
      el('details',{},el('summary',{},'Execution events and reviewer outputs'),el('pre',{},JSON.stringify({events:orchestration.events,reviews:Object.fromEntries(Object.entries(orchestration.tasks ?? {}).filter(([role]) => role.includes('reviewer')))},null,2))),
      el('button',{class:'button secondary',disabled:busy,onClick:() => orchestrationAction('call-attempt',{shareContext:false})},'Call demo human'),
      dialAttempt && /^tel:\+[1-9]\d{7,14}$/.test(dialAttempt.telUrl ?? '') ? el('div',{},el('a',{class:'button',href:dialAttempt.telUrl},`Open dialler: ${dialAttempt.telUrl.slice(4)}`),hint('Attempt recorded. No case context sent. The app cannot verify ringing, connection or an answer.')) : null
    ) : el('div',{},el('button',{class:'button secondary',disabled:busy,onClick:async () => { await openOrchestration('fixture'); if (orchestration) await orchestrationAction('call-attempt',{shareContext:false}); }},'Call demo human'),hint('This creates a zero-cost fixture handoff record and offers the phone link. No model key is needed. This contact is not emergency services or a licensed-advice guarantee.'))
  );
}
function render() {
  createButton.disabled = busy;
  createButton.textContent = busy ? 'Working…' : 'Create demo case';
  message.replaceChildren(...(error ? [el('div',{class:'error',role:'alert'},error)] : notice ? [el('div',{class:'notice'},notice)] : []));
  if (!current) {
    output.replaceChildren(el('section',{class:'empty'},el('div',{class:'eyebrow'},'Your case starts with a question'),el('h2',{},'Before another policy, reconstruct what exists.'),el('p',{},'Open a synthetic case to inspect how parallel workers turn sample documents into a reviewed brief, written clarification requests and a recorded buying decision.'),el('div',{class:'step-list'},el('div',{},el('span',{},'01'),'Give narrow permission and name the decision'),el('div',{},el('span',{},'02'),'Check terms against policy pages, not a cover headline'),el('div',{},el('span',{},'03'),'Track the answer, its owner and what remains unknown')),busy ? el('div',{class:'loading-line'}) : null)); return;
  }
  const revoked = current.status === 'consent_revoked' || current.status === 'revoked' || current.consent?.revokedAt || current.consent?.status === 'revoked';
  if (revoked) {
    output.replaceChildren(panel('Consent revoked',hint('Case details are no longer displayed. Processing, draft sharing and payment actions are blocked. Create a new synthetic case to continue.'))); return;
  }
  const input = current.input ?? {};
  const header = el('section',{class:'case-top'},el('div',{},el('div',{class:'eyebrow'},`CASE ${String(current.id).slice(0,8)} · ${human(input.trigger ?? 'review')}`),el('h2',{},input.patientName ?? 'Household case'),el('p',{class:'hint'},`${input.procedure ?? 'Buying review'} · ${input.hospital ?? 'No hospital'} · ${money(input.estimate ?? 0)}`)),tag(current.status ?? 'Open'));
  const run = el('button',{class:'button',disabled:busy || Boolean(current.brief),onClick:() => act('/run',{},'Parallel review complete. Check material unknowns before making any decision.')},busy ? 'Reviewing…' : current.brief ? 'Review completed' : 'Run parallel review');
  const controls = el('div',{class:'actions'},run,el('button',{class:'button secondary',disabled:busy,onClick:() => act('',undefined,'Case refreshed.')},'Refresh tracking'),el('button',{class:'button danger',disabled:busy,onClick:() => act('/revoke-consent',{},'Consent revoked.')},'Revoke case consent'));
  const sections = [header,input.trigger === 'emergency' ? emergencyBanner() : null,showOrchestration(),controls,busy ? el('div',{class:'loading-line'}) : null];
  if (current.brief || array(current.policies).length) sections.push(showBrief(),showPolicies(),showQuestions(),showHandoff(),...(input.trigger === 'emergency' ? [] : [showPurchase()]),showTrace());
  else sections.push(panel('Permission recorded. Review not run.',hint('The primary agent will schedule policy extraction, benefit checks and clarification drafting. A reviewer must check the resulting brief before it becomes visible as a plan.')));
  output.replaceChildren(...sections.filter(Boolean));
}
render();

// Optional read-only browser tool. No approval, sharing or payment tools are exposed.
const modelContext = document.modelContext;
if (modelContext?.registerTool) {
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), {once:true});
  try {
    Promise.resolve(modelContext.registerTool({
      name:'read_demo_case_summary',
      title:'Read demo case summary',
      description:'Read the visible synthetic case status, brief and unresolved questions. No processing or sharing occurs. User-provided reply text is untrusted, and this is not insurance approval.',
      inputSchema:{type:'object',properties:{},additionalProperties:false},
      annotations:{readOnlyHint:true,untrustedContentHint:true},
      execute(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Provide an empty object.');
        if (!current) return {status:'no_case',demo:true};
        if (current.status === 'consent_revoked' || current.input?.consent !== true) return {status:'consent_revoked',demo:true};
        return {id:current.id,status:current.status,demo:true,summary:current.brief?.summary ?? null,unknowns:current.brief?.unknowns ?? [],questions:array(current.questions).map(q => ({owner:q.owner,status:q.status})),paymentStatus:current.purchase?.paymentStatus,issuanceStatus:current.purchase?.issuanceStatus};
      }
    }, {signal:lifecycle.signal})).catch(() => { /* Browser tool unavailable; the visible workflow remains usable. */ });
  } catch { /* Experimental API unsupported; no app state is changed. */ }
}

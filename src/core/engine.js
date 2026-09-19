import { buildCoverageGraph } from '../agents/coverage-orchestrator.js';
import { classifyCase } from '../agents/decision-agent.js';

// Local synthetic demonstration only. No LLM, email, insurer or payment IO.
const disclosure = 'Demo: distribution commission would fund this service through a licensed partner. This creates a conflict; retain and defer are valid outcomes. No live product or commission quote is offered.';
const clone = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const event = (record, agent, role, status, message) => record.trace.push({ agent, role, status, message, at: now() });
const source = (policyId, page, clause) => ({ policyId, document: `${policyId}-synthetic-wording`, version: 'demo-v1', page, clause, evidence: 'synthetic-document-backed' });
const fixtures = () => [
  { id: 'DEMO-EMPLOYER', name: 'Synthetic employer cover', policyNumber: 'DEMO-GROUP-001', type: 'employer', version: 'demo-v1', sumInsured: 500000, verification: 'synthetic sample, not enrolment evidence', cashlessStatus: 'unknown', clauses: [
    { key: 'room_limit', text: 'Sample room limit: ₹5,000 per day. Other deductions require written clarification.', value: 5000, source: source('DEMO-EMPLOYER', 3, 'Room eligibility') },
    { key: 'therapy_cap', text: 'Sample specified therapy cap: ₹3,00,000. Applicability to this procedure is unresolved.', value: 300000, source: source('DEMO-EMPLOYER', 4, 'Specified therapy benefit') },
    { key: 'network', text: 'Cashless access requires case-specific institutional confirmation.', source: source('DEMO-EMPLOYER', 6, 'Cashless process') }
  ] },
  { id: 'DEMO-PERSONAL', name: 'Synthetic personal cover', policyNumber: 'DEMO-RETAIL-002', type: 'personal', version: 'demo-v1', sumInsured: 700000, verification: 'synthetic sample only', cashlessStatus: 'unknown', clauses: [
    { key: 'copay', text: 'Sample co-pay: 10% of eligible expenses, not necessarily 10% of the hospital estimate.', value: 0.1, source: source('DEMO-PERSONAL', 5, 'Co-payment') },
    { key: 'waiting_period', text: 'Sample pre-existing-condition waiting period: 24 months. History and continuity are unresolved.', value: 24, source: source('DEMO-PERSONAL', 7, 'Waiting periods') },
    { key: 'exclusions', text: 'Eligibility depends on issued exclusions, disclosures and case assessment. Missing history is not absence of disease.', source: source('DEMO-PERSONAL', 8, 'Exclusions and disclosures') }
  ] }
];

export function createCase(input = {}) {
  if (!['planned_care', 'renewal', 'emergency'].includes(input.trigger)) throw new Error('Choose a supported trigger.');
  const estimate = Number(input.estimate || 0);
  if (!Number.isFinite(estimate) || estimate < 0) throw new Error('Estimate must be a non-negative number.');
  // Whitelist fields. A consent flag here only covers this synthetic single adult.
  const allowed = { trigger: input.trigger, patientName: String(input.patientName || 'Demo adult').slice(0, 120), procedure: String(input.procedure || 'Procedure to clarify').slice(0, 240), hospital: String(input.hospital || 'Demo hospital').slice(0, 160), estimate, consent: input.consent === true };
  if (!allowed.consent) Object.assign(allowed, { patientName: '', procedure: '', hospital: '', estimate: 0 });
  return { id: `case-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`, demo: true, createdAt: now(), input: allowed, status: 'created', policies: [], findings: [], questions: [], trace: [], reviews: [], brief: null, coverageGraph: null, classification: null, handoff: null,
    purchase: { decision: null, status: 'not_reviewed', commissionDisclosure: disclosure, householdApproved: false, paymentStatus: 'not_started', issuanceStatus: 'not_issued' } };
}

function requireConsent(record) {
  if (record.input.consent !== true || record.status === 'consent_revoked') throw new Error('Recorded consent is required.');
}

// Reviewer validates contract evidence, not model agreement or confidence.
// This deliberately accepts only unresolved synthetic findings in the MVP.
export function validateFindings(findings, policies) {
  const errors = [];
  for (const finding of findings) {
    const policy = policies.find(item => item.id === finding.policyId);
    const clause = policy?.clauses.find(item => item.key === finding.type);
    if (!clause || !Array.isArray(finding.sources) || finding.sources.length !== 1) {
      errors.push(`${finding.id}: missing known clause or citation`); continue;
    }
    const citation = finding.sources[0];
    if (!['policyId', 'document', 'version', 'page', 'clause', 'evidence'].every(key => citation[key] === clause.source[key])) errors.push(`${finding.id}: citation does not match the known policy version and clause`);
    if (finding.text !== clause.text || finding.value !== (clause.value ?? null)) errors.push(`${finding.id}: assertion differs from cited synthetic excerpt`);
    if (finding.applicability !== 'unresolved') errors.push(`${finding.id}: applicability cannot be confirmed by worker agreement`);
    if (finding.guaranteed === true || finding.cashlessApproved === true || finding.claimApproved === true || finding.confirmedPayable != null) errors.push(`${finding.id}: unsupported coverage certainty`);
  }
  return { pass: errors.length === 0 && findings.length > 0, errors };
}

export async function runCase(caseRecord) {
  const record = clone(caseRecord);
  if (!record.input.consent || record.status === 'consent_revoked') {
    record.status = record.status === 'consent_revoked' ? 'consent_revoked' : 'blocked_consent';
    record.policies = []; record.findings = []; record.questions = []; record.reviews = []; record.brief = null; record.coverageGraph = null; record.classification = null;
    event(record, 'permission-gate', 'reviewer', 'blocked', 'No policy data processed. Consent is required. Emergency care must not wait for this demo.');
    return record;
  }
  // Repeated requests do not discard replies or bypass/inherit a stale decision.
  if (['brief_ready', 'human_handoff', 'review_blocked'].includes(record.status)) return record;
  event(record, 'primary-orchestrator', 'primary', 'started', 'Dispatching independent synthetic cover, benefit-rule and question workers in parallel.');
  if (record.input.trigger === 'emergency') {
    record.handoff = { required: true, status: 'human_requested_demo', owner: 'Human support desk (demo, not staffed)', summary: 'Admit first. Optimise later. Contact the hospital emergency desk now. This prototype cannot call emergency services or provide live support.' };
    event(record, 'emergency-safety', 'reviewer', 'escalated', record.handoff.summary);
  }
  const sample = fixtures();
  const jobs = [
    ['cover-worker', () => sample],
    ['benefit-rules-worker', () => sample.flatMap(policy => policy.clauses.map(clause => ({ id: `${policy.id}-${clause.key}`, policyId: policy.id, type: clause.key, text: clause.text, value: clause.value ?? null, applicability: 'unresolved', sources: [clause.source] })))],
    ['coordination-worker', () => {
      const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      return [
        { id: 'q-hospital', owner: 'Hospital insurance desk', subject: 'Demo: admission estimate and cashless process', body: 'Please clarify the requested deposit, room category, document checklist and the route for a case-specific preauthorisation request. No authorisation is assumed.', sources: [sample[0].clauses[0].source, sample[0].clauses[2].source] },
        { id: 'q-hr', owner: 'HR / benefits administrator', subject: 'Demo: employer enrolment and current benefit wording', body: 'Please confirm enrolment and supply the current group benefit booklet and applicable endorsements. A headline sum insured does not establish this admission’s eligibility.', sources: [sample[0].clauses[1].source] },
        { id: 'q-tpa', owner: 'TPA / insurer', subject: 'Demo: procedure-specific benefit clarification', body: 'Please clarify the applicable therapy limit, room conditions, co-pay, waiting period and documents needed for assessment. Please distinguish guidance, preauthorisation and final settlement.', sources: [sample[0].clauses[1].source, sample[1].clauses[0].source, sample[1].clauses[1].source] }
      ].map(question => ({ ...question, dueAt, status: 'draft', permission: 'requires separate sharing approval', demo: true }));
    }]
  ];
  // Start all jobs before any completion. Dependencies consume the joined output.
  const results = await Promise.all(jobs.map(async ([agent, work]) => {
    event(record, agent, 'worker', 'started', 'Working from the same immutable synthetic fixture version.');
    await Promise.resolve();
    const result = work();
    event(record, agent, 'worker', 'completed', 'Structured result prepared; no external request sent.');
    return result;
  }));
  [record.policies, record.findings, record.questions] = results;
  const employerPolicy = sample.find(policy => policy.type === 'employer');
  const personalPolicy = sample.find(policy => policy.type === 'personal');
  const groupFact = { room_limit: 'room_rent_limit', therapy_cap: 'procedure_limit', network: 'network_requirement' };
  record.coverageGraph = buildCoverageGraph({
    profilePacket: {
      subjectId: record.id,
      source: { type: 'manual', id: `${record.id}:intake`, reporterId: record.id, retrievedAt: record.createdAt, version: 'demo-v1', location: 'synthetic-case-intake' },
      requestedFields: ['displayName', 'currentlyEmployed'],
      consent: { id: `${record.id}:profile-consent`, subjectId: record.id, status: 'granted', purpose: 'profile_intake', sources: ['manual'], fields: ['displayName', 'currentlyEmployed'], grantedAt: record.createdAt },
      data: { displayName: record.input.patientName },
    },
    groupPolicies: [{
      policyId: employerPolicy.id,
      evidence: employerPolicy.clauses.map(clause => ({ fact: groupFact[clause.key], value: clause.value ?? clause.text, sourceId: clause.source.document, page: clause.source.page, version: clause.source.version, evidenceStatus: 'document-backed' })),
    }],
    personalPacket: {
      synthetic: true,
      consent: true,
      evidence: personalPolicy.clauses.map(clause => ({ id: `${personalPolicy.id}:${clause.key}`, policyId: personalPolicy.id, dimension: 'constraints', field: clause.key, value: clause.value ?? clause.text, status: 'document_backed', source: { id: clause.source.document, page: clause.source.page, version: clause.source.version } })),
    },
  });
  record.classification = classifyCase({ trigger: record.input.trigger, statedEstimate: record.input.estimate, coverageGraph: record.coverageGraph });
  const evidenceReview = validateFindings(record.findings, record.policies);
  const checks = [
    { agent: 'evidence-reviewer', pass: evidenceReview.pass, errors: evidenceReview.errors, message: 'Every benefit assertion must exactly match the known synthetic excerpt, source page and version. Worker agreement cannot establish applicability.' },
    { agent: 'privacy-reviewer', pass: record.input.consent === true && record.questions.every(question => question.status === 'draft'), message: 'Single-adult demo processing permitted. All outbound questions remain drafts; no medical details shared.' },
    { agent: 'safety-reviewer', pass: evidenceReview.pass && record.policies.every(policy => policy.cashlessStatus === 'unknown'), message: 'Unsupported applicability and coverage certainty rejected. No claim approval, treatment selection, guaranteed payout or borrowing recommendation. Sum insured is not payable cash.' }
  ];
  record.reviews = checks.map(check => ({ ...check, status: check.pass ? 'passed' : 'blocked', iteration: 1, maxIterations: 1 }));
  checks.forEach(check => event(record, check.agent, 'reviewer', check.pass ? 'passed' : 'blocked', check.message));
  record.status = checks.every(check => check.pass) ? (record.input.trigger === 'emergency' ? 'human_handoff' : 'brief_ready') : 'review_blocked';
  record.brief = {
    summary: record.input.trigger === 'emergency' ? 'Admit first. Optimise later. Human handoff requested in this demo.' : record.input.trigger === 'renewal' ? 'Reconstruct existing cover before a buying decision. Retain, defer and buy remain separate choices.' : 'Admission Readiness Brief: source-linked conditions and written questions, not a claim decision.',
    nextActions: record.input.trigger === 'emergency' ? ['Contact the hospital emergency desk now. Do not delay care for optimisation.', 'An authorised human can review the source-linked case later.'] : ['Verify the existing operator and backup; the readiness drill is not yet completed.', 'Review each minimum-data draft and approve only permitted sharing.', 'Obtain written institutional clarification before treating eligibility as confirmed.'],
    unknowns: ['Cashless and preauthorisation status unknown.', 'Enrolment, policy continuity, medical disclosures and procedure applicability unresolved.', 'Operator permissions and five-minute readiness drill not verified.', 'A new policy may not cover an already planned treatment.'],
    cashScenario: { estimate: record.input.estimate, estimateEvidence: 'user-stated demo estimate', confirmedPayable: null, requestedDeposit: null, possibleUpfront: record.input.estimate || null, label: 'If nothing is confirmed, prepare for the stated estimate as a possible upfront scenario. Deposit and final personal expense are unknown. No policy limits are added into cash.' }
  };
  record.handoff ||= { required: true, status: 'available_on_exception_demo', owner: 'Human review desk (demo)', summary: 'Unresolved contractual points need the institution; a licensed human must review any real purchase recommendation.' };
  event(record, 'primary-orchestrator', 'primary', 'completed', 'One bounded review pass completed. Unknowns preserved; no institution decision fabricated.');
  return record;
}

export function approveQuestion(caseRecord, questionId) {
  const record = clone(caseRecord); requireConsent(record);
  const question = record.questions.find(item => item.id === questionId);
  if (!question) throw new Error('Question not found.');
  if (question.status !== 'draft') return record;
  question.status = 'approved_demo'; question.approvedAt = now(); question.permission = 'user-approved synthetic demo sharing only';
  event(record, 'coordination-worker', 'worker', 'approved_demo', `${question.owner}: draft approved for simulation. No email sent.`);
  return record;
}

export function recordReply(caseRecord, questionId, text) {
  const record = clone(caseRecord); requireConsent(record);
  const question = record.questions.find(item => item.id === questionId);
  if (!question || !['approved_demo', 'answered_demo'].includes(question.status)) throw new Error('Approve the draft before recording a demo reply.');
  if (!String(text || '').trim()) throw new Error('Reply text is required.');
  question.replyHistory ||= [];
  const reply = { text: String(text).slice(0, 5000), at: now(), evidence: 'synthetic unverified reply', authority: question.owner, bindingApproval: false };
  question.replyHistory.push(reply); question.reply = reply; question.status = 'answered_demo';
  record.brief.unknowns = [...new Set([...record.brief.unknowns, 'Demo replies are unverified. Conflicting replies and claim eligibility remain open for authorised institutional review.'])];
  event(record, 'response-reviewer', 'reviewer', 'needs_verification', 'Demo reply preserved verbatim, not treated as cashless or final claim approval.');
  return record;
}

export function reviewPurchase(caseRecord, choice) {
  const record = clone(caseRecord); requireConsent(record);
  const options = typeof choice === 'string' ? { decision: choice } : choice || {};
  if (!['buy', 'retain', 'defer'].includes(options.decision)) throw new Error('Choose buy, retain or defer.');
  if (!record.policies.length || !record.reviews.length || record.reviews.some(review => !review.pass)) throw new Error('Complete cover reconstruction and review first.');
  if (record.input.trigger === 'emergency') throw new Error('Emergency care is not a purchase flow.');
  if (!record.purchase.commissionDisclosure) throw new Error('Commission disclosure is required.');
  record.purchase = { ...record.purchase, decision: options.decision, status: options.decision === 'buy' ? (options.householdApproved === true ? 'human_approved_demo' : 'awaiting_household_approval') : `${options.decision}_recorded_demo`, humanReview: 'explicit demo human action, not a licensed recommendation', treatmentBoundary: 'No new policy is represented as covering this existing or planned treatment. Buying here only demonstrates a future purchase workflow.', householdApproved: options.householdApproved === true, reason: String(options.reason || 'Recorded demo decision. No real product recommendation.'), reviewedAt: now(), paymentStatus: 'not_started', issuanceStatus: 'not_issued' };
  event(record, 'human-review-gate', 'human', record.purchase.status, 'Synthetic decision recorded. A real buying flow still needs verified operator/drill, licensed partner, underwriting and separate household approval.');
  return record;
}

export function simulatePayment(caseRecord) {
  const record = clone(caseRecord); requireConsent(record);
  if (record.purchase.decision !== 'buy' || record.purchase.status !== 'human_approved_demo' || !record.purchase.householdApproved || !record.purchase.commissionDisclosure) throw new Error('Demo human buy review, household approval and commission disclosure are required.');
  if (record.purchase.paymentStatus === 'succeeded_demo') return record;
  record.purchase.paymentStatus = 'succeeded_demo'; record.purchase.issuanceStatus = 'not_issued'; record.purchase.paymentReference = `DEMO-${record.id}`;
  event(record, 'payment-worker', 'worker', 'succeeded_demo', 'Local simulation only. No money moved. Payment is not underwriting acceptance or policy issuance.');
  return record;
}

export function revokeConsent(caseRecord) {
  const record = clone(caseRecord);
  record.input = { trigger: record.input.trigger, patientName: '', procedure: '', hospital: '', estimate: 0, consent: false };
  record.status = 'consent_revoked'; record.policies = []; record.findings = []; record.questions = []; record.brief = null; record.coverageGraph = null; record.classification = null; record.reviews = []; record.handoff = null;
  record.purchase = { decision: null, status: 'blocked_consent', commissionDisclosure: disclosure, householdApproved: false, paymentStatus: 'not_started', issuanceStatus: 'not_issued' };
  record.trace = []; event(record, 'permission-gate', 'reviewer', 'revoked', 'Local case data cleared and subsequent operations blocked. Production downstream deletion is not implemented.');
  return record;
}

import { randomUUID } from 'node:crypto';
import { createDiskStore } from './store.js';
export { createDiskStore, createMemoryStore } from './store.js';

const WORKERS = ['cover-worker', 'rules-worker', 'coordination-worker'];
const REVIEWERS = ['evidence-reviewer', 'safety-reviewer'];
const ROLES = [...WORKERS, ...REVIEWERS, 'primary'];
const projectLedgers = new Map();
let dispatched = 0;
const dispatchQueue = [];
async function acquireDispatch(signal) {
  if (signal.aborted) throw new Error('Aborted before dispatch.');
  if (dispatched >= 3) await new Promise((resolve, reject) => {
    const entry = { resolve, reject, signal };
    const abort = () => { const index = dispatchQueue.indexOf(entry); if (index >= 0) dispatchQueue.splice(index, 1); reject(new Error('Aborted while queued.')); };
    entry.abort = abort; signal.addEventListener('abort', abort, { once: true }); dispatchQueue.push(entry);
  }); else dispatched++;
  return () => { const next = dispatchQueue.shift(); if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(); } else dispatched--; };
}
const at = () => new Date().toISOString();
function frozen(value) { const copy = structuredClone(value); const walk = object => { if (object && typeof object === 'object') { Object.values(object).forEach(walk); Object.freeze(object); } }; walk(copy); return copy; }
function fail(message, code = 'INVALID_REQUEST', statusCode = 400) { const error = new Error(message); error.code = code; error.statusCode = statusCode; return error; }
const certainty = text => {
  const withoutNegations = text.replace(/\b(?:not|never|no|cannot|can't|isn't|is not|are not)\s+(?:a\s+)?(?:guaranteed|approved|covered|payable|claim approval|cashless approval|guarantee)\b/gi, 'uncertain');
  return /\b(?:guaranteed|will (?:pay|reimburse|cover)|claim (?:is |has been )?approved|cashless (?:is |has been )?approved|eligible payout|definitely covered|coverage confirmed)\b/i.test(withoutNegations);
};
const prohibitedAdvice = text => /\b(?:you should|you must|recommend(?:ed)?|please|go ahead and)\s+(?:borrow|take (?:a )?loan|sell|liquidate|delay (?:care|treatment)|choose (?:a )?treatment)\b/i.test(text);

export function validateTaskOutput(output, sources) {
  const blockers = [];
  if (!output || typeof output !== 'object' || !Array.isArray(output.findings) || output.findings.length > 30 || typeof output.summary !== 'string' || output.summary.length > 2000 || !['pass', 'flag', 'block'].includes(output.verdict)) return { pass: false, blockers: ['Malformed or oversized model output.'] };
  const known = new Map(sources.map(source => [source.id, source]));
  if (certainty(output.summary)) blockers.push('Unsupported certainty in model summary.');
  if (prohibitedAdvice(output.summary)) blockers.push('Out-of-scope treatment or financial advice in model summary.');
  if (!sources.some(source => source.text === output.summary) && (/[\d₹$€£]|\b(?:lakh|crore|million|thousand|hundred)\b/i.test(output.summary) || /\b(?:is|are|will be|definitely|fully)\s+(?:covered|eligible|payable|approved)\b/i.test(output.summary))) blockers.push('Invented amount or affirmative eligibility in model summary.');
  for (const finding of output.findings) {
    if (!finding || typeof finding.id !== 'string' || finding.id.length > 120 || typeof finding.text !== 'string' || finding.text.length > 1200 || !Array.isArray(finding.sourceIds) || finding.sourceIds.length > 8 || !['info', 'warning', 'blocker'].includes(finding.severity) || !['observation', 'unknown', 'question'].includes(finding.kind)) { blockers.push('Malformed finding.'); continue; }
    if (finding.sourceIds.some(id => !known.has(id))) blockers.push(`${finding.id}: unsupported citation.`);
    if (!finding.sourceIds.length) blockers.push(`${finding.id}: source-bound findings are required.`);
    // Insurance observations are literal evidence excerpts, not model-made eligibility.
    if (finding.kind === 'observation' && (!finding.sourceIds.length || !finding.sourceIds.some(id => known.get(id)?.text === finding.text))) blockers.push(`${finding.id}: observation is not a known source excerpt.`);
    const exactExcerpt = finding.sourceIds.some(id => known.get(id)?.text === finding.text);
    if (!exactExcerpt && finding.kind !== 'observation') {
      const safeForm = finding.kind === 'question' ? /^(?:What|How|Which|Whether|Does|Is|Can|Could|Would|Please clarify|Please confirm)\b[\s\S]*\?$/i.test(finding.text.trim()) : /^(?:Unknown|Unresolved|Unconfirmed|Not confirmed|Cannot determine|Needs verification)\b/i.test(finding.text.trim());
      if (!safeForm || /[\d₹$€£]|\b(?:lakh|crore|million|thousand|hundred)\b/i.test(finding.text) || /\b(?:is|are|will be|definitely|fully)\s+(?:covered|eligible|payable|approved)\b/i.test(finding.text)) blockers.push(`${finding.id}: invented assertion or amount hidden in question/unknown.`);
    }
    if (certainty(finding.text)) blockers.push(`${finding.id}: unsupported claim certainty.`);
    if (prohibitedAdvice(finding.text)) blockers.push(`${finding.id}: out-of-scope treatment or financial advice.`);
    if (finding.severity === 'blocker') blockers.push(`${finding.id}: model flagged a blocker.`);
  }
  if (output.verdict === 'block') blockers.push('Model returned a blocking verdict.');
  return { pass: blockers.length === 0, blockers: [...new Set(blockers)] };
}

export function createOrchestrator({ store = createDiskStore(), executor, budgetUsd = 0.25, projectBudgetUsd = Number(process.env.ORCHESTRATION_PROJECT_BUDGET_USD || 5), taskReservationUsd = 0.02, timeoutMs = 30000 } = {}) {
  if (!executor || typeof executor.execute !== 'function') throw new Error('An executor.execute implementation is required.');
  if (![budgetUsd, projectBudgetUsd, taskReservationUsd, timeoutMs].every(value => Number.isFinite(value) && value > 0) || budgetUsd > 1 || taskReservationUsd > budgetUsd || timeoutMs > 60000) throw new Error('Invalid bounded orchestration limits.');
  const ledgerKey = store.limits?.directory || store;
  if (!projectLedgers.has(ledgerKey)) projectLedgers.set(ledgerKey, { reservedUsd: 0 });
  const project = projectLedgers.get(ledgerKey);
  const records = new Map(); const active = new Map();
  const event = (run, type, message, role) => { run.events.push({ at: at(), type, message, ...(role ? { role } : {}) }); run.updatedAt = at(); };
  const save = run => store.put(structuredClone(run));
  const ready = (async () => {
    let persistedReserved = 0;
    for (const id of await store.list()) {
      const run = await store.get(id); if (!run) continue;
      if (run.status === 'running') {
        run.status = 'interrupted';
        for (const task of Object.values(run.tasks)) if (task.status === 'running') { task.status = 'interrupted'; task.error = 'Process stopped before completion; provider billing may still have occurred.'; }
        event(run, 'restart_interrupted', 'Interrupted tasks require an explicit safe resume. Prior reservations remain counted.'); await save(run);
      }
      records.set(id, run);
      persistedReserved += run.budget.reservedUsd;
    }
    project.reservedUsd = Math.max(project.reservedUsd, persistedReserved);
  })();
  const get = async id => { await ready; const run = records.get(id); if (!run) throw fail('Run not found.', 'NOT_FOUND', 404); return run; };
  const allowed = run => { if (!run.processingConsent || run.status === 'revoked') throw fail('Consent revoked or absent.', 'CONSENT_REQUIRED', 403); };
  const gate = (run, roles) => {
    const blockers = [];
    for (const role of roles) {
      const task = run.tasks[role];
      if (task.status !== 'completed' || !task.output) blockers.push(`${role}: required task did not complete.`);
      else blockers.push(...validateTaskOutput(task.output, run.sources).blockers);
    }
    return [...new Set(blockers)];
  };
  const reserveStage = async (run, roles) => {
    const pending = roles.filter(role => run.tasks[role].status !== 'completed');
    const perTask = typeof executor.reservationUsd === 'function' ? executor.reservationUsd({ mode: run.mode }) : taskReservationUsd;
    if (!Number.isFinite(perTask) || perTask < 0) throw fail('Executor has no valid conservative reservation.', 'BUDGET_EXCEEDED', 409);
    const reserve = pending.length * perTask;
    if (run.budget.reservedUsd + reserve > run.budget.limitUsd + 1e-9) throw fail('Conservative run budget cannot reserve this stage.', 'BUDGET_EXCEEDED', 409);
    if (project.reservedUsd + reserve > projectBudgetUsd + 1e-9) throw fail('Conservative persisted project budget cannot reserve this stage.', 'BUDGET_EXCEEDED', 409);
    if (pending.some(role => run.tasks[role].attempts >= 2)) throw fail('Task attempt limit reached.', 'ATTEMPT_LIMIT', 409);
    // Reserve the complete parallel stage before any executor is dispatched.
    for (const role of pending) { run.tasks[role].status = 'running'; run.tasks[role].attempts++; run.tasks[role].attemptReservationUsd = perTask; run.tasks[role].reservedUsd = (run.tasks[role].reservedUsd || 0) + perTask; }
    run.budget.reservedUsd = Number((run.budget.reservedUsd + reserve).toFixed(8));
    project.reservedUsd = Number((project.reservedUsd + reserve).toFixed(8));
    run.budget.projectReservedUsd = project.reservedUsd;
    event(run, 'budget_reserved', `Reserved ${reserve.toFixed(4)} USD for ${pending.length} task attempts before dispatch.`); await save(run);
    return pending;
  };
  const executeTask = async (run, role, controller) => {
    const task = run.tasks[role]; const taskController = new AbortController();
    let releaseDispatch;
    const aborted = () => taskController.abort(controller.signal.reason);
    controller.signal.addEventListener('abort', aborted, { once: true });
    let timer;
    try {
      releaseDispatch = await acquireDispatch(controller.signal);
      timer = setTimeout(() => taskController.abort(new Error('Task timeout.')), timeoutMs);
      event(run, 'task_started', 'Bounded structured task dispatched (global maximum three).', role); await save(run);
      if (controller.signal.aborted || taskController.signal.aborted || !run.processingConsent || run.status === 'revoked' || run.status === 'cancelled') throw fail('Cancelled before model dispatch.', 'CANCELLED');
      const packet = { mode: run.mode, runId: run.id, input: structuredClone(run.input), sources: structuredClone(run.sources), upstream: (WORKERS.includes(role) ? [] : role === 'primary' ? [...WORKERS, ...REVIEWERS] : WORKERS).map(upstreamRole => ({ role: upstreamRole, output: REVIEWERS.includes(role) ? { findings: structuredClone(run.tasks[upstreamRole].output.findings), summary: run.tasks[upstreamRole].output.summary } : structuredClone(run.tasks[upstreamRole].output) })), constraints: { syntheticOnly: true, noClaimApproval: true, observationsMustQuoteSource: true, noExternalActions: true, summaryNoAmounts: true, unknownPrefix: 'Unknown, Unresolved, Unconfirmed, Not confirmed, Cannot determine or Needs verification', questionsMustBeInterrogative: true, nonQuotedFindingsNoAmounts: true } };
      const abortPromise = new Promise((_, reject) => { if (taskController.signal.aborted) reject(taskController.signal.reason || new Error('Task aborted.')); else taskController.signal.addEventListener('abort', () => reject(taskController.signal.reason || new Error('Task aborted.')), { once: true }); });
      const result = await Promise.race([executor.execute({ role, packet, signal: taskController.signal }), abortPromise]);
      if (controller.signal.aborted || run.status === 'revoked') return;
      if (!result || typeof result.provider !== 'string' || typeof result.model !== 'string' || !result.usage || !Number.isFinite(result.usage.inputTokens) || !Number.isFinite(result.usage.outputTokens) || result.usage.inputTokens < 0 || result.usage.outputTokens < 0 || !Number.isFinite(result.estimatedCostUsd) || result.estimatedCostUsd < 0) throw fail('Invalid executor usage accounting.', 'MODEL_OUTPUT_INVALID');
      if (JSON.stringify(result.output).length > 60000) throw fail('Model output size limit exceeded.', 'MODEL_OUTPUT_INVALID');
      task.output = structuredClone(result.output); task.provider = result.provider; task.model = result.model; task.usage = structuredClone(result.usage); task.estimatedCostUsd = result.estimatedCostUsd;
      run.usage.inputTokens += result.usage.inputTokens; run.usage.outputTokens += result.usage.outputTokens;
      run.budget.estimatedCostUsd += result.estimatedCostUsd;
      if (result.estimatedCostUsd > task.attemptReservationUsd + 1e-9) throw fail('Reported estimated task cost exceeded conservative reservation. No further tasks dispatched.', 'BUDGET_EXCEEDED');
      task.status = 'completed'; delete task.error; event(run, 'task_completed', 'Structured task output and estimated usage persisted.', role);
    } catch (error) {
      if (run.status !== 'revoked' && !task.output && error.usage && Number.isFinite(error.usage.inputTokens) && Number.isFinite(error.usage.outputTokens) && Number.isFinite(error.estimatedCostUsd)) {
        task.usage = structuredClone(error.usage); task.estimatedCostUsd = error.estimatedCostUsd;
        run.usage.inputTokens += error.usage.inputTokens; run.usage.outputTokens += error.usage.outputTokens; run.budget.estimatedCostUsd += error.estimatedCostUsd;
      }
      if (run.status !== 'revoked') { task.status = controller.signal.aborted ? 'cancelled' : 'failed'; task.error = error.code === 'BUDGET_EXCEEDED' ? error.message : 'Task failed or timed out. No provider error payload is retained.'; event(run, 'task_failed', task.error, role); }
    } finally { clearTimeout(timer); releaseDispatch?.(); controller.signal.removeEventListener('abort', aborted); if (run.status !== 'revoked') await save(run); }
  };
  const stage = async (run, roles, controller) => {
    if (controller.signal.aborted) throw fail('Run cancelled.', 'CANCELLED');
    const pending = await reserveStage(run, roles);
    if (controller.signal.aborted || !run.processingConsent || run.status === 'revoked' || run.status === 'cancelled') throw fail('Run cancelled before dispatch.', 'CANCELLED');
    await Promise.all(pending.map(role => executeTask(run, role, controller)));
    if (controller.signal.aborted) throw fail('Run cancelled.', 'CANCELLED');
    const failed = roles.some(role => run.tasks[role].status !== 'completed');
    if (failed) throw fail('A required model task failed. Explicit resume is required.', 'TASK_FAILED');
    const blockers = gate(run, roles);
    event(run, 'deterministic_gate', blockers.length ? 'Unsupported outputs blocked before downstream dispatch.' : 'Required outputs passed deterministic citation and certainty checks.'); await save(run);
    if (blockers.length) { run.release = { status: 'blocked', summary: 'Unsupported model conclusions were blocked.', findings: [], blockers }; throw fail('Deterministic evidence blocker.', 'EVIDENCE_BLOCKED'); }
  };
  const work = async (run, controller) => {
    try {
      await stage(run, WORKERS, controller);
      await stage(run, REVIEWERS, controller);
      await stage(run, ['primary'], controller);
      allowed(run);
      const blockers = gate(run, ROLES);
      if (blockers.length) { run.release = { status: 'blocked', summary: 'Release blocked.', findings: [], blockers }; run.status = 'blocked'; }
      else {
        const outputs = ROLES.map(role => run.tasks[role].output);
        const flagged = outputs.some(output => output.verdict === 'flag' || output.findings.some(finding => finding.severity === 'warning'));
        const findings = run.tasks.primary.output.findings;
        // Free-form summaries remain internal. Published summary is deterministic.
        run.release = { status: flagged ? 'human_review_required' : 'released', summary: `${flagged ? 'Human review required. ' : ''}Synthetic evidence review complete. Cashless status and claim eligibility remain unknown. No treatment or purchase decision is authorised.`, findings: structuredClone(findings), blockers: [] };
        run.status = flagged ? 'flagged' : 'completed';
      }
      event(run, 'release_gate', 'Models cannot override deterministic blockers. Human phone contact does not release conclusions.');
    } catch (error) {
      if (run.status !== 'revoked' && run.status !== 'cancelled') {
        run.status = error.code === 'EVIDENCE_BLOCKED' || error.code === 'BUDGET_EXCEEDED' || error.code === 'ATTEMPT_LIMIT' ? 'blocked' : 'failed';
        if (run.release.status === 'pending') run.release = { status: 'blocked', summary: 'No conclusion released.', findings: [], blockers: [error.message] };
        event(run, 'run_stopped', error.message);
      }
    } finally { if (run.status !== 'revoked') await save(run); active.delete(run.id); }
  };
  const launch = async run => {
    allowed(run);
    if (active.has(run.id) || !['queued', 'interrupted', 'failed'].includes(run.status)) return frozen(run);
    const controller = new AbortController(); active.set(run.id, controller); run.status = 'running'; run.release = { status: 'pending', summary: '', findings: [], blockers: [] };
    event(run, 'run_started', 'Fixed DAG scheduled in background.'); await save(run);
    // Do not await model execution. Promise failure is contained and persisted.
    void work(run, controller).catch(async () => { active.delete(run.id); run.status = 'failed'; event(run, 'storage_failure', 'Local persistence failed; no conclusion released.'); run.release = { status: 'blocked', summary: 'Storage failed.', findings: [], blockers: ['Storage failure.'] }; await save(run).catch(() => {}); });
    return frozen(run);
  };
  return {
    async createRun(caseRecord, { mode = 'fixture', modelConsent = false } = {}) {
      await ready;
      if (!caseRecord?.demo || caseRecord.input?.consent !== true || caseRecord.status === 'consent_revoked') throw fail('Only consented synthetic cases may run.', 'CONSENT_REQUIRED', 403);
      if (!['fixture', 'live'].includes(mode)) throw fail('Invalid execution mode.');
      if (mode === 'live' && modelConsent !== true) throw fail('Explicit per-run model-provider sharing consent is required.', 'MODEL_CONSENT_REQUIRED', 403);
      const sources = (caseRecord.policies || []).flatMap(policy => (policy.clauses || []).map(clause => ({ id: `${policy.id}:${clause.key}`, policyId: policy.id, version: clause.source?.version, page: clause.source?.page, text: clause.text })));
      if (!sources.length || sources.length > 40 || sources.some(source => !source.policyId.startsWith('DEMO-') || source.version !== 'demo-v1' || !Number.isInteger(source.page) || typeof source.text !== 'string' || source.text.length > 1200)) throw fail('Known source-linked synthetic policies are required.', 'SOURCE_REQUIRED');
      const run = { id: `run-${randomUUID()}`, caseId: String(caseRecord.id).slice(0, 120), mode, status: 'queued', processingConsent: true, modelConsent: modelConsent === true, createdAt: at(), updatedAt: at(), input: { trigger: caseRecord.input.trigger, procedure: String(caseRecord.input.procedure).slice(0, 240), hospital: String(caseRecord.input.hospital).slice(0, 160), estimate: caseRecord.input.estimate }, sources, tasks: Object.fromEntries(ROLES.map(role => [role, { role, status: 'pending', attempts: 0 }])), events: [], usage: { inputTokens: 0, outputTokens: 0 }, budget: { limitUsd: budgetUsd, reservedUsd: 0, estimatedCostUsd: 0, projectLimitUsd: projectBudgetUsd, projectReservedUsd: project.reservedUsd, billingVerified: false, note: 'Conservative reservation and provider-estimated usage, not verified billing. Interrupted provider calls may incur unreported cost. Reservations are not refunded.' }, release: { status: 'pending', summary: '', findings: [], blockers: [] }, callAttempts: [] };
      event(run, 'run_created', 'Synthetic immutable case snapshot captured; no personal name sent to models.'); await save(run); records.set(run.id, run); return frozen(run);
    },
    async getRun(id) { return frozen(await get(id)); },
    async start(id) { const run = await get(id); if (['failed', 'interrupted'].includes(run.status)) return frozen(run); return launch(run); },
    async resume(id) {
      const run = await get(id); allowed(run);
      if (!['failed', 'interrupted'].includes(run.status)) throw fail('Only failed or interrupted runs can safely resume.', 'INVALID_STATE', 409);
      for (const task of Object.values(run.tasks)) if (['failed', 'interrupted', 'cancelled'].includes(task.status)) { if (task.attempts >= 2) throw fail('Task attempt limit reached.', 'ATTEMPT_LIMIT', 409); task.status = 'pending'; }
      return launch(run);
    },
    async cancel(id) {
      const run = await get(id); if (['revoked', 'completed', 'flagged', 'blocked', 'cancelled'].includes(run.status)) return frozen(run);
      run.status = 'cancelled'; active.get(id)?.abort(new Error('User cancelled run.'));
      for (const task of Object.values(run.tasks)) if (['pending', 'running'].includes(task.status)) task.status = 'cancelled';
      run.release = { status: 'blocked', summary: 'Cancelled. No conclusion released.', findings: [], blockers: ['User cancelled.'] }; event(run, 'run_cancelled', 'Local orchestration aborted. Provider calls may already have incurred cost.'); await save(run); return frozen(run);
    },
    async revoke(id) {
      const run = await get(id); run.status = 'revoked'; run.processingConsent = false; run.modelConsent = false; active.get(id)?.abort(new Error('Consent revoked.'));
      run.input = null; run.sources = []; run.callAttempts = []; run.events = [];
      for (const task of Object.values(run.tasks)) { delete task.output; delete task.error; task.status = 'cancelled'; }
      run.release = { status: 'blocked', summary: 'Consent revoked. Local context cleared.', findings: [], blockers: ['Consent revoked.'] };
      event(run, 'consent_revoked', 'Further reads and model tasks blocked. Local context cleared; provider-side deletion is not implemented.'); await save(run); return frozen(run);
    },
    async recordCallAttempt(id, { shareContext = false } = {}) {
      const run = await get(id); allowed(run);
      const phone = process.env.HUMAN_HANDOFF_PHONE || '+919749452397';
      if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw fail('Server handoff phone is not configured correctly.', 'HANDOFF_UNAVAILABLE', 503);
      const attempt = { id: randomUUID(), at: at(), status: 'attempt_recorded', shareContext: shareContext === true, telUrl: `tel:${phone}`, note: 'No dial or connection is known. Opening the phone dialler does not establish connection, staffing or advice.' };
      run.callAttempts.push(attempt); event(run, 'human_dial_requested', shareContext === true ? 'User explicitly permitted synthetic context sharing; no context delivered automatically.' : 'Dial requested without context sharing.'); await save(run); return frozen(attempt);
    }
  };
}

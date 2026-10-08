import {
  MAX_FILE_BYTES, arrayBufferToBase64, buildProcedureBody, buildReviewBody,
  documentConsentScopes, reconstructionConsentScopes, validateMemberForm,
} from './request-builders.js';
import { noopAnalytics } from '../analytics/events.js';

export const TERMINAL_JOB_STATUSES = Object.freeze(['succeeded', 'failed', 'interrupted']);
export const STAGES = Object.freeze(['setup', 'family', 'documents', 'processing_consent', 'processing', 'workspace']);

/**
 * Flow state for the real policy journey. Views read snapshot() and call the methods below; they never
 * call the API directly. Timers and key generation are injectable so the flow can be tested without a browser.
 * `analytics` is a port ({ track, identify, reset }); it filters to the allowlisted taxonomy and sends nothing
 * without consent, so the flow never depends on it.
 */
export function createJourneyController({
  client, onChange = () => {}, pollMs = 4000,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = handle => clearTimeout(handle),
  newKey = () => crypto.randomUUID(), readFile = file => file.arrayBuffer(),
  analytics = noopAnalytics,
} = {}) {
  if (!client) throw new TypeError('A v1 API client is required.');
  const state = {
    stage: 'setup', tab: 'breakdown',
    identity: null, members: [], city: null,
    documentConsentId: null, reconstructionConsentId: null, documents: [], lastUpload: null,
    startKey: null, startDigest: null,
    record: null, job: null, pollWarning: '', pollCount: 0,
    sections: null, consistencyIssues: [], recordStatus: null, readiness: null,
    emergencyCard: null, policyStatus: null, procedureCheck: null, estimate: null,
    busy: null, error: null, notice: '', authExpired: false, canRetry: false,
  };
  let pollTimer = null;
  let lastRun = null;
  const publish = () => onChange(structuredClone(state));

  function stopPolling() { if (pollTimer !== null) clearTimer(pollTimer); pollTimer = null; }

  function failWith(error, { credentials = false } = {}) {
    const kind = error?.kind ?? 'server';
    if (kind === 'auth' && credentials) {
      state.error = { kind: 'validation', code: 'CREDENTIALS_REJECTED', message: 'Those credentials were not accepted. Check them and try again.' };
      return;
    }
    if (kind === 'auth') { state.authExpired = true; state.error = null; state.canRetry = true; return; }
    state.error = { kind, code: error?.code ?? 'ERROR', message: error?.message ?? 'Something went wrong.' };
    state.canRetry = ['network', 'server', 'rate_limited'].includes(kind);
  }

  /** Runs an action with a busy label, clears the previous error and records it for retry. */
  async function run(label, action, { remember = true, credentials = false } = {}) {
    if (state.busy) return null;
    state.busy = label; state.error = null; state.notice = ''; state.canRetry = false;
    if (remember) lastRun = { label, action };
    publish();
    try { const result = await action(); lastRun = null; return result ?? true; }
    catch (error) { failWith(error, { credentials }); return null; }
    finally { state.busy = null; publish(); }
  }

  async function refreshMembers() {
    const matrix = await client.householdMatrix(state.identity.householdId);
    state.members = (matrix.members ?? []).map(member => ({
      id: member.id, displayName: member.displayName, relationship: member.relationshipLabel ?? member.memberKind ?? '',
      isOwner: member.id === state.identity.memberId,
    }));
  }

  async function loadWorkspace() {
    const result = await client.sections(state.record.id);
    state.sections = result.sections ?? [];
    state.consistencyIssues = result.consistencyIssues ?? [];
    state.recordStatus = result.recordStatus;
    state.stage = 'workspace';
  }

  async function pollOnce() {
    pollTimer = null;
    if (state.stage !== 'processing' || !state.job) return;
    try {
      state.job = await client.breakdownJob(state.job.id);
      state.pollWarning = ''; state.pollCount += 1;
      if (state.job.status === 'succeeded') {
        await loadWorkspace();
        analytics.track('breakdown_completed');
        state.notice = 'Your policy breakdown is ready to review.';
      } else if (!TERMINAL_JOB_STATUSES.includes(state.job.status)) {
        pollTimer = setTimer(pollOnce, pollMs);
      } else {
        const failedSteps = (state.job.steps ?? []).filter(step => step.status === 'failed');
        if (failedSteps.some(step => step.errorCode === 'BREAKDOWN_BUDGET_EXHAUSTED')) analytics.track('budget_exhausted_shown');
        else analytics.track('breakdown_failed', { failed_step_count: failedSteps.length });
      }
    } catch (error) {
      if (error?.kind === 'auth') failWith(error);
      else if (['network', 'server', 'rate_limited'].includes(error?.kind)) {
        state.pollWarning = 'We lost touch with Knowvia for a moment. Your breakdown keeps running and we are checking again.';
        pollTimer = setTimer(pollOnce, pollMs);
      } else failWith(error);
    }
    publish();
  }

  function beginPolling(job) {
    state.job = job; state.stage = 'processing'; state.pollWarning = '';
    stopPolling();
    pollTimer = setTimer(pollOnce, 0);
  }

  async function openExistingRecord(record) {
    state.record = record;
    const detail = await client.policyRecord(record.id);
    state.record = detail.record ?? record;
    const job = detail.job ?? null;
    if (job && !TERMINAL_JOB_STATUSES.includes(job.status)) { beginPolling(job); return; }
    if (job && job.status !== 'succeeded' && state.record.status !== 'needs_review' && state.record.status !== 'ready') {
      state.job = job; state.stage = 'processing'; return;
    }
    state.job = job;
    await loadWorkspace();
  }

  async function adoptIdentity(identity) {
    if (state.identity?.adultId && state.identity.adultId !== identity.adultId) analytics.reset();
    analytics.identify(identity.adultId);
    state.identity = identity;
    await refreshMembers();
  }

  const retry = () => (lastRun ? run(lastRun.label, lastRun.action, { remember: false }) : null);

  return Object.freeze({
    snapshot: () => structuredClone(state),
    stop: stopPolling,

    bootstrap({ bootstrapToken, displayName, ownerName }) {
      return run('Creating your household', async () => {
        const created = await client.bootstrapHousehold({ bootstrapToken, displayName, ownerName });
        client.setSessionToken(created.session.token);
        await adoptIdentity({
          householdId: created.household.id, adultId: created.owner.id, memberId: created.ownerMember.id,
          ownerName: created.owner.display_name ?? ownerName, sessionExpiresAt: created.session.expiresAt ?? null,
        });
        analytics.track('household_created');
        state.stage = 'family';
      }, { remember: false, credentials: true });
    },

    connect({ sessionToken, householdId, adultId }) {
      return run('Reconnecting', async () => {
        client.setSessionToken(sessionToken);
        const matrix = await client.householdMatrix(householdId);
        const owner = (matrix.members ?? []).find(member => member.adultUserId === adultId || member.adult_user_id === adultId);
        await adoptIdentity({ householdId, adultId, memberId: owner?.id ?? null, ownerName: owner?.displayName ?? 'You', sessionExpiresAt: null });
        analytics.track('household_reconnected');
        const { records = [] } = await client.listPolicyRecords(householdId);
        if (records.length) {
          const latest = [...records].sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))[0];
          await openExistingRecord(latest);
        } else state.stage = 'family';
      }, { remember: false, credentials: true });
    },

    /** After a 401: store a fresh token and carry on from where the person was. */
    resumeSession(token) {
      client.setSessionToken(token);
      state.authExpired = false; state.error = null;
      publish();
      if (state.stage === 'processing' && state.job && !TERMINAL_JOB_STATUSES.includes(state.job.status)) beginPolling(state.job);
      return lastRun && state.canRetry ? retry() : undefined;
    },

    addMember(form) {
      const checked = validateMemberForm(form);
      if (checked.error) { state.error = { kind: 'validation', code: 'INVALID_MEMBER', message: checked.error }; publish(); return null; }
      return run('Adding family member', async () => {
        await client.addMember(state.identity.householdId, checked.body);
        await refreshMembers();
        analytics.track('member_added', { member_count: state.members.length });
        state.notice = `${checked.body.displayName} was added.`;
      });
    },

    saveCity(city) {
      const value = String(city ?? '').trim();
      return run('Saving city', async () => {
        await client.setCity(state.identity.householdId, value || null);
        state.city = value || null;
        state.notice = value ? `City saved: ${value}.` : 'City cleared.';
      });
    },

    goToStage(stage) {
      if (!STAGES.includes(stage)) return;
      state.stage = stage; state.error = null; state.notice = ''; publish();
    },

    setTab(tab) { state.tab = tab; state.error = null; analytics.track('workspace_tab_viewed', { tab }); publish(); },

    /** Grants document_processing once, then uploads the chosen PDF. */
    uploadDocument({ file, documentKind }) {
      if (!file) { state.error = { kind: 'validation', code: 'FILE_REQUIRED', message: 'Choose a PDF file first.' }; publish(); return null; }
      if (file.size > MAX_FILE_BYTES) { state.error = { kind: 'validation', code: 'FILE_TOO_LARGE', message: 'That file is larger than 15 MB. Upload a smaller copy.' }; publish(); return null; }
      return run('Uploading and checking your document', async () => {
        state.lastUpload = null;
        if (!state.documentConsentId) {
          const grant = await client.grantConsent({
            householdId: state.identity.householdId, subjectAdultId: state.identity.adultId,
            purpose: 'document_processing', scopes: documentConsentScopes(),
          });
          state.documentConsentId = grant.id;
        }
        const contentBase64 = arrayBufferToBase64(await readFile(file));
        const result = await client.uploadDocument(state.identity.householdId, {
          consentGrantId: state.documentConsentId, documentKind, filename: file.name,
          mimeType: file.type || 'application/pdf', contentBase64,
        });
        state.lastUpload = { filename: file.name, accepted: result.accepted === true, reason: result.reason ?? null };
        if (result.accepted) {
          state.documents.push({ id: result.document.id, filename: file.name, documentKind });
          analytics.track('document_upload_completed', { document_kind: documentKind });
          state.notice = `${file.name} was accepted.`;
        } else analytics.track('document_upload_failed', { document_kind: documentKind, failure: 'rejected' });
      });
    },

    /** Grants coverage_reconstruction and starts the breakdown. The Idempotency-Key is reused on retry. */
    startBreakdown() {
      if (!state.documents.length) { state.error = { kind: 'validation', code: 'NO_DOCUMENT', message: 'Upload at least one accepted document first.' }; publish(); return null; }
      return run('Starting your breakdown', async () => {
        if (!state.reconstructionConsentId) {
          const grant = await client.grantConsent({
            householdId: state.identity.householdId, subjectAdultId: state.identity.adultId,
            purpose: 'coverage_reconstruction', scopes: reconstructionConsentScopes(),
          });
          state.reconstructionConsentId = grant.id;
        }
        const documentIds = state.documents.map(document => document.id);
        const digest = `${state.reconstructionConsentId}|${documentIds.join(',')}`;
        if (state.startDigest !== digest) { state.startDigest = digest; state.startKey = `knowvia-ui-${newKey()}`; }
        const result = await client.createPolicyRecord(state.identity.householdId,
          { documentIds, consentGrantId: state.reconstructionConsentId, modelPermission: true }, state.startKey);
        state.record = result.record;
        analytics.track('breakdown_queued');
        beginPolling(result.job);
      });
    },

    resumeJob() {
      return run('Resuming the breakdown', async () => {
        const job = await client.resumeBreakdownJob(state.job.id);
        analytics.track('breakdown_resumed');
        beginPolling({ ...state.job, ...job, status: job.status ?? 'queued' });
      });
    },

    /** Starts over with a fresh upload/consent decision, for example after the budget was used up. */
    backToDocuments() { stopPolling(); state.stage = 'documents'; state.error = null; state.job = null; publish(); },

    reviewParameter({ key, valueType, action, form }) {
      const built = buildReviewBody({ action, valueType, form });
      if (built.error) { state.error = { kind: 'validation', code: 'INVALID_REVIEW', message: built.error }; publish(); return null; }
      return run('Saving your review', async () => {
        await client.reviewParameter(state.record.id, key, built.body);
        await loadWorkspace();
        analytics.track('review_parameter_saved', { review_action: action });
        state.readiness = null; state.emergencyCard = null; state.policyStatus = null;
        state.notice = action === 'confirm' ? 'Confirmed.' : action === 'correct' ? 'Your correction was saved.' : 'Marked as not in the policy.';
      });
    },

    checkReadiness() {
      return run('Checking readiness', async () => {
        state.readiness = await client.checkReadiness(state.record.id);
        state.recordStatus = state.readiness.recordStatus ?? state.recordStatus;
        analytics.track('readiness_checked', { ready: state.readiness.ready === true });
        if (state.readiness.ready) { state.emergencyCard = null; state.policyStatus = null; }
      });
    },

    loadEmergencyCard() { return run('Loading the emergency card', async () => { state.emergencyCard = await client.emergencyCard(state.record.id); analytics.track('emergency_card_viewed'); }); },
    loadPolicyStatus() { return run('Loading the policy status', async () => { state.policyStatus = await client.policyStatus(state.record.id); }); },

    runProcedureCheck(form) {
      const built = buildProcedureBody(form);
      if (built.error) { state.error = { kind: 'validation', code: 'INVALID_PROCEDURE', message: built.error }; publish(); return null; }
      return run('Checking the planned procedure', async () => {
        state.procedureCheck = await client.procedureCheck(state.record.id, built.body);
        analytics.track('procedure_check_requested', { verdict: state.procedureCheck.verdict });
      });
    },

    runEstimate(form) {
      const built = buildProcedureBody(form, { includeBill: true });
      if (built.error) { state.error = { kind: 'validation', code: 'INVALID_ESTIMATE', message: built.error }; publish(); return null; }
      return run('Estimating the cost', async () => {
        state.estimate = await client.estimate(state.record.id, built.body);
        analytics.track('estimate_requested');
      });
    },

    retry,
    dismissError() { state.error = null; state.canRetry = false; publish(); },

    async signOut() {
      stopPolling();
      try { await client.revokeSession(); } catch { /* the token is dropped regardless */ }
      analytics.track('signed_out');
      analytics.reset();
      client.setSessionToken(null);
      Object.assign(state, {
        stage: 'setup', tab: 'breakdown', identity: null, members: [], city: null, documentConsentId: null,
        reconstructionConsentId: null, documents: [], lastUpload: null, startKey: null, startDigest: null, record: null,
        job: null, sections: null, readiness: null, emergencyCard: null, policyStatus: null, procedureCheck: null,
        estimate: null, error: null, authExpired: false, notice: 'You have been signed out.',
      });
      publish();
    },
  });
}

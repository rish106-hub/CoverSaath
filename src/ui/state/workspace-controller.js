export function createWorkspaceController({ client, onChange = () => {} } = {}) {
  if (!client) throw new TypeError('A v1 API client is required.');
  const state = {
    identity: null,
    matrix: null,
    caseRecord: null,
    consent: null,
    job: null,
    busy: false,
    error: '',
    notice: '',
  };
  const publish = () => onChange(structuredClone(state));
  const work = async action => {
    state.busy = true; state.error = ''; state.notice = ''; publish();
    try { return await action(); }
    catch (error) { state.error = error instanceof Error ? error.message : 'Request failed.'; return null; }
    finally { state.busy = false; publish(); }
  };

  return Object.freeze({
    snapshot: () => structuredClone(state),
    async bootstrap(input) {
      return work(async () => {
        const identity = await client.bootstrapHousehold(input);
        client.setSessionToken(identity.session.token);
        state.identity = {
          householdId: identity.household.id,
          adultId: identity.owner.id,
          memberId: identity.ownerMember.id,
          sessionExpiresAt: identity.session.expiresAt,
        };
        state.matrix = await client.householdMatrix(identity.household.id);
        state.notice = 'Persistent household workspace created. The session token remains in this browser tab only.';
      });
    },
    async connect({ sessionToken, householdId, adultId, memberId }) {
      return work(async () => {
        client.setSessionToken(sessionToken);
        state.matrix = await client.householdMatrix(householdId);
        state.identity = { householdId, adultId, memberId, sessionExpiresAt: null };
        state.notice = 'Existing persistent workspace connected for this browser tab.';
      });
    },
    async createAndAnalyze({ route, condition = 'new_purchase', estimateMinor = null }) {
      return work(async () => {
        if (!state.identity) throw new Error('Connect an authenticated household first.');
        const triggerType = route === 'planned_care' ? 'planned_care' : condition === 'renewal' ? 'renewal' : 'user_requested_review';
        let record = await client.createCase({
          householdId: state.identity.householdId,
          subjectMemberId: state.identity.memberId,
          triggerType,
          statedEstimateMinor: estimateMinor,
          currency: estimateMinor === null ? null : 'INR',
        });
        record = await client.transitionCase(record.id, { toStatus: 'collecting', expectedRevision: record.revision });
        record = await client.transitionCase(record.id, { toStatus: 'processing', expectedRevision: record.revision });
        const consent = await client.grantConsent({
          householdId: state.identity.householdId,
          subjectAdultId: state.identity.adultId,
          purpose: 'coverage_reconstruction',
          scopes: [
            { resourceType: 'case', resourceId: record.id, action: 'derive', dataCategory: 'insurance_document' },
            { resourceType: 'case', resourceId: record.id, action: 'read', dataCategory: 'case_summary', recipient: state.identity.adultId },
            { resourceType: 'case', resourceId: record.id, action: 'read', dataCategory: 'analysis_summary', recipient: state.identity.adultId },
          ],
        });
        const key = `ui-${record.id}-${crypto.randomUUID()}`;
        state.caseRecord = record;
        state.consent = consent;
        state.job = await client.startAnalysis(record.id, consent.id, key);
        state.matrix = await client.householdMatrix(state.identity.householdId);
        state.notice = 'Bounded fixture analysis completed and persisted. No model or provider was called.';
      });
    },
    async revoke() {
      return work(async () => {
        if (!state.consent) return;
        await client.revokeConsent(state.consent.id, 'Revoked from household workspace');
        state.consent = null;
        state.job = null;
        state.notice = 'Consent revoked. Derived task outputs are no longer available.';
      });
    },
  });
}

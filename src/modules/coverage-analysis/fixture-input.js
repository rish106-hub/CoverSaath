const supportedDecisionTrigger = trigger => ['emergency', 'planned_care', 'renewal'].includes(trigger) ? trigger : 'renewal';

export function createCoverageAnalysisFixtureInput(caseRecord, { variant = 'standard' } = {}) {
  if (!['standard', 'blocked_source'].includes(variant)) throw new Error('Unsupported fixture variant.');
  const profileSource = `fixture:${caseRecord.id}:profile`;
  const groupSource = `fixture:${caseRecord.id}:group`;
  const personalSource = `fixture:${caseRecord.id}:personal`;
  return {
    consent: true,
    synthetic: true,
    trigger: supportedDecisionTrigger(caseRecord.trigger_type),
    statedEstimate: Number(caseRecord.stated_estimate_minor ?? 0) / 100,
    authorizedSourceIds: variant === 'blocked_source'
      ? [profileSource, personalSource]
      : [profileSource, groupSource, personalSource],
    profilePacket: {
      subjectId: caseRecord.opened_by_adult_id,
      source: {
        type: 'manual',
        id: profileSource,
        reporterId: caseRecord.opened_by_adult_id,
        version: 'fixture-v1',
        location: 'fixture-intake',
      },
      requestedFields: ['displayName'],
      consent: {
        id: `fixture-profile-consent:${caseRecord.id}`,
        subjectId: caseRecord.opened_by_adult_id,
        status: 'granted',
        purpose: 'profile_intake',
        sources: ['manual'],
        fields: ['displayName'],
      },
      data: { displayName: 'Synthetic household adult' },
    },
    groupPolicies: [{
      policyId: `FIXTURE-GROUP:${caseRecord.id}`,
      evidence: [{
        fact: 'room_rent_limit',
        value: 5000,
        sourceId: groupSource,
        page: 3,
        version: 'fixture-v1',
        evidenceStatus: 'document-backed',
      }],
    }],
    personalPacket: {
      synthetic: true,
      consent: true,
      evidence: [{
        id: `fixture-personal-copay:${caseRecord.id}`,
        policyId: `FIXTURE-PERSONAL:${caseRecord.id}`,
        dimension: 'constraints',
        field: 'copay',
        value: '10% of eligible expenses',
        status: 'document_backed',
        source: { id: personalSource, page: 5, version: 'fixture-v1' },
      }],
    },
    continuity: {},
  };
}


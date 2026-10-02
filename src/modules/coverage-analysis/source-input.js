const supportedDecisionTrigger = trigger => ['emergency', 'planned_care', 'renewal'].includes(trigger) ? trigger : 'renewal';

export function createCoverageAnalysisSourceInput(caseRecord, pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    const error = new Error('Live analysis requires at least one authorised, protected OCR source page.');
    error.code = 'SOURCE_PACK_REQUIRED';
    error.statusCode = 409;
    throw error;
  }
  const sources = pages.map(page => ({
    id: page.id,
    version: page.source_version,
    page: page.page_number,
    document: page.document_upload_id,
    documentKind: page.document_kind,
    text: page.extracted_text,
  }));
  const evidence = sources.map(source => ({
    id: `ocr:${source.id}`,
    fact: 'unclassified_policy_text',
    field: 'unclassified_policy_text',
    value: source.text,
    sourceId: source.id,
    source: { id: source.id, version: source.version, page: source.page, document: source.document },
    page: source.page,
    version: source.version,
    evidenceStatus: 'document-backed',
    status: 'document_backed',
    dimension: 'suitability',
    policyId: `UNCLASSIFIED:${source.document}`,
  }));
  return {
    consent: true,
    synthetic: false,
    trigger: supportedDecisionTrigger(caseRecord.trigger_type),
    statedEstimate: Number(caseRecord.stated_estimate_minor ?? 0) / 100,
    authorizedSourceIds: sources.map(source => source.id),
    profilePacket: {
      subjectId: caseRecord.opened_by_adult_id,
      source: { type: 'ocr', ...sources[0], location: `page:${sources[0].page}` },
      requestedFields: ['subject_identity'],
      consent: {
        id: caseRecord.consent_grant_id ?? 'coverage-reconstruction-consent',
        subjectId: caseRecord.opened_by_adult_id,
        status: 'granted',
        purpose: 'coverage_reconstruction',
        sources: ['ocr'],
        fields: ['subject_identity'],
      },
      data: { subject_identity: sources.map(source => source.text).join('\n').slice(0, 12_000) },
    },
    groupPolicies: [{
      policyId: `UNCLASSIFIED:${caseRecord.id}`,
      evidence,
    }],
    personalPacket: {
      synthetic: false,
      consent: true,
      evidence,
    },
    continuity: {},
  };
}

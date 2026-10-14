import { createHash } from 'node:crypto';
import { sanitizeEvidenceTextForStorage } from '../ai-analysis/privacy-evidence-gate.js';
import {
  POLICY_PARAMETER_REGISTRY,
  POLICY_PARAMETER_REGISTRY_VERSION,
} from './policy-parameter-registry.js';

const supportedDecisionTrigger = trigger => ['emergency', 'planned_care', 'renewal'].includes(trigger) ? trigger : 'renewal';

const normalized = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const opaque = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);

function candidateParameterKeys(text) {
  const searchable = ` ${normalized(text)} `;
  const candidates = POLICY_PARAMETER_REGISTRY.parameters
    .filter(parameter => parameter.modelExtraction.allowed && parameter.dataClass !== 'RESTRICTED')
    .filter(parameter => {
      const label = normalized(parameter.label);
      const key = normalized(parameter.key.slice(2));
      return (label.length >= 4 && searchable.includes(` ${label} `))
        || (key.length >= 4 && searchable.includes(` ${key} `));
    })
    .map(parameter => parameter.key);
  return candidates.length > 0 ? candidates.slice(0, 30) : ['a.document_set'];
}

export function createCoverageAnalysisSourceInput(caseRecord, pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    const error = new Error('Live analysis requires at least one authorised, protected OCR source page.');
    error.code = 'SOURCE_PACK_REQUIRED';
    error.statusCode = 409;
    throw error;
  }
  const sources = pages.map(page => {
    const safe = sanitizeEvidenceTextForStorage(page.extracted_text, { maxBytes: 12_000 });
    return {
      id: page.id,
      version: page.source_version,
      page: page.page_number,
      document: page.document_upload_id,
      documentKind: page.document_kind,
      text: safe.text,
      textDigest: safe.digest,
      redactionReasonCodes: safe.reasonCodes,
      candidateParameterKeys: candidateParameterKeys(safe.text),
    };
  });
  const evidence = sources.flatMap(source => source.candidateParameterKeys.map(parameterKey => ({
    id: `ocr:${source.id}:${parameterKey}`,
    fact: parameterKey,
    field: parameterKey,
    value: source.text,
    sourceId: source.id,
    source: { id: source.id, version: source.version, page: source.page },
    page: source.page,
    version: source.version,
    evidenceStatus: 'document-backed',
    status: 'document_backed',
    dimension: 'suitability',
    policyId: `UNCLASSIFIED:${opaque(source.document)}`,
  })));
  const requestedFields = [...new Set(evidence.map(item => item.field))].slice(0, 40);
  return {
    parameterRegistryVersion: POLICY_PARAMETER_REGISTRY_VERSION,
    parameterStates: POLICY_PARAMETER_REGISTRY.parameters.map(parameter => ({
      parameterKey: parameter.key,
      acquisitionState: requestedFields.includes(parameter.key) ? 'received' : 'not_requested',
      resolutionState: 'unknown',
    })),
    consent: true,
    synthetic: false,
    trigger: supportedDecisionTrigger(caseRecord.trigger_type),
    statedEstimate: Number(caseRecord.stated_estimate_minor ?? 0) / 100,
    authorizedSourceIds: sources.map(source => source.id),
    profilePacket: {
      subjectId: caseRecord.opened_by_adult_id,
      source: { type: 'ocr', ...sources[0], location: `page:${sources[0].page}` },
      requestedFields,
      consent: {
        id: caseRecord.consent_grant_id ?? 'coverage-reconstruction-consent',
        subjectId: caseRecord.opened_by_adult_id,
        status: 'granted',
        purpose: 'coverage_reconstruction',
        sources: ['ocr'],
        fields: requestedFields,
      },
      data: Object.fromEntries(requestedFields.map(field => [field, sources
        .filter(source => source.candidateParameterKeys.includes(field))
        .map(source => source.text)
        .join('\n')
        .slice(0, 12_000)])),
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

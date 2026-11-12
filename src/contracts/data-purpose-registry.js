// DPDP field-to-purpose registry (docs/architecture/dpdp-purpose-registry.md). One frozen, testable table that ties a
// stored column, a model-payload slot or an event key to a purpose, a recipient, a retention rule and an erasure path.
//
// EVERYTHING LEGAL HERE IS A DRAFT FOR LEGAL REVIEW: the classification of personal, health and government-identifier
// data, the purposes, retention strings, children's data, cross-border processing and notice wording. Nothing here is
// counsel-approved and no code may present it as such. SYNTHETIC DATA ONLY: this file holds no values, only field names.
//
// A contract: no imports, no I/O. Runtime enforcement by purpose is out of scope for v1 (tests check the table).

export const DATA_PURPOSE_REGISTRY_VERSION = 'data-purpose/v1-draft';
export const LEGAL_REVIEW = 'required';

// Exactly the consent_grants.purpose CHECK list (migration 001); tests/data-purpose-registry.test.mjs compares them.
export const CONSENT_PURPOSES = Object.freeze([
  'profile_intake', 'document_processing', 'coverage_reconstruction', 'voice_intake',
  'institutional_clarification', 'human_review', 'purchase_review', 'payment', 'analytics',
]);

const GEMINI = 'google-gemini';
const ANTHROPIC = 'anthropic';
// Household chat and fact extraction (ADR 0030, S6). The grant that opens this scope is built with chat v1; FOR LEGAL REVIEW.
const CHAT_SCOPE = Object.freeze({ resourceType: 'household', action: 'derive', dataCategory: 'insurance_question', recipient: ANTHROPIC });
// The embedding provider (MODEL_ROUTES routes `embed` to voyage, ADR 0031): its own recipient, so a chat grant never covers it. FOR LEGAL REVIEW.
const EMBED_SCOPE = Object.freeze({ resourceType: 'household', action: 'derive', dataCategory: 'insurance_question', recipient: 'voyage' });
// The purpose a chat or embed grant must carry (resolved server side, re-checked at commit; src/backend/services/provider-consent.js).
export const CHAT_CONSENT_PURPOSE = 'coverage_reconstruction';
export { CHAT_SCOPE, EMBED_SCOPE };
const GEMINI_SCOPE = Object.freeze({ resourceType: 'document', action: 'derive', dataCategory: 'insurance_document', recipient: GEMINI });
const QUESTION_SCOPE = Object.freeze({ resourceType: 'document', action: 'derive', dataCategory: 'insurance_question', recipient: GEMINI });
const SARVAM_SCOPE = Object.freeze({ resourceType: 'document', action: 'derive', dataCategory: 'insurance_document', recipient: 'sarvam' });

// `member`: for a factory (fn names the factory), the method of the returned object that does the erasing; tests check it by name.
const erasure = (module, fn, test, member = null) => Object.freeze({ module, fn, test, member });
const ERASE = Object.freeze({
  userData: erasure('src/backend/repositories/user-data-repository.js', 'UserDataRepository.eraseForHousehold', 'tests/user-data-api.test.mjs'),
  profileAnswers: erasure('src/backend/repositories/profile-answer-repository.js', 'ProfileAnswerRepository.eraseForHousehold', 'tests/profile-answers-api.test.mjs'),
  policyFacts: erasure('src/backend/repositories/policy-facts-repository.js', 'PolicyFactsRepository.eraseForHousehold', 'tests/policy-facts.test.mjs'),
  policyProfiles: erasure('src/backend/repositories/policy-profile-repository.js', 'PolicyProfileRepository.eraseForHousehold', 'tests/policy-profiles.test.mjs'),
  appEvents: erasure('src/backend/repositories/app-event-repository.js', 'AppEventRepository.eraseForHousehold', 'tests/app-events.test.mjs'),
  clauses: erasure('src/backend/repositories/clause-repository.js', 'ClauseRepository.eraseDerived', 'tests/revocation-concurrency.test.mjs'),
  structuring: erasure('src/backend/repositories/policy-structuring-repository.js', 'PolicyStructuringRepository.eraseDerived', 'tests/policy-structuring-persistence.test.mjs'),
  documentBytes: erasure('src/features/input/encrypted-database-storage.js', 'createEncryptedDatabaseByteStorage', 'tests/document-blobs.test.mjs', 'remove'),
  derivedRun: erasure('src/backend/repositories/consent-repository.js', 'ConsentRepository.eraseDerivedRunData', 'tests/revocation-concurrency.test.mjs'),
  adultCascade: erasure('src/backend/repositories/erasure-repository.js', 'ErasureRepository.eraseHousehold', 'tests/data-erasure-api.test.mjs'),
  personRecords: erasure('src/backend/repositories/person-record-erasure.js', 'erasePersonRecordsForCategories', 'tests/person-records-api.test.mjs'),
  memory: erasure('src/backend/repositories/memory-erasure.js', 'eraseMemoryForHousehold', 'tests/holdings-memory.test.mjs'),
  memberDelete: erasure('src/backend/repositories/household-app-repository.js', 'HouseholdAppRepository.deleteMember', 'tests/household-app-api.test.mjs'),
});

/**
 * @typedef {Readonly<{
 *   field: string, personal: boolean, dataClass: 'PUBLIC'|'INTERNAL'|'CONFIDENTIAL'|'RESTRICTED',
 *   category: string, purposes: readonly string[], consentScope: object|null, recipients: readonly string[],
 *   modelEligible: boolean, sealed: boolean, retention: string,
 *   erasure: Readonly<{ module: string, fn: string, test: string, member: string|null }>|null,
 *   childData: 'possible'|'no', crossBorder: 'possible'|'no', legalReview: 'required',
 * }>} PurposeEntry
 */

const entry = fields => Object.freeze({
  personal: true, dataClass: 'CONFIDENTIAL', consentScope: null, recipients: Object.freeze(['none']), modelEligible: false, sealed: false,
  erasure: null, childData: 'no', crossBorder: 'no', ...fields,
  purposes: Object.freeze([...(fields.purposes ?? [])]),
  recipients: Object.freeze([...(fields.recipients ?? ['none'])]),
  legalReview: LEGAL_REVIEW,
});

// Slots of a model payload that carry gated free text. Document text can include member tables, so every one of them can
// carry content about a person under 18; and Gemini's processing location is unconfirmed (cross-border: FOR LEGAL REVIEW).
const modelText = (field, { purposes, scope, category = 'insurance_document', retention = 'not_stored_by_this_service' }) => entry({
  field, category, purposes, consentScope: scope, recipients: [GEMINI], modelEligible: true, retention,
  dataClass: 'CONFIDENTIAL', childData: 'possible', crossBorder: 'possible',
});

const COVERAGE_TASKS = Object.freeze(['profile_extraction', 'group_cover_extraction', 'personal_cover_extraction', 'evidence_synthesis', 'question_drafting']);
const coverageSlots = COVERAGE_TASKS.flatMap(task => ['context.purpose', 'sources[].version', 'sources[].text'].map(path => modelText(
  `model:${task}.${path}`, { purposes: ['coverage_reconstruction'], scope: GEMINI_SCOPE },
)));

const table = (field, fields) => entry({ field: `db:${field}`, ...fields });

export const DATA_PURPOSE_REGISTRY = Object.freeze([
  // Document intake: bytes go to Sarvam for OCR only (document_processing consent, recipient sarvam); never to a model.
  table('document_blobs.*', {
    category: 'insurance_document', purposes: ['document_processing'], consentScope: SARVAM_SCOPE, recipients: ['sarvam'], sealed: true,
    retention: 'until_document_deleted', childData: 'possible', crossBorder: 'possible', dataClass: 'RESTRICTED',
    erasure: ERASE.documentBytes,
  }),
  table('source_pages.blocks_json', {
    category: 'insurance_document', purposes: ['document_processing'], recipients: ['none'], retention: 'until_document_deleted', childData: 'possible',
    erasure: ERASE.derivedRun,
  }),
  table('policy_clauses.text', {
    category: 'insurance_document', purposes: ['document_processing', 'coverage_reconstruction'], recipients: ['none'], retention: 'until_revocation',
    childData: 'possible', sealed: true, erasure: ERASE.clauses, // clause-repository.js seals the text column on write and opens it on read
  }),
  // Policy profile (migration 043, ADR 0024): the names the owner confirmed. Public product identifiers (UIN, insurer code) are plaintext.
  table('policy_profiles.policy_name_enc', {
    category: 'insurance_document', purposes: ['document_processing'], recipients: ['none'], sealed: true, retention: 'until_revocation',
    childData: 'possible', erasure: ERASE.policyProfiles,
  }),
  table('policy_profiles.insurer_name_enc', {
    category: 'insurance_document', purposes: ['document_processing'], recipients: ['none'], sealed: true, retention: 'until_revocation',
    childData: 'possible', erasure: ERASE.policyProfiles,
  }),
  // Policy facts (migration 044, ADR 0025): exact values and quotes are sealed; amount bands, day counts, basis points, enums and
  // year-months are plaintext. recipients none: a model never receives these rows (modelEligible stays false, the default).
  table('policy_facts.value_enc', {
    category: 'insurance_document', purposes: ['document_processing'], recipients: ['none'], sealed: true, retention: 'until_revocation',
    childData: 'possible', erasure: ERASE.policyFacts,
  }),
  table('policy_facts.raw_text_enc', {
    category: 'insurance_document', purposes: ['document_processing'], recipients: ['none'], sealed: true, retention: 'until_revocation',
    childData: 'possible', erasure: ERASE.policyFacts,
  }),
  table('policy_facts.coarse', {
    category: 'insurance_document', purposes: ['document_processing'], recipients: ['none'], retention: 'until_revocation',
    childData: 'possible', erasure: ERASE.policyFacts,
  }),
  table('fact_evidence.quote_enc', {
    category: 'insurance_document', purposes: ['document_processing'], recipients: ['none'], sealed: true, retention: 'until_revocation',
    childData: 'possible', erasure: ERASE.policyFacts,
  }),
  // Holdings and memory (migrations 048-052, ADR 0032). Sealed: memory values and references, declaration labels, premium amounts and
  // agent name and code. recipients none: a model never receives these rows (modelEligible stays false, the default).
  // FOR LEGAL REVIEW (audit F2): the opened value is gated and sent to the chat model (anthropic) as a fact slot, and its redacted
  // passage to the embedding provider (voyage). Recipients name those processors; rows are still sent only under the chat/embed grants.
  table('household_memory_facts.value_enc', {
    category: 'insurance_document', purposes: ['coverage_reconstruction'], recipients: [ANTHROPIC, 'voyage'], sealed: true, retention: 'until_revocation',
    childData: 'possible', crossBorder: 'possible', erasure: ERASE.memory,
  }),
  table('household_memory_facts.reference_ref_enc', {
    category: 'insurance_document', purposes: ['coverage_reconstruction'], recipients: ['none'], sealed: true, retention: 'until_revocation',
    childData: 'possible', erasure: ERASE.memory,
  }),
  // Memory chunks and chat v1 (migrations 053-054, ADR 0031 and 0029). chunk_text_enc is the REDACTED passage; the embedding is plaintext
  // by necessity and is classified, not sealed. recipients (FOR LEGAL REVIEW): voyage receives the redacted passage once, at write time; anthropic receives it as a chat slot at answer time. The embedding vector goes to voyage only.
  table('memory_chunks.chunk_text_enc', {
    category: 'insurance_document', purposes: ['coverage_reconstruction'], recipients: [ANTHROPIC, 'voyage'], sealed: true, retention: 'until_revocation',
    childData: 'possible', crossBorder: 'possible', erasure: ERASE.memory,
  }),
  table('memory_chunks.embedding', {
    category: 'insurance_document', purposes: ['coverage_reconstruction'], recipients: ['voyage'], sealed: false, retention: 'until_revocation',
    childData: 'possible', crossBorder: 'possible', erasure: ERASE.memory,
  }),
  table('chat_turns.content_enc', {
    category: 'insurance_question', purposes: ['coverage_reconstruction'], recipients: ['none'], sealed: true, retention: 'until_revocation',
    childData: 'possible', erasure: ERASE.memory,
  }),
  table('chat_turns.transcript_enc', {
    category: 'insurance_question', purposes: ['coverage_reconstruction'], recipients: ['none'], sealed: true, retention: 'until_revocation',
    childData: 'possible', erasure: ERASE.memory,
  }),
  table('member_declarations.label_enc', {
    category: 'health_or_policy_content', purposes: ['profile_intake'], recipients: ['none'], sealed: true, retention: 'until_revocation',
    childData: 'possible', erasure: ERASE.memory,
  }),
  table('premium_payments.amount_enc', {
    category: 'financial', purposes: ['profile_intake'], recipients: ['none'], sealed: true, retention: 'until_revocation',
    childData: 'possible', erasure: ERASE.memory,
  }),
  table('premium_payments.agent_name_enc', {
    category: 'identity', purposes: ['profile_intake'], recipients: ['none'], sealed: true, retention: 'until_revocation',
    childData: 'possible', erasure: ERASE.memory,
  }),
  table('premium_payments.agent_code_enc', {
    category: 'identity', purposes: ['profile_intake'], recipients: ['none'], sealed: true, retention: 'until_revocation',
    childData: 'possible', erasure: ERASE.memory,
  }),
  table('premium_dues.amount_enc', {
    category: 'financial', purposes: ['profile_intake'], recipients: ['none'], sealed: true, retention: 'until_revocation',
    childData: 'possible', erasure: ERASE.memory,
  }),
  table('policy_structuring_runs.*', {
    category: 'insurance_document', purposes: ['document_processing'], recipients: ['none'], retention: 'until_revocation', childData: 'possible',
    erasure: ERASE.structuring,
  }),

  // Model payload slots (gated text only; ADR 0017 D2). One entry per gated slot of MODEL_INPUT_FIELDS.
  // Gateway tasks (ADR 0030): gated chat, classification, fact-extraction and embedding text. Recipient is the routed provider
  // (anthropic by default). Nothing is stored by this service; provider_calls keeps counts and a digest only.
  ...['chat_answer.payload.question', 'chat_answer.payload.history[].text', 'chat_answer.payload.facts[].label', 'chat_answer.payload.facts[].value',
    'intent_classify.payload.text', 'fact_extract.payload.text'].map(slot => entry({
    field: `model:${slot}`, category: 'insurance_question', purposes: ['coverage_reconstruction'], consentScope: CHAT_SCOPE, recipients: [ANTHROPIC], modelEligible: true,
    retention: 'not_stored_by_this_service', dataClass: 'CONFIDENTIAL', childData: 'possible', crossBorder: 'possible',
  })),
  entry({
    field: 'model:embed.payload.texts[].text', category: 'insurance_question', purposes: ['coverage_reconstruction'], consentScope: EMBED_SCOPE, recipients: ['voyage'], modelEligible: true,
    retention: 'not_stored_by_this_service', dataClass: 'CONFIDENTIAL', childData: 'possible', crossBorder: 'possible',
  }),
  modelText('model:policy_structuring_extract.payload.chunks[].text', { purposes: ['document_processing'], scope: GEMINI_SCOPE }),
  modelText('model:policy_structuring_extract.payload.chunks[].title', { purposes: ['document_processing'], scope: GEMINI_SCOPE }),
  modelText('model:policy_structuring_reconcile.payload.groups[].target', { purposes: ['document_processing'], scope: GEMINI_SCOPE }),
  modelText('model:policy_structuring_reconcile.payload.groups[].subject', { purposes: ['document_processing'], scope: GEMINI_SCOPE }),
  modelText('model:policy_structuring_reconcile.payload.groups[].readings[].value', { purposes: ['document_processing'], scope: GEMINI_SCOPE }),
  modelText('model:policy_structuring_reconcile.payload.groups[].readings[].quote', { purposes: ['document_processing'], scope: GEMINI_SCOPE }),
  modelText('model:policy_evidence_investigate.payload.questions[].text', { purposes: ['coverage_reconstruction'], scope: QUESTION_SCOPE }),
  modelText('model:policy_evidence_investigate.payload.clauses[].title', { purposes: ['coverage_reconstruction'], scope: GEMINI_SCOPE }),
  modelText('model:policy_evidence_investigate.payload.clauses[].text', { purposes: ['coverage_reconstruction'], scope: GEMINI_SCOPE }),
  modelText('model:policy_evidence_override_sweep.payload.questions[].text', { purposes: ['coverage_reconstruction'], scope: QUESTION_SCOPE }),
  modelText('model:policy_evidence_override_sweep.payload.findings[].subject', { purposes: ['coverage_reconstruction'], scope: GEMINI_SCOPE }),
  modelText('model:policy_evidence_override_sweep.payload.findings[].quote', { purposes: ['coverage_reconstruction'], scope: GEMINI_SCOPE }),
  modelText('model:policy_evidence_override_sweep.payload.clauses[].title', { purposes: ['coverage_reconstruction'], scope: GEMINI_SCOPE }),
  modelText('model:policy_evidence_override_sweep.payload.clauses[].text', { purposes: ['coverage_reconstruction'], scope: GEMINI_SCOPE }),
  ...coverageSlots,

  // Contact columns of an adult account: keyed HMACs of the phone and the e-mail (migration 029). A hash of an identifier is still
  // personal data. Same gap as the phone ciphertext: no household-level erasure of an adult account row exists today.
  table('adult_users.phone_hash', {
    category: 'contact', purposes: ['profile_intake'], retention: 'until_account_deleted', erasure: null,
  }),
  table('adult_users.contact_email_hash', {
    category: 'contact', purposes: ['profile_intake'], retention: 'until_account_deleted', erasure: null,
  }),

  // Sealed user-data columns (every *_ciphertext column of the migrations; R2).
  table('adult_users.phone_ciphertext', {
    category: 'contact', purposes: ['profile_intake'], sealed: true, retention: 'until_account_deleted',
    // GAP: no household-level erasure of an adult account row exists; only an invited placeholder is deleted with its member.
    erasure: null,
  }),
  table('profile_answers.value_ciphertext', {
    category: 'identity', purposes: ['profile_intake'], sealed: true, retention: 'until_revocation', childData: 'possible', erasure: ERASE.profileAnswers,
  }),
  table('person_records.payload_ciphertext', {
    category: 'health_or_policy_content', purposes: ['profile_intake'], sealed: true, retention: 'until_revocation', childData: 'possible', erasure: ERASE.personRecords,
  }),
  table('household_members.mobile_ciphertext', {
    category: 'contact', purposes: ['profile_intake'], sealed: true, retention: 'until_member_deleted', childData: 'possible', erasure: ERASE.memberDelete,
  }),
  table('household_members.email_ciphertext', {
    category: 'contact', purposes: ['profile_intake'], sealed: true, retention: 'until_member_deleted', childData: 'possible', erasure: ERASE.memberDelete,
  }),
  table('household_places.label_ciphertext', {
    category: 'location', purposes: ['profile_intake'], sealed: true, retention: 'until_member_or_household_erased', erasure: ERASE.userData,
  }),
  table('household_places.payload_ciphertext', {
    category: 'location', purposes: ['profile_intake'], sealed: true, retention: 'until_member_or_household_erased', erasure: ERASE.userData,
  }),
  table('adult_preferences.prefs_ciphertext', {
    category: 'preference', purposes: ['profile_intake'], sealed: true, retention: 'until_household_erased', erasure: ERASE.userData,
  }),
  table('onboarding_progress.state_ciphertext', {
    category: 'preference', purposes: ['profile_intake'], sealed: true, retention: 'until_household_erased', erasure: ERASE.userData,
  }),
  table('service_cases.stated_estimate_ciphertext', {
    category: 'financial', purposes: ['profile_intake'], sealed: true, retention: 'until_household_erased',
    erasure: erasure('src/backend/services/retention-service.js', 'createRetentionService', 'tests/data-erasure-api.test.mjs'),
  }),
  table('tool_scenarios.inputs_ciphertext', {
    category: 'preference', purposes: ['profile_intake'], sealed: true, retention: 'until_household_erased', erasure: ERASE.userData,
  }),
  // Migration 045 (ADR 0027): labels a person types for a passkey or a device. Removed by foreign-key cascade when the adult row is
  // pruned by household erasure.
  table('webauthn_credentials.label_ciphertext', {
    category: 'identity', purposes: ['profile_intake'], sealed: true, retention: 'until_account_deleted', erasure: ERASE.adultCascade,
  }),
  table('devices.label_ciphertext', {
    category: 'identity', purposes: ['profile_intake'], sealed: true, retention: 'until_account_deleted', erasure: ERASE.adultCascade,
  }),

  // Plain identity columns of a household member. Read only to build the known-identifier list; never sent to a model.
  table('household_members.date_of_birth', {
    category: 'identity', purposes: ['profile_intake'], retention: 'until_member_deleted', childData: 'possible', erasure: ERASE.memberDelete,
  }),
  table('household_members.display_name', {
    category: 'identity', purposes: ['profile_intake'], retention: 'until_member_deleted', childData: 'possible', erasure: ERASE.memberDelete,
  }),

  // Counts-only telemetry (ADR 0017 D5). No personal data by design: counts and the gate version only.
  ...['gateVersion', 'gatedSlots', 'placeholders', 'reasonCodes', 'gatedBytes'].map(key => entry({
    field: `event:provider_call.${key}`, personal: false, dataClass: 'INTERNAL', category: 'telemetry', purposes: [], retention: 'event_ttl_draft',
    erasure: ERASE.appEvents,
  })),
]);

const BY_FIELD = new Map(DATA_PURPOSE_REGISTRY.map(item => [item.field, item]));

/** The entry for a field, or a coded error: an unregistered field has no declared purpose. */
export function purposeEntry(field) {
  const found = BY_FIELD.get(field);
  if (!found) throw Object.assign(new Error('The field has no registered purpose.'), { code: 'PURPOSE_FIELD_UNKNOWN' });
  return found;
}

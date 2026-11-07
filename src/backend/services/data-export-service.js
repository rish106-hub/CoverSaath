import { EXPORT_EXCLUSIONS, REVOCATION_REASONS } from '../../contracts/data-lifecycle.js';

// Export of a household's, a case's or a member's own data (S3). Authorisation first, on every call: the session adult must
// hold a role in the household, and anything another adult entered or has not shared stays out. The manifest says what is left
// out (named categories and flags, not counts of other people's data) and which collections were cut at the row limit
// (`truncated`). Document bytes, OCR text and model output are never returned (see
// EXPORT_EXCLUSIONS, FOR LEGAL REVIEW). Every export appends one counts-only audit event.
//
// `requireCaseField` and `READ_FIELDS` are the field-permission gate the case routes use (src/server/policies); the server
// layer injects them because backend code cannot import from src/server.

const LIMIT = 500;
// Rows are read with LIMIT + 1 so a cut collection can be flagged `truncated`.
const capped = rows => ({ items: rows.slice(0, LIMIT), truncated: rows.length > LIMIT });
const NOT_ERASED_CASE = `NOT EXISTS (SELECT 1 FROM retention_records WHERE resource_type = 'case' AND resource_id = service_cases.id AND deletion_state IN ('deleted', 'verified'))`;

// Audit payloads are exported through a whitelist: short keys, numbers, booleans and short code strings only, and a reason
// only when it is one of the fixed reason codes. Audit rows written before reasons were restricted can hold a person's own
// words (and cannot be erased), so nothing outside the whitelist leaves this file.
const KEY = /^[a-z][A-Za-z0-9]{0,39}$/;
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const REASON_CODES = new Set([...REVOCATION_REASONS, 'consent_revoked', 'document_erasure', 'source_consent_not_current']);
const REASON_KEYS = new Set(['reason', 'reasonCode']);
// String values leave only under these keys, and only in code shape. Any other string (including one under an unknown key) is
// dropped, because legacy audit rows that cannot be erased may hold a person's own words under any key.
const STRING_KEYS = new Set([
  'triggerType', 'kind', 'documentKind', 'mimeType', 'status', 'toStatus', 'to', 'from', 'role', 'purpose', 'policyKind', 'memberKind',
  'decision', 'task', 'taskKey', 'tool', 'authority', 'code', 'registryVersion', 'checkedBy',
]);

export function safeAuditPayload(json) {
  let parsed;
  try { parsed = JSON.parse(json); } catch { return {}; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const clean = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!KEY.test(key)) continue;
    if (REASON_KEYS.has(key)) { if (typeof value === 'string' && REASON_CODES.has(value)) clean[key] = value; continue; }
    if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'boolean') clean[key] = value;
    else if (typeof value === 'string' && STRING_KEYS.has(key) && CODE.test(value)) clean[key] = value;
  }
  return clean;
}
const COUNT_ONLY = Symbol('count_only');

function fail(code, message, statusCode) { throw Object.assign(new Error(message), { code, statusCode }); }
const notFound = code => fail(code, code === 'MEMBER_NOT_FOUND' ? 'Member not found.' : 'Not found.', 404);

export function createDataExportService({ access, database, households, appRepository, consents, userDataRepository, profileAnswers, columnCrypto, audit, requireCaseField, READ_FIELDS, clock = () => new Date() }) {
  const responses = { requireCaseField };

  async function fieldAllowed(principal, caseRecord, field) {
    try {
      await responses.requireCaseField({ principal, caseRecord, field });
      return true;
    } catch (error) {
      if (error?.code === 'FIELD_ACCESS_REQUIRED') return false;
      throw error;
    }
  }

  async function birthDate(principal, householdId, member) {
    if (!member.date_of_birth) return null;
    if (!member.adult_user_id || member.adult_user_id === principal.adultId) return member.date_of_birth;
    return (await consents.canAccessField({ householdId, subjectAdultId: member.adult_user_id, viewerAdultId: principal.adultId, fieldKey: 'date_of_birth' })) === true
      ? member.date_of_birth : null;
  }

  const memberDto = async (principal, householdId, member) => ({
    id: member.id, displayName: member.display_name, memberKind: member.member_kind, relationshipLabel: member.relationship_label,
    dateOfBirth: await birthDate(principal, householdId, member), isYou: member.adult_user_id === principal.adultId,
  });

  const policyDto = policy => ({
    id: policy.id, insurer: policy.insurer_id ? { id: policy.insurer_id, name: policy.insurer_name } : null, policyKind: policy.policy_kind,
    policyNumberMasked: policy.policy_number_masked, startsOn: policy.starts_on, endsOn: policy.ends_on, verificationState: policy.verification_state,
    memberIds: policy.members.map(member => member.memberId),
  });

  // A filename is what the uploader typed and can name a person: it is returned only to the adult who uploaded the document.
  const documentDto = (row, principal) => ({
    id: row.id, caseId: row.case_id, documentKind: row.document_kind,
    ...(row.uploaded_by_adult_id === principal.adultId ? { filename: row.original_filename } : { filenameWithheld: true }),
    mimeType: row.mime_type, byteSize: row.byte_size, lifecycleState: row.lifecycle_state, uploadedAt: row.uploaded_at, deletedAt: row.deleted_at,
  });

  // Facts the person stated themselves, with their values. Facts read from documents or stated by others: key and state only.
  async function factsFor(principal, householdId, where, params) {
    const rows = await database.many(`SELECT id, case_id, subject_member_id, fact_key, epistemic_state, value_json, statement_adult_id, review_status, observed_at, redacted_at
      FROM evidence_facts WHERE household_id = ? AND ${where}
        AND (case_id IS NULL OR NOT EXISTS (SELECT 1 FROM retention_records WHERE resource_type = 'case' AND resource_id = evidence_facts.case_id AND deletion_state IN ('deleted', 'verified')))
      ORDER BY observed_at, id LIMIT ?`, [householdId, ...params, LIMIT + 1]);
    const own = rows.slice(0, LIMIT).map(row => {
      const yours = row.statement_adult_id === principal.adultId && row.value_json !== null;
      let value = COUNT_ONLY;
      if (yours) value = columnCrypto.openJson('evidence_facts', 'value_json', row.id, row.value_json);
      return {
        id: row.id, caseId: row.case_id, subjectMemberId: row.subject_member_id, factKey: row.fact_key, state: row.epistemic_state,
        reviewStatus: row.review_status, observedAt: row.observed_at, redacted: row.redacted_at !== null,
        ...(value === COUNT_ONLY ? { valueWithheld: row.value_json !== null } : { value }),
      };
    });
    return { items: own, truncated: rows.length > LIMIT };
  }

  async function userData(householdId, adultId) {
    const [permissions, places, preferences, onboarding, scenarios] = await Promise.all([
      userDataRepository.listPermissions({ householdId, adultId }),
      userDataRepository.listPlaces({ householdId, adultId }),
      userDataRepository.getPreferences({ householdId, adultId }),
      userDataRepository.getOnboarding({ householdId, adultId }),
      userDataRepository.listScenarios({ householdId, adultId }),
    ]);
    return { permissions, places, preferences, onboarding, scenarios };
  }

  async function record(principal, householdId, resourceType, resourceId, caseId, sections) {
    const counts = Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, Array.isArray(value) ? value.length : (value?.items?.length ?? 0)]));
    await audit.append({ householdId, caseId, actorType: 'adult_user', actorId: principal.adultId, action: 'data_export.generated', resourceType, resourceId, payload: counts });
    return counts;
  }

  const manifest = (kind, counts, extra = {}) => ({
    kind, generatedAt: clock().toISOString(), format: 'knowvia.export.v1', counts, excluded: EXPORT_EXCLUSIONS, ...extra,
  });

  return {
    async exportHousehold(principal, householdId) {
      const { household, role } = await access.requireHousehold(principal, householdId);
      const members = [];
      for (const member of await households.listMembers(householdId)) members.push(await memberDto(principal, householdId, member));
      const policies = (await appRepository.listPolicies(householdId)).map(policyDto);
      const casesPage = capped(await database.many(`SELECT id, trigger_type, status, created_at, updated_at, closed_at FROM service_cases
        WHERE household_id = ? AND opened_by_adult_id = ? AND ${NOT_ERASED_CASE}
        ORDER BY created_at, id LIMIT ?`, [householdId, principal.adultId, LIMIT + 1]));
      const cases = casesPage.items;
      const documentsPage = capped(await database.many(`SELECT * FROM document_uploads WHERE household_id = ? AND uploaded_by_adult_id = ? AND lifecycle_state <> 'deleted' ORDER BY uploaded_at, id LIMIT ?`, [householdId, principal.adultId, LIMIT + 1]));
      const documents = documentsPage.items.map(row => documentDto(row, principal));
      const { consents: grants, truncated: grantsTruncated } = await consents.listForSubject({ householdId, subjectAdultId: principal.adultId, limit: LIMIT });
      const answers = await profileAnswers.listAuthoredBy({ householdId, adultUserId: principal.adultId, limit: LIMIT });
      const facts = await factsFor(principal, householdId, 'statement_adult_id = ?', [principal.adultId]);
      const body = {
        household: { id: household.id, displayName: household.display_name, status: household.status, createdAt: household.created_at },
        viewer: { adultId: principal.adultId, role: role.role },
        members,
        policies,
        cases: cases.map(row => ({ id: row.id, triggerType: row.trigger_type, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, closedAt: row.closed_at })),
        documents,
        consents: grants,
        profileAnswers: answers,
        facts,
        yourData: await userData(householdId, principal.adultId),
      };
      const owner = role.role === 'owner';
      const auditPage = owner
        ? capped(await database.many(`SELECT id, actor_type, action, resource_type, resource_id, event_payload_json, occurred_at FROM audit_events WHERE household_id = ? ORDER BY id LIMIT ?`, [householdId, LIMIT + 1]))
        : null;
      const audits = auditPage
        ? auditPage.items
          .map(row => ({ id: row.id, actorType: row.actor_type, action: row.action, resourceType: row.resource_type, resourceId: row.resource_id, payload: safeAuditPayload(row.event_payload_json), occurredAt: row.occurred_at }))
        : null;
      if (audits) body.audit = audits;
      const counts = await record(principal, householdId, 'household', householdId, null, { members, policies, cases: body.cases, documents, consents: grants, profileAnswers: answers, facts, ...(audits ? { audit: audits } : {}) });
      return {
        ...body,
        manifest: manifest('household', counts, {
          truncated: { consents: grantsTruncated, facts: facts.truncated, cases: casesPage.truncated, documents: documentsPage.truncated, audit: auditPage?.truncated ?? false },
          withheld: { auditTrail: !owner, otherAdultsPrivateData: true, casesOpenedByOthers: true, documentsUploadedByOthers: true },
        }),
      };
    },

    async exportCase(principal, caseId) {
      const caseRecord = await access.requireCase(principal, caseId);
      const householdId = caseRecord.household_id;
      if (!(await fieldAllowed(principal, caseRecord, READ_FIELDS.caseSummary))) fail('FIELD_ACCESS_REQUIRED', 'The subject has not granted access to this field for this viewer.', 403);
      const withheld = [];
      const gated = async (field, name, load) => {
        if (await fieldAllowed(principal, caseRecord, field)) return load();
        withheld.push(name);
        return [];
      };
      const cut = {};
      const page = (name, rows) => { const { items, truncated } = capped(rows); cut[name] = truncated; return items; };
      const documents = await gated(READ_FIELDS.sourcePack, 'documents', async () => page('documents', await database.many(
        `SELECT * FROM document_uploads WHERE case_id = ? AND household_id = ? AND lifecycle_state <> 'deleted' ORDER BY uploaded_at, id LIMIT ?`, [caseId, householdId, LIMIT + 1])).map(row => documentDto(row, principal)));
      const runs = await gated(READ_FIELDS.analysisSummary, 'runs', async () => page('runs', await database.many(
        'SELECT id, workflow_name, execution_mode, status, created_at, finished_at FROM workflow_runs WHERE case_id = ? ORDER BY created_at, id LIMIT ?', [caseId, LIMIT + 1]))
        .map(row => ({ id: row.id, workflowName: row.workflow_name, executionMode: row.execution_mode, status: row.status, createdAt: row.created_at, finishedAt: row.finished_at })));
      const audits = await gated(READ_FIELDS.auditSummary, 'audit', async () => page('audit', await database.many(
        'SELECT id, actor_type, action, resource_type, resource_id, event_payload_json, occurred_at FROM audit_events WHERE case_id = ? ORDER BY id LIMIT ?', [caseId, LIMIT + 1]))
        .map(row => ({ id: row.id, actorType: row.actor_type, action: row.action, resourceType: row.resource_type, resourceId: row.resource_id, payload: safeAuditPayload(row.event_payload_json), occurredAt: row.occurred_at })));
      const answers = (await profileAnswers.listAuthoredBy({ householdId, adultUserId: principal.adultId, limit: LIMIT })).filter(answer => answer.caseId === caseId);
      const facts = await factsFor(principal, householdId, 'case_id = ? AND statement_adult_id = ?', [caseId, principal.adultId]);
      const body = {
        case: {
          id: caseRecord.id, householdId, triggerType: caseRecord.trigger_type, status: caseRecord.status, emergencyMode: Number(caseRecord.emergency_mode) === 1,
          statedEstimateMinor: caseRecord.stated_estimate_minor, currency: caseRecord.currency, createdAt: caseRecord.created_at, closedAt: caseRecord.closed_at,
        },
        documents, runs, profileAnswers: answers, facts, audit: audits,
      };
      const counts = await record(principal, householdId, 'case', caseId, caseId, { documents, runs, profileAnswers: answers, facts, audit: audits });
      return { ...body, manifest: manifest('case', counts, { truncated: { facts: facts.truncated, documents: cut.documents ?? false, runs: cut.runs ?? false, audit: cut.audit ?? false }, withheld: { fields: withheld, otherAdultsPrivateData: true } }) };
    },

    async exportMember(principal, householdId, memberId) {
      await access.requireHousehold(principal, householdId);
      const member = await households.listMembers(householdId).then(list => list.find(item => item.id === memberId));
      if (!member) notFound('MEMBER_NOT_FOUND');
      // Only the requested member's id is listed on each policy: the other members on a shared policy are not part of this export.
      const policies = (await appRepository.listPolicies(householdId)).map(policyDto).filter(policy => policy.memberIds.includes(memberId))
        .map(policy => ({ ...policy, memberIds: [memberId] }));
      const casesPage = capped(await database.many(`SELECT id, trigger_type, status, created_at, closed_at FROM service_cases
        WHERE household_id = ? AND subject_member_id = ? AND opened_by_adult_id = ? AND ${NOT_ERASED_CASE}
        ORDER BY created_at, id LIMIT ?`, [householdId, memberId, principal.adultId, LIMIT + 1]));
      const cases = casesPage.items;
      const facts = await factsFor(principal, householdId, 'subject_member_id = ?', [memberId]);
      const places = (await userDataRepository.listPlaces({ householdId, adultId: principal.adultId })).filter(place => place.memberId === memberId);
      const body = {
        member: await memberDto(principal, householdId, member),
        policies,
        cases: cases.map(row => ({ id: row.id, triggerType: row.trigger_type, status: row.status, createdAt: row.created_at, closedAt: row.closed_at })),
        facts,
        places,
      };
      const counts = await record(principal, householdId, 'household_member', memberId, null, { policies, cases: body.cases, facts, places });
      return { ...body, manifest: manifest('member', counts, { truncated: { facts: facts.truncated, cases: casesPage.truncated }, withheld: { casesOpenedByOthers: true, otherAdultsPrivateData: true } }) };
    },
  };
}

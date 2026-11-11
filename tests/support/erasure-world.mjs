import { parseRecordBody } from '../../src/contracts/capture-registry.js';
// Kitchen-sink synthetic household for the erasure proof (S3). Every household-scoped store gets at least one row, and every
// content column that can hold text carries a canary string, so "nothing is left" can be proven by SQL. Synthetic data only.
import { createHash } from 'node:crypto';
import { hex, insert, seedWorld, seedParameter, seedObservation, at, later } from './postgres-fixtures.mjs';

export async function seedErasureWorld(pool, services, key, { columnCrypto = services.columnCrypto } = {}) {
  const digest = name => createHash('sha256').update(`${key}:${name}`).digest('hex');
  const canary = name => `CANARY-${key}-${name}`;
  const ids = await seedWorld(pool, key);
  const q = (sql, params = []) => pool.query(sql, params);

  // People: the owner has a contact, a second adult holds an account in this household only, one dependent, one invited placeholder.
  await q('UPDATE adult_users SET display_name = $1, contact_email = $2, contact_phone = $3, contact_email_hash = $4 WHERE id = $5',
    [canary('owner-name'), `${canary('owner')}@example.test`.toLowerCase(), canary('owner-phone'), digest('email'), ids.adult]);
  await q('UPDATE household_members SET display_name = $1, relationship_label = $2, date_of_birth = $3 WHERE id = $4', [canary('owner-member'), canary('label'), '1980-01-01', ids.member]);
  ids.adult2 = `adult2-${key}`;
  await insert(pool, 'adult_users', { id: ids.adult2, display_name: canary('adult2-name'), contact_email: `${canary('adult2')}@example.test`.toLowerCase() });
  await insert(pool, 'household_roles', { id: `role2-${key}`, household_id: ids.household, adult_user_id: ids.adult2, role: 'member' });
  ids.member2 = `member2-${key}`;
  await insert(pool, 'household_members', { id: ids.member2, household_id: ids.household, adult_user_id: ids.adult2, display_name: canary('adult2-member') });
  ids.dependent = `dependent-${key}`;
  await insert(pool, 'household_members', { id: ids.dependent, household_id: ids.household, adult_user_id: null, member_kind: 'dependent', display_name: canary('dependent-name'), relationship_label: canary('dep-label'), date_of_birth: '2015-05-05' });
  ids.placeholderAdult = `invited-${key}`;
  await insert(pool, 'adult_users', { id: ids.placeholderAdult, display_name: canary('invited-name'), account_status: 'invited' });
  ids.placeholder = `placeholder-${key}`;
  await insert(pool, 'household_members', { id: ids.placeholder, household_id: ids.household, adult_user_id: ids.placeholderAdult, display_name: canary('invited-member') });
  await insert(pool, 'api_sessions', { id: `session-${key}`, adult_user_id: ids.adult, token_sha256: digest('token') });
  await q(`INSERT INTO auth_identities (id, adult_user_id, issuer, subject_sha256, created_at) VALUES ($1, $2, 'test-issuer', $3, $4)`, [`identity-${key}`, ids.adult, digest('identity'), at]);
  await q('INSERT INTO case_participants (case_id, adult_user_id, participant_role, consent_grant_id, created_at) VALUES ($1, $2, $3, $4, $5)', [ids.case, ids.adult, 'requester', ids.consent, at]);

  // Consent.
  await insert(pool, 'consent_scopes', { id: `scope-${key}`, consent_grant_id: ids.consent, resource_type: 'document', resource_id: ids.document, action: 'collect', data_category: 'insurance_document' });
  ids.consent2 = `consent2-${key}`;
  await insert(pool, 'consent_grants', { id: ids.consent2, household_id: ids.household, subject_adult_id: ids.adult2 });
  // The revocation goes through the real path with free text: the reason must never reach the row or the (unerasable) audit
  // payload, so the canary below can appear nowhere after the fact.
  await services.consents.revoke({ id: `revocation-${key}`, grantId: ids.consent2, revokedByAdultId: ids.adult2, reason: canary('revocation-reason') });
  ids.consent3 = `consent3-${key}`;
  await insert(pool, 'consent_grants', { id: ids.consent3, household_id: ids.household, subject_adult_id: ids.adult2 });

  // Documents and what is read from them.
  await q('UPDATE document_uploads SET original_filename = $1 WHERE id = $2', [`${canary('filename')}.pdf`, ids.document]);
  await q('UPDATE source_pages SET extracted_text = $1, text_sha256 = $2 WHERE id = $3', [canary('page-text'), hex('c'), ids.page]);
  await q('UPDATE ocr_jobs SET result_json = $1, authorization_json = $2 WHERE id = $3', [JSON.stringify({ text: canary('ocr') }), JSON.stringify({ consentGrantId: ids.consent }), ids.ocr]);
  await insert(pool, 'document_blobs', { document_id: ids.document, household_id: ids.household, storage_key: digest('blob') });
  await insert(pool, 'policy_clauses', { id: `clause-${key}`, household_id: ids.household, case_id: ids.case, document_id: ids.document, text: canary('clause-text') });
  await insert(pool, 'policy_answers', { id: `answer-${key}`, household_id: ids.household, case_id: ids.case, requested_by_adult_id: ids.adult, question: canary('question'), document_ids_json: JSON.stringify([ids.document]), answer_json: JSON.stringify({ a: canary('answer') }) });
  // A confirmed policy profile (migration 043). The sealed columns hold an envelope-shaped value carrying the canary.
  await insert(pool, 'policy_profiles', {
    id: `profile-${key}`, household_id: ids.household, case_id: ids.case, document_id: ids.document, source_version: '1', uin: 'ABCHLIP12345V012021', uin_state: 'reported',
    policy_name_enc: `enc2.k1.${canary('policy-name')}`, policy_name_state: 'reported', confirmation_source: 'user_statement', confirmed_at: at, confirmed_by_adult_id: ids.adult,
  });
  // A policy fact and its evidence (migration 044). The sealed columns hold envelope-shaped values carrying the canary.
  await insert(pool, 'policy_facts', {
    id: `pfact-${key}`, household_id: ids.household, case_id: ids.case, document_id: ids.document, source_version: '1', fact_type: 'sum_insured', value_type: 'money', value_enum: null,
    currency: 'INR', amount_band: '5l_10l', value_enc: `enc2.k1.${canary('pfact-value')}`, raw_text_enc: `enc2.k1.${canary('pfact-raw')}`,
  });
  await insert(pool, 'fact_evidence', {
    id: `fev-${key}`, fact_id: `pfact-${key}`, household_id: ids.household, case_id: ids.case, document_id: ids.document, source_version: '1', quote_enc: `enc2.k1.${canary('pfact-quote')}`,
  });
  // Holdings and memory (migrations 048-052): every store gets a row; the sealed columns hold envelope-shaped values carrying the canary.
  ids.holding = `holding-${key}`;
  await insert(pool, 'policy_holdings', { id: ids.holding, household_id: ids.household, policy_id: ids.policy, document_id: ids.document });
  await insert(pool, 'household_memory_facts', { id: `mfact-a-${key}`, household_id: ids.household, holding_id: ids.holding, consent_grant_id: ids.consent, source_document_id: ids.document, source_page_id: ids.page, value_enc: `enc2.k1.${canary('memory-value')}` });
  await insert(pool, 'household_memory_facts', { id: `mfact-b-${key}`, household_id: ids.household, holding_id: ids.holding, fact_class: 'product_term', source_tier: 'ida_wording', status: 'reviewed_reference', consent_grant_id: ids.consent, source_document_id: ids.document, reference_ref_enc: `enc2.k1.${canary('memory-ref')}`, value_enc: `enc2.k1.${canary('memory-value2')}`, fact_key: 'room_rent_limit' });
  await insert(pool, 'household_memory_facts', { id: `mfact-c-${key}`, household_id: ids.household, holding_id: ids.holding, source_tier: 'user_declaration', status: 'user_confirmed', consent_grant_id: ids.consent, declared_by_adult_id: ids.adult, capture_method: 'typed', value_enc: `enc2.k1.${canary('memory-value3')}` });
  await insert(pool, 'memory_conflicts', { id: `mconf-${key}`, household_id: ids.household, holding_id: ids.holding, candidate_fact_ids: [`mfact-a-${key}`, `mfact-c-${key}`] });
  await insert(pool, 'member_declarations', { id: `decl-${key}`, household_id: ids.household, member_id: ids.dependent, consent_grant_id: ids.consent, declared_by_adult_id: ids.adult, label_enc: `enc2.k1.${canary('declaration')}` });
  await insert(pool, 'premium_payments', { id: `ppay-${key}`, household_id: ids.household, holding_id: ids.holding, consent_grant_id: ids.consent, paid_via: 'agent', amount_enc: `enc2.k1.${canary('premium')}`, agent_name_enc: `enc2.k1.${canary('agent-name')}`, agent_code_enc: `enc2.k1.${canary('agent-code')}` });
  await insert(pool, 'premium_dues', { id: `pdue-${key}`, household_id: ids.household, holding_id: ids.holding, consent_grant_id: ids.consent, amount_enc: `enc2.k1.${canary('due')}` });
  await insert(pool, 'catalogue_reviewer_grants', { id: `crg-${key}`, household_id: ids.household, adult_user_id: ids.adult, granted_by: ids.adult, case_id: ids.case });

  await insert(pool, 'catalogue_reviews', { id: `review2-${key}`, household_id: ids.household, case_id: ids.case, grant_id: `crg-${key}`, reviewer_adult_id: ids.adult, document_id: ids.document, fact_key: hex('f'), fact_json: JSON.stringify({ f: canary('review-fact') }) });

  // Policies and evidence.
  await q('UPDATE policies SET household_id = household_id, policy_number_masked = $1, starts_on = $2, ends_on = $3 WHERE id = $4', [canary('policy-number'), '2026-01-01', '2026-12-31', ids.policy]);
  await insert(pool, 'policy_members', { policy_id: ids.policy, household_member_id: ids.dependent });
  ids.fact2 = `fact2-${key}`;
  await insert(pool, 'evidence_facts', { id: ids.fact2, household_id: ids.household, case_id: ids.case, subject_member_id: ids.dependent, policy_id: ids.policy, epistemic_state: 'known', value_json: JSON.stringify({ v: canary('pfact-value') }), statement_adult_id: ids.adult });
  await insert(pool, 'fact_conflicts', { id: `conflict-${key}`, left_fact_id: ids.fact, right_fact_id: ids.fact2 });

  // Workflow.
  ids.task = `task-${key}`;
  ids.task2 = `task2-${key}`;
  await insert(pool, 'workflow_tasks', { id: ids.task, workflow_run_id: ids.run, input_json: JSON.stringify({ i: canary('task-input') }), output_json: JSON.stringify({ o: canary('task-output') }), last_error_message: canary('task-error') });
  await insert(pool, 'workflow_tasks', { id: ids.task2, workflow_run_id: ids.run, parent_task_id: ids.task });
  await insert(pool, 'workflow_task_dependencies', { workflow_task_id: ids.task2, depends_on_task_id: ids.task });
  await q('INSERT INTO workflow_events (workflow_run_id, workflow_task_id, event_type, event_payload_json, occurred_at) VALUES ($1, $2, $3, $4, $5)', [ids.run, ids.task, 'task.completed', JSON.stringify({ p: canary('event') }), at]);
  await q(`INSERT INTO reviewer_findings (id, workflow_run_id, workflow_task_id, reviewer_kind, severity, finding_code, message, created_at) VALUES ($1, $2, $3, 'evidence', 'info', 'CODE', $4, $5)`, [`finding-${key}`, ids.run, ids.task, canary('finding'), at]);
  await insert(pool, 'release_gates', { id: `gate-${key}`, workflow_run_id: ids.run });
  await q('UPDATE workflow_runs SET input_json = $1 WHERE id = $2', [JSON.stringify({ authorizedSources: [{ documentId: ids.document }], sourcePages: [{ documentId: ids.document, sourceId: ids.page, version: 'version-1', page: 2, text: canary('run-excerpt') }], note: canary('run-input') }), ids.run]);
  await insert(pool, 'human_approvals', { id: `approval-${key}`, case_id: ids.case, adult_user_id: ids.adult, consent_grant_id: ids.consent, target_id: ids.case });
  await insert(pool, 'integration_outbox', { id: `outbox-${key}`, case_id: ids.case, consent_grant_id: ids.consent, payload_json: JSON.stringify({ p: canary('outbox') }) });
  await insert(pool, 'coverage_graph_snapshots', { id: `graph-${key}`, household_id: ids.household, case_id: ids.case, graph_json: JSON.stringify({ g: canary('graph') }), generated_by_run_id: ids.run });
  await insert(pool, 'coverage_graph_nodes', { id: `node1-${key}`, snapshot_id: `graph-${key}`, label: canary('node'), source_fact_id: ids.fact2 });
  await insert(pool, 'coverage_graph_nodes', { id: `node2-${key}`, snapshot_id: `graph-${key}`, label: canary('node2') });
  await insert(pool, 'coverage_graph_edges', { id: `edge-${key}`, snapshot_id: `graph-${key}`, from_node_id: `node1-${key}`, to_node_id: `node2-${key}` });

  // Parameters and structuring.
  const parameter = await seedParameter(pool, ids);
  ids.parameter = parameter.record;
  ids.observation = await seedObservation(pool, ids, ids.parameter, { value_json: JSON.stringify({ v: canary('observation') }) });
  await insert(pool, 'coverage_parameter_resolutions', { parameter_record_id: ids.parameter, resolution_state: 'extracted_unverified', resolved_value_json: JSON.stringify({ v: canary('resolved') }), resolved_observation_id: ids.observation, transition_authority: 'model' });
  await q(`INSERT INTO coverage_parameter_acquisitions (parameter_record_id, acquisition_state, requested_at, updated_by, updated_at) VALUES ($1, 'requested', $2, 'test', $3) ON CONFLICT DO NOTHING`, [ids.parameter, at, at]).catch(() => undefined);
  ids.structuringRun = `sr-${key}`;
  await insert(pool, 'policy_structuring_runs', { id: ids.structuringRun, household_id: ids.household, case_id: ids.case, workflow_run_id: ids.run, document_id: ids.document });
  await insert(pool, 'proposed_parameters', { id: `pp-${key}`, structuring_run_id: ids.structuringRun, household_id: ids.household, document_id: ids.document, source_page_id: ids.page, label: canary('proposal-label'), value_json: JSON.stringify({ text: canary('proposal') }) });
  await insert(pool, 'policy_structuring_jobs', { id: `job-${key}`, household_id: ids.household, case_id: ids.case, workflow_run_id: ids.run, document_id: ids.document, consent_grant_id: ids.consent });

  // User-stated data, sealed by the repositories.
  // Setup failures must fail the proof, never reduce its coverage silently.
  await services.profileAnswers.upsert({ householdId: ids.household, caseId: ids.case, adultUserId: ids.adult, answers: new Map([['city', canary('city')], ['state', canary('state')]]) });
  const userData = services.userDataRepository;
  await userData.setPermission({ householdId: ids.household, adultId: ids.adult, permission: 'location', state: 'granted', surface: 'settings', wordingVersion: 'v1', ifMatch: null });
  await userData.setPreferences({ householdId: ids.household, adultId: ids.adult, prefs: { language: canary('prefs') }, ifMatch: null });
  await userData.setOnboarding({ householdId: ids.household, adultId: ids.adult, state: { step: canary('onboarding') }, completed: true, ifMatch: null });
  await userData.setScenario({ householdId: ids.household, adultId: ids.adult, tool: 'tax', inputs: { v: canary('scenario') }, ifMatch: null });
  await userData.setPlace({ householdId: ids.household, adultId: ids.adult, memberId: ids.dependent, place: { kind: 'registered_address', slot: null, label: canary('place-label'), source: 'user_typed', precision: 'exact', payload: { line: canary('address') } }, ifMatch: null }).catch(error => { throw new Error(`setPlace: ${error.code ?? error.message}`); });

  // A sealed person record about the dependent (ADR 0026); the household sweep and member erasure must reach it.
  await services.personRecordRepository.set({ householdId: ids.household, adultId: ids.adult, type: 'member_note', slot: 'main', memberId: ids.dependent,
    parsed: parseRecordBody('member_note', { data: { note: canary('person-record') } }) });

  // Queued worker job (identifiers only, no document or grant): only the household sweep reaches it.
  await q(`INSERT INTO job_queue (id, kind, household_id, payload_json) VALUES ($1, 'ocr.page', $2, '{}')`, [`job-${key}`, ids.household]);

  // Telemetry and idempotency.
  await q(`INSERT INTO household_sync_state (household_id, min_seq, updated_at) VALUES ($1, 0, '2030-01-01T00:00:00.000Z')`, [ids.household]);
  await q(`INSERT INTO app_events (occurred_at, expires_at, event_name, household_id, adult_user_id, case_id, consent_grant_id, route) VALUES (now(), now() + interval '1 day', 'http_request', $1, $2, $3, $4, '/x')`, [ids.household, ids.adult, ids.case, ids.consent]);
  await q(`INSERT INTO idempotency_keys (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at) VALUES ($1, $2, $3, 201, $4, $5, $6)`,
    [`document-upload:${ids.adult}:${ids.case}`, `key-${key}`, hex('d'), JSON.stringify({ document: { id: ids.document, filename: canary('idem-filename') } }), later, at]);
  await q(`INSERT INTO idempotency_keys (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at, household_id, case_id) VALUES ($1, $2, $3, 202, $4, $5, $6, $7, $8)`,
    ['analysis_run', `run-key-${key}`, hex('d'), JSON.stringify({ runId: ids.run }), later, at, ids.household, ids.case]);
  await q('INSERT INTO audit_events (household_id, case_id, actor_type, actor_id, action, resource_type, resource_id, event_payload_json, event_hash, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [ids.household, ids.case, 'system', 'seed', 'case.created', 'case', ids.case, '{"triggerType":"renewal"}', digest('audit'), at]);
  ids.canaryPrefix = `CANARY-${key}-`;
  return ids;
}

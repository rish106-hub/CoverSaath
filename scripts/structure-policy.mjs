#!/usr/bin/env node
/**
 * Whole-document structuring eval for the local sample (ADR 0006). Opt-in.
 *   (no flag)                  section and privacy-gate only: chunk counts, no provider call
 *   --consent=gemini           billable: extract and reconcile with Gemini, score against golden-structuring.json
 *   --consent=gemini --store   as above, then store through a fresh local SQLite backend (.local/eval/structuring-<time>.sqlite)
 *                              and write a local review of everything stored (.local/eval/structuring-review.md)
 * Reads .local/eval/sarvam-raw.json (block-level pages), normalized.json (page text, for --store) and
 * optional known-identifiers.json. Household names found by the local rule extractor are masked before any call.
 * Prints counts only, never document text. Everything else stays under .local/ (gitignored).
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/backend-services.js';
import { FIELD_NAMES, extractFields } from '../src/modules/ai-analysis/eval-extractor.js';
import { createGeminiCaller } from '../src/modules/ai-analysis/field-adjudicator.js';
import { GEMINI_MODEL_RECIPIENT } from '../src/modules/ai-analysis/privacy-evidence-gate.js';
import { getPolicyParameterDefinition } from '../src/modules/coverage-analysis/policy-parameter-registry.js';
import {
  POLICY_STRUCTURING_VERSION, STRUCTURING_LIMITS, documentGrantCheck, gateChunks, isConflict, scoreStructuring,
  sectionDocument, structurePolicyDocument,
} from '../src/modules/policy-structuring/index.js';

const OUT = resolve('.local/eval');
const REGISTRY = 'policy-parameters/v1';
const flags = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
  const [name, ...value] = a.slice(2).split('=');
  return [name, value.length ? value.join('=') : true];
}));
const consent = new Set((flags.consent ?? '').split(',').filter(Boolean));
const readJson = async (name, fallback) => {
  try { return JSON.parse(await readFile(resolve(OUT, name), 'utf8')); } catch (error) {
    if (fallback !== undefined && error.code === 'ENOENT') return fallback;
    throw Object.assign(new Error(`Could not read ${name}.`), { code: error.code ?? 'LOCAL_FILE_INVALID' });
  }
};
const writeJson = (name, value) => writeFile(resolve(OUT, name), JSON.stringify(value, null, 2));
const sha256 = text => createHash('sha256').update(text).digest('hex');

// Same block view as eval-parse.mjs: [{ page, blocks: [{ text, tag }] }] in original page order.
function blockPages(raw) {
  return raw.flatMap(result => result.documents[0].pages).map((page, index) => ({
    page: index + 1,
    blocks: [...page.blocks].sort((a, b) => a.reading_order - b.reading_order).map(b => ({ text: b.text, tag: b.layout_tag ?? null })),
  }));
}

// Identity fields are captured by local rules only (registry: no model extraction). Names among them
// become known identifiers, so the privacy gate masks them in every chunk and title before any call.
function localCapture(pages, fileIdentifiers) {
  const fields = extractFields(pages, FIELD_NAMES);
  const names = [fields.policyholder_name?.value, ...[fields.insured_members?.value].flat()]
    .filter(value => typeof value === 'string' && /\p{L}/u.test(value) && value.length <= 200);
  const knownIdentifiers = [...new Set(names)].map(value => ({ kind: 'NAME', value }));
  return { fields, knownIdentifiers: [...knownIdentifiers, ...(fileIdentifiers ?? [])].slice(0, 200) };
}

// A fresh local backend: one household, case, policy, document with its OCR pages, a coverage run with
// every registry key, and a document-specific grant naming google-gemini. Synthetic ids, real page text.
function freshBackend(normalized, at) {
  const path = `eval/structuring-${at.replace(/[:.]/g, '-')}.sqlite`;
  const database = openDatabase({ path });
  const services = createBackendServices(database, { clock: () => new Date() });
  const run = (sql, ...params) => database.prepare(sql).run(...params);
  run("INSERT INTO households (id, display_name, created_at, updated_at) VALUES ('household-local', 'Local eval household', ?, ?)", at, at);
  run("INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES ('adult-local', 'Local operator', 'active', ?, ?)", at, at);
  run("INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at) VALUES ('role-local', 'household-local', 'adult-local', 'owner', 'active', ?)", at);
  run(`INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at)
    VALUES ('member-local', 'household-local', 'adult-local', 'Policyholder', 'adult', ?, ?)`, at, at);
  run(`INSERT INTO consent_grants (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method, granted_at, created_at)
    VALUES ('consent-local', 'household-local', 'adult-local', 'knowvia-local', 'document_processing', 'v1', 'typed', ?, ?)`, at, at);
  run(`INSERT INTO service_cases (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
    VALUES ('case-local', 'household-local', 'member-local', 'adult-local', 'renewal', 'processing', ?, ?)`, at, at);
  run(`INSERT INTO policies (id, household_id, policy_kind, verification_state, created_at, updated_at)
    VALUES ('policy-local', 'household-local', 'personal', 'unverified', ?, ?)`, at, at);
  run(`INSERT INTO document_uploads (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind, original_filename,
      storage_path, content_sha256, mime_type, byte_size, malware_status, encryption_status, lifecycle_state, uploaded_at, source_version)
    VALUES ('document-local', 'household-local', 'case-local', 'adult-local', 'consent-local', 'policy_schedule', 'policy.pdf',
      'local/document-local', ?, 'application/pdf', 1, 'clean', 'encrypted_local', 'active', ?, ?)`,
  normalized.document.contentSha256, at, normalized.document.sourceVersion);
  run(`INSERT INTO ocr_jobs (id, document_upload_id, provider, status, attempt_count, requested_at, completed_at, updated_at)
    VALUES ('ocr-local', 'document-local', 'sarvam', 'succeeded', 1, ?, ?, ?)`, at, at, at);
  for (const page of normalized.pages) {
    run(`INSERT INTO source_pages (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256, extracted_text,
        extraction_status, created_at, text_sha256) VALUES (?, 'document-local', 'ocr-local', ?, ?, ?, ?, ?, ?, ?)`,
    `page-local-${page.pageNumber}`, page.pageNumber, normalized.document.sourceVersion, sha256(page.text), page.text,
    page.extractionStatus, at, sha256(page.text));
  }
  run(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES ('scope-local-gemini', 'consent-local', 'document', 'document-local', 'derive', 'insurance_document', ?, ?)`, GEMINI_MODEL_RECIPIENT, at);
  run(`INSERT INTO workflow_runs (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest, input_json, created_at)
    VALUES ('run-local', 'case-local', 'coverage-reconstruction', 'v2', 'live', 'running', ?, '{}', ?)`, sha256('run-local'), at);
  services.coverageParameters.initializeRunParameters({
    workflowRunId: 'run-local', registryVersion: REGISTRY, householdId: 'household-local', caseId: 'case-local',
    subjectId: 'member-local', policyId: 'policy-local', updatedBy: 'structure-policy-script',
  });
  return { database, services, path, sourceVersion: normalized.document.sourceVersion };
}

const label = key => { try { return getPolicyParameterDefinition(REGISTRY, key).label; } catch { return key; } };
const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const shown = value => (value?.normalized ? `${cell(value.text)} → \`${JSON.stringify(value.normalized)}\`` : cell(value?.text));

// Local review of what was stored and why. Contains document values; stays under .local/.
function reviewMarkdown({ result, capture, gated, stored, score, meta }) {
  const lines = [];
  const push = (...rows) => lines.push(...rows);
  const { report } = result;
  push(`# Policy structuring review (local only)`, '', `Generated ${meta.at}. Model ${meta.model}. Pipeline ${POLICY_STRUCTURING_VERSION}. Database \`${meta.path}\`.`, '');
  push('## Summary', '', '| Measure | Value |', '|---|---|',
    `| Gemini calls | ${report.calls} |`, `| Tokens in / out | ${report.usage.inputTokens} / ${report.usage.outputTokens} |`,
    `| Elapsed | ${(meta.elapsedMs / 1000).toFixed(0)} s |`,
    `| Chunks | ${report.chunks.total}: ${report.chunks.stored} stored, ${report.chunks.proposed} proposed only, ${report.chunks.skipped} skipped, ${report.chunks.unaccounted} unaccounted |`,
    `| Blocks dropped before chunking | ${JSON.stringify(report.dropped)} |`,
    `| Items | ${report.items.accepted} registry, ${report.items.proposals} proposed, ${report.items.rejected} rejected ${JSON.stringify(report.items.rejectedReasons)} |`,
    `| Conflicts | ${report.conflicts.total} contradictions; ${report.variations.context} differing in context; ${report.variations.perSubject} per-subject variations; ${report.modelSelections} resolved by Gemini selection (unverified, for household confirmation) |`,
    `| Stored | ${stored.counts.observations} observations on ${stored.counts.parameters} parameters (${stored.counts.conflicting} conflicting, ${stored.counts.skippedKeys} keys skipped), ${stored.counts.proposals} proposals |`,
    score ? `| Score vs draft golden | key recall ${score.keyRecall?.toFixed(2)}, hallucinated quotes ${score.hallucinationRate.toFixed(3)}, conflict recall ${score.conflictRecall?.toFixed(2)}; missing ${score.missingKeys.join(', ') || 'none'} |` : '| Score | no golden-structuring.json |',
    '');
  push('## Redaction before Gemini', '',
    `- Known names masked (found by local rules, never sent): ${capture.knownIdentifiers.length}.`,
    `- Chunks withheld from Gemini by the privacy gate: ${Object.keys(gated.skipped).length} (${[...new Set(Object.values(gated.skipped))].join(', ') || 'none'}): ${Object.keys(gated.skipped).join(', ') || '-'}.`,
    '- Every chunk text and section title passed the gate; Gemini saw placeholders such as `<NAME_1>`, `<PHONE_1>` instead of the values.', '');
  push('## Captured locally by rules (not sent to Gemini)', '', '| Field | Value | Page |', '|---|---|---|');
  for (const [field, hit] of Object.entries(capture.fields)) push(`| ${field} | ${cell([hit.value].flat().join(', ')) || '_unknown_'} | ${hit.page ?? ''} |`);
  push('', 'These are not stored in the registry yet: identifier keys forbid model extraction and no rule-capture path exists.', '');
  push('## Stored registry parameters', '', '| Key | Label | State | Reason | Value(s) [subject, page] |', '|---|---|---|---|---|');
  for (const record of stored.records) {
    push(`| ${record.key} | ${label(record.key)} | **${record.state}** | ${record.reason ?? ''} | ${record.observations.map(o => `${shown(o.value)} [${cell(o.value?.subject)}, p${o.page}]`).join('<br>')} |`);
  }
  push('', '## Proposed parameters (pending review, not in the registry)', '', '| Proposed key | Category | Label | Value | Page |', '|---|---|---|---|---|');
  for (const proposal of stored.proposals) push(`| ${proposal.proposedKey} | ${proposal.category} | ${cell(proposal.label)} | ${shown(proposal.value)} | ${proposal.page} |`);
  const where = entry => entry.itemRefs.map(ref => `p${ref.page}/b${ref.blockIndex}`).join(', ');
  push('', '## Conflicts (no winner picked)', '', '| Key | Reason | Sources | Locations |', '|---|---|---|---|');
  for (const conflict of result.conflicts.filter(isConflict)) push(`| ${conflict.target.key} | ${conflict.reasonCode} | ${conflict.sources.join(', ')} | ${where(conflict)} |`);
  push('', '## Variations by subject (not conflicts)', '', 'Different values for distinct named subjects (members, benefits, options). Stored as extracted_unverified with reason per_subject_values.', '',
    '| Key | Locations |', '|---|---|');
  for (const variation of result.conflicts.filter(entry => !isConflict(entry))) push(`| ${variation.target.key} | ${where(variation)} |`);
  push('', '## Gemini reasoning per item', '', 'Confidence and rationale are model notes for review only. They never change state.', '',
    '| Page | Chunk | Target | Value | Confidence | Rationale | Quote |', '|---|---|---|---|---|---|---|');
  for (const item of [...result.extraction.accepted, ...result.extraction.proposals].sort((a, b) => a.page - b.page || a.blockIndex - b.blockIndex)) {
    push(`| ${item.page} | ${item.chunkId} | ${item.parameterKey ?? `proposed: ${item.proposedKey}`} | ${shown(item.value)} | ${item.note?.confidence ?? ''} | ${cell(item.note?.rationale)} | ${cell(item.evidenceQuote)} |`);
  }
  push('', '## Every chunk', '', '| Chunk | Page | Outcome | Reason |', '|---|---|---|---|');
  for (const chunk of report.perChunk) push(`| ${chunk.id} | ${chunk.page} | ${chunk.outcome} | ${chunk.reason ?? ''} |`);
  return `${lines.join('\n')}\n`;
}

function readStored({ database, services }) {
  const records = services.coverageParameters.listForRun('run-local', { limit: 500 })
    .filter(record => record.resolutionState !== 'unknown')
    .map(record => ({
      key: record.parameterKey, state: record.resolutionState, reason: record.resolutionReasonCode,
      observations: database.prepare(`SELECT value_json, page FROM coverage_parameter_observations
        WHERE parameter_record_id = ? AND redacted_at IS NULL ORDER BY created_at, id`).all(record.id)
        .map(row => ({ value: JSON.parse(row.value_json), page: row.page })),
    }));
  const proposals = services.policyStructuring.listProposals({ householdId: 'household-local', documentId: 'document-local', limit: 500 });
  const counts = services.policyStructuring.getStructuringRun({ householdId: 'household-local', workflowRunId: 'run-local', documentId: 'document-local' })?.counts;
  return { records, proposals, counts };
}

async function main() {
  const pages = blockPages(await readJson('sarvam-raw.json'));
  const capture = localCapture(pages, await readJson('known-identifiers.json', null));
  const gated = gateChunks(sectionDocument(pages).chunks, { knownIdentifiers: capture.knownIdentifiers });
  if (!consent.has('gemini')) {
    const chars = gated.sent.reduce((sum, chunk) => sum + chunk.text.length, 0);
    return console.log(JSON.stringify({
      pages: pages.length, chunks: gated.sent.length + Object.keys(gated.skipped).length, knownNames: capture.knownIdentifiers.length,
      gatedSkipped: Object.keys(gated.skipped).length, sentChars: chars,
      estimatedCalls: Math.ceil(gated.sent.length / STRUCTURING_LIMITS.maxChunksPerCall) + 1,
    }));
  }
  const at = new Date().toISOString();
  const model = process.env.LLM_MODEL;
  const call = createGeminiCaller({ apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY, model, timeoutMs: 240_000 });
  const backend = flags.store !== undefined ? freshBackend(await readJson('normalized.json'), at) : null;
  // With --store the grant lives in the database and is re-checked before each call and inside the commit.
  const consentCheck = backend
    ? documentGrantCheck({ consents: backend.services.consents, grantId: 'consent-local', subjectAdultId: 'adult-local', documentId: 'document-local' })
    : () => { if (!consent.has('gemini')) throw Object.assign(new Error('Gemini grant missing.'), { code: 'CONSENT_REQUIRED' }); };
  const commit = backend ? async ({ decisions, proposals }) => backend.services.policyStructuring.commitStructuring({
    householdId: 'household-local', workflowRunId: 'run-local', documentId: 'document-local', sourceVersion: backend.sourceVersion,
    pipelineVersion: POLICY_STRUCTURING_VERSION, registryVersion: REGISTRY, recordedBy: 'policy-structuring', decisions, proposals, consentCheck,
  }) : null;
  const started = Date.now();
  const result = await structurePolicyDocument({
    pages, call, consentCheck, commit, knownIdentifiers: capture.knownIdentifiers, env: { ...process.env, POLICY_STRUCTURING_ENABLED: 'true' },
  });
  const elapsedMs = Date.now() - started;
  const golden = await readJson('golden-structuring.json', null);
  const score = golden ? scoreStructuring(golden, result) : null;
  await writeJson('structuring-items.json', { decisions: result.decisions, proposals: result.proposals, conflicts: result.conflicts, notes: result.extraction.accepted.map(item => ({ key: item.parameterKey, page: item.page, note: item.note })) });
  await writeJson('structuring-report.json', { generatedAt: at, model, elapsedMs, report: result.report, score });
  if (backend) {
    const stored = readStored(backend);
    await writeFile(resolve(OUT, 'structuring-review.md'), reviewMarkdown({ result, capture, gated, stored, score, meta: { at, model, elapsedMs, path: backend.path } }));
    backend.database.close();
  }
  const { chunks, items, conflicts, calls, usage } = result.report;
  console.log(JSON.stringify({ chunks, items: { accepted: items.accepted, proposals: items.proposals, rejected: items.rejected, rejectedReasons: items.rejectedReasons }, conflicts, calls, usage, stored: result.commit, score: score && { keyRecall: score.keyRecall, hallucinationRate: score.hallucinationRate, conflictRecall: score.conflictRecall } }));
}

main().catch(error => { console.error(`structure-policy failed: ${error.code ?? 'ERROR'}`); process.exit(1); });

// DPDP field-to-purpose registry rules R1 to R11 (docs/architecture/dpdp-purpose-registry.md). Everything legal in the
// registry is a draft FOR LEGAL REVIEW. The registry is checked here by tests only; no runtime code reads it in v1.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { QUESTION_CONSENT_SCOPE } from '../src/contracts/policy-evidence.js';
import {
  CONSENT_PURPOSES, DATA_PURPOSE_REGISTRY, DATA_PURPOSE_REGISTRY_VERSION, LEGAL_REVIEW, purposeEntry,
} from '../src/contracts/data-purpose-registry.js';
import { MODEL_INPUT_FIELDS } from '../src/features/ai-analysis/model-input-fields.js';
import { sealModelInput, sealedInputCounts } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { documentGrantCheck } from '../src/features/policy-structuring/index.js';
import { validDraft } from './support/privacy-corpus.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const MIGRATIONS = 'src/backend/database/postgres/migrations/';

// Personal-data fields with no erasure function in the code base today. The list may only shrink; each entry is a finding
// reported to the owner, not an erasure function invented here.
const KNOWN_ERASURE_GAPS = Object.freeze(['db:adult_users.phone_ciphertext']);

function ciphertextColumns() {
  const found = new Set();
  for (const file of readdirSync(new URL(MIGRATIONS, root)).filter(name => name.endsWith('.sql'))) {
    let table = null;
    for (const line of read(`${MIGRATIONS}${file}`).split('\n')) {
      table = line.match(/CREATE TABLE(?: IF NOT EXISTS)?\s+(?:public\.)?(\w+)/i)?.[1] ?? line.match(/ALTER TABLE(?: IF EXISTS)?\s+(?:ONLY\s+)?(?:public\.)?(\w+)/i)?.[1] ?? table;
      for (const column of line.matchAll(/\b(\w*_ciphertext)\b/g)) {
        if (/ADD COLUMN|^\s+\w+_ciphertext\s+text/i.test(line)) found.add(`${table}.${column[1]}`);
      }
    }
  }
  return [...found];
}

function gatedSlotPaths() {
  const out = [];
  const walk = (spec, path, task) => {
    if (spec.type === 'gated' || spec.type === 'gated?') out.push(`model:${task}.${path}`);
    else if (spec.type === 'array') walk(spec.of, `${path}[]`, task);
    else if (spec.type === 'object') for (const [key, child] of Object.entries(spec.fields)) walk(child, path ? `${path}.${key}` : key, task);
  };
  for (const [task, spec] of Object.entries(MODEL_INPUT_FIELDS)) walk(spec, '', task);
  return out;
}

test('registry is a frozen, versioned, legal-review-only draft', () => {
  assert.equal(DATA_PURPOSE_REGISTRY_VERSION, 'data-purpose/v1-draft');
  assert.equal(LEGAL_REVIEW, 'required');
  assert.ok(Object.isFrozen(DATA_PURPOSE_REGISTRY) && DATA_PURPOSE_REGISTRY.every(Object.isFrozen));
  assert.equal(new Set(DATA_PURPOSE_REGISTRY.map(item => item.field)).size, DATA_PURPOSE_REGISTRY.length, 'fields are unique');
  assert.throws(() => purposeEntry('db:not_a_table.not_a_column'), { code: 'PURPOSE_FIELD_UNKNOWN' });
  assert.equal(purposeEntry('db:profile_answers.value_ciphertext').sealed, true);
});

test('R1: consent purposes equal the consent_grants.purpose CHECK list', () => {
  const sql = read(`${MIGRATIONS}001_baseline_schema.sql`);
  const block = sql.match(/CREATE TABLE consent_grants[\s\S]*?purpose text NOT NULL CHECK \(purpose IN \(([\s\S]*?)\)\)/)[1];
  const parsed = [...block.matchAll(/'([a-z_]+)'/g)].map(match => match[1]);
  assert.deepEqual([...new Set(parsed)].sort(), [...CONSENT_PURPOSES].sort());
});

test('R2: every *_ciphertext column of the migrations is registered as sealed', () => {
  const columns = ciphertextColumns();
  assert.ok(columns.length >= 7, `found ${columns.length}`);
  for (const column of columns) assert.equal(purposeEntry(`db:${column}`).sealed, true, column);
  const registered = DATA_PURPOSE_REGISTRY.filter(item => /^db:\w+\.\w+_ciphertext$/.test(item.field)).map(item => item.field.slice(3));
  assert.deepEqual(registered.sort(), columns.sort(), 'no registered ciphertext column is missing from the migrations');
});

test('R3: model-eligible entries are exactly the gated slots of MODEL_INPUT_FIELDS', () => {
  const slots = gatedSlotPaths();
  assert.ok(slots.length >= 25);
  for (const slot of slots) {
    const item = purposeEntry(slot);
    assert.equal(item.modelEligible, true, slot);
    assert.ok(item.recipients.includes('google-gemini'), slot);
  }
  const eligible = DATA_PURPOSE_REGISTRY.filter(item => item.modelEligible).map(item => item.field);
  assert.deepEqual(eligible.sort(), [...slots].sort());
});

test('R4: personal entries name at least one real consent purpose', () => {
  for (const item of DATA_PURPOSE_REGISTRY.filter(candidate => candidate.personal)) {
    assert.ok(item.purposes.length > 0, item.field);
    for (const purpose of item.purposes) assert.ok(CONSENT_PURPOSES.includes(purpose), `${item.field}: ${purpose}`);
  }
});

test('R5: every named erasure path is exported and exercised by a test that names it', async () => {
  for (const item of DATA_PURPOSE_REGISTRY.filter(candidate => candidate.erasure)) {
    const { module, fn, test: testFile } = item.erasure;
    const exported = await import(new URL(module, root).href);
    const [owner, method] = fn.includes('.') ? fn.split('.') : [fn, null];
    assert.equal(typeof exported[owner], 'function', `${item.field}: ${module} does not export ${owner}`);
    if (method) assert.equal(typeof exported[owner].prototype[method], 'function', `${item.field}: ${owner} has no ${method}`);
    assert.ok(existsSync(new URL(testFile, root)), `${item.field}: ${testFile} is missing`);
    assert.ok(read(testFile).includes(method ?? owner), `${item.field}: ${testFile} never mentions ${method ?? owner}`);
  }
});

test('R6: personal stored fields have an erasure path or are listed as a known gap that only shrinks', () => {
  const missing = DATA_PURPOSE_REGISTRY.filter(item => item.personal && item.field.startsWith('db:') && item.erasure === null).map(item => item.field);
  assert.deepEqual(missing.sort(), [...KNOWN_ERASURE_GAPS].sort());
  assert.ok(KNOWN_ERASURE_GAPS.length <= 1, 'the erasure gap list may not grow');
});

test('R7: every entry requires legal review and nothing in the file claims finality', () => {
  for (const item of DATA_PURPOSE_REGISTRY) assert.equal(item.legalReview, 'required', item.field);
  assert.equal(/\bfinal\b/i.test(read('src/contracts/data-purpose-registry.js')), false);
});

test('R8: the consent scopes in code equal the registry', async () => {
  const seen = [];
  const consents = {
    requireActive: async (_grant, request) => { seen.push(request); },
    get: async () => ({ household_id: 'h', scopes: [] }),
  };
  await documentGrantCheck({ consents, grantId: 'g', subjectAdultId: 'a', documentId: 'd', householdId: 'h' })().catch(() => {});
  const { resourceType, action, dataCategory, recipient } = seen[0];
  const structuring = purposeEntry('model:policy_structuring_extract.payload.chunks[].text').consentScope;
  assert.deepEqual(structuring, { resourceType, action, dataCategory, recipient });
  for (const field of ['model:policy_structuring_reconcile.payload.groups[].subject', 'model:policy_evidence_investigate.payload.clauses[].text']) {
    assert.deepEqual(purposeEntry(field).consentScope, structuring, field);
  }
  const { resourceType: qt, action: qa, dataCategory: qc, recipient: qr } = QUESTION_CONSENT_SCOPE;
  assert.deepEqual(purposeEntry('model:policy_evidence_investigate.payload.questions[].text').consentScope, { resourceType: qt, action: qa, dataCategory: qc, recipient: qr });
  assert.match(read('src/integrations/sarvam/ocr-provider.js'), /recipient !== 'sarvam'/);
  assert.equal(purposeEntry('db:document_blobs.*').consentScope.recipient, 'sarvam');
});

test('R9: every counts-only event key the gateway emits is registered as non-personal telemetry', () => {
  const keys = Object.keys(sealedInputCounts(sealModelInput('policy_structuring_extract', validDraft('policy_structuring_extract'))));
  for (const key of keys) {
    const item = purposeEntry(`event:provider_call.${key}`);
    assert.equal(item.personal, false, key);
    assert.equal(item.category, 'telemetry', key);
  }
});

test('R10: fields that can carry member-table content are flagged for children\'s data', () => {
  for (const item of DATA_PURPOSE_REGISTRY.filter(candidate => candidate.field.startsWith('model:') || ['db:source_pages.blocks_json', 'db:policy_clauses.text', 'db:document_blobs.*'].includes(candidate.field))) {
    assert.equal(item.childData, 'possible', item.field);
  }
});

test('R11: provider recipients imply a possible cross-border flag', () => {
  for (const item of DATA_PURPOSE_REGISTRY.filter(candidate => candidate.recipients.some(recipient => recipient === 'google-gemini' || recipient === 'sarvam'))) {
    assert.equal(item.crossBorder, 'possible', item.field);
  }
});

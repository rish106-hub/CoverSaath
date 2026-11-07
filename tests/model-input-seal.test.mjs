// ADR 0017 D2 / WP2: the model-input allow-list and the seal. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { AI_TASKS } from '../src/features/ai-analysis/responsibility-matrix.js';
import { registryCatalog } from '../src/features/policy-structuring/extractor.js';
import { POLICY_PARAMETER_REGISTRY_VERSION } from '../src/features/coverage-analysis/policy-parameter-registry.js';
import { MODEL_INPUT_FIELDS } from '../src/features/ai-analysis/model-input-fields.js';
import {
  MODEL_INPUT_MAX_BYTES, gateText, isGatedText, isSealedModelInput, sanitizeEvidenceForModel, sealModelInput, sealedInputCounts,
} from '../src/features/ai-analysis/privacy-evidence-gate.js';
import {
  STRUCTURING_DRAFT_TASKS, cloneDraft, containerPaths, gated, gatedPaths, pathText, setAt, validDraft,
} from './support/privacy-corpus.mjs';

const RAW_MARKER = 'Synthetic Raw Marker 4417';
const notAllowed = { code: 'MODEL_INPUT_NOT_ALLOWED', statusCode: 500 };
const resolveParameterPolicy = () => ({ modelExtraction: true, dataClass: 'INTERNAL' });
const COVERAGE_TASKS = AI_TASKS.filter(task => !STRUCTURING_DRAFT_TASKS.includes(task));

function coverageSealed(task) {
  return sanitizeEvidenceForModel({
    context: { caseId: 'case-1', subjectId: 'adult-1', purpose: 'Extract requested cover facts.', requestedFields: ['room_rent_limit'] },
    sources: [{ id: 'policy:v1:p3', version: 'v1', page: 3, text: 'Room rent applicability is unresolved.', status: 'unknown' }],
    upstream: [],
  }, { task, resolveParameterPolicy, knownIdentifiers: [] }).input;
}

test('the allow-list covers every model task', () => {
  assert.deepEqual(Object.keys(MODEL_INPUT_FIELDS).sort(), [...AI_TASKS].sort());
});

for (const task of STRUCTURING_DRAFT_TASKS) {
  test(`${task}: a valid draft seals into a frozen, task-bound input`, () => {
    const sealed = sealModelInput(task, validDraft(task));
    assert.equal(isSealedModelInput(sealed, task), true);
    for (const other of AI_TASKS.filter(candidate => candidate !== task)) assert.equal(isSealedModelInput(sealed, other), false);
    const frozen = value => value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(frozen));
    assert.equal(frozen(sealed), true);
    // Gated slots are emitted as plain strings.
    const json = JSON.stringify(sealed);
    assert.equal(json.includes('gateVersion'), false);
    assert.equal(isSealedModelInput(structuredClone(sealed), task), false);
    assert.equal(isSealedModelInput({ ...sealed }, task), false);
  });

  test(`${task}: a raw string in any gated slot is refused without echoing it`, () => {
    const draft = validDraft(task);
    const paths = gatedPaths(draft, isGatedText);
    assert.ok(paths.length >= 2);
    for (const path of paths) {
      const broken = setAt(draft, path, RAW_MARKER);
      assert.throws(() => sealModelInput(task, broken), error => {
        assert.equal(error.code, 'MODEL_INPUT_NOT_ALLOWED');
        assert.equal(error.statusCode, 500);
        assert.ok(error.message.includes(pathText(path)), `message names ${pathText(path)}: ${error.message}`);
        assert.equal(error.message.includes(RAW_MARKER), false);
        assert.equal(JSON.stringify(error).includes(RAW_MARKER), false);
        return true;
      });
      // A forged object is no better than a string.
      assert.throws(() => sealModelInput(task, setAt(draft, path, { text: RAW_MARKER, gateVersion: 'knowvia-privacy-evidence-v9' })), notAllowed);
    }
  });

  test(`${task}: structural defects are refused`, () => {
    const draft = validDraft(task);
    const { objects, arrays } = containerPaths(draft, isGatedText);
    for (const path of objects) {
      const withExtra = cloneDraft(draft);
      let target = withExtra;
      for (const key of path) target = target[key];
      target.extraSlot = RAW_MARKER;
      assert.throws(() => sealModelInput(task, withExtra), error => {
        assert.equal(error.code, 'MODEL_INPUT_NOT_ALLOWED');
        assert.equal(error.message.includes('extraSlot'), false);
        assert.equal(error.message.includes(RAW_MARKER), false);
        return true;
      });
      const withSymbol = cloneDraft(draft);
      target = withSymbol;
      for (const key of path) target = target[key];
      target[Symbol('shadow')] = 1;
      assert.throws(() => sealModelInput(task, withSymbol), notAllowed);
      const withProto = cloneDraft(draft);
      target = withProto;
      for (const key of path) target = target[key];
      Object.defineProperty(target, '__proto__', { value: { polluted: true }, enumerable: true, configurable: true, writable: true });
      assert.throws(() => sealModelInput(task, withProto), notAllowed);
      const withAccessor = cloneDraft(draft);
      target = withAccessor;
      for (const key of path) target = target[key];
      const [firstKey] = Object.keys(target);
      const original = target[firstKey];
      delete target[firstKey];
      Object.defineProperty(target, firstKey, { get: () => original, enumerable: true, configurable: true });
      assert.throws(() => sealModelInput(task, withAccessor), notAllowed);
      const withMissing = cloneDraft(draft);
      target = withMissing;
      for (const key of path) target = target[key];
      delete target[firstKey];
      assert.throws(() => sealModelInput(task, withMissing), notAllowed);
      const proxied = cloneDraft(draft);
      target = proxied;
      for (const key of path.slice(0, -1)) target = target[key];
      if (path.length) {
        target[path.at(-1)] = new Proxy(target[path.at(-1)], {});
        assert.throws(() => sealModelInput(task, proxied), notAllowed);
      } else assert.throws(() => sealModelInput(task, new Proxy(draft, {})), notAllowed);
      class Shaped { constructor(fields) { Object.assign(this, fields); } }
      const classy = cloneDraft(draft);
      target = classy;
      for (const key of path.slice(0, -1)) target = target[key];
      if (path.length) {
        target[path.at(-1)] = new Shaped(target[path.at(-1)]);
        assert.throws(() => sealModelInput(task, classy), notAllowed);
      } else assert.throws(() => sealModelInput(task, new Shaped(draft)), notAllowed);
    }
    for (const path of arrays) {
      const overlong = cloneDraft(draft);
      let target = overlong;
      for (const key of path) target = target[key];
      const sample = target[0];
      while (target.length <= 600) target.push(sample);
      assert.throws(() => sealModelInput(task, overlong), notAllowed);
      const emptied = cloneDraft(draft);
      target = emptied;
      for (const key of path) target = target[key];
      target.length = 0;
      // Only the registry list may be empty; every other list needs at least one entry.
      if (path.at(-1) === 'registry') assert.doesNotThrow(() => sealModelInput(task, emptied));
      else assert.throws(() => sealModelInput(task, emptied), notAllowed);
      const sparse = cloneDraft(draft);
      target = sparse;
      for (const key of path) target = target[key];
      target.foreign = 1;
      assert.throws(() => sealModelInput(task, sparse), notAllowed);
    }
  });

  test(`${task}: a cycle, an unknown enum, a bad id and an out-of-range number are refused`, () => {
    const draft = validDraft(task);
    const cyclic = cloneDraft(draft);
    cyclic.payload.self = cyclic;
    assert.throws(() => sealModelInput(task, cyclic), notAllowed);
    const root = cloneDraft(draft);
    root.payload = root;
    assert.throws(() => sealModelInput(task, root), notAllowed);
    // Walk the draft for one scalar of each kind.
    const scalars = [];
    const walk = (value, path) => {
      if (isGatedText(value)) return;
      if (value && typeof value === 'object') { for (const [key, child] of Object.entries(value)) walk(child, [...path, key]); return; }
      scalars.push([path, value]);
    };
    walk(draft, []);
    assert.ok(scalars.length > 0);
    for (const [path, value] of scalars) {
      const wrong = typeof value === 'number' ? 10_000_000_000 : 'not a valid value!';
      assert.throws(() => sealModelInput(task, setAt(draft, path, wrong)), notAllowed, pathText(path));
    }
  });

  test(`${task}: mutating the draft or its source after sealing changes nothing`, () => {
    const draft = validDraft(task);
    const before = JSON.stringify(sealModelInput(task, draft));
    const sealed = sealModelInput(task, draft);
    const paths = gatedPaths(draft, isGatedText);
    let cursor = draft;
    for (const key of paths[0].slice(0, -1)) cursor = cursor[key];
    cursor[paths[0].at(-1)] = RAW_MARKER;
    draft.payload.added = 1;
    assert.equal(JSON.stringify(sealed), before);
    assert.equal(JSON.stringify(sealed).includes(RAW_MARKER), false);
    assert.throws(() => { sealed.payload.added = 1; }, TypeError);
  });

  test(`${task}: counts hold gate version and numbers only`, () => {
    const sealed = sealModelInput(task, validDraft(task));
    const counts = sealedInputCounts(sealed);
    assert.deepEqual(Object.keys(counts).sort(), ['gateVersion', 'gatedBytes', 'gatedSlots', 'placeholders', 'reasonCodes']);
    for (const [key, value] of Object.entries(counts)) {
      if (key === 'gateVersion') assert.match(value, /^[A-Za-z0-9_.:-]{1,64}$/);
      else assert.ok(Number.isInteger(value) && value >= 0, key);
      assert.equal(/<[A-Z_]+_\d+>/.test(String(value)), false);
      assert.equal(/^[A-Z_]{6,}$/.test(String(value)), false);
    }
    assert.ok(counts.gatedSlots >= 2);
    assert.ok(counts.gatedBytes > 0);
    assert.throws(() => sealedInputCounts({ payload: {} }), notAllowed);
  });
}

test('placeholder and reason counts add up across slots', () => {
  const draft = validDraft('policy_structuring_extract');
  draft.payload.chunks[0].text = gateText('Insured name: Ravi Synthetic. Call +91 98765 43210.', { knownIdentifiers: [] });
  const counts = sealedInputCounts(sealModelInput('policy_structuring_extract', draft));
  assert.ok(counts.placeholders >= 2);
  assert.ok(counts.reasonCodes >= 1);
});

test('static slots: every registry label the extractor sends is accepted, a label the gate would change is not', () => {
  const draft = validDraft('policy_structuring_extract');
  draft.payload.registry = registryCatalog(POLICY_PARAMETER_REGISTRY_VERSION).slice(0, 500);
  assert.ok(draft.payload.registry.length > 20);
  assert.doesNotThrow(() => sealModelInput('policy_structuring_extract', draft));
  for (const label of ['Mr. Ravi Synthetic', 'Call 98765 43210 now', 'Phone: 98765 43210', 'Label <NAME_1>', 'x'.repeat(130)]) {
    const broken = cloneDraft(draft);
    broken.payload.registry = [{ key: 'room_rent_limit', label, valueType: 'money' }];
    assert.throws(() => sealModelInput('policy_structuring_extract', broken), notAllowed, label);
  }
});

test('an input over the serialised ceiling is refused although every slot is valid', () => {
  const draft = validDraft('policy_structuring_extract');
  const big = gated('Waiting period of 24 months applies to this benefit. '.repeat(280), { maxBytes: 16_000 });
  assert.ok(big.outputBytes > 12_000);
  draft.payload.chunks = Array.from({ length: 7 }, (_, index) => ({ ...draft.payload.chunks[0], chunk_id: `p${index + 1}-b0`, page: index + 1, text: big }));
  assert.throws(() => sealModelInput('policy_structuring_extract', draft), error => error.code === 'MODEL_INPUT_NOT_ALLOWED' && /serialised size/.test(error.message));
  draft.payload.chunks = draft.payload.chunks.slice(0, 4);
  assert.doesNotThrow(() => sealModelInput('policy_structuring_extract', draft));
  assert.equal(MODEL_INPUT_MAX_BYTES, 96_000);
});

test('a title is optional but a raw title is not', () => {
  const draft = validDraft('policy_structuring_extract');
  draft.payload.chunks[0].title = null;
  assert.doesNotThrow(() => sealModelInput('policy_structuring_extract', draft));
  draft.payload.chunks[0].title = 'Raw Title 4417';
  assert.throws(() => sealModelInput('policy_structuring_extract', draft), notAllowed);
});

test('an unknown task and a prototype-named task are refused', () => {
  for (const task of ['unknown_task', '__proto__', 'constructor', 'toString', 7, null]) {
    assert.throws(() => sealModelInput(task, validDraft('policy_structuring_extract')), notAllowed);
  }
});

for (const task of COVERAGE_TASKS) {
  test(`${task}: sanitizeEvidenceForModel returns an input sealed for this task only`, () => {
    const input = coverageSealed(task);
    assert.equal(isSealedModelInput(input, task), true);
    for (const other of AI_TASKS.filter(candidate => candidate !== task)) assert.equal(isSealedModelInput(input, other), false);
    assert.equal(Object.isFrozen(input), true);
    assert.equal(input.sources[0].text, 'Room rent applicability is unresolved.');
    assert.match(input.sources[0].id, /^source_[0-9a-f]{24}$/);
    assert.equal(sealedInputCounts(input).gatedSlots, 3);
  });

  test(`${task}: a hand-built coverage draft cannot be sealed, even with gated text`, () => {
    const draft = {
      context: { caseId: 'case_0123456789abcdef01234567', subjectId: 'subject_0123456789abcdef01234567', purpose: gated('Extract requested cover facts.'), requestedFields: ['room_rent_limit'] },
      sources: [{ id: 'source_0123456789abcdef01234567', version: gated('v1'), page: 3, text: gated('Room rent applicability is unresolved.'), status: 'unknown' }],
      upstream: [],
    };
    assert.throws(() => sealModelInput(task, draft), error => error.code === 'MODEL_INPUT_NOT_ALLOWED' && error.message.includes('input.upstream'));
    assert.throws(() => sealModelInput(task, { ...draft, upstream: [{ text: RAW_MARKER }] }), notAllowed);
    const rawText = { ...draft, sources: [{ ...draft.sources[0], text: RAW_MARKER }] };
    assert.throws(() => sealModelInput(task, rawText), error => error.message.includes('input.sources[0].text') && !error.message.includes(RAW_MARKER));
  });
}

test('sanitizeEvidenceForModel keeps a plain clone for a task name that has no allow-list', () => {
  const input = sanitizeEvidenceForModel({
    context: { caseId: 'case-1', subjectId: 'adult-1', purpose: 'Extract requested cover facts.', requestedFields: [] },
    sources: [{ id: 'a', version: 'v1', page: null, text: 'Room rent applicability is unresolved.', status: 'known' }],
    upstream: [],
  }, { task: 'model_task', knownIdentifiers: [] }).input;
  for (const task of AI_TASKS) assert.equal(isSealedModelInput(input, task), false);
});

test('review P2-2: registry slots accept only the registry\'s own keys and labels, whatever the gate would say', () => {
  const draft = validDraft('policy_structuring_extract');
  const catalog = registryCatalog(POLICY_PARAMETER_REGISTRY_VERSION);
  for (const registry of [
    [{ key: 'room_rent_limit', label: 'Ravi Synthetic', valueType: 'money' }],
    [{ key: catalog[0].key, label: `${catalog[0].label} extra`, valueType: catalog[0].valueType }],
    [{ key: 'ravi_synthetic_key', label: catalog[0].label, valueType: catalog[0].valueType }],
    [{ key: catalog[0].key, label: catalog[1].label, valueType: catalog[0].valueType }],
  ]) {
    const broken = cloneDraft(draft);
    broken.payload.registry = registry;
    assert.throws(() => sealModelInput('policy_structuring_extract', broken), notAllowed);
  }
  const fine = cloneDraft(draft);
  fine.payload.registry = catalog.map(({ key, label, valueType }) => ({ key, label, valueType }));
  assert.doesNotThrow(() => sealModelInput('policy_structuring_extract', fine));
});

test('review P2-2: group and finding ids have a strict shape', () => {
  const reconcileDraft = validDraft('policy_structuring_reconcile');
  for (const groupId of ['registry:room_rent_limit|policy', 'g0', 'g01', 'ravi', 'g1 ', 'G1']) {
    const broken = cloneDraft(reconcileDraft);
    broken.payload.groups[0].group_id = groupId;
    assert.throws(() => sealModelInput('policy_structuring_reconcile', broken), notAllowed, groupId);
  }
  const sweepDraft = validDraft('policy_evidence_override_sweep');
  for (const findingId of ['9876543210', 'ravi', 'f0', 'f1x', 'finding_1']) {
    const broken = cloneDraft(sweepDraft);
    broken.payload.findings[0].finding_id = findingId;
    assert.throws(() => sealModelInput('policy_evidence_override_sweep', broken), notAllowed, findingId);
  }
});

test('policy_structuring_extract: a registry entry the registry forbids a model to extract is refused by the seal', () => {
  const draft = validDraft('policy_structuring_extract');
  for (const entry of [
    { key: 'a.contract_and_member_identifiers', label: 'Policy, certificate, member and e-card numbers', valueType: 'identifier' },
    { key: 'c.named_insured_members', label: 'Named insured members', valueType: 'list' },
  ]) {
    const forbidden = cloneDraft(draft);
    forbidden.payload.registry = [entry];
    assert.throws(() => sealModelInput('policy_structuring_extract', forbidden), notAllowed, entry.key);
  }
  const allowedCatalog = cloneDraft(draft);
  allowedCatalog.payload.registry = [...registryCatalog(POLICY_PARAMETER_REGISTRY_VERSION)];
  assert.doesNotThrow(() => sealModelInput('policy_structuring_extract', allowedCatalog), 'the catalog the extractor sends is accepted');
});

test('the investigation checklist vocabulary stays inside the clause kinds', async () => {
  const { CLAUSE_KINDS } = await import('../src/contracts/policy-evidence.js');
  const { INVESTIGATION_BASE_KINDS, INVESTIGATION_CHECKLIST_KINDS } = await import('../src/features/ai-analysis/structuring-contract.js');
  assert.deepEqual([...INVESTIGATION_BASE_KINDS, 'procedure', 'other'].sort(), [...CLAUSE_KINDS].sort(), 'a new clause kind must be added to the checklist allow-list on purpose');
  for (const kind of INVESTIGATION_CHECKLIST_KINDS) assert.ok(CLAUSE_KINDS.includes(kind), kind);
});

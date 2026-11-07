// ADR 0017 D1 to D4 / WP4: every builder that feeds a model produces a sealed input, re-gates model-written strings, and
// the real structuring call factory refuses anything unsealed before consent or money. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createStructuringModelCallFactory } from '../src/features/ai-analysis/index.js';
import { isGatedText, isSealedModelInput, opaqueClauseId, opaqueDocumentId, sealedInputCounts } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { POLICY_PARAMETER_REGISTRY_VERSION as registryVersion } from '../src/features/coverage-analysis/policy-parameter-registry.js';
import { gateChunks, extractChunks, reconcile, sectionDocument } from '../src/features/policy-structuring/index.js';
import { buildClauses, investigate } from '../src/features/policy-evidence/index.js';

const NAME = 'Ravi Synthetic';
const KNOWN = [{ kind: 'NAME', value: NAME }];

test('gateChunks: text equals the branded text, a refused title is dropped and never sent', () => {
  const chunks = [
    { id: 'p1-b0', page: 1, blockIndexes: [0], kind: 'text', title: 'Benefits', text: 'Sum insured: 500000. Waiting period of 24 months.' },
    { id: 'p2-b0', page: 2, blockIndexes: [0], kind: 'text', title: 'api_key=synthetic0123456789abcdef', text: 'Room rent is limited to 1% of the sum insured.' },
    { id: 'p3-b0', page: 3, blockIndexes: [0], kind: 'text', title: null, text: 'api_key=synthetic0123456789abcdef' },
    { id: 'p4-b0', page: 4, blockIndexes: [0], kind: 'text', title: null, text: `Insured name: ${NAME}. Call +91 98765 43210.` },
  ];
  const { sent, skipped } = gateChunks(chunks, { knownIdentifiers: KNOWN });
  assert.deepEqual(Object.keys(skipped), ['p3-b0']);
  assert.equal(skipped['p3-b0'], 'privacy_gate_refused');
  assert.equal(sent.length, 3);
  for (const chunk of sent) {
    assert.equal(isGatedText(chunk.gated), true);
    assert.equal(chunk.text, chunk.gated.text);
    assert.equal(chunk.title, chunk.gatedTitle?.text ?? null);
  }
  const refusedTitle = sent.find(chunk => chunk.id === 'p2-b0');
  assert.equal(refusedTitle.gatedTitle, null);
  assert.equal(refusedTitle.title, null);
  assert.equal(JSON.stringify(sent).includes('synthetic0123456789abcdef'), false);
  assert.equal(sent.find(chunk => chunk.id === 'p4-b0').text.includes('Ravi'), false);
});

test('gateChunks: text that would be cut is skipped as privacy_truncated, not sent short', () => {
  const long = 'Waiting period of 24 months applies to this benefit. '.repeat(400);
  const { sent, skipped } = gateChunks([{ id: 'p1-b0', page: 1, blockIndexes: [0], kind: 'text', title: null, text: long }], { knownIdentifiers: [] });
  assert.equal(sent.length, 0);
  assert.equal(skipped['p1-b0'], 'privacy_truncated');
});

test('extract: the provider call receives a sealed input whose chunk text is the gated text', async () => {
  const sectioned = sectionDocument([{ page: 1, blocks: [{ tag: 'section-title', text: 'Benefits' }, { tag: 'paragraph', text: `Insured name: ${NAME}.` }, { tag: 'paragraph', text: 'Sum insured: 500000.' }] }]);
  const gated = gateChunks(sectioned.chunks, { knownIdentifiers: KNOWN });
  const inputs = [];
  const call = async request => { inputs.push(request); return { json: { items: [] }, usage: { inputTokens: 1, outputTokens: 1 } }; };
  await extractChunks({ chunks: gated.sent, registryVersion, call, consentCheck: () => {} });
  assert.equal(inputs.length, 1);
  const [{ input, task, payload }] = inputs;
  assert.equal(payload, undefined, 'the call no longer carries a loose payload');
  assert.equal(isSealedModelInput(input, task), true);
  assert.equal(task, 'policy_structuring_extract');
  assert.deepEqual(input.payload.chunks.map(chunk => chunk.text), gated.sent.map(chunk => chunk.text));
  assert.equal(JSON.stringify(input).includes('Ravi'), false);
  assert.ok(sealedInputCounts(input).gatedSlots >= 2);
});

test('extract: a chunk that skipped the gate cannot reach the provider (the seal throws, nothing is called)', async () => {
  let called = 0;
  const raw = { id: 'p1-b0', page: 1, blockIndexes: [0], kind: 'text', title: null, text: `Insured name: ${NAME}` };
  await assert.rejects(extractChunks({ chunks: [raw], registryVersion, call: async () => { called += 1; }, consentCheck: () => {} }), { code: 'MODEL_INPUT_NOT_ALLOWED', statusCode: 500 });
  assert.equal(called, 0);
  const forged = { ...raw, gated: { text: raw.text }, gatedTitle: null };
  await assert.rejects(extractChunks({ chunks: [forged], registryVersion, call: async () => { called += 1; }, consentCheck: () => {} }), { code: 'MODEL_INPUT_NOT_ALLOWED' });
  assert.equal(called, 0);
});

const reading = (key, text, quote, page, chunkId) => ({ kind: 'registry', parameterKey: key, value: { text, normalized: null, subject: 'policy' }, evidenceQuote: quote, page, blockIndex: 0, chunkId, subjectInSource: false });

test('reconcile: model-written values are gated again; a reading the gate refuses is dropped and counted', async () => {
  const accepted = [
    reading('d.co_pay_general', 'call 98765 43210', 'Co-pay of 20% applies.', 3, 'p3-b0'),
    reading('d.co_pay_general', '10%', 'Co-pay of 10% applies.', 4, 'p4-b0'),
    reading('d.co_pay_general', '25%', 'Co-pay of 25% applies.', 5, 'p5-b0'),
    reading('d.co_pay_general', 'api_key=synthetic0123456789abcdef', 'Co-pay of 30% applies.', 6, 'p6-b0'),
  ];
  const inputs = [];
  const call = async request => { inputs.push(request); return { json: { conflicts: [] }, usage: { inputTokens: 1, outputTokens: 1 } }; };
  const result = await reconcile({ accepted, call, consentCheck: () => {}, knownIdentifiers: [] });
  assert.equal(inputs.length, 1);
  assert.equal(isSealedModelInput(inputs[0].input, 'policy_structuring_reconcile'), true);
  const sent = JSON.stringify(inputs[0].input);
  assert.equal(sent.includes('98765'), false, 'a phone inside a model-written value never reaches the provider');
  assert.match(sent, /<PHONE_\d+>/);
  assert.equal(sent.includes('synthetic0123456789abcdef'), false);
  assert.equal(result.skipped.filter(entry => entry.reason === 'privacy_gate_refused').length, 1);
});

test('reconcile: the known identifiers list is required, and a group with fewer than two readings is not sent', async () => {
  const accepted = [reading('d.co_pay_general', '10%', 'Co-pay of 10% applies.', 4, 'p4-b0'), reading('d.co_pay_general', '20%', 'Co-pay of 20% applies.', 5, 'p5-b0')];
  await assert.rejects(reconcile({ accepted, call: async () => ({}), consentCheck: () => {} }), { code: 'STRUCTURING_INPUT_INVALID' });
  const refusedHalf = [reading('d.co_pay_general', '10%', 'Co-pay of 10% applies.', 4, 'p4-b0'), reading('d.co_pay_general', 'password: synthetic12345', 'Co-pay of 20% applies.', 5, 'p5-b0')];
  let called = 0;
  const result = await reconcile({ accepted: refusedHalf, call: async () => { called += 1; return { json: { conflicts: [] } }; }, consentCheck: () => {}, knownIdentifiers: [] });
  assert.equal(called, 0);
  assert.equal(result.skipped.some(entry => entry.reason === 'privacy_gate_refused'), true);
});

const stored = { pages: [
  { page: 1, status: 'stored', blocks: [{ tag: 'section-title', text: 'Eye Benefits' }, { tag: 'paragraph', text: 'We will pay for cataract surgery as a hospitalisation benefit.' }] },
  { page: 2, status: 'stored', blocks: [{ tag: 'section-title', text: 'Sub-limits' }, { tag: 'paragraph', text: 'Cataract surgery is capped at Rs. 40,000 per eye.' }] },
] };
const clauses = buildClauses(stored, { documentId: 'doc-record-1', sourceVersion: 'v1' }).clauses;
const QUESTION = 'Is cataract surgery covered?';
const metadata = { calls: [] };

test('investigate: clause and document ids reach the provider only as opaque aliases; citations map back', async () => {
  const seen = [];
  const call = Object.assign(async request => {
    seen.push(request);
    const [first] = request.input.payload.clauses;
    if (request.task === 'policy_evidence_investigate') {
      return { json: { findings: [
        { clause_ids: [first.clause_id], quote: 'cataract surgery', subject: `${NAME} cataract`, conditions: [], exceptions: [] },
        { clause_ids: ['clause_ffffffffffffffffffffffff'], quote: 'cataract surgery', subject: 'invented alias', conditions: [], exceptions: [] },
        { clause_ids: [clauses[0].clauseId], quote: 'hospitalisation benefit', subject: 'raw stored id', conditions: [], exceptions: [] },
      ] }, usage: {} };
    }
    return { json: { overrides: [] }, usage: {} };
  }, { maxInputBytes: 64_000 });
  const { answer } = await investigate({ question: QUESTION, clauses, call, consentCheck: async () => {}, knownIdentifiers: KNOWN });
  assert.equal(seen.length, 2);
  for (const request of seen) {
    assert.equal(isSealedModelInput(request.input, request.task), true);
    const wire = JSON.stringify(request.input);
    for (const clause of clauses) {
      assert.equal(wire.includes(clause.clauseId), false, 'a stored clause id reached the provider');
      assert.equal(wire.includes(clause.documentId), false, 'a stored document id reached the provider');
    }
    for (const clause of request.input.payload.clauses) {
      assert.match(clause.clause_id, /^clause_[0-9a-f]{24}$/);
      assert.match(clause.document_id, /^doc_[0-9a-f]{24}$/);
    }
  }
  assert.equal(seen[0].input.payload.clauses[0].clause_id, opaqueClauseId(clauses[0].clauseId));
  assert.equal(seen[0].input.payload.clauses[0].document_id, opaqueDocumentId(clauses[0].documentId));
  // The citation maps back to the stored clause; the invented alias is rejected.
  assert.deepEqual(answer.sources.map(source => source.clauseId), [clauses[0].clauseId]);
  // A made-up alias and a raw stored id both name no clause the provider was shown, so both findings are dropped.
  assert.ok(answer.unknowns.some(text => /2 model finding\(s\) failed validation/.test(text)), answer.unknowns.join(' | '));
});

test('investigate: the sweep payload re-gates the model-written subject and quote', async () => {
  const seen = [];
  const call = Object.assign(async request => {
    seen.push(request);
    if (request.task === 'policy_evidence_investigate') {
      return { json: { findings: [{ clause_ids: [request.input.payload.clauses[0].clause_id], quote: 'cataract surgery', subject: `${NAME} eye cover, call +91 98765 43210`, conditions: [], exceptions: [] }] }, usage: {} };
    }
    return { json: { overrides: [] }, usage: {} };
  }, { maxInputBytes: 64_000 });
  await investigate({ question: QUESTION, clauses, call, consentCheck: async () => {}, knownIdentifiers: KNOWN });
  const sweep = seen.find(request => request.task === 'policy_evidence_override_sweep');
  assert.ok(sweep, 'the sweep ran');
  const wire = JSON.stringify(sweep.input.payload.findings);
  assert.equal(wire.includes('Ravi'), false);
  assert.equal(wire.includes('98765'), false);
  assert.match(wire, /<NAME_\d+>/);
  assert.match(wire, /<PHONE_\d+>/);
});

test('investigate: a stored clause the gate withheld is never sent, even when the search returns it', async () => {
  const marker = 'UNGATED_STORED_MARKER_4417';
  const withheld = { ...clauses[1], clauseId: 'doc-record-1:withheld', text: `${marker} api_key=synthetic0123456789abcdef` };
  const seen = [];
  const search = () => [withheld, { ...clauses[1], clauseId: 'doc-record-1:not-in-context', text: `${marker} stored only` }];
  const call = Object.assign(async request => { seen.push(request); return { json: request.task === 'policy_evidence_investigate' ? { findings: [] } : { overrides: [] }, usage: {} }; }, { maxInputBytes: 2_400 });
  await investigate({ question: QUESTION, clauses: [...clauses, withheld], call, consentCheck: async () => {}, search, knownIdentifiers: [] });
  assert.ok(seen.length >= 1);
  assert.equal(JSON.stringify(seen).includes(marker), false);
  assert.equal(JSON.stringify(seen).includes('synthetic0123456789abcdef'), false);
});

test('investigate: a seal refusal is a coded server defect, not a provider error', async () => {
  const broken = clauses.map(clause => ({ ...clause, kind: 'limit', text: 'Room rent is capped at 1% of the sum insured.' }));
  const call = Object.assign(async () => ({ json: { findings: [] } }), { maxInputBytes: 64_000 });
  // A clause whose kind the allow-list does not know cannot be sealed: the defect surfaces as MODEL_INPUT_NOT_ALLOWED.
  const odd = broken.map(clause => ({ ...clause, text: 'x'.repeat(10) }));
  odd[0].page = 0;
  await assert.rejects(investigate({ question: QUESTION, clauses: odd, call, consentCheck: async () => {}, knownIdentifiers: [] }), { code: 'MODEL_INPUT_NOT_ALLOWED' });
  assert.equal(metadata.calls.length, 0);
});

const ENV = {
  LLM_PROVIDER: 'google', GOOGLE_GENERATIVE_AI_API_KEY: 'synthetic-test-key', LLM_MODEL: 'test-model', LLM_INPUT_USD_PER_MILLION: '0.2',
  LLM_OUTPUT_USD_PER_MILLION: '0.8', ORCHESTRATION_RUN_BUDGET_USD: '1', ORCHESTRATION_PROJECT_BUDGET_USD: '5',
};

test('structuring call factory: an unsealed call is refused before the consent check, any reservation or the model', async () => {
  const events = [];
  let agents = 0;
  const factory = createStructuringModelCallFactory({
    env: ENV, loadModel: async () => ({}), onProviderEvent: event => events.push(event),
    createAgent: () => { agents += 1; return { generate: async () => ({ output: { items: [] }, totalUsage: { inputTokens: 5, outputTokens: 5 } }) }; },
  });
  let consents = 0;
  const outcomes = [];
  const call = factory({ consentCheck: () => { consents += 1; }, onCall: entry => outcomes.push(entry.outcome) });
  const unsealed = { payload: { registry: [], chunks: [{ chunk_id: 'p1-b0', page: 1, block_indexes: [0], kind: 'text', title: null, text: `Insured name: ${NAME}` }] } };
  await assert.rejects(call({ task: 'policy_structuring_extract', input: unsealed }), { code: 'ungated_model_input' });
  await assert.rejects(call({ task: 'policy_structuring_extract', input: structuredClone(unsealed) }), { code: 'ungated_model_input' });
  assert.equal(consents, 0);
  assert.equal(agents, 0);
  assert.deepEqual(outcomes, ['ungated_model_input', 'ungated_model_input']);
  assert.deepEqual(events.map(event => [event.outcome, event.dispatched]), [['ungated_model_input', false], ['ungated_model_input', false]]);
  assert.equal(JSON.stringify(events).includes('Ravi'), false);

  // A properly gated call goes through the same factory.
  const gated = gateChunks([{ id: 'p1-b0', page: 1, blockIndexes: [0], kind: 'text', title: null, text: `Insured name: ${NAME}. Sum insured: 500000.` }], { knownIdentifiers: KNOWN });
  let captured;
  await extractChunks({ chunks: gated.sent, registryVersion, call: async request => { captured = request; return call(request); }, consentCheck: () => {} });
  assert.equal(isSealedModelInput(captured.input, 'policy_structuring_extract'), true);
  assert.equal(consents, 1);
  assert.equal(agents, 1);
  assert.equal(events.at(-1).outcome, 'ok');
  assert.ok(events.at(-1).gatedSlots >= 1);
});

// ---- Review fixes P2-2, P2-6, P2-7 ---------------------------------------------------------------------------------

const proposal = (key, text, quote, page, chunkId) => ({ kind: 'proposed', proposedKey: key, category: 'unassigned', label: 'x', value: { text, normalized: null, subject: 'policy' }, evidenceQuote: quote, page, blockIndex: 0, chunkId, subjectInSource: false });

test('reconcile: group ids are opaque aliases and a model-written key is gated before it is sent', async () => {
  const accepted = [
    proposal('ravi_synthetic_cover', '10%', 'Cover of 10% applies.', 3, 'p3-b0'), proposal('ravi_synthetic_cover', '20%', 'Cover of 20% applies.', 4, 'p4-b0'),
    reading('d.co_pay_general', '10%', 'Co-pay of 10% applies.', 5, 'p5-b0'), reading('d.co_pay_general', '20%', 'Co-pay of 20% applies.', 6, 'p6-b0'),
  ];
  const inputs = [];
  const call = async request => { inputs.push(request); return { json: { conflicts: [] }, usage: {} }; };
  await reconcile({ accepted, call, consentCheck: () => {}, knownIdentifiers: KNOWN });
  const wire = JSON.stringify(inputs[0].input);
  assert.equal(wire.includes('ravi'), false, 'a model-written key that carries a known name never reaches the provider');
  assert.equal(wire.includes('registry:') || wire.includes('proposed:'), false, 'group ids no longer carry keys');
  for (const group of inputs[0].input.payload.groups) assert.match(group.group_id, /^g[1-9]\d{0,3}$/);
  assert.ok(inputs[0].input.payload.groups.some(group => group.target === 'd.co_pay_general'));
});

test('reconcile: a camelCase model-written key that carries a known name is replaced by the generic target', async () => {
  const accepted = [
    proposal('RaviSyntheticCover', '10%', 'Cover of 10% applies.', 3, 'p3-b0'), proposal('RaviSyntheticCover', '20%', 'Cover of 20% applies.', 4, 'p4-b0'),
  ];
  const inputs = [];
  const call = async request => { inputs.push(request); return { json: { conflicts: [] }, usage: {} }; };
  await reconcile({ accepted, call, consentCheck: () => {}, knownIdentifiers: KNOWN });
  const wire = JSON.stringify(inputs[0].input).toLowerCase();
  assert.equal(wire.includes('ravi'), false, 'a glued camelCase key does not hide a known name from the gate');
  assert.ok(inputs[0].input.payload.groups.some(group => group.target === 'proposed_item'));
});

test('reconcile: a conflict the model reports comes back through the opaque group id', async () => {
  const accepted = [reading('d.co_pay_general', '10%', 'Co-pay of 10% applies.', 5, 'p5-b0'), reading('d.co_pay_general', '20%', 'Co-pay of 20% applies.', 6, 'p6-b0')];
  const call = async request => ({ json: { conflicts: [{ group_id: request.input.payload.groups[0].group_id, quotes: ['Co-pay of 10% applies.', 'Co-pay of 20% applies.'] }] }, usage: {} });
  const result = await reconcile({ accepted, call, consentCheck: () => {}, knownIdentifiers: [] });
  assert.ok(result.conflicts.some(conflict => conflict.sources.includes('reconciler') || conflict.sources.includes('deterministic')));
  assert.equal(result.skipped.some(entry => entry.reason === 'unknown_group'), false);
});

test('reconcile: two quotes that differ only by a known name still reach the model as distinct readings and map back both', async () => {
  const accepted = [
    reading('d.co_pay_general', '10%', `Co-pay of 10% for ${NAME}.`, 5, 'p5-b0'),
    reading('d.co_pay_general', '20%', 'Co-pay of 20% for Meera Testcase.', 6, 'p6-b0'),
    reading('d.co_pay_general', '10%', 'Co-pay of 10% for Meera Testcase.', 7, 'p7-b0'),
  ];
  const known = [...KNOWN, { kind: 'NAME', value: 'Meera Testcase' }];
  const call = async request => {
    const [group] = request.input.payload.groups;
    // Names map to different placeholders (<NAME_1>, <NAME_2>) in one request, so the quotes stay distinct on the wire; send them back.
    return { json: { conflicts: [{ group_id: group.group_id, quotes: group.readings.map(item => item.quote) }] }, usage: {} };
  };
  const result = await reconcile({ accepted, call, consentCheck: () => {}, knownIdentifiers: known });
  assert.equal(result.skipped.some(entry => entry.reason === 'ungrounded_conflict'), false, 'a real conflict is not dropped as ungrounded');
});

test('reconcile: when gating makes two quotes identical, both originals are grounded by the one quote the model returns', async () => {
  // Same sentence about two different people who are not known identifiers: the re-gated text is the same string.
  const accepted = [
    reading('d.co_pay_general', '10%', 'Co-pay of 10% applies to Mr. Alpha Beta.', 5, 'p5-b0'),
    reading('d.co_pay_general', '20%', 'Co-pay of 10% applies to Mr. Gamma Delta.', 6, 'p6-b0'),
  ];
  let sentQuotes;
  const call = async request => {
    const [group] = request.input.payload.groups;
    sentQuotes = group.readings.map(item => item.quote);
    return { json: { conflicts: [{ group_id: group.group_id, quotes: [...new Set(sentQuotes)] }] }, usage: {} };
  };
  const result = await reconcile({ accepted, call, consentCheck: () => {}, knownIdentifiers: [] });
  assert.equal(new Set(sentQuotes).size, 1, 'precondition: the two quotes gate to one string');
  assert.equal(result.skipped.some(entry => entry.reason === 'ungrounded_conflict'), false);
  assert.ok(result.conflicts.some(conflict => conflict.sources.includes('reconciler') || conflict.sources.includes('deterministic')));
});

test('sweep: a finding the re-gate refuses is not swept, picks no context and cannot be an override target', async () => {
  const seen = [];
  const call = Object.assign(async request => {
    seen.push(request);
    if (request.task === 'policy_evidence_investigate') {
      return { json: { findings: [
        { clause_ids: [request.input.payload.clauses[0].clause_id], quote: 'cataract surgery', subject: 'password: synthetic12345 cover', conditions: [], exceptions: [] },
        { clause_ids: [request.input.payload.clauses[1].clause_id], quote: 'capped at Rs. 40,000', subject: 'cataract cap', conditions: [], exceptions: [] },
      ] }, usage: {} };
    }
    // The model names every finding id it might guess, including the refused one.
    return { json: { overrides: [{ clause_ids: [request.input.payload.clauses[0].clause_id], quote: 'cataract surgery', effect: 'limits', target_finding_ids: ['f1', 'f2', 'f3'] }] }, usage: {} };
  }, { maxInputBytes: 64_000 });
  const { answer } = await investigate({ question: QUESTION, clauses, call, consentCheck: async () => {}, knownIdentifiers: [] });
  const sweep = seen.find(request => request.task === 'policy_evidence_override_sweep');
  assert.ok(sweep);
  assert.deepEqual(sweep.input.payload.findings.map(finding => finding.finding_id), ['f2']);
  assert.equal(JSON.stringify(sweep.input).includes('synthetic12345'), false);
  const limited = answer.limited_or_excluded.find(entry => entry.findingId === null);
  assert.ok(limited, 'the override itself is kept');
  assert.deepEqual(limited.targets, ['f2'], 'only the finding the sweep was shown can be a target');
});

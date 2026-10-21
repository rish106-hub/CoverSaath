// Block 3 scenario matrix over generated synthetic PDFs: source verification, association, facts -> rules -> handoff.
// Synthetic data only (tests/support/synthetic-policies.mjs). No model provider, no network, no files written.
// Page texts are supplied by the generator, not extracted from the PDFs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import {
  associateDocuments, assertHandoffContract, buildDecisionCatalogue, curatedFreshness, sha256Hex, toHandoff, typedTwin, verifySourceEvidence,
} from '../src/features/decision-catalogue/index.js';
import {
  POLICY_NUMBERS, SCENARIOS, SYNTHETIC_BANNER, TEMPLATES, UNSAFE_FINDINGS, clauseId, clauseRowsFor, generateTemplate,
} from './support/synthetic-policies.mjs';

const H = 'household-synthetic-1';
const cache = new Map();
const generated = d => {
  const key = `${d.template}@${d.sourceVersion}`;
  if (!cache.has(key)) cache.set(key, generateTemplate(d.template, d.sourceVersion));
  return cache.get(key);
};
const rawNumbers = Object.values(POLICY_NUMBERS).flatMap(n => [n, n.toUpperCase().replace(/\s/g, '')]);
const assertNoRawNumber = (value, where) => {
  const json = JSON.stringify(value);
  for (const n of rawNumbers) assert.ok(!json.includes(n), `${where} leaks a raw policy number`);
};

async function materialise(scenario) {
  const documents = [];
  for (const d of scenario.documents) documents.push({ ...d, generated: await generated(d) });
  const clauseRows = documents.flatMap(d => clauseRowsFor(d.documentId, d.sourceVersion, d.generated));
  const documentIds = [...new Set(documents.map(d => d.documentId))];
  const association = associateDocuments(clauseRows, documentIds);
  const assocOf = id => association.documents.find(d => d.documentId === id);
  const ids = new Map((scenario.policies ?? []).map(p => {
    if (!p.anchor) return [p.key, p.key];
    const anchored = assocOf(p.anchor);
    assert.equal(anchored.status, 'candidate', `${scenario.id}: anchor ${p.anchor} must be a candidate`);
    return [p.key, anchored.policyId];
  }));
  const mapId = key => ids.get(key) ?? key;
  const batches = (scenario.batches ?? []).map(b => ({
    ...b, verifiedPolicyIds: (b.verifiedPolicyIds ?? []).map(mapId),
    candidates: b.candidates.map(c => (c.policyId == null ? c : { ...c, policyId: mapId(c.policyId) })),
  }));
  const policies = (scenario.policies ?? []).map(p => ({ policyId: mapId(p.key), kind: p.kind, coverBasis: p.coverBasis, insuredMembers: p.insuredMembers }));
  return { documents, clauseRows, association, assocOf, ids, mapId, batches, policies };
}

function build(world, view) {
  const catalogue = buildDecisionCatalogue({ householdId: H, batches: world.batches, clauseRows: world.clauseRows, policies: world.policies, asOf: view.asOf, memberId: view.memberId });
  const handoff = toHandoff({ sourceAnswerId: 'synthetic-answer', pipelineCurrent: true, catalogue: { ...catalogue, documentAssociations: world.association.documents }, skipped: [] });
  assert.equal(assertHandoffContract(handoff), true);
  return { catalogue, handoff };
}

const split = key => { const i = key.indexOf('/'); return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)]; };

function checkItem({ catalogue, handoff }, policyId, key, expected, label) {
  const [rule, topic] = split(key);
  const policy = handoff.policies.find(p => p.policyId === policyId);
  assert.ok(policy, `${label}: policy present`);
  const entry = policy.items.find(i => i.rule === rule && i.topic === topic);
  if (expected === undefined) return assert.equal(entry, undefined, `${label}: ${key} must not appear in this policy`);
  assert.ok(entry, `${label}: ${key} present`);
  const want = typeof expected === 'string' ? { state: expected } : expected;
  const at = `${label} ${key}`;
  assert.equal(entry.state, want.state, `${at} state`);
  if ('value' in want) assert.deepEqual(entry.value, want.value, `${at} value`);
  if ('candidateValue' in want) assert.deepEqual(entry.candidateValue, want.candidateValue, `${at} candidateValue`);
  if ('reason' in want) assert.equal(entry.reason, want.reason, `${at} reason`);
  if ('conflictingCount' in want) assert.equal(entry.conflicting.length, want.conflictingCount, `${at} conflicting`);
  if ('discrepancyCount' in want) assert.equal(entry.discrepancies.length, want.discrepancyCount, `${at} discrepancies`);
  if ('conditional' in want) assert.equal(entry.conditional, want.conditional, `${at} conditional`);
  if ('exceptionsCount' in want) assert.equal(entry.exceptions.length, want.exceptionsCount, `${at} exceptions`);
  if ('completion' in want) for (const [k, v] of Object.entries(want.completion)) assert.deepEqual(entry.completion?.[k], v, `${at} completion.${k}`);
  if ('excludedReasons' in want) {
    const layer = catalogue.policies.find(l => l.policyId === policyId);
    const result = layer.rules.find(r => r.rule === rule && r.topic === topic).result;
    for (const reason of want.excludedReasons) assert.ok(result.excluded.some(x => x.reason === reason), `${at} excluded ${reason}`);
  }
}

/** Invariants every built view must hold, whatever the scenario. */
function checkInvariants(world, { catalogue, handoff }, label) {
  assert.equal(catalogue.combinedConfirmedCover, null);
  assert.equal(handoff.combinedConfirmedCover, null);
  assert.equal(handoff.completeness.retrievalComplete, false);
  assert.equal(handoff.policies.length, world.policies.length, `${label}: one layer per policy`);
  const byId = new Map(catalogue.facts.map(f => [f.factId, f]));
  for (const policy of handoff.policies) {
    assert.equal(policy.spendableCash, false);
    for (const entry of policy.items) {
      // A known value is backed only by reviewed, verified facts of this same policy, never by a model fact.
      if (entry.state === 'known') {
        for (const c of entry.citations) {
          const f = byId.get(c.factId);
          assert.ok(f && f.origin !== 'model' && f.verified && f.policyId === policy.policyId, `${label}: ${entry.rule} known from a non-verified or foreign fact`);
        }
      }
      for (const c of [...entry.citations, ...entry.conflicting]) assert.equal(byId.get(c.factId)?.policyId, policy.policyId, `${label}: ${entry.rule} cites another policy`);
    }
  }
  // A model-origin value is never a value; at most an advisory discrepancy or a candidate.
  for (const fact of catalogue.facts.filter(f => f.origin === 'model')) {
    assert.equal(fact.state, 'extracted_unverified');
    for (const policy of handoff.policies) for (const entry of policy.items) {
      if (entry.state === 'known') assert.ok(!entry.citations.some(c => c.factId === fact.factId));
    }
  }
  assertNoRawNumber(handoff, `${label} handoff`);
  assertNoRawNumber(world.association, `${label} association`);
}

// ---- Generator ------------------------------------------------------------------------------------------------------
test('generator: real PDF bytes, every page banner-marked, byte-for-byte deterministic', async () => {
  for (const [template, versions] of Object.entries({ ...Object.fromEntries(Object.keys(TEMPLATES).map(t => [t, ['1']])), wordingA: ['1', '2'] })) {
    for (const version of versions) {
      const first = await generateTemplate(template, version);
      const second = await generateTemplate(template, version);
      assert.equal(first.sha256, second.sha256, `${template}@${version} is deterministic`);
      assert.ok(Buffer.from(first.bytes).equals(Buffer.from(second.bytes)));
      assert.equal(first.sha256, createHash('sha256').update(first.bytes).digest('hex'));
      assert.equal(first.sha256, sha256Hex(first.bytes));
      assert.equal(Buffer.from(first.bytes.subarray(0, 5)).toString('latin1'), '%PDF-');
      const parsed = await PDFDocument.load(first.bytes);
      assert.equal(parsed.getPageCount(), first.pageTexts.length, 'one generator page text per PDF page');
      assert.match(parsed.getTitle(), /synthetic/);
      assert.equal(parsed.getCreationDate().toISOString(), '2026-01-01T00:00:00.000Z');
      for (const page of first.pageTexts) assert.ok(page.startsWith(SYNTHETIC_BANNER) && page.endsWith(SYNTHETIC_BANNER));
    }
  }
  const v1 = await generateTemplate('wordingA', '1');
  const v2 = await generateTemplate('wordingA', '2');
  assert.notEqual(v1.sha256, v2.sha256, 'versions differ');
});

test('manifest: stable unique ids, every scenario declares an expected outcome', () => {
  const all = [...SCENARIOS, ...UNSAFE_FINDINGS];
  assert.equal(new Set(all.map(s => s.id)).size, all.length);
  for (const s of SCENARIOS) assert.ok(s.views || s.source || s.association, `${s.id} has expectations`);
  for (const id of ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12', 'S13', 'S14', 'R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10', 'R11']) {
    assert.ok(SCENARIOS.some(s => s.id === id), `${id} present`);
  }
});

// ---- Scenario matrix ------------------------------------------------------------------------------------------------
for (const scenario of SCENARIOS) {
  test(`${scenario.id}: ${scenario.title}`, async () => {
    const world = await materialise(scenario);

    for (const check of scenario.source ?? []) {
      const own = await generated(check.document);
      let bytes = Buffer.from(own.bytes);
      if (check.mutate === 'flip_byte') { bytes = Buffer.from(bytes); bytes[Math.floor(bytes.length / 2)] ^= 0x01; }
      if (check.mutate === 'not_pdf') bytes = Buffer.from(`${SYNTHETIC_BANNER} - plain text, not a PDF`);
      const digest = check.digestOf === 'mutated' ? sha256Hex(bytes) : check.digestOf ? (await generated(check.digestOf)).sha256 : own.sha256;
      const out = verifySourceEvidence({
        record: { ...check.record, contentSha256: digest }, bytes,
        pageTexts: check.pageTexts === 'none' ? null : own.pageTexts, facts: check.facts,
      });
      assert.deepEqual(out.blocking, check.expect.blocking, `${scenario.id} source "${check.name}" blocking`);
      assert.deepEqual(out.humanReview, check.expect.humanReview, `${scenario.id} source "${check.name}" humanReview`);
    }

    if (scenario.association) {
      for (const [documentId, status] of Object.entries(scenario.association.status)) {
        const d = world.assocOf(documentId);
        assert.equal(d.status, status, `${scenario.id} ${documentId} association`);
        assert.equal(d.verified, false, 'association is never verified by this path');
        if (status === 'candidate') assert.ok(d.policyId.startsWith('pol-'));
        else assert.equal(d.policyId, null);
      }
      for (const [a, b] of scenario.association.same ?? []) assert.equal(world.assocOf(a).policyId, world.assocOf(b).policyId, `${a} and ${b} share a policy`);
      for (const [a, b] of scenario.association.different ?? []) assert.notEqual(world.assocOf(a).policyId, world.assocOf(b).policyId, `${a} and ${b} differ`);
      assertNoRawNumber(world.association, `${scenario.id} association`);
    }

    for (const twin of scenario.typedTwins ?? []) {
      const own = await generated(twin.document);
      const rows = clauseRowsFor(twin.document.documentId, twin.document.sourceVersion, own);
      const candidate = { topic: twin.topic, clauseIds: [clauseId(twin.document.documentId, twin.document.sourceVersion, twin.page)], factType: 'finding.limits', value: { effect: 'limits', findingId: 'f1' } };
      const out = typedTwin(candidate, rows);
      if (twin.expect === null) assert.equal(out, null, `${scenario.id} twin "${twin.name}"`);
      else for (const [k, v] of Object.entries(twin.expect)) assert.deepEqual(out?.[k], v, `${scenario.id} twin "${twin.name}" ${k}`);
    }

    for (const f of scenario.freshness ?? []) assert.equal(curatedFreshness(f.record, f.today), f.expect, `${scenario.id} freshness`);

    for (const [index, view] of (scenario.views ?? []).entries()) {
      const label = `${scenario.id} view ${index} (asOf ${view.asOf}, member ${view.memberId})`;
      const built = build(world, view);
      checkInvariants(world, built, label);
      for (const [key, items] of Object.entries(view.expect)) {
        for (const [ruleKey, expected] of Object.entries(items)) checkItem(built, world.mapId(key), ruleKey, expected, label);
      }
      if (scenario.rejected) assert.deepEqual(built.catalogue.rejected.map(r => r.code), scenario.rejected, `${label} rejected`);
      if (scenario.factCount != null) assert.equal(built.catalogue.facts.length, scenario.factCount, `${label} fact count`);
      if (scenario.reviewRequired != null) assert.equal(built.handoff.reviewRequired, scenario.reviewRequired, `${label} reviewRequired`);
      if (scenario.conflicts) {
        assert.deepEqual(built.handoff.conflicts.map(c => [c.policyId, c.rule]), scenario.conflicts.map(([p, r]) => [world.mapId(p), r]), `${label} conflicts`);
      }
      if (scenario.coordination) {
        assert.equal(built.handoff.coordination.state, scenario.coordination.state);
        assert.deepEqual(built.handoff.coordination.notes.map(n => n.policyId), scenario.coordination.notes.map(world.mapId), `${label} top-up notes`);
        assert.equal(built.handoff.coordination.claimOrder, null);
      }
      if (scenario.curatedComparison) {
        for (const [documentId, status] of Object.entries(scenario.curatedComparison)) {
          assert.equal(built.catalogue.curatedComparison.find(c => c.documentId === documentId)?.status, status, `${label} curated ${documentId}`);
        }
      }
      // Handoff association: only candidate documents of this layer are listed, and none is verified.
      for (const policy of built.handoff.policies) {
        for (const d of policy.association.documents) assert.equal(world.assocOf(d.documentId).policyId, policy.policyId);
      }
    }
  });
}

// ---- Regressions for behaviour this matrix found unsafe (fixed in applicability.js, 2026-10-21) -------------------------
for (const finding of UNSAFE_FINDINGS) {
  test(`${finding.id} regression (was unsafe: ${finding.title})`, async () => {
    const world = await materialise(finding);
    for (const view of finding.views) {
      const built = build(world, view);
      for (const [key, items] of Object.entries(view.expect)) {
        for (const [ruleKey, expected] of Object.entries(items)) checkItem(built, world.mapId(key), ruleKey, expected, `${finding.id}`);
      }
    }
  });
}

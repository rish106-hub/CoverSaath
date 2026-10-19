// Counts-only coverage report: every chunk ends stored, proposed or skipped, and nothing from the document
// (chunk text, values, quotes, labels) is copied in. Chunk ids and page numbers are positional, not content.

const tally = (list, pick) => list.reduce((counts, entry) => {
  const key = pick(entry);
  counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}, {});
const count = value => (Number.isFinite(value) ? value : 0);

function chunkOutcome(chunk, outcome, storedIds, proposedIds) {
  if (!outcome) return null;
  if (outcome.status === 'skipped') return { outcome: 'skipped', reason: outcome.reason };
  if (storedIds.has(chunk.id)) return { outcome: 'stored' };
  if (proposedIds.has(chunk.id)) return { outcome: 'proposed' };
  return { outcome: 'skipped', reason: outcome.reason ?? 'none_returned' };
}

function commitCounts(commit) {
  if (!commit || typeof commit !== 'object') return null;
  const fields = ['observations', 'parameters', 'conflicting', 'skippedKeys', 'proposals'];
  return { replayed: commit.replayed === true, ...Object.fromEntries(fields.map(field => [field, Array.isArray(commit[field]) ? commit[field].length : count(commit[field])])) };
}

export function buildCoverageReport({ sectioned, extraction, reconciliation, commit = null } = {}) {
  const chunks = sectioned?.chunks ?? [];
  const accepted = extraction?.accepted ?? [];
  const proposals = extraction?.proposals ?? [];
  const rejected = extraction?.rejected ?? [];
  const outcomes = extraction?.chunkOutcomes ?? {};
  const storedIds = new Set(accepted.map(item => item.chunkId));
  const proposedIds = new Set(proposals.map(item => item.chunkId));
  const perChunk = [];
  let unaccounted = 0;
  for (const chunk of chunks) {
    const result = chunkOutcome(chunk, Object.hasOwn(outcomes, chunk.id) ? outcomes[chunk.id] : null, storedIds, proposedIds);
    if (!result) { unaccounted += 1; continue; }
    perChunk.push({ id: chunk.id, page: chunk.page, ...result });
  }
  const conflicts = reconciliation?.conflicts ?? [];
  const skipped = perChunk.filter(entry => entry.outcome === 'skipped');
  return {
    chunks: {
      total: chunks.length,
      stored: perChunk.filter(entry => entry.outcome === 'stored').length,
      proposed: perChunk.filter(entry => entry.outcome === 'proposed').length,
      skipped: skipped.length,
      unaccounted,
    },
    skippedReasons: tally(skipped, entry => entry.reason),
    dropped: tally(sectioned?.dropped ?? [], entry => entry.reason),
    items: { accepted: accepted.length, proposals: proposals.length, rejected: rejected.length, rejectedReasons: tally(rejected, entry => entry.reason) },
    conflicts: {
      total: conflicts.length,
      deterministic: conflicts.filter(conflict => conflict.sources?.includes('deterministic')).length,
      reconciler: conflicts.filter(conflict => conflict.sources?.includes('reconciler')).length,
    },
    calls: count(extraction?.calls) + count(reconciliation?.calls),
    usage: {
      inputTokens: count(extraction?.usage?.inputTokens) + count(reconciliation?.usage?.inputTokens),
      outputTokens: count(extraction?.usage?.outputTokens) + count(reconciliation?.usage?.outputTokens),
    },
    perChunk,
    ...(commit ? { commit: commitCounts(commit) } : {}),
  };
}

// Eval metrics against a golden file. result: { extraction, reconciliation }.
export function scoreStructuring(golden, result) {
  const expectedKeys = golden?.structuring?.expectedKeys ?? [];
  const expectedConflicts = golden?.structuring?.expectedConflicts ?? [];
  const accepted = result?.extraction?.accepted ?? [];
  const rejected = result?.extraction?.rejected ?? [];
  const conflicts = result?.reconciliation?.conflicts ?? [];
  const found = expected => accepted.some(item => item.parameterKey === expected.key && (expected.page == null || item.page === expected.page));
  const missingKeys = expectedKeys.filter(expected => !found(expected)).map(expected => expected.key);
  const foundConflicts = expectedConflicts.filter(expected => conflicts.some(conflict => conflict.target?.kind === 'registry' && conflict.target.key === expected.key)).map(expected => expected.id);
  const rawItems = result?.extraction?.rawItems ?? accepted.length + (result?.extraction?.proposals ?? []).length + rejected.length;
  return {
    keyRecall: expectedKeys.length ? (expectedKeys.length - missingKeys.length) / expectedKeys.length : null,
    hallucinationRate: rawItems ? rejected.filter(entry => entry.reason === 'quote_not_in_chunk').length / rawItems : 0,
    conflictRecall: expectedConflicts.length ? foundConflicts.length / expectedConflicts.length : null,
    missingKeys,
    foundConflicts,
  };
}

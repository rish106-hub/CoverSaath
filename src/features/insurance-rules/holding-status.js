// Holding status machine (policy_holdings.status, migration 048). Pure: no I/O. Deterministic code owns every transition.
//
//   uploaded --detect--> insurer_pending --report--> product_reported --parse--> parsed --memorise--> conflicts | ready
//   conflicts --resolve (last open conflict)--> ready        ready --collate (a new disagreement)--> conflicts
//
// Unresolved conflicts never block: memorise runs with conflicts open and the holding is usable in `conflicts`. Re-applying an event a
// holding has already passed is a no-op ({ changed: false }), so a retried or replayed job never moves a holding backwards.
// `openConflicts` is the number of pending memory_conflicts rows of the holding after the step.

import { HOLDING_STATUSES } from '../../contracts/holdings.js';

const RANK = Object.freeze(Object.fromEntries(HOLDING_STATUSES.map((status, index) => [status, index])));
export const HOLDING_EVENTS = Object.freeze(['detect', 'report', 'parse', 'collate', 'memorise', 'resolve']);

const invalid = (from, event) => Object.assign(new Error('The holding cannot make this step now.'), {
  code: 'HOLDING_TRANSITION_INVALID', statusCode: 409, from, event,
});

const settled = openConflicts => (openConflicts > 0 ? 'conflicts' : 'ready');
const MEMORISED = new Set(['conflicts', 'ready']);

/** The next status of a holding, or throws HOLDING_TRANSITION_INVALID. Returns { status, changed }. */
export function nextHoldingStatus(current, event, { openConflicts = 0 } = {}) {
  if (!Object.hasOwn(RANK, current) || !HOLDING_EVENTS.includes(event)) throw invalid(current, event);
  if (!Number.isInteger(openConflicts) || openConflicts < 0) throw invalid(current, event);
  const to = status => Object.freeze({ status, changed: status !== current });
  switch (event) {
    case 'detect':
      return current === 'uploaded' ? to('insurer_pending') : to(current);
    case 'report':
      if (current === 'uploaded' || current === 'insurer_pending') return to('product_reported');
      return to(current);
    case 'parse':
      if (RANK[current] < RANK.product_reported) throw invalid(current, event);
      return current === 'product_reported' ? to('parsed') : to(current);
    case 'collate':
      if (RANK[current] < RANK.parsed) throw invalid(current, event);
      return MEMORISED.has(current) ? to(settled(openConflicts)) : to(current);
    case 'memorise':
      if (RANK[current] < RANK.parsed) throw invalid(current, event);
      return to(settled(openConflicts));
    case 'resolve':
      if (RANK[current] < RANK.parsed) throw invalid(current, event);
      return MEMORISED.has(current) ? to(settled(openConflicts)) : to(current);
    default:
      throw invalid(current, event);
  }
}

/** The status table, for documentation and the BFF: [from, event, to (no open conflicts), to (open conflicts)]. */
export function holdingStatusTable() {
  const rows = [];
  for (const from of HOLDING_STATUSES) {
    for (const event of HOLDING_EVENTS) {
      const cell = open => { try { return nextHoldingStatus(from, event, { openConflicts: open }).status; } catch { return null; } };
      rows.push(Object.freeze([from, event, cell(0), cell(1)]));
    }
  }
  return Object.freeze(rows);
}

import { freeze, requireRecord } from './contracts.js';
import { validateCitation } from './source-hierarchy.js';

function confirmed(value, expected) {
  return value?.status === expected && validateCitation(value.source);
}

export function classifyContinuity(value = {}) {
  const input = requireRecord(value, 'input.continuity');
  const operator = Boolean(confirmed(input.operator, 'verified'));
  const backup = Boolean(confirmed(input.backup, 'authorised'));
  const drill = Boolean(confirmed(input.drill, 'passed'));
  const state = operator && backup && drill ? 'ready' : 'unresolved';
  return freeze({
    state,
    operator: operator ? 'verified' : 'unverified',
    backup: backup ? 'authorised' : 'unverified',
    drill: drill ? 'passed' : 'not_passed_or_unverified',
    missing: [!operator && 'verified operator', !backup && 'authorised backup', !drill && 'passed five-minute drill'].filter(Boolean),
    boundary: 'Readiness does not establish adequate insurance or approval.',
  });
}

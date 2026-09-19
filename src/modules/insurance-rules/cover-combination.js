import { freeze } from './contracts.js';
import { resolveEvidence } from './evidence-state.js';

export function combinePolicyCover(policies) {
  const layers = policies.map(policy => {
    const limit = resolveEvidence('sum_insured', policy.observations);
    return {
      policyId: policy.id,
      policyKind: policy.kind,
      limit,
      spendableCash: false,
    };
  });
  return freeze({
    method: 'separate_contract_layers',
    layers,
    combinedLimit: null,
    doubleCountingPrevented: true,
    coordinationStatus: policies.length > 1 ? 'requires_case_specific_coordination' : 'single_contract_only',
    boundary: 'Policy limits are not added together and are not spendable or confirmed payable cash.',
  });
}

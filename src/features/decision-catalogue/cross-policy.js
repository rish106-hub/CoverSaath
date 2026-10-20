// B3-4 cross-policy separation. Each policy keeps its own facts; nothing here adds limits together or ranks policies.
import { COVER_BASES, POLICY_KINDS, deepFreeze, text } from './contracts.js';
import { evaluateRules } from './rules.js';

export function separatePolicies(policies, facts, { asOf = null, memberId = null } = {}) {
  if (!Array.isArray(policies) || policies.length > 20) throw new TypeError('Policies must be a bounded array.');
  const seen = new Set();
  const layers = policies.map((policy, index) => {
    const policyId = text(policy?.policyId, 128);
    if (!policyId || seen.has(policyId)) throw new TypeError(`policies[${index}] needs a unique policyId.`);
    seen.add(policyId);
    if (!POLICY_KINDS.includes(policy.kind)) throw new TypeError(`policies[${index}].kind is unsupported.`);
    const coverBasis = COVER_BASES.includes(policy.coverBasis) ? policy.coverBasis : 'unknown';
    return {
      policyId, kind: policy.kind, coverBasis,
      insuredMembers: Array.isArray(policy.insuredMembers) ? [...new Set(policy.insuredMembers.map(id => text(id, 128)).filter(Boolean))] : [],
      period: policy.period ?? null,
      rules: evaluateRules(facts, { policyId, memberId, asOf }),
      spendableCash: false,
    };
  });
  return deepFreeze({
    layers,
    // Coordination is never inferred. Combined confirmed cover stays null so a benefit cannot be counted twice.
    coordination: {
      state: layers.length > 1 ? 'unresolved' : 'single_policy', claimOrder: null,
      // A top-up only responds above an underlying threshold that is a separate, unverified fact; it is never a larger sum insured.
      notes: layers.filter(layer => layer.kind === 'top_up' || layer.kind === 'super_top_up').map(layer => ({ policyId: layer.policyId, note: 'Responds above a deductible threshold; its limit is not added to another policy.' })),
    },
    combinedConfirmedCover: null,
    boundary: 'Policy limits are separate contract layers: not added, ranked or treated as payable together.',
  });
}

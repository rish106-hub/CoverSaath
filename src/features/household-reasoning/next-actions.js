// WP7 next actions and external checks. Every action is a request, with a reason and a status that never claims
// completion: nothing here reports that an insurer, TPA or hospital has been contacted or has confirmed anything.
import { deepFreeze } from './contracts.js';

const act = (actionType, reasonCode, text, relatedGapKeys, extra = {}) => ({ actionType, reasonCode, text, status: 'pending', relatedGapKeys, ...extra });

const PRIORITY_ORDER = Object.freeze({ P0: 0, P1: 1, P2: 2 });

export function buildNextActions({ gaps: unsorted, questions }) {
  const gaps = [...unsorted].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || (a.gapKey < b.gapKey ? -1 : 1));
  const actions = [];
  const asked = new Map(questions.map(question => [question.questionId, question]));
  for (const g of gaps) {
    const keys = [g.gapKey];
    if (g.eligibleQuestionId && asked.has(g.eligibleQuestionId)) {
      actions.push(act('provide_context', g.reason, 'Answer the follow-up question; the answer is recorded as reported context only.', keys, { questionId: g.eligibleQuestionId }));
    }
    if (g.expectedResolver === 'DOCUMENT') {
      const hasDocument = /user_has_document_not_yet_processed/.test(g.currentState);
      if (hasDocument || g.gapKey === 'source_revalidation_required' || g.gapKey === 'no_current_source') {
        actions.push(act('upload_document', g.reason, g.gapKey === 'source_revalidation_required'
          ? 'Upload the current version of the policy document so the evidence can be read again.'
          : 'Upload the document so it can be processed with consent; its contents are then read as evidence, not typed in by hand.', keys));
      } else {
        actions.push(act('identify_existing_document', g.reason, 'Check whether an already-uploaded, authorised policy document covers this, such as the policy schedule, certificate or benefit table.', keys));
      }
    } else if (g.expectedResolver === 'REVIEW') {
      actions.push(act('independent_review', g.reason, 'This needs independent human review of the cited evidence. No reviewer has been assigned by this preview.', keys));
    } else if (g.expectedResolver === 'DYNAMIC_EXTERNAL') {
      if (g.gapKey === 'hospital_network_unverified') {
        actions.push(act('hospital_confirmation', g.reason, 'Ask the hospital to confirm the exact facility and its current arrangement with the insurer or TPA. Not yet done.', keys));
        actions.push(act('insurer_or_tpa_confirmation', g.reason, 'Ask the insurer or TPA whether cashless treatment is currently available at that facility. Not yet done.', keys));
      } else if (g.gapKey === 'emergency_intimation_unverified') {
        actions.push(act('insurer_or_tpa_confirmation', g.reason, 'Contact the insurer or TPA using the helpline printed on the policy documents to find out how to give notice. Not yet done.', keys));
        actions.push(act('hospital_confirmation', g.reason, 'Ask the hospital which documents and contacts it needs for admission. Not yet done.', keys));
      } else {
        actions.push(act('insurer_or_tpa_confirmation', g.reason, 'These items change over time and need current confirmation from the insurer or TPA. Not yet done.', keys));
      }
    }
  }
  const unique = new Map();
  for (const a of actions) {
    const key = `${a.actionType}|${a.questionId ?? ''}`; // one action per type; the highest-priority gap supplies the reason
    const held = unique.get(key);
    unique.set(key, held ? { ...held, relatedGapKeys: [...new Set([...held.relatedGapKeys, ...a.relatedGapKeys])].sort() } : a);
  }
  const list = [...unique.values()].sort((a, b) => (`${a.actionType}|${a.reasonCode}` < `${b.actionType}|${b.reasonCode}` ? -1 : 1));
  // An empty list while blocking gaps remain is intended: such a gap has no open question (answered, skipped or over the
  // budget) and no document, review or external resolver, so there is nothing new to ask. It stays visible in contextGaps.
  if (!list.length && !gaps.some(g => g.blocking)) {
    list.push(act('no_further_context_needed', 'no_open_context_gaps', 'No further context is needed for this evidence summary. It is not a claim decision.', []));
  }
  return deepFreeze(list);
}

export function buildExternalChecks({ gaps, scenario, positions }) {
  const checks = [];
  const effective = scenario.effective;
  if (gaps.some(g => g.gapKey === 'hospital_network_unverified')) {
    checks.push({
      checkId: 'hospital_network_status', status: 'not_performed', resolver: 'DYNAMIC_EXTERNAL', provenance: 'dynamic_external_confirmation_required',
      requires: 'current confirmation from the insurer, TPA or hospital',
      facility: { identity: 'unresolved', name: effective.hospitalName, city: effective.hospitalCity, branch: effective.hospitalBranch, provenance: 'user_reported' },
      note: 'A name, city or address does not establish that a hospital is in any insurer network.',
    });
  }
  if (gaps.some(g => g.gapKey === 'emergency_intimation_unverified')) {
    checks.push({ checkId: 'emergency_intimation_process', status: 'not_performed', resolver: 'DYNAMIC_EXTERNAL', provenance: 'dynamic_external_confirmation_required', requires: 'current confirmation from the insurer or TPA of how and when to give notice', facility: null, note: 'Seek emergency care first. This preview does not delay or gate care.' });
  }
  for (const position of positions) {
    for (const check of position.dynamicChecks) checks.push({ checkId: `policy_item/${check.rule}`, status: 'not_performed', resolver: 'DYNAMIC_EXTERNAL', provenance: check.provenance, requires: check.requires, policyId: position.policyId, topic: check.topic, facility: null, note: null });
  }
  return deepFreeze(checks.sort((a, b) => (`${a.checkId}${a.policyId ?? ''}` < `${b.checkId}${b.policyId ?? ''}` ? -1 : 1)));
}

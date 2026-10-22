// WP6 finite question bank and deterministic planner. Question text is static: it never contains document content,
// user input or model output. A question asks for situational context or evidence; it never asks a person to rule on
// what a contract says, certify membership from memory, or choose between conflicting wording.
import { ANSWER_KEYS, LIMITS, NOT_KNOWN, SKIPPED, deepFreeze } from './contracts.js';

const YES_NO = Object.freeze(['YES', 'NO', NOT_KNOWN, SKIPPED]);
const OPEN = Object.freeze([NOT_KNOWN, SKIPPED]);
const q = (questionId, questionKey, text, answerType, options, resolver, effort, expectedEffect, explanation) => ({
  questionId, questionKey, text, answerType, allowedOptions: options, required: false, skippable: true, resolver, effortLevel: effort, expectedEffect, explanation,
});

// allowedOptions lists only the fixed, non-free-text choices (YES/NO and the I_DO_NOT_KNOW / SKIPPED sentinels). For text, date and
// member questions the answer is any value of answerType as well; a client must not treat allowedOptions as the complete answer set.
// trigger: the gap rule that makes the question eligible. target: the scenario field the answer fills.
export const QUESTION_BANK = deepFreeze([
  q('Q_BENEFIT_TOPIC', 'topic_detail', 'Which benefit or situation do you want to check?', 'text', OPEN, 'USER', 1, 'names_the_topic_used_to_match_terms', 'G05: a topic is needed to match policy terms.'),
  q('Q_CONTINUITY_DOCUMENT', 'continuity_document_available', 'Do you have records showing uninterrupted coverage under this or an earlier policy?', 'yes_no', YES_NO, 'DOCUMENT', 2, 'identifies_a_document_for_waiting_period_continuity', 'G07: continuity must be evidenced, not remembered.'),
  q('Q_EXACT_DATE', 'exact_date', 'Do you have an exact planned date for the procedure? If so, enter it as YYYY-MM-DD.', 'date', OPEN, 'USER', 1, 'lets_date_dependent_terms_be_checked', 'G04: the date could change which terms apply.'),
  q('Q_HOSPITAL_BRANCH', 'hospital_branch', 'Can you share the hospital branch or full address?', 'text', OPEN, 'USER', 1, 'identifies_the_facility_for_a_later_network_check', 'G06: the facility must be identified before a network check.'),
  q('Q_HOSPITAL_CITY', 'hospital_city', 'In which city is the hospital?', 'text', OPEN, 'USER', 1, 'identifies_the_facility_for_a_later_network_check', 'G06: the facility must be identified before a network check.'),
  q('Q_HOSPITAL_NAME', 'hospital_name', 'Which hospital is being considered?', 'text', OPEN, 'USER', 1, 'names_the_facility_for_a_later_network_check', 'G06: a facility must be named.'),
  q('Q_MEMBER', 'member_id', 'Which insured family member is receiving treatment?', 'member_id', OPEN, 'USER', 1, 'scopes_every_finding_to_one_member', 'G02: findings are scoped to one member.'),
  q('Q_OTHER_POLICY', 'other_policy_available', 'Is there another health policy, such as employer cover or a top-up, for this member?', 'yes_no', YES_NO, 'USER', 1, 'indicates_whether_a_second_document_exists', 'G08: another policy is requested only when the question needs it.'),
  q('Q_POLICY_SCHEDULE', 'policy_schedule_available', 'Do you have the policy schedule or insured-member list?', 'yes_no', YES_NO, 'DOCUMENT', 2, 'identifies_a_document_that_can_establish_membership', 'G03: membership comes from a schedule or certificate.'),
  q('Q_PROCEDURE_DETAIL', 'procedure_detail', 'What procedure is written on the hospital estimate?', 'text', OPEN, 'USER', 1, 'names_the_procedure_used_to_match_terms', 'G05: a specific name is needed to match terms.'),
]);

const BY_ID = new Map(QUESTION_BANK.map(question => [question.questionId, question]));
const PRIORITY_LEVEL = Object.freeze({ P0: 3, P1: 2, P2: 1 });
const IMPACT_LEVEL = Object.freeze({ applicability: 3, major_restriction: 2, dynamic_check_readiness: 2, clarification: 1 });

export const questionById = id => BY_ID.get(id) ?? null;

/** How many distinct bank questions the journey has already used (an answer, a skip or an "I do not know" each count). */
export function journeyQuestionCount(scenario) {
  return Object.keys(scenario.answers).filter(key => ANSWER_KEYS[key]?.question).length;
}

/**
 * @returns { questions, budget, suppressed } — at most two USER questions, never one already answered, skipped or
 * marked unknown. Order: blocking level, impact level, effort, then question id.
 */
export function selectFollowUpQuestions(gaps, scenario) {
  const perTurn = scenario.scenarioType === 'emergency_admission' ? 1 : LIMITS.questionsPerTurn;
  const used = journeyQuestionCount(scenario);
  const remaining = Math.max(0, LIMITS.questionsPerJourney - used);
  const candidates = new Map();
  const suppressed = [];
  for (const g of gaps) {
    if (!g.eligibleQuestionId) continue;
    const question = BY_ID.get(g.eligibleQuestionId);
    if (!question) continue;
    // Never repeat: any recorded answer state for the question's key (answered, skipped, unknown) retires it.
    if (Object.hasOwn(scenario.answers, question.questionKey)) { suppressed.push({ questionId: question.questionId, reasonCode: 'already_answered_or_skipped' }); continue; }
    const level = { blocking: PRIORITY_LEVEL[g.priority], impact: IMPACT_LEVEL[g.impact] };
    const held = candidates.get(question.questionId);
    if (!held || level.blocking > held.level.blocking || (level.blocking === held.level.blocking && level.impact > held.level.impact)) {
      candidates.set(question.questionId, { question, level, gap: g });
    }
  }
  const ordered = [...candidates.values()].sort((a, b) => b.level.blocking - a.level.blocking || b.level.impact - a.level.impact
    || a.question.effortLevel - b.question.effortLevel || (a.question.questionId < b.question.questionId ? -1 : 1));
  const take = Math.min(perTurn, remaining);
  const chosen = ordered.slice(0, take);
  for (const c of ordered.slice(take)) suppressed.push({ questionId: c.question.questionId, reasonCode: remaining === 0 ? 'question_budget_exhausted' : 'turn_limit_reached' });
  const questions = chosen.map(({ question, gap }) => ({
    questionId: question.questionId, questionKey: question.questionKey, text: question.text, answerType: question.answerType, allowedOptions: [...question.allowedOptions],
    // Never required: a person may skip, and an emergency is never gated behind a questionnaire.
    required: false, skippable: true, priority: gap.priority, reasonCode: gap.reason, resolver: question.resolver, expectedEffect: question.expectedEffect, alreadyAnswered: false,
  }));
  return deepFreeze({
    questions,
    budget: { perTurnLimit: perTurn, journeyLimit: LIMITS.questionsPerJourney, usedInJourney: used, remainingInJourney: remaining, exhausted: remaining === 0 },
    suppressed: suppressed.sort((a, b) => (a.questionId < b.questionId ? -1 : 1)),
  });
}

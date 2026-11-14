// answer-card/v1: the structured chat answer. The model fills only headline, explanation and condition text; the server builds
// the rest and releases a card only after src/features/chat-answer-guard passes. Copy here is not final legal wording (legalReview).
export const ANSWER_CARD_CONTRACT = 'answer-card/v1';
export const ANSWER_CARD_STATUSES = Object.freeze(['evidence_found', 'unknown', 'out_of_scope']);
export const ANSWER_CARD_VERDICTS = Object.freeze(['covered', 'not_covered', 'partly_covered', 'depends', 'unknown']);
export const ANSWER_CARD_CONDITION_KINDS = Object.freeze(['waiting_period', 'sublimit', 'copay', 'deductible', 'exclusion', 'room_rent', 'document_needed']);
export const ANSWER_CARD_SOURCE_TIERS = Object.freeze(['own_pdf', 'ida_wording', 'user_declaration']);
export const ANSWER_CARD_SOURCE_STATUSES = Object.freeze(['extracted_unverified', 'reviewed_reference', 'user_confirmed', 'conflicting', 'unknown']);
export const ANSWER_CARD_ACTION_KINDS = Object.freeze(['answer_question', 'find_hospital', 'call_insurer', 'upload_document', 'ask_followup', 'grievance_path']);
export const ANSWER_CARD_LIMITS = Object.freeze({
  headline: 90, explanation: 280, quote: 160, conditions: 6, sources: 8, actions: 3, followups: 3, speechWords: 25,
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value) => typeof value === 'string';

// Shape and size only. Whether the content is grounded is the guard's job, not this function's.
export function validateAnswerCardShape(card) {
  const errors = [];
  if (!isObject(card)) return { valid: false, errors: ['card_not_object'] };
  const L = ANSWER_CARD_LIMITS;
  if (card.contract !== ANSWER_CARD_CONTRACT) errors.push('contract');
  if (!ANSWER_CARD_STATUSES.includes(card.status)) errors.push('status');
  if (!ANSWER_CARD_VERDICTS.includes(card.verdict)) errors.push('verdict');
  if (!isString(card.headline) || card.headline.length === 0) errors.push('headline');
  else if (card.headline.length > L.headline) errors.push('headline_too_long');
  if (!isString(card.explanation)) errors.push('explanation');
  else if (card.explanation.length > L.explanation) errors.push('explanation_too_long');
  if (card.ruleResultId != null && !isString(card.ruleResultId)) errors.push('rule_result_id');

  const conditions = card.conditions ?? [];
  if (!Array.isArray(conditions)) errors.push('conditions');
  else {
    if (conditions.length > L.conditions) errors.push('conditions_too_many');
    conditions.forEach((condition, index) => {
      if (!isObject(condition)) return errors.push(`conditions[${index}]`);
      if (!ANSWER_CARD_CONDITION_KINDS.includes(condition.kind)) errors.push(`conditions[${index}].kind`);
      if (!isString(condition.text) || condition.text.length === 0) errors.push(`conditions[${index}].text`);
      if (!Array.isArray(condition.sourceIds) || !condition.sourceIds.every(isString)) errors.push(`conditions[${index}].sourceIds`);
    });
  }
  const sources = card.sources ?? [];
  if (!Array.isArray(sources)) errors.push('sources');
  else {
    if (sources.length > L.sources) errors.push('sources_too_many');
    sources.forEach((source, index) => {
      if (!isObject(source)) return errors.push(`sources[${index}]`);
      if (!isString(source.id) || source.id.length === 0) errors.push(`sources[${index}].id`);
      if (!Array.isArray(source.factIds) || !source.factIds.every(isString)) errors.push(`sources[${index}].factIds`);
      if (!ANSWER_CARD_SOURCE_TIERS.includes(source.tier)) errors.push(`sources[${index}].tier`);
      if (!ANSWER_CARD_SOURCE_STATUSES.includes(source.status)) errors.push(`sources[${index}].status`);
      if (!isString(source.quote)) errors.push(`sources[${index}].quote`);
      else if (source.quote.length > L.quote) errors.push(`sources[${index}].quote_too_long`);
    });
  }
  const actions = card.actions ?? [];
  if (!Array.isArray(actions)) errors.push('actions');
  else {
    if (actions.length > L.actions) errors.push('actions_too_many');
    actions.forEach((action, index) => {
      if (!isObject(action) || !ANSWER_CARD_ACTION_KINDS.includes(action.kind) || !isString(action.label)) errors.push(`actions[${index}]`);
      // An action may reference a trusted contact by id; only the guard attaches `contact` (C10 rejects a draft carrying one).
      else if (action.contactId != null && (!isString(action.contactId) || !['call_insurer', 'grievance_path'].includes(action.kind))) errors.push(`actions[${index}].contact`);
      else if (action.contact != null && (action.contactId == null || !isObject(action.contact) || !isString(action.contact.kind) || !isString(action.contact.value))) errors.push(`actions[${index}].contact`);
    });
  }
  const followups = card.followups ?? [];
  if (!Array.isArray(followups) || !followups.every(isString)) errors.push('followups');
  else if (followups.length > L.followups) errors.push('followups_too_many');
  if (card.speech != null) {
    if (!isObject(card.speech) || !isString(card.speech.text)) errors.push('speech');
    else if (card.speech.text.trim().split(/\s+/).filter(Boolean).length > L.speechWords) errors.push('speech_too_long');
  }
  return { valid: errors.length === 0, errors };
}

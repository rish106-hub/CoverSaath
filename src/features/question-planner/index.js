// Deterministic question planner (arch-a draft 2.2). Pure: no DB, no model, no clock (caller passes `now`). Never produces text:
// it returns catalogue ids; the UI renders the reviewed catalogue wording. Minors only get coverage-relevant questions (R2).
import { QUESTION_CATALOGUE_VERSION, NOT_SURE, FOLLOWUP_ANY } from '../../contracts/question-catalogue.js';
import { getPolicyFactKey } from '../../contracts/policy-facts.js';
import { CATALOGUE_V1 } from './catalogue-v1.js';

export { QUESTION_CATALOGUE_VERSION, CATALOGUE_V1 };
export const MAX_QUESTIONS_BEFORE_CARD = 2;
export const NOT_SURE_SUPPRESSION_DAYS = 30;
export { SUPPORTED_LOCALES } from '../../contracts/question-catalogue.js';
export const CARD_TILES = Object.freeze(['sum_insured', 'room_rent', 'waiting_periods', 'copay_deductible', 'exclusions', 'cashless']);
export const CONFLICT_PROMPT_EN = 'Which is right?';
const DAY_MS = 86_400_000;
const NO_TILE_FACTOR = 0.25;

const slotId = (factKey, scopeKey, memberId) => `${factKey}|${scopeKey ?? ''}|${memberId ?? ''}`;
const toMs = now => {
  const ms = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(ms)) throw Object.assign(new Error('planNextQuestions needs a valid now.'), { code: 'QUESTION_PLANNER_NOW_REQUIRED' });
  return ms;
};
const factClassOf = item => getPolicyFactKey(item.slot.factKey)?.factClass ?? 'household_declaration';
const itemMembers = (item, members) => (item.perMember ? members : [null]);

export function planNextQuestions({
  slots = [], members = [], answeredLog = [], openedTiles = [], askedVerdictNeeds = [], now, phase = 'before_card', limit, catalogue = CATALOGUE_V1,
} = {}) {
  const nowMs = toMs(now);
  // before_card: at most 2 (B9), only items that change an on-card tile. strip: unlimited unless a limit is passed, still score-ordered.
  const cap = phase === 'strip'
    ? (Number.isInteger(limit) ? Math.max(0, limit) : Infinity)
    : Math.max(0, Math.min(Number.isInteger(limit) ? limit : MAX_QUESTIONS_BEFORE_CARD, MAX_QUESTIONS_BEFORE_CARD));
  // B10: openedTiles shape this call's scores only. Interest is never returned, stored or turned into a profile.
  const slotMap = new Map(slots.map(slot => [slotId(slot.factKey, slot.scopeKey, slot.memberId), slot]));
  const opened = new Set(openedTiles);
  const needs = new Set(askedVerdictNeeds);
  const order = new Map(catalogue.map((item, index) => [item.id, index]));
  const memberOrder = new Map(members.map((member, index) => [member.id, index]));
  const logFor = (questionId, memberId) => answeredLog.filter(e => e.questionId === questionId && (e.memberId ?? null) === (memberId ?? null));
  const latest = entries => entries.reduce((a, b) => (a === undefined || Date.parse(b.answeredAt) >= Date.parse(a.answeredAt) ? b : a), undefined);

  // Followup activation: a followup is a candidate only after its parent was answered with the trigger option for that member.
  const parents = new Map();
  for (const item of catalogue) for (const [trigger, targets] of Object.entries(item.followups ?? {})) for (const target of targets) {
    parents.set(target, [...(parents.get(target) ?? []), { parent: item.id, trigger }]);
  }
  const followupActive = (item, memberId) => {
    const links = parents.get(item.id);
    if (!links) return { gated: false, active: false };
    const active = links.some(({ parent, trigger }) => {
      const last = latest(logFor(parent, memberId).filter(e => e.outcome === 'answered'));
      return last !== undefined && (trigger === FOLLOWUP_ANY ? (last.optionIds ?? []).length > 0 : (last.optionIds ?? []).includes(trigger));
    });
    return { gated: true, active };
  };

  const candidates = [];
  for (const item of catalogue) {
    if (item.phase !== phase) continue;
    for (const member of itemMembers(item, members)) {
      const memberId = member?.id ?? null;
      if (member?.isMinor === true && !item.coverageRelevant) continue;
      const { gated, active } = followupActive(item, memberId);
      if (gated && !active) continue;
      const slot = slotMap.get(slotId(item.slot.factKey, item.slot.scopeKey, memberId));
      const status = slot?.status ?? 'unknown';
      const conflicting = status === 'conflicting' && Array.isArray(slot?.alternatives) && slot.alternatives.length >= 2;
      const needsAsk = status === 'unknown' || status === 'conflicting'
        || (status === 'extracted_unverified' && factClassOf(item) === 'household_declaration');
      if (!needsAsk) continue;
      const entries = logFor(item.id, memberId);
      if (!conflicting && entries.some(e => e.outcome === 'answered') && !gated) continue;
      const lastAnswer = latest(entries);
      if (lastAnswer?.outcome === NOT_SURE && nowMs - Date.parse(lastAnswer.answeredAt) < NOT_SURE_SUPPRESSION_DAYS * DAY_MS) continue;
      if (gated && entries.some(e => e.outcome === 'answered')) continue;

      const tiles = item.valueOfInformation.unlocksTiles;
      // A required input of a tile (B6) weighs 3 when that tile is opened or on the card.
      const tileFactor = tiles.length === 0 ? NO_TILE_FACTOR
        : tiles.reduce((sum, tile) => sum + (opened.has(tile) || CARD_TILES.includes(tile)
          ? (item.requiredInputOf?.includes(tile) ? 3 : opened.has(tile) ? 2 : 1) : 0), 0);
      if (tileFactor === 0) continue;
      const verdict = needs.has(item.id) || needs.has(item.slot.factKey);
      const score = item.valueOfInformation.weight * tileFactor * (verdict ? 1 : 0.5);
      const reason = conflicting ? 'conflict' : gated ? 'followup' : verdict ? 'changes_verdict' : status === 'extracted_unverified' ? 'confirm_extracted' : 'unknown';
      const entry = { questionId: item.id, memberId, reason, phase };
      if (conflicting) {
        entry.conflict = {
          prompt: CONFLICT_PROMPT_EN,
          choices: slot.alternatives.slice(0, 2).map((alt, index) => ({ choiceId: index === 0 ? 'a' : 'b', value: alt.value, sourceTier: alt.sourceTier })),
        };
      }
      candidates.push({ entry, score, followup: gated, order: order.get(item.id), member: memberOrder.get(memberId) ?? 0 });
    }
  }
  candidates.sort((a, b) => (b.followup - a.followup) || (b.score - a.score) || (a.order - b.order) || (a.member - b.member));
  return candidates.slice(0, cap).map(c => c.entry);
}

/**
 * Turns a tap into a user_declaration DTO (no DB write). "Not sure" is status unknown and writes no memory row (the user tier
 * stores only user_confirmed, ADR 0023 D2); the caller logs it so the planner can suppress the slot for 30 days.
 */
export function recordAnswer({ questionId, memberId = null, optionIds, catalogueVersion, catalogue = CATALOGUE_V1, conflictResolution = false }) {
  const bad = message => Object.assign(new Error(message), { code: 'QUESTION_ANSWER_INVALID', statusCode: 400 });
  if (catalogueVersion !== QUESTION_CATALOGUE_VERSION) throw bad('Catalogue version does not match.');
  const item = catalogue.find(i => i.id === questionId);
  if (!item) throw bad('Unknown question.');
  if (!Array.isArray(optionIds) || optionIds.length === 0 || new Set(optionIds).size !== optionIds.length) throw bad('Pick at least one option.');
  const kind = item.input.kind;
  const allowed = item.input.options.map(o => o.id);
  if (kind !== 'member_pick' && optionIds.some(id => !allowed.includes(id))) throw bad('Option is not valid for this question.');
  if (kind !== 'multi_choice_chips' && kind !== 'member_pick' && optionIds.length !== 1) throw bad('Pick one option.');
  if (item.perMember && !memberId) throw bad('This question needs a member.');
  if (!item.perMember && memberId) throw bad('This question is not per member.');
  const notSure = optionIds.includes(NOT_SURE);
  if (notSure && optionIds.length > 1) throw bad('Not sure cannot be combined.');
  const triggers = item.followups ?? {};
  const followupsActivated = notSure ? [] : [...new Set(optionIds.flatMap(id => triggers[id] ?? []).concat(triggers[FOLLOWUP_ANY] ?? []))];
  return Object.freeze({
    sourceTier: 'user_declaration',
    factKey: item.slot.factKey,
    scopeKey: item.slot.scopeKey ?? null,
    memberScope: item.slot.memberScope,
    subjectMemberId: memberId,
    status: notSure ? 'unknown' : 'user_confirmed',
    writeMemoryRow: !notSure,
    value: notSure ? null : kind === 'multi_choice_chips' || kind === 'member_pick' ? [...optionIds].sort() : optionIds[0],
    captureMethod: conflictResolution ? 'conflict_resolution' : 'box_confirm',
    questionId: item.id,
    catalogueVersion,
    followupsActivated,
    sensitivity: item.sensitivity,
    optionIds: Object.freeze([...optionIds]),
  });
}

/**
 * Analytics payload for an answer (B1). Health and money answers leak nothing about the choice: only the question id and that it was
 * answered. Only sensitivity 'none' answers carry option ids.
 */
export function analyticsPayloadFor(answer) {
  if (answer?.sensitivity === 'none') return { questionId: answer.questionId, answered: true, optionIds: [...answer.optionIds] };
  return { questionId: answer?.questionId, answered: true };
}

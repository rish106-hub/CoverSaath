// Question catalogue contract (arch-a draft section 2.1). Fixed, legal-reviewable questions; the model never writes one.
// Pure: no I/O, no model. Wording is FOR LEGAL REVIEW (legalReview 'pending'); hi is null until a human translates it.
import { POLICY_FACT_KEY_NAMES, MEMBER_SCOPES } from './policy-facts.js';

export const QUESTION_CATALOGUE_VERSION = 'question-catalogue/v1';
export const INPUT_KINDS = Object.freeze([
  'yes_no_unsure', 'single_choice', 'multi_choice_chips', 'amount_presets', 'date_presets', 'member_pick',
]);
export const NOT_SURE = 'not_sure';
export const OTHER = 'other';
export const MAX_SINGLE_CHOICE_OPTIONS = 5;
export const MAX_CHIP_OPTIONS = 8;
export const AMOUNT_PRESET_COUNT = 4;
export const DATE_PRESET_IDS = Object.freeze(['this_year', 'last_year', 'two_to_four_years', 'longer', NOT_SURE]);
export const FOLLOWUP_ANY = '*';

// Slot keys not yet in the append-only registry (src/contracts/policy-facts.js). Proposed for the next registry append; every other
// catalogue key must already exist there. Mapping notes live in catalogue-v1.js.
export const PROPOSED_FACT_KEYS = Object.freeze([
  'member_covered', 'member_relationship', 'declared_employer_cover', 'home_city', 'preference_cashless', 'preference_language', 'purchase_channel',
]);

const KNOWN_KEYS = new Set([...POLICY_FACT_KEY_NAMES, ...PROPOSED_FACT_KEYS]);
const text = value => typeof value === 'string' && value.trim().length > 0;
const optionIds = item => (item.input?.options ?? []).map(option => option.id);

/** Returns an array of error strings; empty means valid. */
export function validateCatalogue(items) {
  const errors = [];
  if (!Array.isArray(items) || items.length === 0) return ['catalogue must be a non-empty array'];
  const ids = new Set();
  for (const item of items) {
    if (!text(item?.id)) { errors.push('item without id'); continue; }
    if (ids.has(item.id)) errors.push(`${item.id}: duplicate id`);
    ids.add(item.id);
  }
  for (const item of items) {
    if (!text(item?.id)) continue;
    const at = message => errors.push(`${item.id}: ${message}`);
    if (!text(item.prompt?.en)) at('prompt.en missing');
    if (!text(item.why?.en)) at('why.en missing');
    for (const field of ['prompt', 'why']) if (item[field]?.hi !== null && item[field]?.hi !== undefined && !text(item[field].hi)) at(`${field}.hi must be null or text`);
    if (!text(item.slot?.factKey)) at('slot.factKey missing');
    else if (!KNOWN_KEYS.has(item.slot.factKey)) at(`slot.factKey ${item.slot.factKey} is neither a registry key nor a proposed key`);
    if (!MEMBER_SCOPES.includes(item.slot?.memberScope)) at('slot.memberScope invalid');
    if (item.legalReview !== 'pending') at("legalReview must be 'pending'");
    if (typeof item.perMember !== 'boolean') at('perMember must be boolean');
    const voi = item.valueOfInformation;
    if (!Array.isArray(voi?.unlocksTiles) || !(voi?.weight > 0 && voi.weight <= 1)) at('valueOfInformation needs unlocksTiles[] and weight in (0,1]');
    const kind = item.input?.kind;
    if (!INPUT_KINDS.includes(kind)) { at('input.kind invalid'); continue; }
    const options = optionIds(item);
    if (new Set(options).size !== options.length) at('duplicate option ids');
    const real = options.filter(id => id !== NOT_SURE && id !== OTHER);
    if (kind === 'yes_no_unsure' && options.join() !== 'yes,no,not_sure') at('yes_no_unsure options must be yes,no,not_sure');
    if (kind === 'single_choice') {
      if (options.filter(id => id !== NOT_SURE).length > MAX_SINGLE_CHOICE_OPTIONS) at('single_choice allows at most 5 options plus not_sure');
      if (!options.includes(NOT_SURE)) at('single_choice needs not_sure');
    }
    if (kind === 'multi_choice_chips') {
      if (real.length > MAX_CHIP_OPTIONS) at('multi_choice_chips allows at most 8 options plus other');
      if (!options.includes(OTHER)) at('multi_choice_chips needs other');
    }
    if (kind === 'amount_presets' && (real.length !== AMOUNT_PRESET_COUNT || !options.includes('other_amount'))) at('amount_presets needs 4 presets and other_amount');
    if (kind === 'date_presets' && options.join() !== DATE_PRESET_IDS.join()) at('date_presets options must be the fixed preset list');
    if (kind === 'member_pick' && options.length > 0) at('member_pick options come from members, not the catalogue');
    for (const option of item.input.options ?? []) if (!text(option.label?.en)) at(`option ${option.id} label.en missing`);
    for (const [trigger, targets] of Object.entries(item.followups ?? {})) {
      if (trigger !== FOLLOWUP_ANY && !options.includes(trigger)) at(`followup trigger ${trigger} is not an option`);
      for (const target of targets) if (!ids.has(target)) at(`followup ${target} does not exist`);
    }
  }
  // Cycle check over followup edges.
  const edges = new Map(items.filter(i => text(i?.id)).map(i => [i.id, [...new Set(Object.values(i.followups ?? {}).flat())]]));
  const state = new Map();
  const visit = id => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    const cyclic = (edges.get(id) ?? []).some(next => edges.has(next) && visit(next));
    state.set(id, 2);
    return cyclic;
  };
  for (const id of edges.keys()) if (visit(id)) { errors.push(`${id}: followup cycle`); break; }
  return errors;
}

export function assertCatalogue(items) {
  const errors = validateCatalogue(items);
  if (errors.length) throw Object.assign(new Error(`Question catalogue invalid: ${errors.join('; ')}`), { code: 'QUESTION_CATALOGUE_INVALID' });
  return items;
}

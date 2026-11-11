// Collate: the ADR 0023 D3 resolver, made deterministic and pure (complete.md section 3.2 step 4, section 9.1 and 9.4). No I/O, no
// model, no provider call. The holding.collate job feeds it the candidates of one holding and writes what it returns.
//
// Per fact key (one slot; scope '' only in this slice) it takes:
//   own          policy_facts rows of the holding's document (own-PDF tier). origin deterministic | model_proposed.
//   ida          values read by deterministic code from the IDA reference (insurer wording tier). origin reference | model_proposed.
//   declaration  the current user_declaration memory row of the slot, or null.
// and returns the machine-tier rows to hold (own_pdf, ida_wording) and the conflict to record, if any.
//
// Authority (AI.md, ADR 0003, ADR 0009, complete.md 9.1):
//   * This module never produces a user_declaration row or the status user_confirmed. Only the conflict-resolve route writes those,
//     from an adult's own choice.
//   * reviewed_reference is produced only for an IDA value whose origin is `reference` (deterministic). A model-proposed IDA value is
//     refused (MODEL_REFERENCE_REFUSED) and a model-proposed own-PDF fact is never cited by a reviewed_reference row.
//   * own_pdf rows are only extracted_unverified or conflicting. No row is ever plain "confirmed".
//   * Missing means unknown: nothing is written for a tier with no value; the read-time resolver answers unknown.
//
// Fact classes (ADR 0023 D3):
//   product_term           IDA primary, own PDF corroborates. Equal -> reviewed_reference citing both. Differ -> both conflicting,
//                          conflict own_vs_insurer. The user may choose (ADR 0032, FOR LEGAL REVIEW); chat keeps both quotes and says
//                          to check with the insurer.
//   personal_value         own PDF primary, IDA ignored. A typed declaration that differs -> own conflicting, conflict own_vs_declaration.
//   household_declaration  declaration primary, own PDF a candidate; same as personal_value for conflicts.

import { getPolicyFactKey, isTierStatus } from '../../contracts/policy-facts.js';
import { equalityKey } from '../policy-facts/fact-equality.js';

export const COLLATE_VERSION = 'collate.1';
const MAX_ALTERNATIVES = 4;

const MACHINE_TIERS = new Set(['own_pdf', 'ida_wording']);
const OWN_ORIGINS = new Set(['deterministic', 'model_proposed']);
const IDA_ORIGINS = new Set(['reference', 'model_proposed']);

const coded = (code, message) => Object.assign(new Error(message), { code });

function distinctValues(valueType, values) {
  const seen = new Map();
  for (const value of values) {
    const key = equalityKey(valueType, value);
    if (key !== null && !seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()];
}

// The own-PDF tier of one slot from its current policy_facts rows.
function ownIntent(entry, own, refused) {
  const usable = [];
  for (const fact of own ?? []) {
    if (!fact || !OWN_ORIGINS.has(fact.origin)) { refused.push('OWN_ORIGIN_REFUSED'); continue; }
    if (fact.state === 'unknown') continue;
    if (fact.state !== 'extracted_unverified' && fact.state !== 'conflicting') { refused.push('OWN_STATE_REFUSED'); continue; }
    usable.push(fact);
  }
  if (usable.length === 0) return null;
  const values = distinctValues(entry.type, usable.flatMap(fact => (fact.state === 'conflicting' ? fact.alternatives ?? [] : [fact.value])));
  const cited = usable.find(fact => fact.origin === 'deterministic') ?? usable[0];
  const inTierConflict = usable.some(fact => fact.state === 'conflicting') || values.length > 1;
  if (!inTierConflict && values.length === 0) return null;
  return {
    tier: 'own_pdf',
    status: inTierConflict ? 'conflicting' : 'extracted_unverified',
    value: inTierConflict ? null : values[0],
    alternatives: inTierConflict ? values.slice(0, MAX_ALTERNATIVES) : [],
    policyFactId: cited.factId,
    referenceId: null,
    modelSourced: usable.every(fact => fact.origin === 'model_proposed'),
    inTierReason: inTierConflict ? (new Set(usable.map(fact => fact.origin)).size > 1 ? 'model_disagree' : 'two_pages') : null,
    deterministicFactId: usable.find(fact => fact.origin === 'deterministic')?.factId ?? null,
  };
}

// The IDA tier of one slot. Only a product term, only a deterministic reference reading.
function idaIntent(entry, ida, refused) {
  if (entry.factClass !== 'product_term') {
    if ((ida ?? []).length > 0) refused.push('IDA_NOT_PRODUCT_TERM');
    return null;
  }
  const usable = [];
  for (const item of ida ?? []) {
    if (!item || !IDA_ORIGINS.has(item.origin)) { refused.push('IDA_ORIGIN_REFUSED'); continue; }
    if (item.origin !== 'reference') { refused.push('MODEL_REFERENCE_REFUSED'); continue; }
    if (equalityKey(entry.type, item.value) === null) { refused.push('IDA_VALUE_INVALID'); continue; }
    usable.push(item);
  }
  if (usable.length === 0) return null;
  const values = distinctValues(entry.type, usable.map(item => item.value));
  return {
    tier: 'ida_wording',
    status: values.length > 1 ? 'conflicting' : 'reviewed_reference',
    value: values.length > 1 ? null : values[0],
    alternatives: values.length > 1 ? values.slice(0, MAX_ALTERNATIVES) : [],
    policyFactId: null,
    referenceId: usable[0].refId,
    reference: usable[0],
    modelSourced: false,
  };
}

const asConflicting = intent => ({
  ...intent,
  status: 'conflicting',
  alternatives: intent.status === 'conflicting' ? intent.alternatives : [intent.value],
  value: null,
});

/**
 * Collates one slot. Returns { factKey, factClass, valueType, own, ida, conflict, refused } where own and ida are row intents or null
 * and conflict is { reason } (between the two written rows, or the own row and the declaration) or null.
 */
export function collateSlot({ factKey, own = [], ida = [], declaration = null }) {
  const entry = getPolicyFactKey(factKey);
  if (!entry) throw coded('COLLATE_FACT_KEY_UNKNOWN', 'The fact key is not in the registry.');
  const refused = [];
  let ownRow = ownIntent(entry, own, refused);
  let idaRow = idaIntent(entry, ida, refused);
  let conflict = null;

  if (ownRow && idaRow) {
    const agree = ownRow.status === 'extracted_unverified' && idaRow.status === 'reviewed_reference'
      && equalityKey(entry.type, ownRow.value) === equalityKey(entry.type, idaRow.value);
    if (agree) {
      // Citing both: the reviewed_reference row points at the own-PDF fact, but never at a model-proposed one.
      idaRow = { ...idaRow, policyFactId: ownRow.deterministicFactId };
    } else {
      ownRow = asConflicting(ownRow);
      idaRow = asConflicting(idaRow);
      conflict = { reason: 'own_vs_insurer' };
    }
  }

  if (ownRow && !conflict && declaration && declaration.captureMethod !== 'conflict_resolution' && entry.factClass !== 'product_term') {
    const differs = ownRow.status === 'conflicting'
      || equalityKey(entry.type, ownRow.value) !== equalityKey(entry.type, declaration.value);
    if (differs) {
      ownRow = asConflicting(ownRow);
      conflict = { reason: 'own_vs_declaration' };
    }
  }

  // Two readings inside the own-PDF tier (two pages, or deterministic vs model) disagree: record it so the holding cannot settle ready.
  if (ownRow && !conflict && ownRow.inTierReason) conflict = { reason: ownRow.inTierReason };

  for (const row of [ownRow, idaRow]) if (row) assertMachineRowAuthority(row);
  return Object.freeze({ factKey, factClass: entry.factClass, valueType: entry.type, own: ownRow, ida: idaRow, conflict, refused: Object.freeze(refused) });
}

/**
 * The last guard before a machine row is written (the collate job calls it again in the writer). Throws COLLATE_AUTHORITY_REFUSED for
 * a user tier, a status outside its tier, user_confirmed, or a reviewed_reference row resting on model output.
 */
export function assertMachineRowAuthority(row) {
  const refuse = () => { throw coded('COLLATE_AUTHORITY_REFUSED', 'A machine row may not carry this status.'); };
  if (!row || !MACHINE_TIERS.has(row.tier)) refuse();
  if (!isTierStatus(row.tier, row.status) || row.status === 'user_confirmed' || row.status === 'unknown') refuse();
  if (row.status === 'reviewed_reference' && (row.tier !== 'ida_wording' || row.modelSourced !== false || row.reference?.origin !== 'reference')) refuse();
  if (row.tier === 'own_pdf' && row.status === 'reviewed_reference') refuse();
  return row;
}

/**
 * Read-time resolution of one slot from its current memory rows (ADR 0023 D3 with the ADR 0032 change: a user may resolve any
 * conflict). rows: { own, ida, declaration } each { id, status, value, alternatives, captureMethod?, resolvesFactIds? } or null.
 * Returns { status, value, sourceTier, sourceIds, alternatives, checkWithInsurer }.
 */
export function resolveSlot({ factKey, own = null, ida = null, declaration = null }) {
  const entry = getPolicyFactKey(factKey);
  if (!entry) throw coded('COLLATE_FACT_KEY_UNKNOWN', 'The fact key is not in the registry.');
  const productTerm = entry.factClass === 'product_term';
  const machine = [own, ida].filter(row => row && row.status !== 'unknown');
  const machineValues = machine.flatMap(row => (row.status === 'conflicting' ? row.alternatives ?? [] : [row.value]));
  const out = (status, value, sourceTier, sources, alternatives = []) => Object.freeze({
    status, value: value ?? null, sourceTier, sourceIds: Object.freeze(sources.map(row => row.id)),
    alternatives: Object.freeze(alternatives), checkWithInsurer: productTerm && status !== 'reviewed_reference' && status !== 'unknown' && machine.length > 0,
  });

  if (declaration) {
    const resolved = declaration.resolvesFactIds ?? [];
    const covered = machine.every(row => resolved.includes(row.id));
    const fresh = machine.filter(row => !resolved.includes(row.id));
    const freshDiffers = fresh.some(row => row.status === 'conflicting'
      || equalityKey(entry.type, row.value) !== equalityKey(entry.type, declaration.value));
    if (declaration.captureMethod === 'conflict_resolution') {
      // A later machine row with a different value makes the slot conflicting again; nothing is overwritten silently.
      if (!covered && freshDiffers) return out('conflicting', null, null, [declaration, ...machine], distinctValues(entry.type, [declaration.value, ...machineValues]));
      return out('user_confirmed', declaration.value, 'user_declaration', [declaration, ...machine], productTerm ? distinctValues(entry.type, machineValues) : []);
    }
    if (!productTerm) {
      if (machine.some(row => row.status === 'conflicting' || equalityKey(entry.type, row.value) !== equalityKey(entry.type, declaration.value))) {
        return out('conflicting', null, null, [declaration, ...machine], distinctValues(entry.type, [declaration.value, ...machineValues]));
      }
      return out('user_confirmed', declaration.value, 'user_declaration', [declaration, ...machine]);
    }
  }
  if (machine.some(row => row.status === 'conflicting')) return out('conflicting', null, null, machine, distinctValues(entry.type, machineValues));
  if (productTerm && ida?.status === 'reviewed_reference') return out('reviewed_reference', ida.value, 'ida_wording', machine);
  if (own?.status === 'extracted_unverified') return out('extracted_unverified', own.value, 'own_pdf', [own]);
  return out('unknown', null, null, []);
}

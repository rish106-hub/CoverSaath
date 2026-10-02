// Section 11 — Household portfolio: is the household as a whole protected?
// Analysis section. analyze(context) derives household-level values deterministically from the
// extracted policy record (sections 1–9), the household member list and other policy records.
// It never returns Proven, never guesses, and never adds sums insured into one family figure.

import { defineSection } from '../contracts.js';

const BLOCKING_ORDER = ['NotPermitted', 'Conflicting', 'Unknown'];
const BASE_POLICY_TYPES = new Set(['individual', 'family_floater', 'group']);
const LAYER_POLICY_TYPES = new Set(['top_up', 'super_top_up']);
const CHILD_RELATIONSHIPS = new Set(['son', 'daughter', 'child', 'dependent child', 'dependent_child']);
const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'smt', 'shri', 'sri', 'shrimati', 'kumari', 'master', 'dr', 'baby']);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const readParameter = (record, key) => {
  if (!record) return null;
  if (typeof record.get === 'function') return record.get(key) ?? null;
  return record[key] ?? null;
};

/** Returns { ok: true, value } when Proven, else { ok: false, state, reason }. */
function input(record, key, label = 'this policy') {
  const stored = readParameter(record, key);
  if (!stored) return { ok: false, state: 'Unknown', reason: `${key} missing on ${label}` };
  const state = stored.evidenceState ?? 'Unknown';
  if (state === 'Proven' && stored.value) return { ok: true, value: stored.value };
  if (state === 'NotPermitted') return { ok: false, state: 'NotPermitted', reason: `${key} withheld by permission on ${label}` };
  if (state === 'Conflicting') return { ok: false, state: 'Conflicting', reason: `${key} is Conflicting on ${label}` };
  return { ok: false, state: 'Unknown', reason: `${key} is ${state} (not Proven) on ${label}` };
}

function blockingState(failures) {
  for (const state of BLOCKING_ORDER) if (failures.some(failure => failure.state === state)) return state;
  return 'Unknown';
}

export function normaliseName(raw) {
  if (typeof raw !== 'string') return '';
  const head = raw.split(/\s+[—–-]\s+|\(|,|\|/)[0] ?? '';
  const tokens = head
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  while (tokens.length > 1 && HONORIFICS.has(tokens[0])) tokens.shift();
  return tokens.join(' ');
}

const parseIsoDate = text => {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [y, m, d] = text.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return { y, m, d };
};

/** Completed years at `asOf`; null when either date is missing or invalid. */
export function ageInYears(dateOfBirth, asOf) {
  const dob = parseIsoDate(dateOfBirth);
  const at = parseIsoDate(asOf);
  if (!dob || !at) return null;
  let age = at.y - dob.y;
  if (at.m < dob.m || (at.m === dob.m && at.d < dob.d)) age -= 1;
  return age >= 0 ? age : null;
}

/** The date a person born on `dateOfBirth` reaches `years` of age (29 Feb → 28 Feb in non-leap years). */
function birthdayAtAge(dateOfBirth, years) {
  const dob = parseIsoDate(dateOfBirth);
  if (!dob) return null;
  const y = dob.y + years;
  const lastDay = new Date(Date.UTC(y, dob.m, 0)).getUTCDate();
  const d = Math.min(dob.d, lastDay);
  return `${String(y).padStart(4, '0')}-${String(dob.m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function formatInr(amountMinor) {
  const rupees = Math.round(amountMinor / 100);
  const digits = String(Math.abs(rupees));
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `₹${rupees < 0 ? '-' : ''}${rest ? `${rest},${lastThree}` : lastThree}`;
}

const isChild = member => CHILD_RELATIONSHIPS.has(String(member?.relationship ?? '').trim().toLowerCase());
const memberName = member => String(member?.displayName ?? member?.id ?? 'unnamed member');

function recordLabel(record, index) {
  const number = input(record, 'policy_number');
  if (index === 0) return number.ok ? `this policy (${number.value.text})` : 'this policy';
  return number.ok ? `other record ${index} (${number.value.text})` : `other record ${index}`;
}

// ---------------------------------------------------------------------------
// Result constructors
// ---------------------------------------------------------------------------

const result = (key, evidenceState, value, stateReason, derivedFrom, notes = null) =>
  ({ key, value: evidenceState === 'Calculated' || evidenceState === 'Dynamic' ? value : null, evidenceState, stateReason, derivedFrom, notes });

const blocked = (key, failures, derivedFrom, notes = null) =>
  result(key, blockingState(failures), null, failures.map(failure => failure.reason).join('; '), derivedFrom, notes);

const normaliseCity = city => (typeof city === 'string' ? city.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() : '');
const ADEQUACY_SUBLIMITS = Object.freeze({
  cataract: 'cataract_limit_per_eye',
  joint_replacement: 'joint_replacement_limit_per_joint',
  maternity_normal: 'maternity_normal_limit',
  maternity_csection: 'maternity_csection_limit',
});

/** Returns an error token for an unusable procedure-cost reference, or null. */
export function validateCostReference(reference) {
  for (const field of ['version', 'source', 'publishedOn']) if (typeof reference[field] !== 'string' || !reference[field].trim()) return `missing_${field}`;
  if (!parseIsoDate(reference.publishedOn)) return 'publishedOn_not_iso_date';
  if (!Array.isArray(reference.entries) || reference.entries.length === 0 || reference.entries.length > 5_000) return 'entries_must_be_1_to_5000';
  for (const entry of reference.entries) {
    if (!entry || typeof entry.city !== 'string' || typeof entry.procedure !== 'string') return 'entry_missing_city_or_procedure';
    for (const field of ['typicalCostMinor', 'highCostMinor']) if (!Number.isInteger(entry[field]) || entry[field] <= 0 || entry[field] > 10_000_000_000) return `entry_${field}_invalid`;
    if (entry.highCostMinor < entry.typicalCostMinor) return 'entry_high_below_typical';
  }
  return null;
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

function analyzeHousehold(context = {}) {
  const asOf = typeof context.asOf === 'string' ? context.asOf.slice(0, 10) : null;
  const primary = context.parameters ?? null;
  const otherRecords = Array.isArray(context.otherRecords) ? context.otherRecords : [];
  const records = [primary, ...otherRecords];
  const members = Array.isArray(context.household?.members) ? context.household.members : [];
  const references = context.references ?? {};
  const out = [];

  const noMembers = { state: 'Unknown', reason: 'household member list not supplied' };
  const noAsOf = { state: 'Unknown', reason: 'asOf date missing or invalid' };
  const asOfValid = parseIsoDate(asOf) !== null;

  // Coverage matching -------------------------------------------------------
  const matchRecord = (record, label) => {
    const insured = input(record, 'insured_members', label);
    if (!insured.ok) return { ok: false, failure: insured };
    const names = new Set((insured.value.items ?? []).map(normaliseName).filter(Boolean));
    return { ok: true, covered: new Set(members.filter(member => names.has(normaliseName(member.displayName))).map(member => member.id ?? member.displayName)) };
  };
  const primaryMatch = matchRecord(primary, 'this policy');
  const allMatches = records.map((record, index) => matchRecord(record, recordLabel(record, index)));
  const memberKey = member => member.id ?? member.displayName;
  const coveredAnywhere = new Set(allMatches.filter(match => match.ok).flatMap(match => [...match.covered]));
  const primaryCovered = primaryMatch.ok ? members.filter(member => primaryMatch.covered.has(memberKey(member))) : [];

  // members_with_evidenced_cover / members_without_evidenced_cover ---------------------------
  {
    const derivedFrom = ['insured_members'];
    if (members.length === 0) {
      out.push(blocked('members_with_evidenced_cover', [noMembers], derivedFrom));
      out.push(blocked('members_without_evidenced_cover', [noMembers], derivedFrom));
    } else {
      const failures = allMatches.filter(match => !match.ok).map(match => match.failure);
      const covered = members.filter(member => coveredAnywhere.has(memberKey(member))).map(memberName);
      const uncovered = members.filter(member => !coveredAnywhere.has(memberKey(member))).map(memberName);
      const reason = 'Matched household names against Proven insured_members items on every record (normalised name match; eligibility is not enrolment).';
      if (failures.length === 0) {
        out.push(result('members_with_evidenced_cover', 'Calculated', { kind: 'text_list', items: covered }, reason, derivedFrom));
        out.push(result('members_without_evidenced_cover', 'Calculated', { kind: 'text_list', items: uncovered }, reason, derivedFrom));
      } else {
        // Proven matches still evidence cover; absence cannot be concluded while a record is unreadable.
        if (covered.length > 0) {
          out.push(result('members_with_evidenced_cover', 'Calculated', { kind: 'text_list', items: covered },
            `${reason} Partial: ${failures.map(failure => failure.reason).join('; ')}.`, derivedFrom));
        } else {
          out.push(blocked('members_with_evidenced_cover', failures, derivedFrom));
        }
        if (uncovered.length === 0) {
          out.push(result('members_without_evidenced_cover', 'Calculated', { kind: 'text_list', items: [] }, reason, derivedFrom));
        } else {
          out.push(blocked('members_without_evidenced_cover', failures, derivedFrom,
            `Not named on any Proven insured list so far: ${uncovered.join(', ')}.`));
        }
      }
    }
  }

  // eldest_member_age_years -----------------------------------------------------------------
  {
    const derivedFrom = [];
    if (members.length === 0) out.push(blocked('eldest_member_age_years', [noMembers], derivedFrom));
    else if (!asOfValid) out.push(blocked('eldest_member_age_years', [noAsOf], derivedFrom));
    else {
      const missing = members.filter(member => ageInYears(member.dateOfBirth, asOf) === null).map(memberName);
      if (missing.length > 0) {
        out.push(blocked('eldest_member_age_years', [{ state: 'Unknown', reason: `date of birth missing or invalid for: ${missing.join(', ')}` }], derivedFrom));
      } else {
        const eldest = Math.max(...members.map(member => ageInYears(member.dateOfBirth, asOf)));
        out.push(result('eldest_member_age_years', 'Calculated', { kind: 'years', count: eldest },
          `Completed years at ${asOf} from household-supplied dates of birth (all household members, insured or not).`, derivedFrom));
      }
    }
  }

  // members_attracting_age_copay --------------------------------------------------------------
  const threshold = input(primary, 'copay_age_threshold_years');
  const copayPercent = input(primary, 'copay_age_percent');
  const agesFor = list => list.map(member => ({ member, age: asOfValid ? ageInYears(member.dateOfBirth, asOf) : null }));
  {
    const key = 'members_attracting_age_copay';
    const derivedFrom = ['insured_members', 'copay_age_threshold_years', 'copay_age_percent'];
    const failures = [];
    if (members.length === 0) failures.push(noMembers);
    if (!asOfValid) failures.push(noAsOf);
    if (!primaryMatch.ok) failures.push(primaryMatch.failure);
    if (!threshold.ok) failures.push(threshold);
    if (!copayPercent.ok) failures.push(copayPercent);
    if (failures.length > 0) out.push(blocked(key, failures, derivedFrom));
    else if (copayPercent.value.percent === 0) {
      out.push(result(key, 'Calculated', { kind: 'text_list', items: [] }, 'Age-based co-pay is Proven as 0%.', derivedFrom));
    } else {
      const aged = agesFor(primaryCovered);
      const missing = aged.filter(entry => entry.age === null).map(entry => memberName(entry.member));
      const attracting = aged.filter(entry => entry.age !== null && entry.age >= threshold.value.count).map(entry => memberName(entry.member));
      if (missing.length > 0) {
        out.push(blocked(key, [{ state: 'Unknown', reason: `date of birth missing for insured member(s): ${missing.join(', ')}` }], derivedFrom,
          attracting.length ? `Known so far: ${attracting.join(', ')}.` : null));
      } else {
        out.push(result(key, 'Calculated', { kind: 'text_list', items: attracting },
          `Insured members aged ${threshold.value.count} or above at ${asOf} (co-pay ${copayPercent.value.percent}%). Age at the time of a claim can differ.`, derivedFrom));
      }
    }
  }

  // floater_concentration_risk --------------------------------------------------------------
  {
    const key = 'floater_concentration_risk';
    const derivedFrom = ['sum_insured_structure', 'insured_members', 'copay_age_threshold_years'];
    const structure = input(primary, 'sum_insured_structure');
    if (!structure.ok) out.push(blocked(key, [structure], derivedFrom));
    else if (structure.value.enumValue !== 'family_floater') {
      out.push(result(key, 'Calculated', { kind: 'boolean', flag: false }, `Sum insured structure is ${structure.value.enumValue}, not a family floater.`, derivedFrom));
    } else {
      const failures = [];
      if (members.length === 0) failures.push(noMembers);
      if (!asOfValid) failures.push(noAsOf);
      if (!primaryMatch.ok) failures.push(primaryMatch.failure);
      if (!threshold.ok) failures.push({ ...threshold, reason: `${threshold.reason}; no age threshold to judge concentration` });
      if (failures.length > 0) out.push(blocked(key, failures, derivedFrom));
      else if (primaryCovered.length < 2) {
        out.push(result(key, 'Calculated', { kind: 'boolean', flag: false }, 'Fewer than two household members are named on the floater, so no pool is shared.', derivedFrom));
      } else {
        const aged = agesFor(primaryCovered);
        const high = aged.filter(entry => entry.age !== null && entry.age >= threshold.value.count).map(entry => memberName(entry.member));
        const missing = aged.filter(entry => entry.age === null).map(entry => memberName(entry.member));
        if (high.length > 0) {
          out.push(result(key, 'Calculated', { kind: 'boolean', flag: true },
            `Floater shared by ${primaryCovered.length} insured members; ${high.join(', ')} at or above the policy's age co-pay threshold of ${threshold.value.count}.`, derivedFrom));
        } else if (missing.length > 0) {
          out.push(blocked(key, [{ state: 'Unknown', reason: `date of birth missing for insured member(s): ${missing.join(', ')}` }], derivedFrom));
        } else {
          out.push(result(key, 'Calculated', { kind: 'boolean', flag: false },
            `No insured member is at or above the age co-pay threshold of ${threshold.value.count} at ${asOf}.`, derivedFrom));
        }
      }
    }
  }

  // next_cover_change_date / next_cover_change_reason ------------------------------------------
  {
    const derivedFrom = ['policy_end_date', 'insured_members', 'dependent_child_max_age_years'];
    const endDate = input(primary, 'policy_end_date');
    const failures = [];
    if (!endDate.ok) failures.push(endDate);
    if (!asOfValid) failures.push(noAsOf);
    let candidate = null;
    let notes = null;
    if (failures.length === 0) {
      candidate = { date: endDate.value.date, reason: endDate.value.date < asOf
        ? `Policy period ended on ${endDate.value.date}; renewal or lapse is pending.`
        : `Policy period ends on ${endDate.value.date} (renewal due).` };
      if (!primaryMatch.ok) failures.push(primaryMatch.failure);
      else {
        const children = primaryCovered.filter(isChild);
        if (children.length > 0) {
          const maxAge = input(primary, 'dependent_child_max_age_years');
          if (!maxAge.ok) failures.push({ ...maxAge, reason: `${maxAge.reason}; insured dependent child present` });
          else {
            const missing = children.filter(child => !parseIsoDate(child.dateOfBirth)).map(memberName);
            if (missing.length > 0) failures.push({ state: 'Unknown', reason: `date of birth missing for insured child: ${missing.join(', ')}` });
            else {
              const pastAgeOut = [];
              for (const child of children) {
                const reaches = birthdayAtAge(child.dateOfBirth, maxAge.value.count);
                if (reaches < asOf) { pastAgeOut.push(memberName(child)); continue; }
                if (reaches < candidate.date) {
                  candidate = { date: reaches, reason: `${memberName(child)} reaches the dependent-child maximum age of ${maxAge.value.count} on ${reaches}, before the policy end date ${endDate.value.date}.` };
                }
              }
              if (pastAgeOut.length) notes = `Already at or past the dependent-child maximum age of ${maxAge.value.count}: ${pastAgeOut.join(', ')}; confirm their cover at renewal.`;
            }
          }
        }
      }
    }
    if (failures.length > 0) {
      out.push(blocked('next_cover_change_date', failures, derivedFrom));
      out.push(blocked('next_cover_change_reason', failures, derivedFrom));
    } else {
      const reason = 'Earliest of this policy\'s end date and any insured dependent child reaching the policy\'s maximum child age.';
      out.push(result('next_cover_change_date', 'Calculated', { kind: 'date', date: candidate.date }, reason, derivedFrom, notes));
      out.push(result('next_cover_change_reason', 'Calculated', { kind: 'text', text: candidate.reason }, reason, derivedFrom, notes));
    }
  }

  // employer_cover_dependence_percent ----------------------------------------------------------
  {
    const key = 'employer_cover_dependence_percent';
    const derivedFrom = ['policy_type', 'sum_insured_amount'];
    const types = records.map((record, index) => ({ record, index, type: input(record, 'policy_type', recordLabel(record, index)) }));
    const groups = types.filter(entry => entry.type.ok && entry.type.value.enumValue === 'group');
    if (groups.length === 0) {
      const typeFailures = types.filter(entry => !entry.type.ok).map(entry => entry.type);
      const reason = 'No record is Proven to be a group (employer) policy, so employer dependence cannot be measured.';
      if (typeFailures.length > 0) out.push(blocked(key, typeFailures, derivedFrom));
      else out.push(result(key, 'Unknown', null, reason, derivedFrom));
    } else {
      const failures = types.filter(entry => !entry.type.ok).map(entry => entry.type);
      const base = types.filter(entry => entry.type.ok && BASE_POLICY_TYPES.has(entry.type.value.enumValue));
      const amounts = base.map(entry => ({ ...entry, si: input(entry.record, 'sum_insured_amount', recordLabel(entry.record, entry.index)) }));
      failures.push(...amounts.filter(entry => !entry.si.ok).map(entry => entry.si));
      if (failures.length > 0) out.push(blocked(key, failures, derivedFrom));
      else {
        const total = amounts.reduce((sum, entry) => sum + entry.si.value.amountMinor, 0);
        const group = amounts.filter(entry => entry.type.value.enumValue === 'group').reduce((sum, entry) => sum + entry.si.value.amountMinor, 0);
        if (total === 0) out.push(result(key, 'Unknown', null, 'Base sums insured total zero; share cannot be computed.', derivedFrom));
        else {
          const percent = Math.round((group / total) * 10_000) / 100;
          out.push(result(key, 'Calculated', { kind: 'percent', percent },
            `Group-policy sum insured as a share of all base indemnity sums insured (${base.length} records; top-up, fixed-benefit and critical-illness records excluded). This is a share of stated limits, not a guaranteed family amount.`, derivedFrom));
        }
      }
    }
  }

  // sum_insured_adequacy ------------------------------------------------------------------------
  // Compares this policy's stated limits (sum insured, and a procedure sub-limit when the record holds one) with a
  // dated city cost reference. Limits only: co-pays, deductibles and room-rent effects reduce payouts further.
  {
    const key = 'sum_insured_adequacy';
    const derivedFrom = ['sum_insured_amount', ...Object.values(ADEQUACY_SUBLIMITS)];
    const reference = references.procedureCostReference ?? null;
    const problem = reference ? validateCostReference(reference) : null;
    const city = normaliseCity(context.household?.city);
    const si = input(primary, 'sum_insured_amount');
    if (!reference) out.push(result(key, 'Unknown', null, 'No procedure-cost reference dataset is available (references.procedureCostReference is null), so adequacy against city treatment costs cannot be judged.', derivedFrom));
    else if (problem) out.push(result(key, 'Unknown', null, `procedure_cost_reference_invalid:${problem}`, derivedFrom));
    else if (asOf && reference.publishedOn > asOf) out.push(result(key, 'Unknown', null, 'procedure_cost_reference_published_after_analysis_date', derivedFrom));
    else if (!city) out.push(result(key, 'Unknown', null, 'household_city_unknown', derivedFrom));
    else if (!si.ok) out.push(blocked(key, [si], derivedFrom));
    else {
      const entries = reference.entries.filter(entry => normaliseCity(entry.city) === city);
      if (!entries.length) out.push(result(key, 'Unknown', null, 'no_cost_reference_for_city', derivedFrom));
      else {
        const lines = [];
        let shortCount = 0;
        for (const entry of entries) {
          const sublimitKey = ADEQUACY_SUBLIMITS[entry.procedure];
          const sublimit = sublimitKey ? input(primary, sublimitKey) : null;
          const cover = sublimit?.ok ? Math.min(si.value.amountMinor, sublimit.value.amountMinor) : si.value.amountMinor;
          const coverLabel = sublimit?.ok ? `sub-limit ${formatInr(cover)}` : `sum insured ${formatInr(cover)}`;
          const label = String(entry.procedure).replaceAll('_', ' ');
          if (cover >= entry.highCostMinor) lines.push(`${label}: ${coverLabel} covers the high-cost estimate ${formatInr(entry.highCostMinor)}.`);
          else if (cover >= entry.typicalCostMinor) lines.push(`${label}: ${coverLabel} covers the typical cost ${formatInr(entry.typicalCostMinor)} but not the high-cost estimate ${formatInr(entry.highCostMinor)}.`);
          else { shortCount += 1; lines.push(`${label}: ${coverLabel} is ${formatInr(entry.typicalCostMinor - cover)} below the typical cost ${formatInr(entry.typicalCostMinor)}.`); }
          if (sublimitKey && !sublimit?.ok && sublimit?.state !== 'Unknown') lines.push(`(${label} sub-limit is ${sublimit.state}; sum insured used.)`);
        }
        out.push(result(key, 'Dynamic', { kind: 'rule', text: `${shortCount ? `${shortCount} of ${entries.length}` : 'None of the'} referenced procedures exceed the stated limit at typical cost. ${lines.join(' ')} Limits only; co-pays, deductibles and room-rent rules reduce payouts further.` },
          `procedure_cost_reference ${reference.version} published ${reference.publishedOn} (${reference.source}); city ${entries[0].city}`, derivedFrom));
      }
    }
  }

  // layering_gap ----------------------------------------------------------------------------------
  {
    const key = 'layering_gap';
    const derivedFrom = ['policy_type', 'sum_insured_amount', 'topup_deductible_amount', 'deductible_amount'];
    const types = records.map((record, index) => ({ record, index, label: recordLabel(record, index), type: input(record, 'policy_type', recordLabel(record, index)) }));
    const layers = types.filter(entry => entry.type.ok && LAYER_POLICY_TYPES.has(entry.type.value.enumValue));
    if (layers.length === 0) {
      const typeFailures = types.filter(entry => !entry.type.ok).map(entry => entry.type);
      if (typeFailures.length > 0) out.push(blocked(key, typeFailures, derivedFrom));
      else out.push(result(key, 'Unknown', null, 'No top-up or super top-up record exists, so layering is not assessed.', derivedFrom));
    } else {
      const failures = types.filter(entry => !entry.type.ok).map(entry => entry.type);
      const bases = types.filter(entry => entry.type.ok && BASE_POLICY_TYPES.has(entry.type.value.enumValue))
        .map(entry => ({ ...entry, si: input(entry.record, 'sum_insured_amount', entry.label) }));
      // A top-up states its threshold as topup_deductible_amount; older records may only hold deductible_amount.
      const tops = layers.map(entry => {
        const threshold = input(entry.record, 'topup_deductible_amount', entry.label);
        return { ...entry, deductible: threshold.ok ? threshold : input(entry.record, 'deductible_amount', entry.label) };
      });
      failures.push(...bases.filter(entry => !entry.si.ok).map(entry => entry.si));
      failures.push(...tops.filter(entry => !entry.deductible.ok).map(entry => entry.deductible));
      if (bases.length === 0) failures.push({ state: 'Unknown', reason: 'no base indemnity record to layer on' });
      if (failures.length > 0) out.push(blocked(key, failures, derivedFrom));
      else {
        const lines = [];
        for (const top of tops) {
          const deductible = top.deductible.value.amountMinor;
          for (const base of bases) {
            const si = base.si.value.amountMinor;
            const head = `${top.label} deductible ${formatInr(deductible)} vs ${base.label} sum insured ${formatInr(si)}`;
            if (deductible > si) lines.push(`${head}: gap of ${formatInr(deductible - si)} paid by the household.`);
            else if (deductible < si) lines.push(`${head}: overlap of ${formatInr(si - deductible)}.`);
            else lines.push(`${head}: aligned.`);
          }
        }
        out.push(result(key, 'Calculated', { kind: 'rule', text: lines.join(' ') },
          'Each top-up deductible compared with each base sum insured separately; base sums insured are not added together.', derivedFrom));
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

const EXPERTISE = `Section 11 is an analysis section. No model reads policy text for it; deterministic code derives
household-level values from Proven values already extracted in sections 1–9, the household member list and
any other policy records the household holds.

Method:
- A household member counts as covered only when a Proven insured_members item names them after name
  normalisation (case, punctuation, honorifics such as Mr, Mrs, Smt, Shri and the relationship suffix are
  ignored). Being an eligible relationship under the wording is not enrolment.
- Ages are completed years at the analysis date from the household-supplied date of birth. A missing date of
  birth makes every value that depends on that member Unknown.
- Sums insured from different policies are never added into one guaranteed family figure. Floater limits are
  shared by everyone named on that floater.
- Age co-pay membership and floater concentration use the policy's own Proven age threshold. When the
  threshold is not Proven, both stay Unknown; no default age is assumed.
- The next cover change is the earliest of the policy end date and any insured dependent child reaching the
  policy's maximum child age.
- Employer dependence is measured only when a record is Proven to be a group policy. Layering is assessed only
  when a top-up or super top-up record exists. Adequacy compares stated limits with a dated procedure-cost
  reference for the household's city; without the reference or the city it is Unknown.
- Inputs that are Unknown, Conflicting or NotPermitted propagate. NotPermitted is never shown as Unknown.
- Values are facts about the record, not advice. Nothing here recommends buying, porting or dropping cover.`;

export default defineSection({
  number: 11,
  id: 'section-11-household',
  title: 'Household portfolio',
  question: 'Is the household as a whole protected?',
  kind: 'analysis',
  expertise: EXPERTISE,
  parameters: [
    {
      key: 'members_without_evidenced_cover',
      label: 'Members without evidenced cover',
      description: 'Household members not named in any Proven insured_members list across all supplied records. Eligibility under a definition is not enrolment. Empty list means every household member is named somewhere.',
      valueType: 'text_list', effects: ['inform'], bases: ['per_person'],
      critical: true, visibility: 'cover', emergencyCard: true,
      derivedFrom: ['insured_members'],
    },
    {
      key: 'members_with_evidenced_cover',
      label: 'Members with evidenced cover',
      description: 'Household members named in at least one Proven insured_members list across all supplied records, matched by normalised name.',
      valueType: 'text_list', effects: ['inform'], bases: ['per_person'],
      visibility: 'cover',
      derivedFrom: ['insured_members'],
    },
    {
      key: 'floater_concentration_risk',
      label: 'Floater concentration risk',
      description: 'True when this policy is a family floater shared by two or more named household members and at least one is at or above the policy\'s own age co-pay threshold. Unknown when that threshold is not Proven.',
      valueType: 'boolean', effects: ['inform'], bases: ['per_policy'],
      visibility: 'cover',
      derivedFrom: ['sum_insured_structure', 'insured_members', 'copay_age_threshold_years'],
    },
    {
      key: 'eldest_member_age_years',
      label: 'Eldest household member age',
      description: 'Completed years at the analysis date of the oldest household member, from household-supplied dates of birth. Unknown if any date of birth is missing.',
      valueType: 'years', effects: ['inform'], bases: ['per_person'],
      visibility: 'operational',
      validate: value => (value.count > 130 ? 'age_out_of_range' : null),
    },
    {
      key: 'members_attracting_age_copay',
      label: 'Members attracting age co-pay',
      description: 'Insured members of this policy whose age at the analysis date is at or above the Proven age co-pay threshold. Age at the time of an actual claim may differ.',
      valueType: 'text_list', effects: ['pay_percent'], bases: ['per_claim'],
      critical: true, visibility: 'cover', estimateInput: true,
      derivedFrom: ['insured_members', 'copay_age_threshold_years', 'copay_age_percent'],
    },
    {
      key: 'next_cover_change_date',
      label: 'Next cover change date',
      description: 'Earliest of this policy\'s Proven end date and the date any insured dependent child reaches the Proven maximum dependent-child age.',
      valueType: 'date', effects: ['inform'], bases: ['per_policy'],
      visibility: 'cover',
      derivedFrom: ['policy_end_date', 'insured_members', 'dependent_child_max_age_years'],
    },
    {
      key: 'next_cover_change_reason',
      label: 'Next cover change reason',
      description: 'Why the next cover change date applies: policy end (renewal) or a named child reaching the maximum dependent age.',
      valueType: 'text', effects: ['inform'], bases: ['per_policy'],
      visibility: 'cover',
      derivedFrom: ['policy_end_date', 'insured_members', 'dependent_child_max_age_years'],
    },
    {
      key: 'employer_cover_dependence_percent',
      label: 'Employer cover dependence',
      description: 'Share (0–100) of base indemnity sums insured that comes from records Proven to be group policies. Measured only when a group record exists; a share of stated limits, not a guaranteed amount.',
      valueType: 'percent', effects: ['inform'], bases: ['per_policy'],
      visibility: 'cover',
      derivedFrom: ['policy_type', 'sum_insured_amount'],
    },
    {
      key: 'sum_insured_adequacy',
      label: 'Sum insured adequacy',
      description: 'This policy\'s stated limits (sum insured, or a procedure sub-limit when held) versus a dated city procedure-cost reference for the household\'s city. Dynamic while the reference is dated; Unknown without a reference or a household city.',
      valueType: 'rule', effects: ['inform'], bases: ['per_policy'],
      visibility: 'cover',
      derivedFrom: ['sum_insured_amount'],
    },
    {
      key: 'layering_gap',
      label: 'Layering gap or overlap',
      description: 'For each top-up or super top-up record, its Proven deductible compared with each base record\'s Proven sum insured: a gap (deductible above base SI, paid by the household), an overlap, or aligned.',
      valueType: 'rule', effects: ['inform'], bases: ['per_policy'],
      visibility: 'cover',
      derivedFrom: ['policy_type', 'sum_insured_amount', 'deductible_amount'],
    },
  ],
  analyze: analyzeHousehold,
  reviewGuidance: 'Check that every household member\'s display name matches the certificate spelling; a mismatch shows a covered person as uncovered. Confirm dates of birth with the member. For members_attracting_age_copay, confirm the age co-pay threshold and whether the wording measures age at claim, at entry or at renewal. For next_cover_change_date, confirm whether a child\'s cover ends on the birthday or at the following renewal.',
});

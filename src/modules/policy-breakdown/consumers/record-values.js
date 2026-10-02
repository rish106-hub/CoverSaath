// Helpers for consumers that read a policy record. Consumers never read page text or call models.

export const USABLE_STATES = Object.freeze(['Proven', 'Calculated', 'Dynamic', 'Reported']);

/** Returns the parameter result when its value is usable, else null. */
export function usable(parameters, key) {
  const result = parameters[key];
  if (!result || !result.value || !USABLE_STATES.includes(result.evidenceState)) return null;
  return result;
}

export const moneyOf = (parameters, key) => usable(parameters, key)?.value.amountMinor ?? null;
export const percentOf = (parameters, key) => usable(parameters, key)?.value.percent ?? null;
export const countOf = (parameters, key) => usable(parameters, key)?.value.count ?? null;
export const flagOf = (parameters, key) => { const result = usable(parameters, key); return result ? result.value.flag : null; };
export const enumOf = (parameters, key) => usable(parameters, key)?.value.enumValue ?? null;
export const textOf = (parameters, key) => { const result = usable(parameters, key); return result ? (result.value.text ?? null) : null; };
export const dateOf = (parameters, key) => usable(parameters, key)?.value.date ?? null;
export const listOf = (parameters, key) => usable(parameters, key)?.value.items ?? null;

/** A compact, display-ready field: value + state + where it came from. */
export function fieldView(parameters, key) {
  const result = parameters[key];
  if (!result) return { key, label: key, value: null, evidenceState: 'Unknown', reviewState: 'unreviewed', source: null };
  const citation = result.citations?.find(item => item.matched) ?? null;
  return {
    key,
    label: result.label,
    value: USABLE_STATES.includes(result.evidenceState) ? result.value : null,
    display: displayValue(USABLE_STATES.includes(result.evidenceState) ? result.value : null, result),
    evidenceState: result.evidenceState,
    stateReason: result.stateReason ?? null,
    reviewState: result.review?.state ?? 'unreviewed',
    conditions: result.conditions ?? [],
    source: citation ? { documentId: citation.documentId, pageNumber: citation.pageNumber, quote: citation.quote } : null,
  };
}

const rupees = minor => `₹${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

export function displayValue(value, result = {}) {
  if (!value) return null;
  switch (value.kind) {
    case 'money': return rupees(value.amountMinor) + (result.basis && result.basis !== 'not_applicable' ? ` ${result.basis.replaceAll('_', ' ')}` : '');
    case 'percent': return `${value.percent}%`;
    case 'days': case 'months': case 'years': return `${value.count} ${value.kind}`;
    case 'count': return String(value.count);
    case 'boolean': return value.flag ? 'Yes' : 'No';
    case 'enum': return value.enumValue.replaceAll('_', ' ');
    case 'date': return value.date;
    case 'text': case 'rule': return value.text;
    case 'text_list': return value.items.join('; ');
    default: return null;
  }
}

export function ageOn(dateOfBirth, onDate) {
  if (!dateOfBirth || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return null;
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [y, m, d] = onDate.slice(0, 10).split('-').map(Number);
  return y - by - ((m < bm || (m === bm && d < bd)) ? 1 : 0);
}

export const formatRupees = rupees;

/**
 * How a consumer may treat a reducer: 'value' (usable), 'absent' (a person confirmed the pack does not state
 * it), 'not_stated' (extraction found no clause; unconfirmed), 'withheld' (NotPermitted) or 'unknown'.
 */
export function limitStatus(parameters, key) {
  if (usable(parameters, key)) return 'value';
  const result = parameters[key];
  if (result?.evidenceState === 'NotPermitted') return 'withheld';
  if (result?.evidenceState === 'Unknown' && result.review?.state === 'confirmed_absent') return 'absent';
  // The extractor read the whole pack and found no such clause (and, for critical parameters, the blind
  // verifier agreed). Consumers may treat it as not applying but must say so.
  if (result?.evidenceState === 'Unknown' && result.stateReason === 'not_found_in_source_pack' && ['not_required', 'agrees_absent', undefined].includes(result.verification?.verifier)) return 'not_stated';
  // The pack states this only for other named members, every one of those values verified.
  if (result?.evidenceState === 'Unknown' && result.stateReason === 'stated_only_for_other_members') return 'not_stated';
  return 'unknown';
}

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'smt', 'shri', 'sri', 'shrimati', 'kumari', 'master', 'dr', 'baby']);

/** One name normalisation for every consumer: lower case, letters only, relationship suffix and honorifics dropped. */
export function normalisePersonName(raw) {
  const head = String(raw ?? '').split(/\s+[—–-]\s+|\(|,|\|/)[0] ?? '';
  const tokens = head.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && HONORIFICS.has(tokens[0])) tokens.shift();
  return tokens.join(' ');
}

// Relationship words a scope may use instead of names ("Dependent Parents", "Self", "Children").
const RELATIONSHIP_GROUPS = Object.freeze({
  self: ['self', 'employee', 'proposer', 'primary', 'policyholder'],
  spouse: ['spouse', 'wife', 'husband', 'partner'],
  child: ['son', 'daughter', 'child', 'children', 'kids'],
  parent: ['mother', 'father', 'parent', 'parents', 'mother in law', 'father in law', 'parents in law'],
  sibling: ['brother', 'sister', 'sibling', 'siblings'],
});
const relationshipGroup = text => {
  const words = ` ${String(text ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim()} `;
  return Object.entries(RELATIONSHIP_GROUPS).filter(([, terms]) => terms.some(term => words.includes(` ${term} `))).map(([group]) => group);
};

function scopeParts(scope) {
  return String(scope ?? '').split(/;|,|\/|&|\band\b/i).map(part => part.trim()).filter(Boolean);
}

/** 'member' (the scope names this member or their relationship), 'other' (it names someone else for certain) or 'unclear'. */
function scopeMatch(scope, member, insuredNames) {
  const name = normalisePersonName(member.displayName);
  const memberGroups = relationshipGroup(member.relationship);
  const parts = scopeParts(scope);
  if (parts.some(part => normalisePersonName(part) === name)) return 'member';
  if (parts.some(part => relationshipGroup(part).some(group => memberGroups.includes(group)))) return 'member';
  // Certain only when every part is a different insured person's name.
  return parts.length && parts.every(part => { const other = normalisePersonName(part); return other !== name && insuredNames.has(other); }) ? 'other' : 'unclear';
}

/**
 * Returns a parameters view for one member: where a parameter has a member-specific variant naming this
 * member (by name, ignoring honorifics, or by relationship group), the variant's value and state replace the
 * policy-wide ones. A value stated only for other named insured persons reads as not stated for this member;
 * a scope that cannot be resolved with certainty leaves the parameter Unknown, so it widens ranges.
 */
export function resolveForMember(parameters, member) {
  if (!member?.displayName) return parameters;
  const insuredNames = new Set((usable(parameters, 'insured_members')?.value.items ?? []).map(normalisePersonName).filter(Boolean));
  const view = { ...parameters };
  for (const [key, result] of Object.entries(parameters)) {
    if (!result?.memberVariants?.length) continue;
    const matches = result.memberVariants.map(item => ({ item, match: scopeMatch(item.memberScope, member, insuredNames) }));
    const variant = matches.find(entry => entry.match === 'member')?.item;
    if (variant) {
      view[key] = { ...result, value: variant.value, evidenceState: variant.evidenceState, stateReason: `member_variant:${variant.stateReason ?? ''}`, citations: variant.citations ?? result.citations, conditions: variant.conditions ?? result.conditions, memberScope: variant.memberScope };
    } else if (result.stateReason === 'member_specific_values_only' && matches.every(entry => entry.match === 'other' && entry.item.evidenceState === 'Proven')) {
      view[key] = { ...result, stateReason: 'stated_only_for_other_members', notes: `Stated only for: ${result.memberVariants.map(item => item.memberScope).join(', ')}.` };
    }
  }
  return view;
}

/** The variants of a parameter as usable values, for consumers that must bound across members. */
export function provenVariants(parameters, key) {
  return (parameters[key]?.memberVariants ?? []).filter(item => item.evidenceState === 'Proven' && item.value);
}

import { NOT_STATED, emptyParameterResult, normaliseValue } from '../contracts.js';
import { valueSupportedByQuotes, verifyCitations } from '../verification/citations.js';

// Deterministic assembly of one extraction section. Models propose; this file decides evidence state.
//
// Proven     : found, value normalises, every citation quote verified on page text, the value appears in
//              a quote (numbers, dates, identifiers), and — for critical parameters — the blind verifier
//              found the same value for the same member scope.
// Conflicting: two different values for the same scope, or the verifier disagrees with the extractor.
// Unknown    : not found, invalid, unverified, or only member-specific values exist (kept as variants).

const tokenOrNull = value => (value == null || value === NOT_STATED ? null : value);
const trimList = list => (Array.isArray(list) ? list.map(item => String(item).trim()).filter(Boolean) : []);
const scopeKey = item => (item.memberScope ? item.memberScope.trim().toLowerCase().replace(/\s+/g, ' ') : '');

const ENTITY_SUFFIXES = [[/\blimited\b/g, 'ltd'], [/\bcompany\b/g, 'co'], [/\bprivate\b/g, 'pvt'], [/\bcorporation\b/g, 'corp']];
function canonicalText(text) {
  let value = String(text).toLowerCase();
  for (const [pattern, replacement] of ENTITY_SUFFIXES) value = value.replace(pattern, replacement);
  return value.replace(/[^a-z0-9]+/g, '');
}

/** Returns true, false, or 'not_comparable' (free-text rules need a person). */
export function valuesEqual(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'money': return left.amountMinor === right.amountMinor;
    case 'percent': return Math.abs(left.percent - right.percent) < 0.005;
    case 'days': case 'months': case 'years': case 'count': return left.count === right.count;
    case 'boolean': return left.flag === right.flag;
    case 'enum': return left.enumValue === right.enumValue;
    case 'date': return left.date === right.date;
    case 'text_list': {
      const normalise = items => [...new Set(items.map(item => item.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()))].sort();
      return JSON.stringify(normalise(left.items)) === JSON.stringify(normalise(right.items));
    }
    // Identifiers, names and phone numbers must match exactly after canonicalisation.
    case 'text': return canonicalText(left.text) === canonicalText(right.text);
    case 'rule': return 'not_comparable';
    default: return false;
  }
}

function candidateFromItem(parameter, item, pagesByNumber) {
  const normalised = normaliseValue(parameter, item);
  const citations = (item.citations ?? []).slice(0, 5);
  const verification = verifyCitations(citations, pagesByNumber);
  const valueProblem = normalised.ok && verification.allMatched
    ? valueSupportedByQuotes(normalised.value, verification.results.map(result => result.quote))
    : null;
  return {
    item,
    normalised,
    verification,
    valueProblem,
    citations: verification.results.map(result => ({
      documentId: pagesByNumber.get(result.pageNumber)?.documentId ?? null,
      pageNumber: pagesByNumber.get(result.pageNumber)?.localPageNumber ?? result.pageNumber,
      packPage: result.pageNumber,
      quote: result.quote,
      matched: result.matched,
      matchMethod: result.method,
    })),
  };
}

/** Evidence state of a single candidate before verifier comparison. */
function candidateState(candidate) {
  if (!candidate.normalised.ok) return ['Unknown', `value_invalid:${candidate.normalised.reason}`];
  if (!candidate.verification.allMatched) return ['Unknown', candidate.citations.length ? 'citation_not_found_in_page_text' : 'no_citation_supplied'];
  if (candidate.valueProblem) return ['Unknown', candidate.valueProblem];
  return ['Proven', 'citations_verified'];
}

function baseResult(parameter, candidate, extraction) {
  const { item, normalised } = candidate;
  const [state, reason] = candidateState(candidate);
  return {
    ...emptyParameterResult(parameter),
    value: state === 'Proven' ? normalised.value : null,
    proposedValue: state === 'Proven' ? null : (normalised.ok ? normalised.value : { valueText: item.valueText ?? null, valueNumber: item.valueNumber ?? null, valueBoolean: item.valueBoolean ?? null, valueList: item.valueList ?? null }),
    unit: item.unit ?? null,
    basis: tokenOrNull(item.basis),
    effect: tokenOrNull(item.effect),
    memberScope: item.memberScope ?? null,
    conditions: trimList(item.conditions),
    exceptions: trimList(item.exceptions),
    citations: candidate.citations,
    confidence: item.confidence ?? null,
    notes: item.notes ?? null,
    evidenceState: state,
    stateReason: reason,
    extraction,
  };
}

function compareWithVerifier(parameter, candidate, verifierItems, pagesByNumber) {
  if (!verifierItems) return { verifier: 'not_run' };
  const sameScope = verifierItems.filter(item => item.found === true && scopeKey(item) === scopeKey(candidate.item));
  if (sameScope.length === 0) return { verifier: 'found_nothing' };
  const verifierCandidate = candidateFromItem(parameter, sameScope[0], pagesByNumber);
  const equal = verifierCandidate.normalised.ok && candidate.normalised.ok ? valuesEqual(verifierCandidate.normalised.value, candidate.normalised.value) : false;
  return {
    verifier: equal === 'not_comparable' ? 'needs_human_comparison' : equal ? 'agrees' : 'disagrees',
    verifierValue: verifierCandidate.normalised.ok ? verifierCandidate.normalised.value : null,
    verifierCitations: verifierCandidate.citations,
  };
}

/** Applies the verifier outcome to a Proven critical value. */
function applyVerifier(target, outcome) {
  if (target.evidenceState !== 'Proven') return;
  if (outcome.verifier === 'not_run') { target.proposedValue = target.value; target.value = null; target.evidenceState = 'Unknown'; target.stateReason = 'critical_parameter_not_independently_verified'; }
  else if (outcome.verifier === 'found_nothing') { target.evidenceState = 'Conflicting'; target.stateReason = 'verifier_found_no_value'; }
  else if (outcome.verifier === 'disagrees') { target.evidenceState = 'Conflicting'; target.stateReason = 'verifier_disagrees'; }
}

/**
 * @param section     section definition
 * @param extracted   model output { parameters: [...] } from the section agent
 * @param verified    model output from the blind verifier for critical parameters, or null
 * @param pages       [{ pageNumber, localPageNumber, text, documentId }]
 * @returns parameter results keyed by parameter key (+ memberVariants for member-scoped values)
 */
export function assembleExtractionSection({ section, extracted, verified = null, pages, extraction, verifierExtraction = null }) {
  const pagesByNumber = new Map(pages.map(page => [page.pageNumber, page]));
  const byKey = new Map(section.parameters.map(parameter => [parameter.key, []]));
  const maxItems = section.parameters.length * 3;
  for (const item of (extracted?.parameters ?? []).slice(0, maxItems)) if (byKey.has(item?.key)) byKey.get(item.key).push(item);
  const verifierByKey = new Map();
  for (const item of (verified?.parameters ?? []).slice(0, maxItems)) {
    if (!byKey.has(item?.key)) continue;
    if (!verifierByKey.has(item.key)) verifierByKey.set(item.key, []);
    verifierByKey.get(item.key).push(item);
  }

  const results = {};
  for (const parameter of section.parameters) {
    const found = byKey.get(parameter.key).filter(item => item.found === true);
    const verifierItems = parameter.critical ? (verifierByKey.get(parameter.key) ?? (verified ? [] : null)) : undefined;
    const verifierFound = (verifierItems ?? []).filter(item => item.found === true);

    if (found.length === 0) {
      const result = emptyParameterResult(parameter, { reason: 'not_found_in_source_pack' });
      result.extraction = extraction;
      if (parameter.critical && verifierFound.length > 0) {
        const candidate = candidateFromItem(parameter, verifierFound[0], pagesByNumber);
        Object.assign(result, baseResult(parameter, candidate, verifierExtraction ?? extraction), { value: null, proposedValue: candidate.normalised.ok ? candidate.normalised.value : null, evidenceState: 'Conflicting', stateReason: 'extractor_found_nothing_but_verifier_found_a_value' });
      }
      result.verification = { verifier: parameter.critical ? (verifierItems ? (verifierFound.length ? 'found_value' : 'agrees_absent') : 'not_run') : 'not_required' };
      results[parameter.key] = result;
      continue;
    }

    const candidates = found.map(item => candidateFromItem(parameter, item, pagesByNumber));
    const groups = new Map();
    for (const candidate of candidates) {
      const key = scopeKey(candidate.item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(candidate);
    }

    // Member-scoped variants: each verified independently; never promoted to the policy-wide value.
    const variants = [...groups.entries()].filter(([key]) => key !== '').map(([, group]) => {
      const candidate = group[0];
      const variant = baseResult(parameter, candidate, extraction);
      if (group.some(other => other !== candidate && other.normalised.ok && candidate.normalised.ok && valuesEqual(other.normalised.value, candidate.normalised.value) === false)) {
        variant.evidenceState = 'Conflicting'; variant.stateReason = 'pack_states_different_values'; variant.value = null;
      }
      if (parameter.critical) { variant.verification = compareWithVerifier(parameter, candidate, verifierItems, pagesByNumber); applyVerifier(variant, variant.verification); }
      return { memberScope: candidate.item.memberScope, value: variant.value, evidenceState: variant.evidenceState, stateReason: variant.stateReason, conditions: variant.conditions, citations: variant.citations, verification: variant.verification ?? { verifier: 'not_required' } };
    });

    const primaryGroup = groups.get('');
    let result;
    if (!primaryGroup) {
      result = { ...emptyParameterResult(parameter, { reason: 'member_specific_values_only' }), extraction, verification: { verifier: parameter.critical ? 'see_member_variants' : 'not_required' } };
    } else {
      const primary = primaryGroup[0];
      result = baseResult(parameter, primary, extraction);
      const disagreement = primaryGroup.some(other => other !== primary && other.normalised.ok && primary.normalised.ok && valuesEqual(other.normalised.value, primary.normalised.value) === false);
      if (result.evidenceState === 'Proven' && disagreement) {
        result.evidenceState = 'Conflicting';
        result.stateReason = 'pack_states_different_values';
        result.alternatives = primaryGroup.filter(other => other !== primary).map(other => ({ value: other.normalised.ok ? other.normalised.value : null, citations: other.citations, conditions: trimList(other.item.conditions) }));
      }
      if (parameter.critical) { result.verification = compareWithVerifier(parameter, primary, verifierItems, pagesByNumber); applyVerifier(result, result.verification); }
      else result.verification = { verifier: 'not_required' };
    }
    if (variants.length) result.memberVariants = variants;
    results[parameter.key] = result;
  }
  return results;
}

// Which Block 3 rules matter to which scenario, and how a free-text topic is matched to an item topic. Matching is a
// plain token comparison: it never classifies a diagnosis, creates a procedure code or resolves a hospital.

export const RESTRICTIVE_RULES = Object.freeze(['exclusion', 'waiting_period', 'copay', 'deductible', 'sublimit', 'room_rent_limit', 'icu_limit']);
export const OVERLAP_RULES = Object.freeze(['sublimit', 'room_rent_limit', 'icu_limit', 'restoration', 'bonus', 'add_on']);
const TOPIC_REQUIRED_RULES = Object.freeze(['sublimit', 'add_on', 'exclusion']);

const CORE_RULES = ['member_enrolment', 'policy_period', 'sum_insured', 'waiting_period', 'copay', 'deductible', 'continuous_cover'];
const CORE_BY_SCENARIO = Object.freeze({
  planned_procedure: CORE_RULES,
  general_benefit: CORE_RULES,
  policy_comparison: [...CORE_RULES, 'room_rent_limit', 'icu_limit', 'restoration'],
  emergency_admission: ['member_enrolment', 'policy_period', 'sum_insured', 'claim_documents', 'network_status'],
  cashless_information: ['member_enrolment', 'policy_period', 'network_status', 'claim_documents'],
});

const GENERIC_PROCEDURE_TERMS = new Set([
  'surgery', 'operation', 'procedure', 'treatment', 'hospitalisation', 'hospitalization', 'admission', 'admit', 'admitted', 'stay', 'care',
  'a', 'an', 'the', 'my', 'his', 'her', 'for', 'of', 'to', 'at', 'in', 'on', 'and', 'needs', 'need', 'planned', 'medical', 'health', 'something', 'some', 'any', 'major', 'minor', 'big', 'small', 'is', 'be', 'has', 'have', 'will', 'father', 'mother', 'wife', 'husband',
  // Explicit uncertainty ("I don't know", "not sure", the answer sentinels) names no procedure.
  'i', 'we', 'you', 'do', 'doe', 'don', 't', 'know', 'not', 'sure', 'unsure', 'unknown', 'skipped', 'idea', 'no', 'yet', 'decided', 'unclear', 'maybe', 'tbd', 'dunno', 'cannot', 'nothing', 'say', 'tell',
  'want', 'please', 'hospital', 'this', 'that', 'it', 'with', 'by', 'from', 'as', 'am', 'are', 'was', 'would', 'like', 'going', 'get', 'getting', 'undergo', 'doing', 'doctor', 'advised', 'suggested',
  'eye', 'ear', 'nose', 'throat', 'heart', 'knee', 'hip', 'back', 'spine', 'stomach', 'kidney', 'brain', 'leg', 'arm', 'tooth', 'teeth', 'bone', 'skin', 'chest',
]);

// Plain plural trimming that leaves words whose singular ends in s (diagnosis, bypass, status, this) alone.
const singular = token => {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !/(?:ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
};

export const tokensOf = value => (typeof value === 'string'
  ? value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean).map(singular)
  : []);

/** True when the item topic's tokens appear, in order and adjacent, in any scenario text. */
export function topicMatches(itemTopic, texts) {
  const needle = tokensOf(itemTopic);
  if (!needle.length) return false;
  return texts.some(text => {
    const hay = tokensOf(text);
    for (let i = 0; i + needle.length <= hay.length; i += 1) if (needle.every((token, j) => hay[i + j] === token)) return true;
    return false;
  });
}

export const isSpecificProcedure = text => tokensOf(text).some(token => !GENERIC_PROCEDURE_TERMS.has(token));

export function scenarioTexts(scenario) {
  return [scenario.procedureText, scenario.topic, scenario.effective.procedureDetail, scenario.effective.topicDetail].filter(Boolean);
}

/** Relevant to the scenario: a topic-matched item, or a core rule of a general (no-topic) item. Never widens a state. */
export function isRelevant(item, scenario) {
  if (item.topic !== '') return topicMatches(item.topic, scenarioTexts(scenario));
  if (TOPIC_REQUIRED_RULES.includes(item.rule)) return false;
  return CORE_BY_SCENARIO[scenario.scenarioType].includes(item.rule);
}

export const coreRules = scenarioType => CORE_BY_SCENARIO[scenarioType];

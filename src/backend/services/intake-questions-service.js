import { getPolicyFactKey } from '../../contracts/policy-facts.js';
import { CATALOGUE_V1, QUESTION_CATALOGUE_VERSION, planNextQuestions, recordAnswer } from '../../features/question-planner/index.js';

// Intake questions for one holding (architecture v1 section 3, question planner #139). Deterministic: no model call, no text is
// produced here. The planner returns catalogue ids; the client renders the reviewed catalogue wording (FOR LEGAL REVIEW).
//
// Store: an answer is a user_declaration row in household_memory_facts (capture_method box_confirm, status user_confirmed, value
// sealed), written by MemoryFactRepository.insertFact under the household's profile_intake consent grant. No new table: erasure is
// the existing memory erasure (household, member, consent grant, document; memory-erasure.js) and the value is sealed there.
// "Not sure" writes nothing (the user tier holds only user_confirmed, ADR 0023 D2). Known gap: without a stored log, a "not sure"
// slot is asked again on the next plan instead of being held back for 30 days.

const PHASES = new Set(['before_card', 'strip']);
const MEMBER_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const invalid = (message, code = 'INTAKE_REQUEST_INVALID') => Object.assign(new Error(message), { code, statusCode: 400 });

const itemFor = (factKey, scopeKey) => CATALOGUE_V1.find(item => item.slot.factKey === factKey && (item.slot.scopeKey ?? '') === (scopeKey ?? ''));

/** The client-facing part of a catalogue item: wording, input and flags. No slot or scoring internals. */
export function catalogueEntry(id) {
  const item = CATALOGUE_V1.find(entry => entry.id === id);
  if (!item) return null;
  return {
    id: item.id, prompt: item.prompt, why: item.why, input: item.input, sensitivity: item.sensitivity, phase: item.phase,
    perMember: item.perMember === true, followups: item.followups, legalReview: item.legalReview,
  };
}

/** Stored value from the picked option ids: yes/no becomes a boolean for a bool key, one pick a string, chips a sorted array. */
export function storedValueOf(answer) {
  const type = getPolicyFactKey(answer.factKey)?.type;
  if (type === 'bool' && typeof answer.value === 'string' && ['yes', 'no'].includes(answer.value)) return answer.value === 'yes';
  return answer.value;
}

/** Option ids back from a stored value (the planner's answered log needs them for followups). */
export function optionIdsOf(value) {
  if (value === true) return ['yes'];
  if (value === false) return ['no'];
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string');
  return typeof value === 'string' ? [value] : [];
}

/** True when a YYYY-MM-DD birth date makes the member under 18 at `now`; unknown dates are not minors (planner R2 only narrows). */
export function isMinorOn(dateOfBirth, now) {
  if (typeof dateOfBirth !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return false;
  const born = Date.parse(`${dateOfBirth}T00:00:00Z`);
  if (!Number.isFinite(born)) return false;
  const b = new Date(born);
  return new Date(now).getTime() < Date.UTC(b.getUTCFullYear() + 18, b.getUTCMonth(), b.getUTCDate());
}

export function createIntakeQuestionsService({ database, memoryFacts, clock = () => new Date() }) {
  if (!database || !memoryFacts) throw new TypeError('database and memoryFacts are required.');

  async function members(householdId, now) {
    const rows = await database.many(`SELECT id, member_kind, date_of_birth FROM household_members
      WHERE household_id = ? ORDER BY created_at, id`, [householdId]);
    return rows.map(row => ({ id: row.id, isMinor: isMinorOn(row.date_of_birth, now) }));
  }

  async function plan({ holding, adultId, phase = 'before_card' }) {
    if (!PHASES.has(phase)) throw invalid('phase must be before_card or strip.');
    const now = clock();
    const householdId = holding.householdId;
    const [people, current] = await Promise.all([
      members(householdId, now),
      memoryFacts.listCurrent({ householdId, adultId, holdingId: holding.id }),
    ]);
    // One slot per (key, scope, member): a user declaration wins over a machine reading for the planner's "needs asking" test.
    const slots = new Map();
    const answeredLog = [];
    for (const fact of current.facts) {
      const id = `${fact.factKey}|${fact.scopeKey ?? ''}|${fact.memberId ?? ''}`;
      if (!slots.has(id) || fact.tier === 'user_declaration') {
        slots.set(id, { factKey: fact.factKey, scopeKey: fact.scopeKey || undefined, memberId: fact.memberId ?? null, status: fact.status });
      }
      if (fact.tier !== 'user_declaration') continue;
      const item = itemFor(fact.factKey, fact.scopeKey);
      if (item) answeredLog.push({ questionId: item.id, memberId: fact.memberId ?? null, outcome: 'answered', optionIds: optionIdsOf(fact.value), answeredAt: fact.createdAt });
    }
    const questions = planNextQuestions({ slots: [...slots.values()], members: people, answeredLog, now, phase });
    // The reviewed catalogue entries for the returned ids (static wording from code, FOR LEGAL REVIEW; never model text), so a
    // client renders exactly this catalogue version instead of keeping its own copy.
    const catalogue = Object.fromEntries([...new Set(questions.map(q => q.questionId))].map(id => [id, catalogueEntry(id)]));
    return { catalogueVersion: QUESTION_CATALOGUE_VERSION, phase, questions, catalogue, truncated: current.truncated === true };
  }

  async function answer({ holding, adultId, body }) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('The body must be an object.');
    const memberId = body.memberId ?? null;
    if (memberId !== null && (typeof memberId !== 'string' || !MEMBER_ID.test(memberId))) throw invalid('memberId is invalid.');
    if (typeof body.consentGrantId !== 'string' || !body.consentGrantId || body.consentGrantId.length > 100) throw invalid('consentGrantId is required.');
    const recorded = recordAnswer({ questionId: body.questionId, memberId, optionIds: body.optionIds, catalogueVersion: body.catalogueVersion });
    if (memberId !== null) {
      const member = await database.one('SELECT id FROM household_members WHERE id = ? AND household_id = ?', [memberId, holding.householdId]);
      if (!member) throw Object.assign(new Error('The member was not found.'), { code: 'MEMBER_NOT_FOUND', statusCode: 404 });
    }
    let stored = false;
    if (recorded.writeMemoryRow) {
      const result = await memoryFacts.insertFact({
        householdId: holding.householdId, adultId, holdingId: holding.id, memberId, memberScope: recorded.memberScope,
        factKey: recorded.factKey, scopeKey: recorded.scopeKey ?? '', tier: 'user_declaration', status: 'user_confirmed',
        value: storedValueOf(recorded), consentGrantId: body.consentGrantId, captureMethod: recorded.captureMethod,
      });
      stored = result.written;
    }
    // Only ids and booleans go back: the value the person picked is already on their screen.
    return { questionId: recorded.questionId, memberId, status: recorded.status, stored, followupsActivated: recorded.followupsActivated };
  }

  return { plan, answer };
}

import { readBody } from '../http/request.js';
import { requireOwnedHolding } from './holding-facts-routes.js';

// Intake questions for a holding (question planner, catalogue v1). Off unless HOLDINGS_ENABLED is exactly "true" (503
// HOLDINGS_DISABLED). Owner adult only, with the same 404 HOLDING_NOT_FOUND for a missing holding, another household's holding and
// a non-owner. No model call. Wording comes only from the reviewed catalogue in code (FOR LEGAL REVIEW), never from a model.
//
//   GET  /api/v1/holdings/{id}/intake-questions?phase=before_card|strip   planner output (at most 2 before the card) plus the
//                                                                         catalogue entries for those ids
//   POST /api/v1/holdings/{id}/intake-answers                              body { questionId, memberId?, optionIds, catalogueVersion,
//                                                                           consentGrantId } -> a sealed user_declaration memory fact
//                                                                           under a current profile_intake grant ("not sure" stores nothing)

const QUESTIONS = /^\/api\/v1\/holdings\/([^/]+)\/intake-questions$/;
const ANSWERS = /^\/api\/v1\/holdings\/([^/]+)\/intake-answers$/;

/** Returns a response for an intake route, or null when the path is not one. */
export async function handleHoldingIntakeRoute({ req, url, principal, services }) {
  const questions = url.pathname.match(QUESTIONS);
  const answers = url.pathname.match(ANSWERS);
  if (!(questions && req.method === 'GET') && !(answers && req.method === 'POST')) return null;
  if (!services.holdings.enabled()) throw Object.assign(new Error('Holdings are disabled.'), { code: 'HOLDINGS_DISABLED', statusCode: 503 });
  const holding = await requireOwnedHolding({ services, principal, holdingId: (questions ?? answers)[1] });
  if (questions) {
    const phase = url.searchParams.get('phase') ?? 'before_card';
    return { status: 200, body: await services.intakeQuestions.plan({ holding, adultId: principal.adultId, phase }) };
  }
  const body = await readBody(req);
  return { status: 200, body: await services.intakeQuestions.answer({ holding, adultId: principal.adultId, body }) };
}

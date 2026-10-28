import { toHandoff } from '../../features/decision-catalogue/index.js';
import { buildHouseholdCoveragePreview, validateScenarioInput } from '../../features/household-reasoning/index.js';

// Block 4 adapter: a read-only household coverage preview over authorised Block 3 evidence (household-reasoning).
// The server builds every handoff itself from the live stored answer through the same catalogue service, consent and
// document-currency checks as the decision-catalogue route. A request can name sources; it cannot carry evidence.
// Nothing is written, no provider is called, and the scenario is neither stored nor logged.
// Every access check is awaited before the next step, and sources are resolved one at a time (no Promise.all), so a
// rejected check stops the request instead of escaping it.

const notFound = (code, message) => Object.assign(new Error(message), { code, statusCode: 404 });
const caseNotFound = () => notFound('CASE_NOT_FOUND', 'Case not found.');
const memberNotFound = () => notFound('HOUSEHOLD_MEMBER_NOT_FOUND', 'Household member not found.');
// Answers whose documents changed after they were stored: the preview asks for revalidation instead of failing.
const REVALIDATION_CODES = new Map([['POLICY_EVIDENCE_ANSWER_STALE', 'answer_stale']]);

/**
 * @param services   backend services (access, households)
 * @param catalogue  the decision catalogue service (build)
 */
export function createHouseholdPreviewService({ services, catalogue }) {
  if (!services?.access || !services?.households || typeof catalogue?.build !== 'function') throw new TypeError('services and a catalogue service are required.');

  /**
   * @param principal      the authenticated principal
   * @param householdId    from the route
   * @param body           the untrusted request body
   * @param authorizeCase  the route's source-pack field gate: (caseRecord) => void | Promise<void>, rejects when consent is missing
   */
  async function preview({ principal, householdId, body, authorizeCase }) {
    const request = validateScenarioInput(body);
    // Household read access first: a foreign or unknown household is an indistinguishable 404 (HOUSEHOLD_NOT_FOUND).
    await services.access.requireHousehold(principal, householdId, { write: false });
    const { memberId, plannedDate } = request.scenario.effective;
    if (memberId && !(await services.households.listMembers(householdId)).some(member => member.id === memberId)) throw memberNotFound();

    // Resolve and authorise every source before reading any of them, so one foreign reference fails the whole request
    // identically whatever the others are. No source contributes to the response, a count or a question before that.
    const cases = [];
    for (const source of request.sources) {
      let caseRecord;
      try { caseRecord = await services.access.requireCase(principal, source.caseId, { write: false }); } catch (error) {
        if (['CASE_NOT_FOUND', 'HOUSEHOLD_NOT_FOUND'].includes(error?.code)) throw caseNotFound();
        throw error;
      }
      if (!caseRecord || caseRecord.household_id !== householdId) throw caseNotFound();
      await authorizeCase(caseRecord);
      cases.push({ caseRecord, answerId: source.answerId });
    }

    // One request-scoped cache: the curated product archives are verified once, not once per source.
    const curatedCache = {};
    const sources = [];
    for (const [sourceIndex, { caseRecord, answerId }] of cases.entries()) {
      try {
        const built = await catalogue.build({ caseRecord, answerId, asOf: plannedDate, memberId, curatedCache });
        sources.push({ sourceIndex, status: 'ok', handoff: toHandoff(built) });
      } catch (error) {
        const reason = REVALIDATION_CODES.get(error?.code);
        if (!reason) throw error;
        sources.push({ sourceIndex, status: 'revalidation_required', reason });
      }
    }
    return buildHouseholdCoveragePreview({ request, sources });
  }

  return Object.freeze({ preview });
}

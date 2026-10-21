import { toHandoff } from '../../features/decision-catalogue/index.js';
import { buildHouseholdCoveragePreview, validateScenarioInput } from '../../features/household-reasoning/index.js';

// Block 4 adapter: a read-only household coverage preview over authorised Block 3 evidence (household-reasoning).
// The server builds every handoff itself from the live stored answer through the same catalogue service, consent and
// document-currency checks as the decision-catalogue route. A request can name sources; it cannot carry evidence.
// Nothing is written, no provider is called, and the scenario is neither stored nor logged.

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
   * @param authorizeCase  the route's source-pack field gate: (caseRecord) => void, throws when consent is missing
   */
  function preview({ principal, householdId, body, authorizeCase }) {
    const request = validateScenarioInput(body);
    // Household read access first: a foreign or unknown household is an indistinguishable 404 (HOUSEHOLD_NOT_FOUND).
    services.access.requireHousehold(principal, householdId, { write: false });
    const { memberId, plannedDate } = request.scenario.effective;
    if (memberId && !services.households.listMembers(householdId).some(member => member.id === memberId)) throw memberNotFound();

    // Resolve and authorise every source before reading any of them, so one foreign reference fails the whole request
    // identically whatever the others are. No source contributes to the response, a count or a question before that.
    const cases = request.sources.map(source => {
      let caseRecord;
      try { caseRecord = services.access.requireCase(principal, source.caseId, { write: false }); } catch (error) {
        if (['CASE_NOT_FOUND', 'HOUSEHOLD_NOT_FOUND'].includes(error.code)) throw caseNotFound();
        throw error;
      }
      if (caseRecord.household_id !== householdId) throw caseNotFound();
      authorizeCase(caseRecord);
      return { caseRecord, answerId: source.answerId };
    });

    const sources = cases.map(({ caseRecord, answerId }, sourceIndex) => {
      try {
        const built = catalogue.build({ caseRecord, answerId, asOf: plannedDate, memberId });
        return { sourceIndex, status: 'ok', handoff: toHandoff(built) };
      } catch (error) {
        const reason = REVALIDATION_CODES.get(error?.code);
        if (reason) return { sourceIndex, status: 'revalidation_required', reason };
        throw error;
      }
    });
    return buildHouseholdCoveragePreview({ request, sources });
  }

  return Object.freeze({ preview });
}

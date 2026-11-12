// Holdings routes (ADR 0032). Off unless HOLDINGS_ENABLED is exactly "true" (the same answer as an unknown route while off). A stub
// slice: read-only lists, enough to prove ownership at the server boundary. Ownership is checked inside the repository: a foreign or
// missing household is the same 404. Bodies carry ids, closed enums and counts, never a sealed value.
//
//   GET /api/v1/households/{id}/holdings   -> { holdings, creation_issues: [{ document_id, state: 'retrying' | 'failed', code: null | 'HOLDING_CREATE_FAILED' }] }
//                                            (a document whose holding could not be created after OCR; retried by the worker, then failed)
//   GET /api/v1/households/{id}/holdings/{holdingId}
//
// Every holding carries a deterministic `summary` (data already stored, no model call):
//   summary: { insurerName: string | null, productName: string | null,
//              sumInsured: Headline | null, policyPeriod: Headline | null, premium: Headline | null }
//   Headline: { factKey: 'sum_insured' | 'policy_period' | 'premium_total', value, status: extracted_unverified | conflicting | unknown | reviewed_reference | user_confirmed }
//   insurerName and productName are null until the owner confirmed the product (never an unconfirmed candidate, never the UIN). A headline is
//   null while the holding has no fact for that key; `value` is the unit-typed value of the fact registry (null when conflicting or unknown).
// One policy is one holding: a wording linked to a holding (POST /holdings/{id}/documents) never shows as a second holding.
// A linked document also contributes its facts: collate reads the own-PDF facts of the holding's document and of each readable linked document
// (same tier, no precedence). Equal values collapse; different values make the fact `conflicting` with both alternatives, and GET .../facts then
// lists each reading as its own `sources` entry (tier own_pdf, id = the policy fact id, page.documentKind and pageId). GET .../documents adds
// `factsState` per link: 'included' | 'none' (nothing read yet or found) | 'off' (POLICY_FACTS_ENABLED is off, so it adds no facts).
// DELETE .../documents/{documentId} retires the facts read only from that document and re-collates. Additive: no field was removed or renamed.

const HOLDINGS = /^\/api\/v1\/households\/([^/]+)\/holdings(?:\/([^/]+))?$/;

/** Resolves a response, or null when the path is not a holdings route (or the flag is off). Errors propagate to the caller's error mapper. */
export async function handleHoldingsRoute({ req, url, principal, services }) {
  const match = req.method === 'GET' ? HOLDINGS.exec(url.pathname) : null;
  if (!match || !services.holdingsEnabled()) return null;
  const [, householdId, holdingId] = match;
  const withSummary = async list => {
    const summaries = await services.holdings.summaries({ householdId, holdings: list });
    return list.map(item => ({ ...item, summary: summaries.get(item.id) }));
  };
  if (holdingId) {
    const holding = await services.policyHoldings.get({ householdId, adultId: principal.adultId, holdingId });
    return { status: 200, body: (await withSummary([holding]))[0] };
  }
  const holdings = await withSummary(await services.policyHoldings.list({ householdId, adultId: principal.adultId }));
  return { status: 200, body: { holdings, creation_issues: await services.policyHoldings.creationIssues({ householdId, adultId: principal.adultId }) } };
}

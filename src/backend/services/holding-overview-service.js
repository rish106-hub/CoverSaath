import { OVERVIEW_HOLDING_STATES } from '../../contracts/member-relationships.js';
import { holdingsEnabled } from './holdings-flag.js';

// GET /api/v1/households/{id}/overview and /policies, rebuilt on holdings (ADR 0032) instead of the legacy policies and policy_members.
// Deterministic code over stored rows only: no model call, no inference. A field that was not extracted is null (never a guess, never a
// default). Owner only, like the other holding routes: a non-owner member, viewer or foreign caller gets the same 404 HOUSEHOLD_NOT_FOUND.
// Off unless HOLDINGS_ENABLED is exactly "true" (503 HOLDINGS_DISABLED, answered to the owner only, after the ownership check).
//
// Per holding:
//   { holdingId, insurer: string | null, productName: string | null, sumInsuredRs: number | null, premiumRs: number | null,
//     nextDueOn: 'YYYY-MM-DD' | null, renewsOn: 'YYYY-MM-DD' | null, coveredMemberIds: string[] | null, state }
//   insurer and productName: only what the owner confirmed (null until then). sumInsuredRs and premiumRs: rupees from the resolved sum_insured
//   and premium_total facts; null while the fact is absent, conflicting or unknown. renewsOn: the resolved renewal_date fact only (never derived
//   from the policy period). nextDueOn: the earliest premium due of the holding that is not paid. coveredMemberIds: the members listed on the
//   holding's policy record, null when none is listed (unknown, never "everyone").
//   state: needs_product (the owner has not stated the insurer and plan), reading (facts are being read), ready, conflicting (open conflicts)
//   or failed (a pipeline step gave up and the holding never settled).

const coded = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode });
const READY_STATES = new Set(['ready', 'conflicts']);

export function stateOfHolding(status, failed) {
  if (failed && !READY_STATES.has(status)) return 'failed';
  if (status === 'conflicts') return 'conflicting';
  if (status === 'ready') return 'ready';
  if (status === 'uploaded' || status === 'insurer_pending') return 'needs_product';
  return 'reading';
}

const rupees = headline => {
  if (!headline || headline.status === 'conflicting' || headline.status === 'unknown') return null;
  const minor = headline.value?.amountMinor;
  return Number.isSafeInteger(minor) && minor >= 0 ? minor / 100 : null;
};

export function createHoldingOverviewService({ access, app, policyHoldings, holdings, premiums, env = process.env }) {
  for (const [name, dependency] of Object.entries({ access, app, policyHoldings, holdings, premiums })) if (!dependency) throw new TypeError(`${name} is required.`);

  async function requireOwner(principal, householdId) {
    const { household, role } = await access.requireHousehold(principal, householdId);
    if (role.role !== 'owner') throw coded('HOUSEHOLD_NOT_FOUND', 'Household not found.', 404);
    if (!holdingsEnabled(env)) throw coded('HOLDINGS_DISABLED', 'Holdings are disabled.', 503);
    return household;
  }

  async function holdingItems(principal, householdId) {
    const adultId = principal.adultId;
    const list = await policyHoldings.list({ householdId, adultId });
    if (list.length === 0) return [];
    const summaries = await holdings.summaries({ householdId, holdings: list });
    const renewals = await holdings.renewalDates({ householdId, holdings: list });
    const failed = await policyHoldings.failedHoldingIds({ householdId, adultId });
    const covered = await policyHoldings.coveredMemberIds({ householdId, adultId, holdings: list });
    const nextDue = new Map();
    for (const due of await premiums.listDues({ householdId, adultId })) {
      if (due.state === 'paid' || (nextDue.has(due.holdingId) && nextDue.get(due.holdingId) <= due.dueOn)) continue;
      nextDue.set(due.holdingId, due.dueOn);
    }
    return list.map(holding => {
      const summary = summaries.get(holding.id);
      return {
        holdingId: holding.id,
        insurer: summary?.insurerName ?? null,
        productName: summary?.productName ?? null,
        sumInsuredRs: rupees(summary?.sumInsured),
        premiumRs: rupees(summary?.premium),
        nextDueOn: nextDue.get(holding.id) ?? null,
        renewsOn: renewals.get(holding.id) ?? null,
        coveredMemberIds: covered.get(holding.id) ?? null,
        state: stateOfHolding(holding.status, failed.has(holding.id)),
      };
    });
  }

  return Object.freeze({
    async policies(principal, householdId) {
      await requireOwner(principal, householdId);
      return { householdId, holdings: await holdingItems(principal, householdId) };
    },

    async overview(principal, householdId) {
      const household = await requireOwner(principal, householdId);
      const { members } = await app.listMembers(principal, householdId);
      const items = await holdingItems(principal, householdId);
      const holdingsByState = Object.fromEntries(OVERVIEW_HOLDING_STATES.map(state => [state, items.filter(item => item.state === state).length]));
      const dated = items.filter(item => item.nextDueOn !== null).sort((a, b) => (a.nextDueOn < b.nextDueOn ? -1 : a.nextDueOn > b.nextDueOn ? 1 : 0));
      return {
        household: { id: household.id, displayName: household.display_name, status: household.status },
        viewerRole: 'owner',
        members,
        holdings: items,
        counts: {
          members: members.length,
          adults: members.filter(member => member.memberKind === 'adult').length,
          dependents: members.filter(member => member.memberKind === 'dependent').length,
          holdings: items.length,
          holdingsByState,
        },
        nextDue: dated[0] ? { holdingId: dated[0].holdingId, dueOn: dated[0].nextDueOn } : null,
        derived: 'counts_and_dates_only',
      };
    },
  });
}

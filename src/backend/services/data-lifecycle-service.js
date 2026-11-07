import { ERASURE_REASONS } from '../../contracts/data-lifecycle.js';

// Erasure of a case, a member or a household on a person's request (S3). Authorisation lives here, before any work; the
// repository then does the erasure in one transaction. Rules:
//   * The caller must hold a role in the household (a foreign household and a missing one answer the same 404).
//   * Household erasure: the owner only. Case erasure: the owner, an operator, or the adult who opened the case, with a
//     writing role. Member erasure: the owner or a member role (the same roles that may add or remove a member).
//   * The body must repeat the id of what is being erased ("confirm"), so a stray request cannot erase anything.
//   * Erasure does not need current processing consent: a person must always be able to erase their own data.
// Bytes in document storage are removed after the transaction by the document worker; the answer says how many are still pending.
// The wording a person sees around erasure is FOR LEGAL REVIEW.

const CASE_MANAGER_ROLES = ['owner', 'operator', 'backup_operator'];

function fail(code, message, statusCode) { throw Object.assign(new Error(message), { code, statusCode }); }

function confirmed(body, expectedId) {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || body.confirm !== expectedId) {
    fail('ERASURE_CONFIRMATION_REQUIRED', 'Send {"confirm": "<id>"} with the id of what you are erasing.', 400);
  }
}

export function createDataLifecycleService({ access, households, erasure, documentWorker = null, clock = () => new Date() }) {
  // After the transaction: remove stored bytes, then delete the tombstones nothing refers to. Never throws; a failure leaves
  // the document pending for the worker's next sweep.
  async function finish(householdId, documentIds) {
    let removed = 0;
    for (const documentId of documentIds) {
      try {
        if (documentWorker && await documentWorker.processDocument(documentId) === 'deleted') removed += 1;
      } catch { /* retried by the worker */ }
    }
    try { await erasure.pruneDeletedDocuments({ householdId }); } catch { /* retried by the sweep */ }
    return { total: documentIds.length, bytesRemoved: removed, pending: documentIds.length - removed };
  }

  const dto = (scope, id, result, documents) => ({
    status: documents.pending === 0 ? 'erased' : 'erasure_pending_storage',
    scope,
    id,
    erasedAt: clock().toISOString(),
    counts: result.counts,
    documents,
  });

  return {
    async eraseCase(principal, caseId, body) {
      const { household_id: householdId, opened_by_adult_id: openedBy } = await access.requireCase(principal, caseId, { write: true });
      confirmed(body, caseId);
      const roles = (await households.listActiveRoles(householdId, principal.adultId)).map(item => item.role);
      if (!roles.some(role => CASE_MANAGER_ROLES.includes(role)) && openedBy !== principal.adultId) {
        fail('ERASURE_FORBIDDEN', 'You do not have permission to erase this case.', 403);
      }
      const result = await erasure.eraseCase({ householdId, caseId, actor: { type: 'adult_user', id: principal.adultId }, reason: ERASURE_REASONS.dataSubjectRequest });
      return dto('case', caseId, result, await finish(householdId, result.documentIds));
    },

    async eraseMember(principal, householdId, memberId, body) {
      const { role } = await access.requireHousehold(principal, householdId);
      if (!['owner', 'member'].includes(role.role)) fail('HOUSEHOLD_WRITE_FORBIDDEN', 'Your role in this household can read but not change it.', 403);
      confirmed(body, memberId);
      // The cases about this member are erased with it, so the caller needs the same standing as for erasing each case.
      const roles = (await households.listActiveRoles(householdId, principal.adultId)).map(item => item.role);
      const result = await erasure.eraseMember({
        householdId, memberId, actor: { type: 'adult_user', id: principal.adultId }, reason: ERASURE_REASONS.dataSubjectRequest,
        mayEraseOthersCases: roles.some(item => CASE_MANAGER_ROLES.includes(item)),
      });
      return dto('member', memberId, result, await finish(householdId, result.documentIds));
    },

    async eraseHousehold(principal, householdId, body) {
      const { role } = await access.requireHousehold(principal, householdId);
      if (role.role !== 'owner') fail('ERASURE_FORBIDDEN', 'Only the household owner can erase the household.', 403);
      confirmed(body, householdId);
      const result = await erasure.eraseHousehold({ householdId, actor: { type: 'adult_user', id: principal.adultId }, reason: ERASURE_REASONS.dataSubjectRequest });
      return dto('household', householdId, result, await finish(householdId, result.documentIds));
    },

    finish,
  };
}

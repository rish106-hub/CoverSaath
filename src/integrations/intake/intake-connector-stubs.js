import { UnconfiguredConnectorError } from '../shared/index.js';

// Fail-closed stubs for intake connectors that are not built. No network, no credentials.
export function createIntakeConnectorStubs({ ids } = {}) {
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length || !ids.every(id => typeof id === 'string' && /^[a-z_]+$/.test(id))) {
    throw new TypeError('ids must be a non-empty list of unique lowercase identifiers.');
  }
  const stubs = {};
  for (const id of ids) {
    const refuse = async () => { throw new UnconfiguredConnectorError(id); };
    stubs[id] = Object.freeze({
      health: () => ({ connector: id, status: 'not_built', networkAttempted: false, contractVerified: false }),
      requestAuthorization: refuse,
      listCandidates: refuse,
      fetchDocument: refuse,
      revoke: refuse,
    });
  }
  return Object.freeze(stubs);
}

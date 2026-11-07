// Test adapter: the reconcile payload names groups by opaque aliases (g1, g2, ...), but fixtures are written against the
// stored group id ("registry:<key>|<subject>"). `viaWire` rewrites a fixture's group ids to the aliases of the request it answers.
export const viaWire = call => async request => {
  const response = await call(request);
  const groups = request?.input?.payload?.groups ?? [];
  const wireId = id => {
    const parts = /^(?:registry|proposed):(.+?)\|(.*)$/.exec(typeof id === 'string' ? id : '');
    return parts ? groups.find(group => group.target === parts[1] && group.subject === parts[2])?.group_id ?? id : id;
  };
  const conflicts = response?.json?.conflicts;
  if (!Array.isArray(conflicts)) return response;
  return { ...response, json: { ...response.json, conflicts: conflicts.map(entry => (entry && typeof entry === 'object' ? { ...entry, group_id: wireId(entry.group_id) } : entry)) } };
};

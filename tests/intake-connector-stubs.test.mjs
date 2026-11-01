import test from 'node:test';
import assert from 'node:assert/strict';
import { INTAKE_CONNECTORS } from '../src/contracts/index.js';
import { createIntakeConnectorStubs, UnconfiguredConnectorError } from '../src/integrations/index.js';

test('invalid id lists are refused', () => {
  for (const ids of [[], ['a', 'a'], ['Bad-Id'], undefined]) assert.throws(() => createIntakeConnectorStubs({ ids }), TypeError);
});

test('stubs never touch the network and every action fails closed', async t => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = () => { calls += 1; throw new Error('network must not be used'); };
  t.after(() => { globalThis.fetch = original; });
  const ids = INTAKE_CONNECTORS.filter(c => c.id !== 'upload').map(c => c.id);
  const stubs = createIntakeConnectorStubs({ ids });
  assert.deepEqual(Object.keys(stubs).sort(), [...ids].sort());
  for (const id of ids) {
    assert.deepEqual(stubs[id].health(), { connector: id, status: 'not_built', networkAttempted: false, contractVerified: false });
    for (const method of ['requestAuthorization', 'listCandidates', 'fetchDocument', 'revoke']) {
      await assert.rejects(stubs[id][method](), UnconfiguredConnectorError);
    }
  }
  assert.equal(calls, 0);
});

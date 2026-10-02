import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EVIDENCE_STATES, ENTRY_ROUTES } from '../src/ui/components/household-workspace.js';
import { createWorkspaceController } from '../src/ui/state/workspace-controller.js';

const appSource = await readFile(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const stylesSource = await readFile(new URL('../src/ui/styles.css', import.meta.url), 'utf8');
const clientSource = await readFile(new URL('../src/ui/api/v1-client.js', import.meta.url), 'utf8');

test('workspace exposes exactly the two canonical entry routes', () => {
  assert.deepEqual(ENTRY_ROUTES.map(route => route.title), [
    'Plan a procedure',
    'Emergency help',
  ]);
  assert.equal(ENTRY_ROUTES.length, 2);
});

test('household matrix and evidence vocabulary cover the required state model', () => {
  assert.match(appSource, /view\.matrix\?\.members/);
  assert.deepEqual(EVIDENCE_STATES.map(([name]) => name), [
    'Proven', 'Calculated', 'Reported', 'Dynamic', 'Unknown', 'Conflicting',
  ]);
});

test('case workspace preserves the four answer layers and direct-human emergency boundary', () => {
  for (const layer of ['Decision', 'Financial', 'Evidence', 'Research']) assert.match(appSource, new RegExp(`'${layer}'`));
  assert.match(appSource, /No AI, Gnani or IVR sits in front/i);
  assert.match(appSource, /tel:112/);
  assert.match(appSource, /Break down the policy once/i);
  assert.match(appSource, /policy_decomposition_\[a-j\]/);
  assert.doesNotMatch(appSource, /five-minute|5-minute/i);
  assert.doesNotMatch(appSource, /CoverSaath/i);
});

test('shipped workspace uses only the authenticated persistent v1 API', () => {
  assert.match(clientSource, /\/api\/v1/);
  assert.doesNotMatch(appSource, /['`]\/api\/cases/);
  assert.doesNotMatch(clientSource, /localStorage|sessionStorage/);
});

test('policy reconstruction gates planned care while emergency skips analysis', async () => {
  const calls = [];
  const analyses = [];
  const client = {
    setSessionToken() {},
    createCase: async body => { calls.push(body); return { id:`case-${calls.length}`, trigger_type:body.triggerType, revision:'r1' }; },
    transitionCase: async (id, body) => ({ id, trigger_type:calls.find((_call, index) => `case-${index + 1}` === id).triggerType, revision:body.toStatus }),
    grantConsent: async () => ({ id:'consent-1' }),
    startAnalysis: async caseId => { analyses.push(caseId); return { id:`run-${analyses.length}`, status:'completed', tasks:[] }; },
    householdMatrix: async () => ({ members:[] }),
  };
  const controller = createWorkspaceController({ client });
  await controller.connect({ sessionToken:'x'.repeat(32), householdId:'h1', adultId:'a1', memberId:'m1' });
  await controller.reconstructPolicy();
  await controller.createAndAnalyze({ route:'planned_care' });
  await controller.createAndAnalyze({ route:'emergency' });
  assert.deepEqual(calls.map(call => call.triggerType), ['user_requested_review', 'planned_care', 'emergency']);
  assert.deepEqual(analyses, ['case-1', 'case-2']);
});

test('responsive theme includes dark mode and reduced-motion handling', () => {
  assert.match(stylesSource, /prefers-color-scheme\s*:\s*dark/);
  assert.match(stylesSource, /prefers-reduced-motion\s*:\s*reduce/);
  assert.match(stylesSource, /@media \(max-width:780px\)/);
});

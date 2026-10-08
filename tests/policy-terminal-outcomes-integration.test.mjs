import test from 'node:test';
import assert from 'node:assert/strict';

import { createPolicyBreakdownService } from '../src/modules/policy-breakdown/service.js';
import { PARAMETER_INDEX } from '../src/modules/policy-breakdown/sections/index.js';

const recordId = 'policy-record-terminal-outcomes';
const householdId = 'household-terminal-outcomes';
const adultId = 'adult-terminal-outcomes';

const results = Object.fromEntries([...PARAMETER_INDEX.values()].map(definition => [definition.key, {
  key: definition.key,
  section: definition.section,
  label: definition.label,
  valueType: definition.valueType,
  critical: definition.critical,
  visibility: definition.visibility,
  value: null,
  evidenceState: 'Unknown',
  stateReason: 'not_found_in_source_pack',
  citations: [],
  conditions: [],
  exceptions: [],
  review: { state: 'unreviewed' },
}]));

function database() {
  return {
    async one(statement) {
      if (statement.includes('FROM policy_records')) return {
        id: recordId,
        household_id: householdId,
        created_by_adult_id: adultId,
        consent_grant_id: 'consent-terminal-outcomes',
        status: 'needs_review',
        contract_version: 'knowvia.policy-breakdown.v1',
        display_title: null,
        insurer_name: null,
        product_name: null,
        policy_number_masked: null,
        summary_json: JSON.stringify({ consistencyIssues: [] }),
        created_at: '2026-10-07T00:00:00.000Z',
        updated_at: '2026-10-07T00:00:00.000Z',
        ready_at: null,
      };
      if (statement.includes('FROM consent_grants')) return { revoked_at: null, expires_at: null };
      throw new Error(`Unexpected database.one statement: ${statement}`);
    },
    async query(statement) {
      if (statement.includes('FROM policy_parameters')) {
        return Object.values(results).map(result => ({ result_json: JSON.stringify(result) }));
      }
      throw new Error(`Unexpected database.query statement: ${statement}`);
    },
  };
}

test('service adds justified terminal metadata to all 314 parameters without changing evidence state', async () => {
  const service = createPolicyBreakdownService({
    database: database(),
    services: {
      access: { requireHousehold: async () => true },
      audit: null,
    },
  });

  const response = await service.getSections({ adultId }, recordId);
  const parameters = response.sections.flatMap(section => section.parameters);

  assert.equal(PARAMETER_INDEX.size, 314, 'the canonical section registry must retain the 314-parameter contract');
  assert.equal(parameters.length, 314, 'the service exposes every canonical parameter');
  assert.ok(parameters.every(parameter => parameter.evidenceState === 'Unknown'), 'terminal classification must not rewrite evidenceState');
  assert.ok(parameters.every(parameter => typeof parameter.terminalOutcomeReason === 'string' && Array.isArray(parameter.sourceAttempts)));
  assert.ok(parameters.every(parameter => parameter.sourceAttempts.length === 0), 'no source attempt may be invented');

  const critical = parameters.filter(parameter => parameter.critical);
  const nonCritical = parameters.filter(parameter => !parameter.critical);
  assert.ok(critical.length > 0);
  assert.ok(critical.every(parameter => parameter.terminalOutcome === 'RequiredNow'));
  assert.ok(nonCritical.every(parameter => parameter.terminalOutcome === 'RequiredForLaterJourney'));
  assert.ok(parameters.every(parameter => !['NotApplicable', 'Unavailable'].includes(parameter.terminalOutcome)), 'absence alone cannot imply not applicable or unavailable');
});

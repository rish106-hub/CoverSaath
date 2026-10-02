import { RUNTIME_RESPONSIBILITIES } from '../ai-analysis/responsibility-matrix.js';

import { inputSchemaId, outputSchemaId } from './contract-ids.js';

const task = (key, kind, dependsOn) => Object.freeze({
  key,
  kind,
  dependsOn: Object.freeze(dependsOn),
  inputSchema: inputSchemaId(key),
  outputSchema: outputSchemaId(key),
  ...RUNTIME_RESPONSIBILITIES[key],
});

export const COVERAGE_ANALYSIS_WORKFLOW = Object.freeze({
  name: 'coverage-analysis',
  version: '4',
  tasks: Object.freeze([
    task('profile', 'profile_intake', []),
    task('group', 'group_cover_analysis', []),
    task('personal', 'personal_cover_analysis', []),
    task('coverage', 'coverage_graph', ['profile', 'group', 'personal']),
    task('documentIdentity', 'policy_decomposition_a', ['coverage']),
    task('continuity', 'policy_decomposition_b', ['coverage']),
    task('enrolment', 'policy_decomposition_c', ['coverage']),
    task('financialRules', 'policy_decomposition_d', ['coverage']),
    task('benefits', 'policy_decomposition_e', ['coverage']),
    task('exclusions', 'policy_decomposition_f', ['coverage']),
    task('hospitalAccess', 'policy_decomposition_g', ['coverage']),
    task('claimsProcess', 'policy_decomposition_h', ['coverage']),
    task('renewalChange', 'policy_decomposition_i', ['coverage']),
    task('serviceResearch', 'policy_decomposition_j', ['coverage']),
    task('decision', 'deterministic_classification', ['coverage']),
    task('householdAction', 'policy_decomposition_k', ['decision', 'documentIdentity', 'continuity', 'enrolment', 'financialRules', 'benefits', 'exclusions', 'hospitalAccess', 'claimsProcess', 'renewalChange', 'serviceResearch']),
    task('evidence', 'evidence_review', ['coverage', 'decision', 'documentIdentity', 'continuity', 'enrolment', 'financialRules', 'benefits', 'exclusions', 'hospitalAccess', 'claimsProcess', 'renewalChange', 'serviceResearch']),
    task('privacy', 'privacy_review', ['coverage', 'decision']),
    task('safety', 'safety_review', ['coverage', 'decision']),
    task('questions', 'question_drafting', ['coverage', 'decision']),
    task('primary', 'bounded_synthesis', ['decision', 'householdAction', 'evidence', 'privacy', 'safety', 'questions']),
    task('release', 'deterministic_release_gate', ['primary']),
  ]),
});

export const taskDefinition = key => COVERAGE_ANALYSIS_WORKFLOW.tasks.find(task => task.key === key) ?? null;

export const COVERAGE_ANALYSIS_WORKFLOW = Object.freeze({
  name: 'coverage-analysis',
  version: '1',
  tasks: Object.freeze([
    Object.freeze({ key: 'profile', kind: 'profile_intake', dependsOn: Object.freeze([]) }),
    Object.freeze({ key: 'group', kind: 'group_cover_analysis', dependsOn: Object.freeze([]) }),
    Object.freeze({ key: 'personal', kind: 'personal_cover_analysis', dependsOn: Object.freeze([]) }),
    Object.freeze({ key: 'coverage', kind: 'coverage_graph', dependsOn: Object.freeze(['profile', 'group', 'personal']) }),
    Object.freeze({ key: 'decision', kind: 'deterministic_classification', dependsOn: Object.freeze(['coverage']) }),
    Object.freeze({ key: 'evidence', kind: 'evidence_review', dependsOn: Object.freeze(['coverage', 'decision']) }),
    Object.freeze({ key: 'privacy', kind: 'privacy_review', dependsOn: Object.freeze(['coverage', 'decision']) }),
    Object.freeze({ key: 'safety', kind: 'safety_review', dependsOn: Object.freeze(['coverage', 'decision']) }),
    Object.freeze({ key: 'primary', kind: 'bounded_synthesis', dependsOn: Object.freeze(['decision', 'evidence', 'privacy', 'safety']) }),
    Object.freeze({ key: 'release', kind: 'deterministic_release_gate', dependsOn: Object.freeze(['primary']) }),
  ]),
});

export const taskDefinition = key => COVERAGE_ANALYSIS_WORKFLOW.tasks.find(task => task.key === key) ?? null;


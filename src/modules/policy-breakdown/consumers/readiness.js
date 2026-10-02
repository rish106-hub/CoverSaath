// Readiness gate: a record becomes `ready` only when every critical parameter has been reviewed by a person
// and no critical conflict or consistency issue is open. Deterministic; no model involvement.

const REVIEWED = new Set(['confirmed', 'corrected', 'confirmed_absent']);

export function evaluateReadiness({ record, parameters, consistencyIssues = [], jobStatus }) {
  const blockers = [];
  if (jobStatus !== 'succeeded') blockers.push({ code: 'BREAKDOWN_NOT_COMPLETE', message: 'The breakdown job has not completed successfully.' });
  if (record.status === 'revoked') blockers.push({ code: 'RECORD_REVOKED', message: 'Consent for this record was revoked.' });
  for (const result of Object.values(parameters)) {
    if (!result.critical) continue;
    const reviewState = result.review?.state ?? 'unreviewed';
    if (!REVIEWED.has(reviewState)) {
      blockers.push({ code: 'CRITICAL_PARAMETER_UNREVIEWED', key: result.key, section: result.section, evidenceState: result.evidenceState, message: `${result.label} needs a person to confirm, correct or mark it absent.` });
    } else if (reviewState === 'confirmed_absent' && result.evidenceState !== 'Unknown') {
      blockers.push({ code: 'CRITICAL_PARAMETER_ABSENT_MISMATCH', key: result.key, section: result.section, message: `${result.label} was marked absent but now holds a ${result.evidenceState} value; review it again.` });
    } else if (result.evidenceState === 'Conflicting') {
      blockers.push({ code: 'CRITICAL_PARAMETER_CONFLICTING', key: result.key, section: result.section, message: `${result.label} is still Conflicting; correct it with one value.` });
    }
  }
  for (const issue of consistencyIssues) {
    if (!issue.critical) continue;
    const unresolved = issue.keys.some(key => parameters[key]?.critical && !REVIEWED.has(parameters[key]?.review?.state ?? 'unreviewed'));
    if (unresolved) blockers.push({ code: 'CONSISTENCY_ISSUE_OPEN', rule: issue.rule, keys: issue.keys, message: issue.message });
  }
  return { ready: blockers.length === 0, blockers };
}

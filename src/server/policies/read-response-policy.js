export const READ_FIELDS = Object.freeze({
  caseSummary: Object.freeze({ purpose: 'coverage_reconstruction', dataCategory: 'case_summary' }),
  sourcePack: Object.freeze({ purpose: 'document_processing', dataCategory: 'source_pack_metadata' }),
  auditSummary: Object.freeze({ purpose: 'human_review', dataCategory: 'audit_summary' }),
  analysisSummary: Object.freeze({ purpose: 'coverage_reconstruction', dataCategory: 'analysis_summary' }),
});

function caseSubject(database, caseRecord) {
  if (caseRecord.subject_member_id) {
    const member = database.prepare(`SELECT adult_user_id FROM household_members
      WHERE id = ? AND household_id = ?`).get(caseRecord.subject_member_id, caseRecord.household_id);
    if (member?.adult_user_id) return member.adult_user_id;
  }
  return caseRecord.opened_by_adult_id;
}

export function createReadResponsePolicy({ database, consents }) {
  return Object.freeze({
    requireCaseField({ principal, caseRecord, field }) {
      consents.requireResourceAccess({
        householdId: caseRecord.household_id,
        subjectAdultId: caseSubject(database, caseRecord),
        viewerAdultId: principal.adultId,
        purpose: field.purpose,
        resourceType: 'case',
        resourceId: caseRecord.id,
        action: 'read',
        dataCategory: field.dataCategory,
      });
    },
  });
}

function parsedOutput(task) {
  if (!task.output_json) return null;
  try { return JSON.parse(task.output_json); } catch { return null; }
}

function outputPayload(output) {
  return output?.contractVersion === 'knowvia-agent-contract-v1' && output.payload && typeof output.payload === 'object'
    ? output.payload
    : output;
}

function redactedResult(task) {
  const output = outputPayload(parsedOutput(task));
  if (!output || typeof output !== 'object') return null;
  if (task.task_kind === 'bounded_synthesis') {
    return {
      status: typeof output.status === 'string' ? output.status : null,
      route: typeof output.route === 'string' ? output.route : null,
      blockerCount: Array.isArray(output.blockers) ? output.blockers.length : 0,
    };
  }
  if (task.task_kind === 'deterministic_release_gate') {
    return {
      status: typeof output.status === 'string' ? output.status : null,
      externalActionsAuthorized: output.externalActionsAuthorized === true,
      blockerCount: Array.isArray(output.blockers) ? output.blockers.length : 0,
    };
  }
  if (['evidence_review', 'privacy_review', 'safety_review'].includes(task.task_kind)) {
    return {
      status: typeof output.status === 'string' ? output.status : null,
      findingCodes: Array.isArray(output.findings)
        ? [...new Set(output.findings.map(finding => finding?.code).filter(code => typeof code === 'string'))]
        : [],
    };
  }
  if (/^policy_decomposition_[a-j]$/.test(task.task_kind)) {
    const facts = Array.isArray(output.facts) ? output.facts : [];
    return {
      section: typeof output.section === 'string' ? output.section : null,
      responsibility: typeof output.responsibility === 'string' ? output.responsibility : null,
      facts: facts.slice(0, 100).map(fact => ({
        field: typeof fact?.field === 'string' ? fact.field : 'unclassified',
        evidenceState: typeof fact?.evidenceState === 'string' ? fact.evidenceState : 'Unknown',
        page: fact?.provenance?.page ?? null,
      })),
    };
  }
  if (task.task_kind === 'deterministic_classification') {
    return {
      route: typeof output.route === 'string' ? output.route : null,
      unknownCount: Array.isArray(output.unknowns) ? output.unknowns.length : 0,
    };
  }
  return null;
}

function taskSummary(task) {
  return {
    id: task.id,
    jobId: task.workflow_run_id,
    parentTaskId: task.parent_task_id,
    agentName: task.agent_name,
    taskKind: task.task_kind,
    status: task.status,
    attemptCount: task.attempt_count,
    terminalReason: task.terminal_reason,
    resultSummary: redactedResult(task),
    createdAt: task.created_at,
    startedAt: task.started_at,
    finishedAt: task.finished_at,
  };
}

export function analysisJobDto(run, tasks, dag) {
  const executions = tasks.map(task => parsedOutput(task)?.producer?.execution).filter(Boolean);
  return {
    id: run.id,
    caseId: run.case_id,
    workflowName: run.workflow_name,
    workflowVersion: run.workflow_version,
    executionMode: run.execution_mode,
    status: run.status,
    terminalReason: run.terminal_reason,
    createdAt: run.created_at,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    tasks: tasks.map(taskSummary),
    dag,
    modelUsage: {
      providers: [...new Set(executions.map(item => item.provider))],
      models: [...new Set(executions.map(item => item.model))],
      inputTokens: executions.reduce((total, item) => total + item.inputTokens, 0),
      outputTokens: executions.reduce((total, item) => total + item.outputTokens, 0),
      totalTokens: executions.reduce((total, item) => total + item.totalTokens, 0),
      calls: executions.reduce((total, item) => total + item.calls, 0),
      latencyMs: executions.reduce((total, item) => total + item.latencyMs, 0),
      costUsd: executions.reduce((total, item) => total + item.costUsd, 0),
    },
  };
}

export function analysisTaskDto(task) {
  return taskSummary(task);
}

export function caseSummaryDto(record) {
  return {
    id: record.id,
    subjectMemberId: record.subject_member_id,
    triggerType: record.trigger_type,
    status: record.status,
    emergencyMode: record.emergency_mode === 1,
    statedEstimateMinor: record.stated_estimate_minor,
    currency: record.currency,
    revision: record.updated_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    closedAt: record.closed_at,
  };
}

export function sourcePackDto(caseId, sources, workflows) {
  return {
    caseId,
    sources: sources.map(source => ({
      id: source.id,
      documentKind: source.document_kind,
      mimeType: source.mime_type,
      byteSize: source.byte_size,
      malwareStatus: source.malware_status,
      encryptionStatus: source.encryption_status,
      lifecycleState: source.lifecycle_state,
      uploadedAt: source.uploaded_at,
    })),
    workflows: workflows.map(workflow => ({
      id: workflow.id,
      workflowName: workflow.workflow_name,
      workflowVersion: workflow.workflow_version,
      executionMode: workflow.execution_mode,
      status: workflow.status,
      terminalReason: workflow.terminal_reason,
      createdAt: workflow.created_at,
      finishedAt: workflow.finished_at,
    })),
  };
}

export function auditSummaryDto(events) {
  return {
    events: events.map(event => ({
      id: event.id,
      action: event.action,
      resourceType: event.resource_type,
      occurredAt: event.occurred_at,
    })),
  };
}

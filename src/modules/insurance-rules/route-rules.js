import { freeze } from './contracts.js';
import { validateCitation } from './source-hierarchy.js';

export function determineRoute({ trigger, evidenceState, treatmentRelevance, continuity, needAssessment }) {
  if (trigger === 'emergency') return freeze({ route: 'emergency', reason: 'Care takes priority over insurance optimisation.', instruction: 'Admit first. Optimise later.' });
  const assessedTreatment = treatmentRelevance.filter(item => item.relevance !== 'not_assessed');
  if (evidenceState === 'conflict' || assessedTreatment.some(item => item.state === 'conflict')) {
    return freeze({ route: 'human_review', reason: 'Material source-backed evidence conflicts.' });
  }
  if (evidenceState === 'unknown' || assessedTreatment.some(item => item.state === 'unknown') || continuity.state !== 'ready') {
    return freeze({ route: 'clarification', reason: 'Required evidence or continuity readiness remains unresolved.' });
  }
  const citedNeed = needAssessment && validateCitation(needAssessment.source);
  if (citedNeed && needAssessment.status === 'none_identified') {
    return freeze({ route: 'no_action', reason: 'The supplied reviewed need record identifies no additional purchase action.' });
  }
  return freeze({ route: 'purchase_review', reason: 'Evidence is ready for household and licensed purchase review. No purchase is authorised.' });
}

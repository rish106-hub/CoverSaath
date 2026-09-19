export const EMERGENCY_INSTRUCTION = Object.freeze({
  headline: 'Admit first. Optimise later.',
  action: 'Contact the hospital emergency desk or local emergency services now. Insurance processing must not delay care.',
  processingConsentRequired: false,
});

const transitions = Object.freeze({
  created: new Set(['collecting', 'blocked', 'revoked', 'closed']),
  collecting: new Set(['processing', 'blocked', 'revoked', 'closed']),
  processing: new Set(['human_review', 'blocked', 'ready', 'revoked']),
  human_review: new Set(['processing', 'blocked', 'ready', 'revoked', 'closed']),
  blocked: new Set(['collecting', 'processing', 'human_review', 'revoked', 'closed']),
  ready: new Set(['processing', 'human_review', 'closed', 'revoked']),
  closed: new Set(),
  revoked: new Set(),
});

export function assertCaseTransition(from, to) {
  if (from === to) return;
  if (!transitions[from]?.has(to)) {
    const error = new Error(`Invalid case transition: ${from} -> ${to}.`);
    error.code = 'INVALID_CASE_TRANSITION';
    throw error;
  }
}

export function emergencyInstruction(triggerType) {
  return triggerType === 'emergency' ? EMERGENCY_INSTRUCTION : null;
}


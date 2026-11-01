// Maps a decision-catalogue handoff status to a user-facing insight state (run C, F3).
export const INSIGHT_STATES = Object.freeze(['verified', 'extracted_unverified', 'conflicting', 'unknown']);
const FROM_HANDOFF = Object.freeze({ known: 'verified', unverified: 'extracted_unverified', conflicting: 'conflicting' });

export function insightStateFromHandoff(status) {
  return typeof status === 'string' && Object.hasOwn(FROM_HANDOFF, status) ? FROM_HANDOFF[status] : 'unknown';
}

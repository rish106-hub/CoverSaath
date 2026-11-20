// How a fact is labelled for the person, by SOURCE TIER and STATUS together (ADR 0036 D7), never by status alone: an
// extracted_unverified row from the insurer tier (a model read the public wording, FSS has not reviewed it) must not be called
// "read from your policy document". Wording is DRAFT and FOR LEGAL REVIEW.

export const INSURER_UNCHECKED_LABEL = "From the insurer's wording, not checked";

const BY_TIER_STATUS = Object.freeze({
  'ida_wording|extracted_unverified': INSURER_UNCHECKED_LABEL,
  'ida_wording|reviewed_reference': "from the insurer's published terms",
  'own_pdf|extracted_unverified': 'read from your policy schedule, not yet confirmed by you',
  'user_declaration|user_confirmed': 'confirmed by you',
});
const BY_STATUS = Object.freeze({
  user_confirmed: 'confirmed by you',
  reviewed_reference: "from the insurer's published terms",
  extracted_unverified: 'read from your policy schedule, not yet confirmed by you',
});

/** The label of a fact for chat text: { sourceTier, status } -> phrase, or null when none applies. */
export const factSourceLabel = ({ sourceTier = null, status }) => BY_TIER_STATUS[`${sourceTier}|${status}`] ?? BY_STATUS[status] ?? null;

/** The label the model is shown beside a fact it may cite. */
export const modelSlotSuffix = ({ sourceTier = null, status }) => {
  if (status !== 'extracted_unverified') return null;
  return sourceTier === 'ida_wording' ? `(${INSURER_UNCHECKED_LABEL})` : '(read from the policy document, not confirmed)';
};

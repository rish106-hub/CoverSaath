// Versioned privacy notice data (DPDP itemised notice). FOR LEGAL REVIEW: see notices-v1.js.
import { NOTICES_V1, NOTICE_LANGUAGE, NOTICE_SET_VERSION, NOTICE_LEGAL_REVIEW_STATUS } from './notices-v1.js';

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

export { NOTICE_LANGUAGE, NOTICE_SET_VERSION, NOTICE_LEGAL_REVIEW_STATUS };

export const NOTICES = deepFreeze(NOTICES_V1.map(notice => ({
  ...notice,
  version: NOTICE_SET_VERSION,
  language: NOTICE_LANGUAGE,
  legalReview: NOTICE_LEGAL_REVIEW_STATUS,
})));

export const NOTICE_IDS = Object.freeze(NOTICES.map(notice => notice.id));

export function getNotice(id) {
  return NOTICES.find(notice => notice.id === id) ?? null;
}

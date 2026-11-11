// Never-collect list (capture design 3.12, ADR 0026): a government number, a payment card, a card verification code, a password or
// a one-time code must not be stored in any free-text field. The check is a deliberately blunt safety net run on typed text before
// it is sealed; it rejects the common shapes, not every possible one. It never returns, logs or echoes the matched text.
//
//   Aadhaar   12 digits, contiguous or grouped 4-4-4 with one repeated space or hyphen
//   Card      13 to 19 contiguous digits, or four groups of digits joined by one repeated space or hyphen (4-4-4-1..4)
//   PAN       five letters, four digits, one letter (ten characters)
//   CVV/CVC   the label followed by 3 or 4 digits
//   Password  password / passwd / pwd / passcode / UPI pin / ATM pin / mPIN / OTP label followed by a value
// A phone number with a 91 country code and no separators is 12 digits and is therefore refused in free text. Phone fields have their own
// validator and do not pass through this check. Wording and scope are not final and need legal review.

const AADHAAR_CONTIGUOUS = /(?<![0-9])[0-9]{12}(?![0-9])/;
const AADHAAR_GROUPED = /(?<![0-9])[0-9]{4}([ -])[0-9]{4}\1[0-9]{4}(?![0-9])/;
const CARD_CONTIGUOUS = /(?<![0-9])[0-9]{13,19}(?![0-9])/;
const CARD_GROUPED = /(?<![0-9])[0-9]{4}([ -])[0-9]{4}\1[0-9]{4}\1[0-9]{1,4}(?![0-9])/;
const PAN = /(?<![A-Za-z0-9])[A-Za-z]{5}[0-9]{4}[A-Za-z](?![A-Za-z0-9])/;
const CVV = /(?<![A-Za-z])(?:cvv2?|cvc2?|cid)(?![A-Za-z])\s*[:=#-]?\s*[0-9]{3,4}(?![0-9])/i;
const SECRET_LABEL = /(?<![A-Za-z])(?:password|passwd|pwd|passcode|(?:upi|atm|m)[ -]?pin|otp|one[ -]time[ -](?:password|code))(?![A-Za-z])\s*(?:is|are|:|=|-)\s*\S+/i;

const PATTERNS = Object.freeze([AADHAAR_CONTIGUOUS, AADHAAR_GROUPED, CARD_CONTIGUOUS, CARD_GROUPED, PAN, CVV, SECRET_LABEL]);

/** True when `text` looks like an Aadhaar number, PAN, card number, CVV, password or one-time code. */
export function containsSensitiveIdentifier(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return PATTERNS.some(pattern => pattern.test(text));
}

/** Throws 400 SENSITIVE_IDENTIFIER_REJECTED naming only the field. */
export function assertNoSensitiveIdentifier(text, field) {
  if (containsSensitiveIdentifier(text)) {
    throw Object.assign(new Error(`${field} looks like a sensitive identifier and was not saved. Do not enter Aadhaar, PAN, card numbers, CVV, passwords or one-time codes.`), {
      code: 'SENSITIVE_IDENTIFIER_REJECTED', statusCode: 400,
    });
  }
}

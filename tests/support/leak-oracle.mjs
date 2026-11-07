// Leak oracle for the privacy gate corpus (docs/architecture/privacy-gate-golden-corpus.md section 4).
// Test support only. SYNTHETIC DATA ONLY. It returns a verdict and never the matched text.

const PLACEHOLDER = /<[A-Z]+(?:_[A-Z]+)*_[1-9]\d{0,5}>/g;

function digitValue(character) {
  let steps = 0;
  let cp = character.codePointAt(0) - 1;
  while (steps < 9 && /^\p{Nd}$/u.test(String.fromCodePoint(cp))) { steps += 1; cp -= 1; }
  return steps;
}

export function normalise(value) {
  return String(value).normalize('NFKC').replace(/\p{Cf}/gu, '')
    .replace(/\p{Nd}/gu, character => (/[0-9]/.test(character) ? character : String(digitValue(character))))
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

const digitSkeleton = value => normalise(value).replace(/\D/g, '');

/** True when `output` still carries `fragment` (rule a), a 4-digit run of it (rule b) or a name token of it (rule c). */
export function leaksFragment(output, fragment) {
  // Placeholders go before lower-casing: their upper-case form is how they are recognised.
  const text = normalise(String(output).replace(PLACEHOLDER, ' '));
  const target = normalise(fragment);
  if (!target) return false;
  // A short fragment (a leftover OCR letter and digit) counts only as a whole token, so "i" is not found in "item".
  if (target.length < 4 ? new RegExp(`(?<![\\p{L}\\p{N}])${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(text) : text.includes(target)) return true;
  const targetDigits = digitSkeleton(fragment);
  // Alphanumeric identifiers (a PAN: ABCDE1234F) are covered too: their digit group is checked even when OCR spacing splits the letters from it.
  if (targetDigits.length >= 4 && /\d/.test(target)) {
    // Digit groups join across spaces and punctuation only; a letter ends a run, so the digits of two words never merge.
    const outputRuns = text.replace(/(\d)[\s.\-‐-―/·]+(?=\d)/g, '$1').match(/\d+/g) ?? [];
    // A window needs three different digits: "0000" is in every round amount and says nothing about the secret.
    for (let at = 0; at + 4 <= targetDigits.length; at += 1) {
      const window = targetDigits.slice(at, at + 4);
      if (new Set(window).size >= 3 && outputRuns.some(run => run.includes(window))) return true;
    }
  }
  if (/\p{L}/u.test(target) && !/\d/.test(target)) {
    const words = new Set(text.split(/[^\p{L}\p{M}]+/u).filter(Boolean));
    for (const token of target.split(/[^\p{L}\p{M}]+/u).filter(token => [...token].length >= 3)) if (words.has(token)) return true;
  }
  return false;
}

export function leaks(output, secrets) {
  return secrets.filter(secret => leaksFragment(output, secret)).length;
}

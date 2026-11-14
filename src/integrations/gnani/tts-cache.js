import { createHash } from 'node:crypto';

// B7: only fixed, impersonal strings may be cached. Anything with a number, amount, date or month is personal-adjacent
// and is synthesised fresh every time.
const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
  'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'thousand', 'lakh', 'lakhs', 'lac', 'lacs', 'crore', 'crores', 'million', 'billion',
  'hazaar', 'hazar', 'sau', 'lakh', 'karod', 'crore', 'ek', 'do', 'teen', 'char', 'paanch', 'chhe', 'saat', 'aath', 'nau', 'das',
  'bees', 'tees', 'chalis', 'pachas', 'saath',
  'हज़ार', 'हजार', 'लाख', 'करोड़', 'करोड', 'सौ', 'एक', 'दो', 'तीन', 'चार', 'पांच', 'पाँच', 'छह', 'सात', 'आठ', 'नौ', 'दस', 'बीस', 'तीस', 'चालीस', 'पचास',
];
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'जनवरी', 'फ़रवरी', 'फरवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'सितम्बर', 'अक्टूबर', 'नवंबर', 'दिसंबर',
];
const BLOCKED = new Set([...NUMBER_WORDS, ...MONTHS].map(word => word.toLowerCase()));

export function isCacheableSpeech(text) {
  if (typeof text !== 'string' || text.trim() === '') return false;
  if (/\p{Nd}/u.test(text)) return false; // any digit, including Devanagari digits
  if (/[₹]|\b(?:rs|inr|rupees?|rupaye|rupay[ea])\b|रुपये|रुपए/iu.test(text)) return false;
  if (/\b(?:today|tomorrow|yesterday|aaj|kal)\b|आज|कल/iu.test(text)) return false;
  const words = text.toLowerCase().split(/[^\p{L}\p{M}]+/u).filter(Boolean);
  return !words.some(word => BLOCKED.has(word));
}

export function createTtsCache({ maxEntries = 500 } = {}) {
  const store = new Map();
  const keyOf = (text, lang, voice) => createHash('sha256').update(`${text}|${lang}|${voice}`).digest('hex');
  return Object.freeze({
    get(text, lang, voice) {
      if (!isCacheableSpeech(text)) return null;
      const key = keyOf(text, lang, voice);
      const hit = store.get(key);
      if (!hit) return null;
      store.delete(key);
      store.set(key, hit); // LRU: most recent last
      return hit;
    },
    set(text, lang, voice, value) {
      if (!isCacheableSpeech(text)) return false;
      const key = keyOf(text, lang, voice);
      store.delete(key);
      store.set(key, value);
      while (store.size > maxEntries) store.delete(store.keys().next().value);
      return true;
    },
    get size() { return store.size; },
  });
}

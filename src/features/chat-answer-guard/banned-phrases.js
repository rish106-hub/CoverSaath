// Banned output phrases, one list per rule. Matching is on NFKC-lowercased text. Lists fail closed: a legitimate sentence that
// trips one (for example "guaranteed renewal") is dropped to the "documents don't say" card. Wording is not final: legal review.
const p = (id, source) => Object.freeze({ id, pattern: new RegExp(source, 'iu') });

// "guaranteed" is banned, except as a renewal term (IRDAI lifelong renewability): allowed only when a word starting with "renew"
// is within 3 words of that occurrence. Checked per occurrence, so "guaranteed renewal, claim guaranteed" still fails.
function guaranteeRule() {
  return Object.freeze({
    id: 'guaranteed',
    pattern: {
      test(text) {
        const words = String(text).split(/\s+/);
        return words.some((word, i) => {
          if (!/^\W*guarantee[ds]?\W*$/iu.test(word)) return false;
          const near = [...words.slice(Math.max(0, i - 3), i), ...words.slice(i + 1, i + 4)];
          return !near.some((w) => /^\W*renew/iu.test(w));
        });
      },
    },
  });
}

// G1: promises about a claim outcome. Only the insurer or TPA decides.
export const OUTCOME_PROMISE_PHRASES = Object.freeze([
  p('will_be_paid', '\\bwill\\s+(?:definitely\\s+|surely\\s+)?be\\s+(?:paid|approved|settled|accepted|rejected|denied|reimbursed|honou?red|cleared)\\b'),
  p('claim_will_be', '\\bclaims?\\s+will\\s+(?:be|get)\\b'),
  p('you_will_receive', '\\byou\\s+(?:will|are\\s+going\\s+to)\\s+(?:get|receive)\\s+(?:the\\s+)?(?:money|payout|amount|claim|reimbursement)\\b'),
  guaranteeRule(),
  p('definitely', '\\b(?:definitely|certainly|surely|absolutely)\\s+(?:covered|paid|approved|settled|eligible)\\b'),
  p('hundred_percent_covered', '\\b100\\s*%\\s+(?:covered|sure|certain)\\b'),
  p('sure_to_be', '\\bsure\\s+to\\s+be\\s+(?:paid|approved|covered|settled)\\b'),
  p('hinglish_pakka', '\\bpakk[ae]\\b'),
  p('hinglish_zaroor', '\\bzaroor\\s+(?:milega|milegi|paas|pass|approve|hoga|honge)\\b'),
  p('hinglish_pakka_hindi', 'पक्का'),
]);

// G3 purchase and product advice, G4 medical advice, G12 tax advice, G13 legal advice.
export const ADVICE_PHRASES = Object.freeze([
  p('should_buy_switch', '\\byou\\s+(?:should|must|ought\\s+to|need\\s+to|have\\s+to)\\s+(?:buy|purchase|switch|port|surrender|lapse|cancel|upgrade|migrate|renew\\s+with|take\\s+out)\\b'),
  p('recommend_product', '\\bi\\s+(?:recommend|suggest|advise)\\s+(?:you\\s+)?(?:to\\s+)?(?:buy|switch|port|surrender|lapse|cancel|upgrade|taking|buying|switching|porting)\\b'),
  p('better_to_switch', '\\b(?:better|best|wise|smart)\\s+to\\s+(?:buy|switch|port|surrender|lapse|cancel|upgrade)\\b'),
  p('consider_switching', '\\bconsider\\s+(?:buying|switching|porting|surrendering|lapsing|cancelling|upgrading)\\b'),
  p('medicine_advice', '\\b(?:take|use|stop\\s+taking|skip)\\s+(?:this|the|your|a)\\s+(?:medicine|medication|tablet|pill|drug|dose|injection|antibiotic)s?\\b'),
  p('medical_diagnosis', '\\b(?:you\\s+(?:probably\\s+)?have|diagnosed\\s+with|your\\s+symptoms\\s+(?:suggest|indicate))\\b'),
  p('dosage', '\\bdosage\\b'),
  p('tax_advice', '\\b(?:tax[\\s-]+sav(?:ing|er)|save\\s+tax|tax\\s+(?:benefit|deduction|rebate|exemption)|(?:claim|get)\\s+(?:a\\s+)?deduction|section\\s+80d|80d\\s+deduction)\\b'),
  p('legal_advice', '\\b(?:you\\s+should\\s+(?:sue|file\\s+a\\s+(?:case|lawsuit|complaint\\s+in\\s+court))|take\\s+legal\\s+action|legal\\s+action\\s+against|sue\\s+the\\s+insurer)\\b'),
]);

export function firstMatch(list, text) {
  const normalised = String(text ?? '').normalize('NFKC');
  return list.find((entry) => entry.pattern.test(normalised))?.id ?? null;
}

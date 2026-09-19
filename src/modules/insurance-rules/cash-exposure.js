import { freeze, optionalMoney } from './contracts.js';

export function separateCashExposure({ statedEstimate, availableCash } = {}) {
  const estimate = optionalMoney(statedEstimate, 'input.statedEstimate');
  const cash = optionalMoney(availableCash, 'input.availableCash');
  const upfrontGap = estimate == null || cash == null ? null : Math.max(estimate - cash, 0);
  return freeze({
    upfrontCash: {
      statedEstimate: estimate,
      statedAvailableCash: cash,
      planningGap: upfrontGap,
      status: estimate == null || cash == null ? 'unknown' : 'stated_inputs_only',
    },
    possibleFinalExposure: {
      amount: null,
      status: 'unknown',
      reason: 'Final settlement depends on case facts and institutional decisions that these rules do not predict.',
    },
    insuranceLimitsAreCash: false,
  });
}

// Synthetic checker keys for curated-source tests. Each adult gets one Ed25519 key pair per test world, generated fresh.
import { generateCheckerKeyPair, signCuratedAction } from '../../src/features/decision-catalogue/index.js';

export function checkerKeyring() {
  const keys = new Map();
  const key = adultId => {
    if (!keys.has(adultId)) keys.set(adultId, generateCheckerKeyPair());
    return keys.get(adultId);
  };
  const sign = (action, adultId, fields, { now = new Date(), privateKeyPem = key(adultId).privateKeyPem, ...options } = {}) =>
    signCuratedAction({ privateKeyPem, action, now, checkerId: adultId, ...options, ...fields });
  return { key, publicKey: adultId => key(adultId).publicKey, sign, rotate: adultId => { keys.delete(adultId); return key(adultId); } };
}

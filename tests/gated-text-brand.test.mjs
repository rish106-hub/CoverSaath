// ADR 0017 D1 / WP1: GatedText is a frozen, module-private-branded gate output. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as aiAnalysis from '../src/features/ai-analysis/index.js';
import { PRIVACY_EVIDENCE_GATE_VERSION, gateText, isGatedText } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { sanitizeEvidenceTextForStorage } from './support/storage-gate.mjs';

const PLAIN = 'Sum insured: 500000';

test('gateText returns a frozen, branded object whose text equals the storage gate output', () => {
  const g = gateText(PLAIN, { knownIdentifiers: [] });
  assert.equal(Object.isFrozen(g), true);
  assert.equal(g.text, sanitizeEvidenceTextForStorage(PLAIN, { maxBytes: 16_000 }).text);
  assert.equal(g.gateVersion, PRIVACY_EVIDENCE_GATE_VERSION);
  assert.equal(isGatedText(g), true);
  assert.deepEqual(Object.keys(g).sort(), ['gateVersion', 'inputBytes', 'outputBytes', 'placeholderCount', 'reasonCodeCount', 'text']);
});

test('the brand is not enumerable, not serialised and not cloneable', () => {
  const g = gateText(PLAIN, { knownIdentifiers: [] });
  assert.equal(Object.keys(g).some(key => typeof key === 'symbol'), false);
  assert.deepEqual(Object.getOwnPropertyNames(g).filter(key => /gated/i.test(key)), []);
  assert.equal(JSON.stringify(g).includes('gatedText'), false);
  assert.equal(isGatedText(structuredClone(g)), false);
  assert.equal(isGatedText(JSON.parse(JSON.stringify(g))), false);
});

test('forgeries are never gated text', () => {
  const g = gateText(PLAIN, { knownIdentifiers: [] });
  const literal = { text: 'x', gateVersion: PRIVACY_EVIDENCE_GATE_VERSION, placeholderCount: 0, reasonCodeCount: 0, inputBytes: 1, outputBytes: 1 };
  assert.equal(isGatedText(literal), false);
  const copied = { ...literal };
  for (const symbol of Object.getOwnPropertySymbols(g)) Object.defineProperty(copied, symbol, { value: g[symbol], enumerable: false });
  assert.equal(isGatedText(copied), false);
  assert.equal(isGatedText(Object.freeze(copied)), false);
  assert.equal(isGatedText({ ...g }), false);
  assert.equal(isGatedText(Object.create(g)), false);
  assert.equal(isGatedText(new Proxy(g, {})), false);
  assert.equal(isGatedText(Object.freeze({ get text() { return 'x'; }, gateVersion: PRIVACY_EVIDENCE_GATE_VERSION })), false);
  for (const value of [null, undefined, 'text', 7, [], () => {}]) assert.equal(isGatedText(value), false);
});

test('a minted value cannot be rewritten', () => {
  const g = gateText(PLAIN, { knownIdentifiers: [] });
  assert.throws(() => { g.text = 'x'; }, TypeError);
  assert.throws(() => { g.gateVersion = 'v0'; }, TypeError);
  assert.throws(() => { Object.defineProperty(g, 'text', { value: 'x' }); }, TypeError);
  assert.equal(isGatedText(g), true);
  assert.equal(g.text, PLAIN);
});

test('truncation fails closed with EVIDENCE_SOURCE_LIMIT', () => {
  const long = `${'Waiting period of 24 months applies. '.repeat(40)}`;
  assert.throws(() => gateText(long, { knownIdentifiers: [], maxBytes: 200 }), { code: 'EVIDENCE_SOURCE_LIMIT' });
});

test('restricted evidence is refused, not returned', () => {
  assert.throws(() => gateText('-----BEGIN PRIVATE KEY----- synthetic', { knownIdentifiers: [] }), { code: 'RESTRICTED_EVIDENCE' });
});

test('a missing knownIdentifiers list is refused', () => {
  assert.throws(() => gateText(PLAIN), { code: 'PRIVACY_GATE_MALFORMED' });
  assert.throws(() => gateText(PLAIN, {}), { code: 'PRIVACY_GATE_MALFORMED' });
  assert.throws(() => gateText('', { knownIdentifiers: [] }), { code: 'PRIVACY_GATE_MALFORMED' });
});

test('raw input carrying placeholder syntax needs regate', () => {
  assert.throws(() => gateText('Insured <NAME_1> room rent', { knownIdentifiers: [] }), { code: 'RESTRICTED_EVIDENCE' });
  const g = gateText('Insured <NAME_1> room rent', { knownIdentifiers: [], regate: true });
  assert.equal(isGatedText(g), true);
  assert.equal(g.text, 'Insured <NAME_1> room rent');
  assert.equal(g.placeholderCount, 1);
});

test('counts describe the value and expose no reason codes', () => {
  const raw = 'Insured name: Ravi Synthetic. Call +91 98765 43210. Sum insured 500000.';
  const g = gateText(raw, { knownIdentifiers: [] });
  const tokens = g.text.match(/<[A-Z]+(?:_[A-Z]+)*_[1-9][0-9]{0,5}>/g) ?? [];
  assert.equal(g.placeholderCount, tokens.length);
  assert.ok(tokens.length >= 2);
  assert.ok(Number.isInteger(g.reasonCodeCount) && g.reasonCodeCount >= 1);
  assert.equal(g.inputBytes, Buffer.byteLength(raw, 'utf8'));
  assert.equal(g.outputBytes, Buffer.byteLength(g.text, 'utf8'));
  const serialised = JSON.stringify(g);
  assert.equal(/DIRECT_IDENTIFIER|SENSITIVE_HEALTH|reasonCodes/.test(serialised), false);
  assert.equal(gateText(PLAIN, { knownIdentifiers: [] }).reasonCodeCount, 0);
});

test('the module index exports the brand check but never the seal check', () => {
  assert.equal(typeof aiAnalysis.gateText, 'function');
  assert.equal(typeof aiAnalysis.isGatedText, 'function');
  assert.equal(typeof aiAnalysis.sealModelInput, 'function');
  assert.equal('isSealedModelInput' in aiAnalysis, false);
  assert.equal('sealedInputCounts' in aiAnalysis, false);
});

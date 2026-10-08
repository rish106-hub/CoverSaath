import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCESS_STATES,
  INSURER_DIRECTORY,
  NON_HEALTH_INSURERS,
  insurerById,
  insurerByName,
  insurerForUin,
  normaliseInsurerName,
} from '../src/modules/policy-breakdown/references/official/insurer-directory.js';

// Insurer names exactly as the IRDAI Handbook on Indian Insurance Statistics 2024-25 prints them.
const HANDBOOK_NAMES = [
  'Aditya Birla Health insurance Co. Ltd.', 'Care Health Insurance Ltd.', 'ManipalCigna Health Insurance Co. Ltd.',
  'Niva Bupa Health Insurance Co. Ltd.', 'Star Health and Allied Insurance Co. Ltd.', 'National Insurance Co. Ltd.',
  'The New India Assurance Co. Ltd.', 'The Oriental Insurance Co. Ltd.', 'United India Insurance Co. Ltd.',
  'Acko General Insurance Ltd.', 'Bajaj Allianz General Insurance Co. Ltd.', 'Cholamandalam MS General Insurance Co. Ltd.',
  'Future Generali India Insurance Co. Ltd.', 'Go Digit General Insurance Ltd.', 'HDFC ERGO General Insurance Co. Ltd.',
  'ICICI Lombard General Insurance Co. Ltd.', 'IFFCO Tokio General Insurance Co. Ltd.', 'Kotak Mahindra General Insurance Co. Ltd.',
  'Liberty General Insurance Ltd.', 'Magma HDI General Insurance Co. Ltd.', 'Navi General Insurance Limited',
  'Raheja QBE General Insurance Co. Ltd.', 'Reliance General Insurance Co. Ltd.', 'Royal Sundaram General Insurance Co. Ltd.',
  'SBI General Insurance Co. Ltd.', 'Shriram General Insurance Co. Ltd.', 'Tata AIG General Insurance Co. Ltd.',
  'Universal Sompo General Insurance Co. Ltd.', 'Zuno General Insurance Co. Ltd.', 'Galaxy Health Insurance Co Ltd.',
  'Narayana Health Insurance Ltd.', 'Star Health & Allied Insurance Co. Ltd.', 'Kshema General Insurance Limited',
  'Magma General Insurance Co. Ltd.', 'Zurich Kotak General Insurance Co. (India) Ltd.', 'Agriculture Insurance Company of India Ltd.',
  'ECGC Ltd.', 'Galaxy Health and Allied Insurance Company Limited', 'Narayana Health Insurance Co. Ltd',
];

const nonHealth = name => NON_HEALTH_INSURERS.some(entry => [entry.legalName, ...entry.aliases].some(alias => normaliseInsurerName(alias) === normaliseInsurerName(name)));

test('every Handbook insurer resolves to exactly one directory entry or is a known non-health insurer', () => {
  for (const name of HANDBOOK_NAMES) {
    const insurer = insurerByName(name);
    assert.ok(insurer || nonHealth(name), `unresolved Handbook name: ${name}`);
    assert.ok(!(insurer && nonHealth(name)), `${name} is both health and non-health`);
  }
  // Same company under two Handbook spellings or a former name resolves to one entry.
  assert.equal(insurerByName('Star Health & Allied Insurance Co. Ltd.'), insurerByName('Star Health and Allied Insurance Co. Ltd.'));
  assert.equal(insurerByName('Kotak Mahindra General Insurance Co. Ltd.').id, 'zurich-kotak');
  assert.equal(insurerByName('Magma HDI General Insurance Co. Ltd.'), insurerByName('Magma General Insurance Co. Ltd.'));
  assert.equal(insurerByName('Reliance General Insurance Co. Ltd.').id, 'indusind-general');
  assert.equal(insurerByName('  STAR HEALTH AND ALLIED INSURANCE COMPANY LIMITED ').id, 'star-health');
  assert.equal(insurerByName('Some Unknown Insurance Co. Ltd.'), null);
  assert.equal(insurerByName(''), null);
});

test('directory entries are complete, frozen and internally consistent', () => {
  const ids = new Set();
  for (const insurer of INSURER_DIRECTORY) {
    assert.ok(Object.isFrozen(insurer) && Object.isFrozen(insurer.officialHosts) && Object.isFrozen(insurer.wordingIndexUrls));
    assert.ok(!ids.has(insurer.id), `duplicate id ${insurer.id}`);
    ids.add(insurer.id);
    assert.equal(insurer.verifiedOn, '2026-10-08');
    assert.ok(insurer.legalName && insurer.officialHosts.length > 0);
    assert.ok(ACCESS_STATES.includes(insurer.access));
    assert.ok(insurer.uinPrefixes.length > 0, `${insurer.id} has no verified UIN prefix`);
    assert.ok(insurer.irdaiRegistrationNumber === null || /^\d{3}$/.test(insurer.irdaiRegistrationNumber));
    for (const url of insurer.wordingIndexUrls) {
      const parsed = new URL(url);
      assert.equal(parsed.protocol, 'https:');
      assert.ok(insurer.officialHosts.includes(parsed.hostname), `${url} is not on ${insurer.id}'s hosts`);
    }
    if (insurer.access !== 'server_rendered') assert.equal(insurer.wordingIndexUrls.length, 0, `${insurer.id} has an index it cannot read`);
  }
  assert.ok(INSURER_DIRECTORY.length >= 30);
  assert.equal(insurerById('hdfc-ergo').legalName, 'HDFC ERGO General Insurance Company Limited');
});

test('no UIN company code or official host belongs to two insurers', () => {
  const prefixOwner = new Map();
  const hostOwner = new Map();
  for (const insurer of INSURER_DIRECTORY) {
    for (const prefix of [...insurer.uinPrefixes, ...insurer.legacyUinPrefixes]) {
      assert.ok(!prefixOwner.has(prefix), `${prefix} maps to ${prefixOwner.get(prefix)} and ${insurer.id}`);
      prefixOwner.set(prefix, insurer.id);
    }
    for (const host of insurer.officialHosts) {
      assert.ok(!hostOwner.has(host), `${host} maps to ${hostOwner.get(host)} and ${insurer.id}`);
      hostOwner.set(host, insurer.id);
    }
  }
});

test('insurerForUin matches the company code of a well-formed UIN only', () => {
  assert.equal(insurerForUin('HDFHLIP26058V082526').id, 'hdfc-ergo');
  assert.equal(insurerForUin('hdfhlip26058 v082526').id, 'hdfc-ergo', 'case and a space before the version are tolerated');
  assert.equal(insurerForUin('APOPAIP19004V011920').id, 'hdfc-ergo', 'legacy Apollo Munich code');
  assert.equal(insurerForUin('NBHHLIP26049V022526').id, 'niva-bupa');
  assert.equal(insurerForUin('MAXHLIP21576V022021').id, 'niva-bupa');
  assert.equal(insurerForUin('SHAHLIP23017V012223').id, 'star-health');
  assert.equal(insurerForUin('RHIHLIP21532V032021').id, 'care-health');
  assert.equal(insurerForUin('INIHLIP26040V042526').id, 'indusind-general');
  assert.equal(insurerForUin('ZZZHLIP26058V082526'), null, 'unknown company code');
  assert.equal(insurerForUin('HDFHLIP2605V082526'), null, 'malformed');
  assert.equal(insurerForUin('IRDAN146RP0001V01202324'), null, 'non-health UIN format');
  assert.equal(insurerForUin(null), null);
});

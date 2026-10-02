import s01 from './s01-document-authority.js';
import s02 from './s02-people.js';
import s03 from './s03-time.js';
import s04 from './s04-treatment.js';
import s05 from './s05-exclusions.js';
import s06 from './s06-money.js';
import s07 from './s07-hospital-access.js';
import s08 from './s08-claims.js';
import s09 from './s09-renewal.js';
import s10 from './s10-insurer-quality.js';
import s11 from './s11-household.js';
import s12 from './s12-regulatory.js';
import { BreakdownContractError } from '../contracts.js';

export const SECTIONS = Object.freeze([s01, s02, s03, s04, s05, s06, s07, s08, s09, s10, s11, s12]);

function buildIndex(sections) {
  const index = new Map();
  sections.forEach((section, position) => {
    if (section.number !== position + 1) throw new BreakdownContractError('SECTION_REGISTRY_INVALID', `Section at position ${position + 1} declares number ${section.number}.`);
    for (const parameter of section.parameters) {
      if (index.has(parameter.key)) {
        throw new BreakdownContractError('SECTION_REGISTRY_INVALID', `Parameter key ${parameter.key} is declared by sections ${index.get(parameter.key).section} and ${section.number}.`);
      }
      index.set(parameter.key, parameter);
    }
  });
  return index;
}

/** key → parameter definition across all 12 sections. Fails at import if two sections share a key. */
export const PARAMETER_INDEX = buildIndex(SECTIONS);
export const EXTRACTION_SECTIONS = Object.freeze(SECTIONS.filter(section => section.kind === 'extraction'));
export const ANALYSIS_SECTIONS = Object.freeze(SECTIONS.filter(section => section.kind === 'analysis'));

export function sectionByNumber(number) {
  return SECTIONS.find(section => section.number === Number(number)) ?? null;
}

export function criticalParameters() {
  return [...PARAMETER_INDEX.values()].filter(parameter => parameter.critical);
}

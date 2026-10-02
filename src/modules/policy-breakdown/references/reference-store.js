import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Dated reference data for the analysis sections (10–12). Nothing here is embedded: an operator places
// reviewed JSON files in BREAKDOWN_REFERENCE_DIR, each carrying its own source and publication date.
//
//   insurer-disclosures.json   { "entries": [ { insurerName, metric, value, period, publishedOn, source, city? } ] }
//   regulatory-floor.json      a full floor table (see sections/s12-regulatory.js validateFloorTable)
//   procedure-costs.json       { version, source, publishedOn, entries: [ { city, procedure, typicalCostMinor, highCostMinor } ] }
//
// The sections validate content deeply and answer Unknown for anything unusable. This loader only bounds size,
// parses JSON and reports problems; a broken file is ignored, never half-used.

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const FILES = Object.freeze({
  insurerDisclosures: 'insurer-disclosures.json',
  regulatoryFloor: 'regulatory-floor.json',
  procedureCostReference: 'procedure-costs.json',
});

export const EMPTY_REFERENCES = Object.freeze({ insurerDisclosures: [], regulatoryFloor: null, procedureCostReference: null });

function readJson(path, problems, name) {
  if (!existsSync(path)) return null;
  try {
    if (statSync(path).size > MAX_FILE_BYTES) { problems.push(`${name}: larger than 5 MB, ignored`); return null; }
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    problems.push(`${name}: ${error instanceof SyntaxError ? 'not valid JSON' : 'unreadable'}, ignored`);
    return null;
  }
}

export function loadBreakdownReferences({ directory } = {}) {
  if (!directory) return { ...EMPTY_REFERENCES, loadedFrom: null, problems: [] };
  const problems = [];
  const disclosures = readJson(join(directory, FILES.insurerDisclosures), problems, FILES.insurerDisclosures);
  const floor = readJson(join(directory, FILES.regulatoryFloor), problems, FILES.regulatoryFloor);
  const costs = readJson(join(directory, FILES.procedureCostReference), problems, FILES.procedureCostReference);
  const entries = Array.isArray(disclosures) ? disclosures : Array.isArray(disclosures?.entries) ? disclosures.entries : [];
  if (disclosures && !entries.length) problems.push(`${FILES.insurerDisclosures}: no entries array, ignored`);
  return Object.freeze({
    insurerDisclosures: Object.freeze(entries.slice(0, 20_000)),
    regulatoryFloor: floor && typeof floor === 'object' && !Array.isArray(floor) ? floor : null,
    procedureCostReference: costs && typeof costs === 'object' && !Array.isArray(costs) ? costs : null,
    loadedFrom: directory,
    problems,
  });
}

/** Reloads when the files change, so an operator can update references without a restart. */
export function createReferenceProvider({ directory, ttlMs = 60_000, clock = () => Date.now() } = {}) {
  let cached = null;
  let loadedAt = 0;
  return () => {
    if (!cached || clock() - loadedAt > ttlMs) { cached = loadBreakdownReferences({ directory }); loadedAt = clock(); }
    return cached;
  };
}

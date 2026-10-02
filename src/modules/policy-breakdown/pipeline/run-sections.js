import { emptyParameterResult, sectionOutputSchema } from '../contracts.js';
import { BREAKDOWN_PROMPT_VERSION, buildSectionPrompt, buildVerifierPrompt } from '../agents/prompts.js';
import { assembleExtractionSection } from '../assembly/assemble-section.js';
import { runCrossChecks } from '../assembly/cross-checks.js';
import { ANALYSIS_SECTIONS, EXTRACTION_SECTIONS } from '../sections/index.js';

// Pure orchestration over page text. Persistence and job state live in the service.

export const agentName = (section, role = 'extractor') => `${section.id}:${role}`;

/**
 * Runs the extractor and the blind verifier for one extraction section, in parallel.
 * Returns { extracted, verified, calls } — raw, schema-shaped model outputs.
 */
export async function runExtractionSection({ section, pages, runner, budget, signal }) {
  const critical = section.parameters.filter(parameter => parameter.critical);
  const extractorPrompt = buildSectionPrompt(section, pages);
  const calls = [];
  const call = async (role, prompt, schema) => {
    const agent = agentName(section, role);
    try {
      const result = await runner.run({ agent, system: prompt.system, prompt: prompt.prompt, schema, budget, signal });
      calls.push({ agent, status: 'succeeded', provider: result.provider, model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costUsd: result.costUsd, latencyMs: result.latencyMs, promptVersion: BREAKDOWN_PROMPT_VERSION });
      return result.output;
    } catch (error) {
      calls.push({ agent, status: 'failed', provider: runner.provider, model: runner.model, inputTokens: null, outputTokens: null, costUsd: null, latencyMs: null, errorCode: error.code ?? 'MODEL_CALL_FAILED', promptVersion: BREAKDOWN_PROMPT_VERSION });
      throw error;
    }
  };
  const verifierSection = { ...section, parameters: critical };
  const verifierCall = () => call('verifier', buildVerifierPrompt(section, pages, critical), sectionOutputSchema(verifierSection));
  const [extractedResult, verifiedResult] = await Promise.allSettled([
    call('extractor', extractorPrompt, sectionOutputSchema(section)),
    critical.length ? verifierCall() : Promise.resolve(null),
  ]);
  if (extractedResult.status === 'rejected') throw extractedResult.reason;
  let verified = verifiedResult.status === 'fulfilled' ? verifiedResult.value : undefined;
  // One retry for the verifier so a transient failure does not discard the paid extraction.
  if (verified === undefined) verified = await verifierCall();
  return { extracted: extractedResult.value, verified, calls };
}

export function assembleSectionFromStep({ section, stepOutput, pages, runner }) {
  const extraction = { agent: agentName(section, 'extractor'), promptVersion: BREAKDOWN_PROMPT_VERSION, model: runner?.model ?? stepOutput.model ?? 'unknown' };
  return assembleExtractionSection({
    section,
    extracted: stepOutput.extracted,
    verified: stepOutput.verified,
    pages,
    extraction,
    verifierExtraction: { ...extraction, agent: agentName(section, 'verifier') },
  });
}

export function failedSectionResults(section, reason) {
  return Object.fromEntries(section.parameters.map(parameter => [parameter.key, emptyParameterResult(parameter, { reason })]));
}

/**
 * Runs the deterministic analysis sections (10–12) over assembled extraction parameters.
 */
export function runAnalysisSections({ parameters, household, otherRecords = [], references = {}, asOf }) {
  const results = {};
  for (const section of ANALYSIS_SECTIONS) {
    let outputs;
    try {
      outputs = section.analyze({ asOf, parameters, household, otherRecords, references });
    } catch (error) {
      for (const parameter of section.parameters) results[parameter.key] = emptyParameterResult(parameter, { reason: `analysis_failed:${error.code ?? error.name}` });
      continue;
    }
    const byKey = new Map((outputs ?? []).map(output => [output.key, output]));
    for (const parameter of section.parameters) {
      const output = byKey.get(parameter.key);
      const base = emptyParameterResult(parameter, { reason: 'analysis_returned_nothing' });
      if (!output) { results[parameter.key] = base; continue; }
      // Analysis may never produce Proven; enforce rather than trust.
      const state = output.evidenceState === 'Proven' ? 'Unknown' : output.evidenceState;
      results[parameter.key] = {
        ...base,
        value: ['Calculated', 'Dynamic'].includes(state) ? output.value ?? null : null,
        evidenceState: state,
        stateReason: output.stateReason ?? null,
        derivedFrom: output.derivedFrom ?? [],
        notes: output.notes ?? null,
        extraction: { agent: `${section.id}:analyser`, promptVersion: null, model: 'deterministic' },
        verification: { verifier: 'deterministic' },
      };
    }
  }
  return results;
}

export function finaliseParameters(parameters) {
  return { parameters, consistencyIssues: runCrossChecks(parameters) };
}

export { EXTRACTION_SECTIONS, ANALYSIS_SECTIONS };

import { AI_TASKS, DETERMINISTIC_TASKS } from './responsibility-matrix.js';

const RUNTIME_TO_AI_TASK = Object.freeze({
  profile: 'profile_extraction',
  group: 'group_cover_extraction',
  personal: 'personal_cover_extraction',
  primary: 'evidence_synthesis',
});

export function createAiTaskExecutors({ gateway, requestBuilders, resultAdapters, reservationUsd = 0 } = {}) {
  if (!gateway || typeof gateway.execute !== 'function') throw new TypeError('An AI model gateway is required.');
  const entries = Object.entries(RUNTIME_TO_AI_TASK).map(([runtimeKey, aiTask]) => [runtimeKey, async context => {
    const build = requestBuilders?.[runtimeKey];
    const adapt = resultAdapters?.[runtimeKey];
    if (typeof build !== 'function' || typeof adapt !== 'function') {
      throw Object.assign(new Error(`AI runtime adapter for ${runtimeKey} is not configured.`), { code: 'ai_adapter_not_configured' });
    }
    const response = await gateway.execute({ task: aiTask, input: await build(context), reservationUsd });
    return adapt(response.output, response.metadata, context);
  }]);
  return Object.freeze(Object.fromEntries(entries));
}

export function createAiEnhancedTaskRegistry({ baseRegistry, aiExecutors, enabledTaskKeys = [] } = {}) {
  if (!baseRegistry || typeof baseRegistry !== 'object') throw new TypeError('A base task registry is required.');
  const enabled = new Set(enabledTaskKeys);
  for (const key of enabled) {
    const aiTask = RUNTIME_TO_AI_TASK[key];
    if (!aiTask || !AI_TASKS.includes(aiTask)) {
      const code = DETERMINISTIC_TASKS.includes(key) || ['coverage', 'decision', 'evidence', 'privacy', 'safety', 'release'].includes(key)
        ? 'deterministic_task_protected'
        : 'unsupported_ai_task';
      throw Object.assign(new Error(`Runtime task ${key} cannot be replaced by a model.`), { code });
    }
    if (typeof aiExecutors?.[key] !== 'function') throw new TypeError(`Missing AI executor for ${key}.`);
  }
  return Object.freeze(Object.fromEntries(Object.entries(baseRegistry).map(([key, execute]) => [key, enabled.has(key) ? aiExecutors[key] : execute])));
}

export { RUNTIME_TO_AI_TASK };

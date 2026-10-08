import { el, hint, button } from './dom.js';
import { formatPaise } from './format.js';

const STATUS_WORDS = Object.freeze({ pending: 'Waiting', queued: 'Waiting', running: 'Working', succeeded: 'Done', failed: 'Failed', interrupted: 'Stopped' });

export function describeProgress(job) {
  if (!job) return 'Starting.';
  const steps = job.steps ?? [];
  const done = steps.filter(step => step.status === 'succeeded').length;
  if (job.status === 'queued') return 'Your breakdown is in the queue. It will start shortly.';
  if (job.status === 'succeeded') return 'All steps are done.';
  if (job.status === 'failed') return 'The breakdown stopped before it finished.';
  if (job.status === 'interrupted') return 'The breakdown was interrupted. You can resume it.';
  const current = steps.find(step => step.status === 'running');
  return `${done} of ${steps.length} steps done${current ? `. Now: ${current.label ?? current.id}` : ''}.`;
}

export function processingView({ view, controller }) {
  const job = view.job;
  const steps = job?.steps ?? [];
  const done = steps.filter(step => step.status === 'succeeded').length;
  const failedSteps = steps.filter(step => step.status === 'failed');
  const budget = job?.error?.code === 'BREAKDOWN_BUDGET_EXHAUSTED';
  const stopped = job && ['failed', 'interrupted'].includes(job.status);

  let outcome = null;
  if (budget) {
    outcome = el('div', { class: 'error', role: 'alert', 'data-testid': 'budget-exhausted' },
      el('strong', {}, 'This policy used up its processing allowance. '),
      el('span', {}, `Knowvia stopped at ${done} of ${steps.length} steps so it does not spend more than planned${job.spentUsd !== undefined ? ` (used $${job.spentUsd} of $${job.budgetUsd})` : ''}. Nothing is lost. Please contact Knowvia support, or try again later with a shorter document. We will not retry on our own.`));
  } else if (stopped) {
    outcome = el('div', { class: 'error', role: 'alert', 'data-testid': 'job-failed' },
      el('strong', {}, job.status === 'interrupted' ? 'The breakdown was interrupted. ' : 'Part of the breakdown failed. '),
      el('span', {}, job.error?.message ?? 'Steps that finished are kept. You can retry only the steps that did not finish.'),
      failedSteps.length ? el('ul', { class: 'plain-list' }, failedSteps.map(step => el('li', {}, step.label ?? step.id))) : null,
      el('div', { class: 'actions' }, el('button', { class: 'button', type: 'button', disabled: Boolean(view.busy), 'data-testid': 'resume-job', onClick: () => controller.resumeJob() }, 'Resume the failed steps')));
  }

  return el('section', { 'aria-labelledby': 'stage-heading', 'data-testid': 'stage-processing' },
    el('h2', { id: 'stage-heading', tabindex: '-1', 'data-testid': 'stage-heading' }, job?.status === 'queued' ? 'Waiting in the queue' : 'Reading your policy'),
    el('p', { class: 'lede' }, 'You can leave this page open. We check progress every few seconds.'),
    el('div', { class: 'panel' },
      el('p', { class: 'progress-summary', role: 'status', 'aria-live': 'polite', 'data-testid': 'job-progress-text' }, describeProgress(job)),
      el('progress', { max: Math.max(steps.length, 1), value: done, 'aria-label': 'Breakdown progress', 'data-testid': 'job-progress-bar' }),
      el('p', { class: 'tag-line' }, el('span', { class: `tag job-${job?.status ?? 'queued'}`, 'data-testid': 'job-status' }, job?.status ?? 'queued')),
      view.pollWarning ? el('div', { class: 'warning', role: 'status', 'data-testid': 'poll-warning' }, view.pollWarning) : null,
      steps.length
        ? el('ol', { class: 'job-steps', 'data-testid': 'job-steps' }, steps.map(step => el('li', { class: `job-step ${step.status}`, 'data-testid': `job-step-${step.id}`, 'data-status': step.status },
          el('span', {}, step.label ?? step.id), el('span', { class: 'tag' }, STATUS_WORDS[step.status] ?? step.status))))
        : hint('Preparing the steps.'),
      job?.spentUsd !== undefined && job?.budgetUsd ? hint(`Processing allowance used: ${Math.round((job.spentUsd / job.budgetUsd) * 100)}%.`) : null),
    outcome,
    budget ? el('div', { class: 'actions' }, button('Back to documents', { variant: 'secondary', testid: 'budget-back', onClick: () => controller.backToDocuments() })) : null);
}

export { formatPaise };

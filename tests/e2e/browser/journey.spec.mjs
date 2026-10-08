import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { loadSyntheticPack, buildSyntheticPdf } from '../../fixtures/policy-breakdown/synthetic-pack.mjs';
import { bootstrapToken } from '../helpers/stack.mjs';

// Browser journey on the real API + real pipeline, with fake Sarvam and Gemini (no keys, no spend):
// household → family → document consent → upload → AI consent → breakdown → workspace → review → tools.
// Failure paths drive the fakes through their /__control endpoints.
const GEMINI = `http://127.0.0.1:${process.env.E2E_GEMINI_PORT ?? 8890}`;
const SARVAM = `http://127.0.0.1:${process.env.E2E_SARVAM_PORT ?? 8891}`;
const control = (origin, body) => fetch(`${origin}/__control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

let policyPdf;
test.beforeAll(async () => { policyPdf = Buffer.from(await buildSyntheticPdf(loadSyntheticPack({ pack: 'a' }))); });
test.afterEach(async () => { await control(GEMINI, { reset: true }); await control(SARVAM, { reset: true }); });

async function blockingAxe(page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return results.violations.filter(violation => ['serious', 'critical'].includes(violation.impact)).map(violation => `${violation.id}: ${violation.nodes.length} node(s)`);
}

async function createHousehold(page) {
  await page.goto('/');
  await page.getByTestId('bootstrap-token').fill(bootstrapToken);
  await page.getByTestId('household-name').fill('Kumar household');
  await page.getByTestId('owner-name').fill('Ram Kumar');
  await page.getByTestId('bootstrap-submit').click();
  await expect(page.getByTestId('stage-family')).toBeVisible();
}

async function addSpouse(page) {
  await page.getByTestId('member-name').fill('Sita Kumar');
  await page.getByTestId('member-relationship').selectOption('spouse');
  await page.getByTestId('member-dob').fill('1991-02-02');
  await page.getByTestId('member-submit').click();
  await expect(page.getByTestId('member-item')).toHaveCount(2);
}

async function uploadPolicy(page) {
  await page.getByTestId('family-continue').click();
  await expect(page.getByTestId('stage-documents')).toBeVisible();
  await page.getByTestId('consent-document-processing').check();
  await page.getByTestId('document-file').setInputFiles({ name: 'policy-pack.pdf', mimeType: 'application/pdf', buffer: policyPdf });
  await page.getByTestId('upload-submit').click();
  await expect(page.getByTestId('upload-accepted')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('documents-continue').click();
  await expect(page.getByTestId('stage-processing-consent')).toBeVisible();
}

async function startBreakdown(page) {
  await page.getByTestId('consent-coverage-reconstruction').check();
  await page.getByTestId('start-submit').click();
  await expect(page.getByTestId('stage-processing')).toBeVisible();
}

test('full journey: household → upload → breakdown → review → emergency card, procedure check and estimate', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await createHousehold(page);
  await addSpouse(page);
  await uploadPolicy(page);
  await startBreakdown(page);

  await expect(page.getByTestId('stage-workspace')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('breakdown-view')).toBeVisible();
  await expect(page.getByTestId('record-status')).toHaveText('Needs your review');
  await expect(page.locator('[data-testid^="section-"]').first()).toBeVisible();
  expect(await blockingAxe(page), 'serious/critical axe violations on the workspace').toEqual([]);

  // Review: confirm the first proposed value the UI offers.
  const confirm = page.locator('[data-testid^="confirm-"]').first();
  if (!(await confirm.isVisible())) await page.locator('[data-testid^="section-"] summary, [data-testid^="section-"] button').first().click();
  await expect(confirm).toBeVisible();
  await confirm.click();
  await expect(page.getByTestId('notice')).toHaveText('Confirmed.');

  await page.getByTestId('check-readiness').click();
  await expect(page.getByTestId('readiness-panel')).toBeVisible();

  await page.getByTestId('tab-emergency').click();
  await expect(page.getByTestId('emergency-card')).toBeVisible();
  await expect(page.getByTestId('call-112')).toBeVisible();

  await page.getByTestId('tab-procedure').click();
  await page.getByTestId('procedure-form-submit').click();
  await expect(page.getByTestId('procedure-result')).toBeVisible();
  await expect(page.getByTestId('procedure-verdict')).toBeVisible();

  await page.getByTestId('tab-estimate').click();
  await page.getByTestId('estimate-room-rate').fill('4000');
  await page.getByTestId('estimate-room-days').fill('3');
  await page.getByTestId('bill-amount-0').fill('50000');
  await page.getByTestId('estimate-form-submit').click();
  await expect(page.getByTestId('estimate-result')).toBeVisible();
  // No member or dates were given, so waiting periods are unresolved: the household's worst case is never ₹0.
  await expect(page.getByTestId('estimate-household-pays')).not.toHaveText(/^₹0 to ₹0$/);
  expect(await blockingAxe(page), 'serious/critical axe violations on the estimate').toEqual([]);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0);
  expect(pageErrors).toEqual([]);
});

test('model timeout on one section shows a failed job that resume recovers', async ({ page }) => {
  await createHousehold(page);
  await uploadPolicy(page);
  await control(GEMINI, { failure: { mode: '500', times: null, section: 4, role: 'extractor' } });
  await startBreakdown(page);
  await expect(page.getByTestId('job-failed')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('resume-job')).toBeVisible();

  await control(GEMINI, { reset: true });
  await page.getByTestId('resume-job').click();
  await expect(page.getByTestId('stage-workspace')).toBeVisible({ timeout: 90_000 });
});

test('OCR outage fails the job with a clear message instead of hanging', async ({ page }) => {
  await createHousehold(page);
  await uploadPolicy(page);
  await control(SARVAM, { failure: { mode: '500', times: null } });
  await startBreakdown(page);
  await expect(page.getByTestId('job-failed')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('job-failed')).not.toBeEmpty();
});

test('validation: upload without permission is refused locally and nothing is sent', async ({ page }) => {
  await createHousehold(page);
  await page.getByTestId('family-continue').click();
  const uploads = [];
  page.on('request', request => { if (request.url().includes('/documents')) uploads.push(request.url()); });
  await page.getByTestId('document-file').setInputFiles({ name: 'policy-pack.pdf', mimeType: 'application/pdf', buffer: policyPdf });
  await page.getByTestId('upload-form').evaluate(form => form.requestSubmit());
  await expect(page.getByTestId('local-error')).toBeVisible();
  expect(uploads).toEqual([]);
});

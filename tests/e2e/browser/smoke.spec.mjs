import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Smoke: the app loads, the first screen has no serious/critical axe violations, and nothing scrolls sideways.
test('app loads and the first screen is accessible and responsive', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto('/');
  await expect(page.locator('body')).toBeVisible();
  await expect(page.locator('body')).not.toBeEmpty();
  await page.waitForLoadState('networkidle');

  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const blocking = results.violations.filter(violation => ['serious', 'critical'].includes(violation.impact));
  expect(blocking.map(violation => `${violation.id}: ${violation.nodes.length} node(s)`), 'serious/critical axe violations').toEqual([]);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0);
  expect(pageErrors).toEqual([]);
});

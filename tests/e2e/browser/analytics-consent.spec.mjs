import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { bootstrapToken } from '../helpers/stack.mjs';

// Consent-gated analytics, end to end: browser (posthog-js, dummy key) → Vite → API /ingest proxy → fake PostHog.
// Proves (1) no analytics request leaves the page before or after "No thanks", (2) after "Allow" only allowlisted
// events arrive and none carries a name, and (3) the browser never talks to a posthog.com host directly.
const POSTHOG = `http://127.0.0.1:${process.env.E2E_POSTHOG_PORT ?? 8889}`;
const receivedEvents = async () => (await (await fetch(`${POSTHOG}/__events`)).json());

test.beforeEach(async ({ context }) => {
  await fetch(`${POSTHOG}/__reset`, { method: 'POST' });
  await context.clearCookies();
  // posthog-js deliberately drops automated-browser traffic when navigator.webdriver is true.
  // This suite verifies the real-user consent and proxy path, while production keeps bot filtering enabled.
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', { configurable: true, get: () => false });
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      value: { brands: [{ brand: 'Chromium', version: '153' }], mobile: false, platform: 'Windows' },
    });
  });
});

function watchAnalyticsTraffic(page) {
  const seen = { ingest: [], thirdParty: [] };
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/ingest')) seen.ingest.push(url.pathname);
    if (/posthog\.com$/.test(url.hostname)) seen.thirdParty.push(url.href);
  });
  return seen;
}

async function createHousehold(page) {
  await page.getByTestId('bootstrap-token').fill(bootstrapToken);
  await page.getByTestId('household-name').fill('Kumar household');
  await page.getByTestId('owner-name').fill('Ram Kumar');
  await page.getByTestId('bootstrap-submit').click();
  await expect(page.getByTestId('stage-family')).toBeVisible();
  await page.getByTestId('member-name').fill('Sita Kumar');
  await page.getByTestId('member-relationship').selectOption('spouse');
  await page.getByTestId('member-dob').fill('1991-02-02');
  await page.getByTestId('member-submit').click();
  await expect(page.getByTestId('member-item')).toHaveCount(2);
}

test('the choice is offered up front, is accessible, and the product works either way', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('analytics-banner')).toBeVisible();
  await expect(page.getByTestId('analytics-allow')).toBeVisible();
  await expect(page.getByTestId('analytics-deny')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.filter(violation => ['serious', 'critical'].includes(violation.impact)).map(violation => violation.id)).toEqual([]);
  await expect(page.getByTestId('bootstrap-form')).toBeVisible();
});

test('without consent and after "No thanks": zero analytics requests, nothing reaches PostHog', async ({ page }) => {
  const seen = watchAnalyticsTraffic(page);
  await page.goto('/');
  await createHousehold(page); // acting before choosing must not send anything either
  await page.getByTestId('analytics-deny').click();
  await expect(page.getByTestId('analytics-banner')).toHaveCount(0);
  await expect(page.getByTestId('analytics-settings')).toBeVisible();
  await page.getByTestId('family-continue').click();
  await expect(page.getByTestId('stage-documents')).toBeVisible();
  await page.waitForTimeout(3500); // longer than the SDK's batch flush interval

  expect(seen.ingest, 'requests to /ingest').toEqual([]);
  expect(seen.thirdParty, 'direct requests to posthog.com').toEqual([]);
  expect((await receivedEvents()).events).toEqual([]);
  const consent = (await page.context().cookies()).find(cookie => cookie.name === 'knowvia_consent');
  expect(decodeURIComponent(consent.value)).toBe('v1|analytics=denied');

  await page.reload();
  await expect(page.getByTestId('analytics-banner')).toHaveCount(0);
});

test('after "Allow": only allowlisted events arrive through the proxy, with no names or cookies', async ({ page }) => {
  const seen = watchAnalyticsTraffic(page);
  await page.goto('/');
  await page.getByTestId('analytics-allow').click();
  await expect(page.getByTestId('analytics-banner')).toHaveCount(0);
  await createHousehold(page);

  await expect.poll(async () => (await receivedEvents()).events.map(item => item.event).sort(), { timeout: 20_000 })
    .toEqual(expect.arrayContaining(['consent_granted', 'household_created', 'member_added']));
  const { events, requests } = await receivedEvents();
  const allowed = ['landing_viewed', 'consent_granted', 'household_created', 'member_added', '$identify', '$exception', '$set'];
  for (const item of events) expect(allowed, `unexpected event ${item.event}`).toContain(item.event);
  const serialised = JSON.stringify(events);
  for (const forbidden of ['Ram Kumar', 'Sita Kumar', 'Kumar household', '1991-02-02', bootstrapToken]) expect(serialised).not.toContain(forbidden);
  expect(events.find(item => item.event === 'member_added').properties.member_count).toBe(2);
  for (const request of requests) { expect(request.cookie).toBeNull(); expect(request.authorization).toBeNull(); }
  expect(seen.thirdParty, 'direct requests to posthog.com').toEqual([]);

  // Turning it off stops capture immediately.
  await page.getByTestId('analytics-settings').click();
  await page.getByTestId('analytics-deny').click();
  const before = (await receivedEvents()).events.length;
  await page.getByTestId('family-continue').click();
  await page.waitForTimeout(3500);
  expect((await receivedEvents()).events.length).toBe(before);
});

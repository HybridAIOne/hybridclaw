import { expect, test } from 'playwright/test';

const ADMIN_PAGES = [
  { name: 'dashboard', path: '/admin' },
  { name: 'activity', path: '/admin/activity' },
  { name: 'agents', path: '/admin/agents' },
  { name: 'skills', path: '/admin/skills' },
  { name: 'automation', path: '/admin/automation' },
  { name: 'channels', path: '/admin/channels' },
  { name: 'connectors', path: '/admin/connectors' },
  { name: 'mcp-servers', path: '/admin/mcp' },
  { name: 'federation', path: '/admin/federation' },
  { name: 'providers', path: '/admin/models' },
  { name: 'network-policy', path: '/admin/network-policy' },
  { name: 'output-guard', path: '/admin/output-guard' },
  { name: 'credentials', path: '/admin/credentials' },
  { name: 'gateway', path: '/admin/gateway' },
  { name: 'settings', path: '/admin/config' },
  { name: 'logs', path: '/admin/logs' },
  { name: 'extensions', path: '/admin/extensions' },
  { name: 'terminal', path: '/admin/terminal' },
] as const;

test.beforeEach(async ({ page }, testInfo) => {
  const theme = String(testInfo.project.metadata.theme);
  await page.addInitScript((value) => {
    window.localStorage.setItem('hybridclaw-theme', value);
  }, theme);
});

for (const adminPage of ADMIN_PAGES) {
  test(`${adminPage.name} page`, async ({ page }, testInfo) => {
    await page.goto(adminPage.path);
    await expect(page.locator('.main-panel')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute(
      'data-theme',
      String(testInfo.project.metadata.theme),
    );
    if (adminPage.name === 'skills') {
      await page
        .getByText('Loading skill catalog...')
        .waitFor({ state: 'hidden', timeout: 15_000 });
    }

    await page.addStyleTag({
      content: `
        *, *::before, *::after {
          animation-duration: 0s !important;
          transition-duration: 0s !important;
          caret-color: transparent !important;
        }
        code,
        time,
        canvas,
        [data-visual-dynamic],
        .log-viewer,
        .logs-layout .key-value-grid > div:not(:first-child) strong {
          visibility: hidden !important;
        }
      `,
    });
    await page.waitForTimeout(250);

    await expect(page).toHaveScreenshot(`${adminPage.name}.png`);
  });
}

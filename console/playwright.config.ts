import { defineConfig, devices } from 'playwright/test';

const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './visual',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  reporter: isCI ? 'github' : 'list',
  snapshotPathTemplate:
    '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',
  timeout: 30_000,
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.001,
    },
  },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:9090',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium-light',
      metadata: { theme: 'light' },
      use: { colorScheme: 'light' },
    },
    {
      name: 'chromium-dark',
      metadata: { theme: 'dark' },
      use: { colorScheme: 'dark' },
    },
  ],
  webServer: {
    command: 'npm run dev -- start --foreground --sandbox=host',
    cwd: '..',
    env: {
      ...process.env,
      HYBRIDCLAW_ACCEPT_TRUST: 'true',
      HYBRIDCLAW_DATA_DIR: '/tmp/hybridclaw-console-visual',
    },
    timeout: 120_000,
    url: 'http://127.0.0.1:9090/health',
    reuseExistingServer: false,
  },
});

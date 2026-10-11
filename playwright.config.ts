import { defineConfig, devices } from '@playwright/test';

/** Engines: AIRGAP_BROWSERS=chromium,firefox,webkit (default chromium). */
const ENGINES = { chromium: devices['Desktop Chrome'], firefox: devices['Desktop Firefox'], webkit: devices['Desktop Safari'] } as const;
const BROWSERS = (process.env['AIRGAP_BROWSERS'] ?? 'chromium').split(',').map((b) => b.trim()).filter((b): b is keyof typeof ENGINES => b in ENGINES);

/**
 * E2E runs against the PRODUCTION build served by `vite preview`, so the CSP
 * under test is exactly what ships to GitHub Pages.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173/airgap/',
    trace: 'retain-on-failure',
  },
  projects: BROWSERS.map((name) => ({ name, use: { ...ENGINES[name] } })),
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173/airgap/',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

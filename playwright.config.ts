import { defineConfig, devices } from '@playwright/test';

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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173/airgap/',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

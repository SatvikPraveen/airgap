import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { wasmBase64 } from './vite-plugins.ts';

/**
 * Engines for browser mode: AIRGAP_BROWSERS=chromium,firefox,webkit (default chromium).
 * CI runs one engine per job; locally the default keeps the loop fast.
 */
const BROWSERS = (process.env['AIRGAP_BROWSERS'] ?? 'chromium').split(',').map((b) => b.trim()).filter(Boolean) as ('chromium' | 'firefox' | 'webkit')[];

export default defineConfig({
  plugins: [wasmBase64()],
  test: {
    projects: [
      {
        // Pure logic: capabilities, header inspection, flatten, convert orchestration.
        // No DOM, no canvas.
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // The canvas codec needs a real browser (createImageBitmap, OffscreenCanvas).
        // jsdom cannot stand in for a real encoder, so these run in headless Chromium.
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: BROWSERS.map((browser) => ({ browser })),
            screenshotFailures: false,
          },
        },
      },
    ],
  },
});

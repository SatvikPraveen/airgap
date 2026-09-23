import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
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
            instances: [{ browser: 'chromium' }],
            screenshotFailures: false,
          },
        },
      },
    ],
  },
});

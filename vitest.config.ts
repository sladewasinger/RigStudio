import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

/**
 * Two projects:
 *   unit        — the fast pure-module suite (node env; importSvg opts into jsdom via a
 *                 file docblock). `npm test` runs ONLY this project.
 *   interaction — realistic-gesture regression tests that need a real layout engine
 *                 (elementFromPoint, getScreenCTM, getBBox). Runs in headless Chromium
 *                 via Vitest Browser Mode. `npm run test:interaction`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/__tests__/**/*.test.ts'],
          // The browser suite lives here too but must never run under node.
          exclude: ['src/__tests__/interaction/**', '**/node_modules/**'],
        },
      },
      {
        // Pre-bundle the app's heavy transitive dep so Vitest doesn't optimize it
        // mid-run and reload a test (which the runner warns is flaky).
        optimizeDeps: { include: ['@anthropic-ai/sdk'] },
        test: {
          name: 'interaction',
          include: ['src/__tests__/interaction/**/*.test.ts'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotFailures: false,
            instances: [
              { browser: 'chromium', viewport: { width: 1280, height: 800 } },
            ],
          },
        },
      },
    ],
  },
});

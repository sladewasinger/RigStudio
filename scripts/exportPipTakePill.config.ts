import { defineConfig } from 'vitest/config';

/**
 * Standalone Vitest config for the one-off Pip "take a pill" export + verification
 * (`npm run export:take-pill`). It is deliberately separate from vitest.config.ts's
 * unit/interaction projects: it runs under jsdom (so importSvg's DOMParser resolves) and
 * writes real artifacts, so it must not be swept up by `npm test`.
 */
export default defineConfig({
  test: {
    name: 'export-take-pill',
    environment: 'jsdom',
    include: ['scripts/**/*.export.test.ts'],
    testTimeout: 30000,
  },
});

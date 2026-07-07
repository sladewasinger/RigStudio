import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default to node; importSvg.test.ts opts into jsdom via a file docblock.
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
});

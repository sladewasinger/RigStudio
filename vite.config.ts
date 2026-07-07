import { defineConfig } from 'vite';

// PORT is set by tooling that needs to pick a free port (e.g. the Claude Code preview
// harness when 5173 is already taken by a manually started dev server).
export default defineConfig({
  server: {
    port: Number(process.env.PORT) || 5173,
  },
});

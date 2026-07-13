#!/usr/bin/env node
// `bin` launcher for the `rig-studio-mcp` server (package.json's `bin.rig-studio-mcp`).
// Same tsx `tsImport` pattern as `headless/bin.mjs` — see that file's header for why this
// must stay a plain `.mjs` runnable by a bare `node` with no loader already active. An
// MCP client (Claude Desktop, Claude Code, ...) spawns this directly over stdio; this
// repo's own dev workflow (`npm run mcp`) takes the simpler `tsx src/mcp/server.ts` path.
import { tsImport } from 'tsx/esm/api';

await tsImport('./server.ts', import.meta.url);

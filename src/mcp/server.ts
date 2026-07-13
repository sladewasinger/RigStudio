/**
 * `rig-studio-mcp` entry point — thin process wrapper around `createServer.ts` (kept
 * separate so tests build+drive a server without spawning a process or touching real
 * stdio, mirroring `headless/cli.ts` vs. `headless/cliCommands.ts`). Run via
 * `npm run mcp` (`tsx src/mcp/server.ts`) or the `rig-studio-mcp` bin launcher
 * (`bin.mjs`) — an AI client (Claude Desktop, Claude Code, any MCP client) spawns this
 * as a LOCAL stdio subprocess on demand; there is no port, no hosting (ROADMAP H2).
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './createServer';

const server = createServer();
await server.connect(new StdioServerTransport());

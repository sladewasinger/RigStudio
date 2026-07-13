/**
 * ROADMAP H2's real-stdio smoke test: spawn the ACTUAL `rig-studio-mcp` entry point
 * (`src/mcp/server.ts`, what `npm run mcp` and the `rig-studio-mcp` bin both resolve to)
 * as a real child process and speak JSON-RPC to it over stdio via the MCP SDK's own
 * `Client` + `StdioClientTransport` — proving the transport/registration wiring actually
 * works end to end, not just the handler functions (`mcpTools.test.ts` covers those
 * directly). Mirrors `headlessCli.test.ts`'s one spawn-based smoke test for the `rig` CLI.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = join(__dirname, '..', '..');
const TSX_CLI = join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SERVER_ENTRY = join(REPO_ROOT, 'src', 'mcp', 'server.ts');
const PIP_SVG_PATH = join(REPO_ROOT, 'public', 'PIP_MASTER.svg');

let client: Client | null = null;

afterEach(async () => {
  await client?.close();
  client = null;
});

async function connectedClient(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, SERVER_ENTRY],
    cwd: REPO_ROOT,
  });
  const c = new Client({ name: 'mcp-stdio-test-client', version: '0.0.0' });
  await c.connect(transport);
  client = c;
  return c;
}

describe('rig-studio-mcp over real stdio', () => {
  it('initializes, lists tools, and imports+lists parts through one live JSON-RPC round trip', async () => {
    const c = await connectedClient();

    const tools = await c.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'add_bones', 'add_state_machine', 'analyze_rig', 'apply_clip', 'export_lottie',
      'export_riv', 'import_svg', 'list_parts', 'load_project', 'render_filmstrip',
      'save_project', 'validate',
    ]);

    const imported = await c.callTool({
      name: 'import_svg',
      arguments: { file_path: PIP_SVG_PATH, session: 'stdio-flow' },
    });
    expect(imported.isError).toBeFalsy();
    const importedText = (imported.content as { type: string; text: string }[])[0].text;
    const importedData = JSON.parse(importedText);
    expect(importedData.partCount).toBeGreaterThan(5);

    const listed = await c.callTool({ name: 'list_parts', arguments: { session: 'stdio-flow' } });
    expect(listed.isError).toBeFalsy();
    const listedData = JSON.parse((listed.content as { type: string; text: string }[])[0].text);
    const flatLabels = (tree: any[]): string[] => tree.flatMap((n) => [n.label, ...flatLabels(n.children)]);
    expect(flatLabels(listedData.tree)).toContain('right_arm');
  }, 30000);

  it('reports an unknown-session tool call as isError over the wire', async () => {
    const c = await connectedClient();
    const result = await c.callTool({ name: 'list_parts', arguments: { session: 'never-imported' } });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0].text;
    expect(text).toMatch(/Unknown session/);
  }, 30000);
});

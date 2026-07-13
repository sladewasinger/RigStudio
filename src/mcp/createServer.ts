/**
 * Builds and registers every rig-studio-mcp tool onto an `McpServer`, WITHOUT connecting
 * a transport — split out of `server.ts` (which adds the stdio transport + `connect()`)
 * so the unit suite can construct a fully-wired server and drive it in-process via the
 * MCP SDK's `Client` + `InMemoryTransport`, or call the plain handler functions in
 * `./tools/*` directly, without spawning a process (mirrors `headless/cli.ts` vs.
 * `headless/cliCommands.ts`'s process-wrapper/pure-logic split).
 *
 * Every tool wraps its handler in `toResult`/`toErrorResult`: an `McpToolError` (a
 * caller-actionable failure — bad session, invalid clip, missing file) becomes an
 * `isError: true` result with the message as-is; anything else is a real bug and is
 * re-thrown wrapped as "Unexpected error: ..." so it isn't mistaken for a handled case.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { errorMessage, McpToolError } from './errors';
import {
  AddBoneInputSchema, ClipInputSchema, ProtectedKeySchema, SessionParam, StateMachineInputSchema,
} from './schemas';
import {
  handleImportSvg, handleLoadProject, handleSaveProject, handleListParts, handleValidate,
} from './tools/docTools';
import { handleAnalyzeRig } from './tools/analyzeTools';
import { handleAddBones, handleAddStateMachine } from './tools/rigTools';
import { handleApplyClip } from './tools/clipTools';
import { handleRenderFilmstrip, handleExportRiv, handleExportLottie } from './tools/exportTools';

function toResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function toErrorResult(e: unknown): CallToolResult {
  const text = e instanceof McpToolError ? e.message : `Unexpected error: ${errorMessage(e)}`;
  return { content: [{ type: 'text', text }], isError: true };
}

/** Wrap a plain (params) => data handler as an MCP tool callback. */
function wrap<A>(handler: (args: A) => unknown): (args: A) => CallToolResult {
  return (args: A) => {
    try {
      return toResult(handler(args));
    } catch (e) {
      return toErrorResult(e);
    }
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'rig-studio-mcp', version: '0.1.0' });

  server.registerTool('import_svg', {
    description: 'Import an SVG (Inkscape/Illustrator) into a new in-memory rig session. Every group at any depth becomes a part.',
    inputSchema: { svg_text: z.string().optional(), file_path: z.string().optional(), session: SessionParam },
  }, wrap(handleImportSvg));

  server.registerTool('load_project', {
    description: 'Load a .rig.json project (by path or inline JSON text) into an in-memory session.',
    inputSchema: { file_path: z.string().optional(), json_text: z.string().optional(), session: SessionParam },
  }, wrap(handleLoadProject));

  server.registerTool('save_project', {
    description: 'Serialize a session\'s doc to .rig.json — writes to file_path, or returns the JSON text when omitted. Output opens directly in the Rig Studio editor.',
    inputSchema: { file_path: z.string().optional(), session: SessionParam },
  }, wrap(handleSaveProject));

  server.registerTool('list_parts', {
    description: 'The part tree (hierarchy, kinds, path counts), skinned parts with their controlling bone chains, bone chains, and clips of a session.',
    inputSchema: { session: SessionParam },
  }, wrap(handleListParts));

  server.registerTool('analyze_rig', {
    description: 'Heuristic rig analysis (A5 RigProfile): bone chains, left/right symmetry pairs, role guesses (torso/head/limb/...), figure group — plus the compact text block sent to the in-app AI assistant.',
    inputSchema: { session: SessionParam },
  }, wrap(handleAnalyzeRig));

  server.registerTool('add_bones', {
    description: 'Add one or more bones (Bones 2.0 joints, chainable via parentLabel) and optionally bind EXPLICIT art-part labels to them (no geometric auto-bind headlessly — labels must resolve to real art parts).',
    inputSchema: {
      bones: z.array(AddBoneInputSchema).min(1),
      bindTo: z.array(z.string()).optional()
        .describe('Convenience: bind these art labels to the union of every newly-added bone\'s resolved chain.'),
      session: SessionParam,
    },
  }, wrap(handleAddBones));

  server.registerTool('apply_clip', {
    description: 'Apply a structured clip (the SAME schema the in-app AI assistant produces) to a session: mode "new" appends a clip, "replace" edits an existing one in place. Validated with the same duration-clamp/skinned-scale-drop rules as the panel.',
    inputSchema: {
      clip: ClipInputSchema,
      mode: z.enum(['new', 'replace']),
      targetClipName: z.string().optional().describe('mode "replace" only; defaults to the doc\'s first clip.'),
      protectedKeys: z.array(ProtectedKeySchema).optional(),
      session: SessionParam,
    },
  }, wrap(handleApplyClip));

  server.registerTool('add_state_machine', {
    description: 'Add a Rive-style state machine (inputs, animation states, transitions with AND-ed conditions) to a session.',
    inputSchema: { machine: StateMachineInputSchema, session: SessionParam },
  }, wrap(handleAddStateMachine));

  server.registerTool('render_filmstrip', {
    description: 'Rasterize frames of a clip to PNGs (default: the same keyframe-cluster frame selection the AI assistant\'s filmstrip vision uses). Skinned parts render rigid (no headless LBS deformation).',
    inputSchema: {
      clip: z.string(),
      times: z.array(z.number()).optional(),
      count: z.number().int().positive().optional(),
      width: z.number().int().positive().optional(),
      out_dir: z.string().optional(),
      session: SessionParam,
    },
  }, wrap(handleRenderFilmstrip));

  server.registerTool('export_riv', {
    description: 'Export a session\'s doc to a Rive .riv binary (all clips as named animations, plus state machines). Playback-only — not openable in the Rive editor.',
    inputSchema: { file_path: z.string(), session: SessionParam },
  }, wrap(handleExportRiv));

  server.registerTool('export_lottie', {
    description: 'Export one clip to Lottie JSON. (Lottie support is frozen per current project direction — prefer export_riv unless a Lottie consumer is the actual target.)',
    inputSchema: { file_path: z.string(), clip: z.string(), session: SessionParam },
  }, wrap(handleExportLottie));

  server.registerTool('validate', {
    description: 'Check a session\'s doc: part/clip/state-machine counts and round-trip serialization byte-stability.',
    inputSchema: { session: SessionParam },
  }, wrap(handleValidate));

  return server;
}

/**
 * Command implementations for the `rig` CLI (import / validate / export-riv /
 * render-frames). Kept separate from `cli.ts` (the thin process-argv/stdout/exitCode
 * wrapper) so tests can call these directly — real fs I/O against a scratch dir, but no
 * spawned process, no asserting on real stdio/exit codes.
 */
import fs from 'node:fs';
import path from 'node:path';

import { RigDoc, deserializeDoc, normalizeDoc, serializeDoc } from '../core/model';
import { exportRiv } from '../io/riv';
import { importSvgHeadless } from './importSvgHeadless';
import { diffJson } from './diff';
import { partTreeSummary } from './partTree';
import { renderFrames } from './renderFrames';

export interface CommandResult {
  code: 0 | 1;
  stdout: string;
  stderr: string;
}

const USAGE = `rig <command> [args]

Commands:
  import <art.svg> [-o out.rig.json]       Import an SVG into a .rig.json project
  validate <file.rig.json>                 Check a project file (normalization + round-trip stability)
  export-riv <file.rig.json> [-o out.riv]  Export a project to a Rive .riv binary
  render-frames <file.rig.json> --clip <name> [-o outdir] [--times 0,250,500 | --count N] [--width N]
                                            Rasterize frames of a clip to PNGs (default frame
                                            selection: the AI filmstrip's keyframe-cluster algorithm)
`;

function ok(stdout: string): CommandResult {
  return { code: 0, stdout, stderr: '' };
}

function fail(message: string): CommandResult {
  return { code: 1, stdout: '', stderr: message.endsWith('\n') ? message : `${message}\n` };
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function parseArgs(args: string[]): { positional: string[]; out: string | null } {
  const positional: string[] = [];
  let out: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--out') out = args[++i] ?? null;
    else positional.push(a);
  }
  return { positional, out };
}

function defaultOutPath(inputPath: string, ext: string): string {
  const base = path.basename(inputPath).replace(/\.[^.]+$/, '');
  return path.join(path.dirname(inputPath), base + ext);
}

/** Turn a JSON.parse SyntaxError into a "line N, column M" message when possible (V8's
 *  message embeds a character offset, e.g. "... at position 42"). Newer V8 already
 *  appends its own "(line N column M)" — skip ours rather than duplicate it. */
function describeJsonError(text: string, e: unknown): string {
  const message = messageOf(e);
  if (/line \d+ column \d+/i.test(message)) return message;
  const m = /position (\d+)/.exec(message);
  if (!m) return message;
  const offset = Number(m[1]);
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - before.lastIndexOf('\n');
  return `${message} (line ${line}, column ${column})`;
}

// ---- import ----

export function runImport(args: string[]): CommandResult {
  const { positional, out } = parseArgs(args);
  const svgPath = positional[0];
  if (!svgPath) return fail('Usage: rig import <art.svg> [-o out.rig.json]');
  const resolved = path.resolve(svgPath);
  if (!fs.existsSync(resolved)) return fail(`SVG file not found: ${resolved}`);

  const svgText = fs.readFileSync(resolved, 'utf8');
  const name = path.basename(resolved).replace(/\.svg$/i, '');
  let doc: RigDoc;
  try {
    doc = importSvgHeadless(svgText, name);
  } catch (e) {
    return fail(`Import failed: ${messageOf(e)}`);
  }
  normalizeDoc(doc);

  const json = serializeDoc(doc);
  const outPath = path.resolve(out ?? defaultOutPath(resolved, '.rig.json'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, json, 'utf8');

  const count = doc.parts.length;
  const stdout =
    `Imported "${doc.name}" (${count} part${count === 1 ? '' : 's'})\n`
    + `${partTreeSummary(doc)}\n\n`
    + `Wrote ${outPath} (${Buffer.byteLength(json, 'utf8')} bytes)\n`;
  return ok(stdout);
}

// ---- validate ----

export function runValidate(args: string[]): CommandResult {
  const { positional } = parseArgs(args);
  const filePath = positional[0];
  if (!filePath) return fail('Usage: rig validate <file.rig.json>');
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return fail(`File not found: ${resolved}`);

  const text = fs.readFileSync(resolved, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(`Invalid JSON in ${resolved}: ${describeJsonError(text, e)}`);
  }
  const rawDoc =
    raw && typeof raw === 'object' && 'doc' in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>).doc
      : raw;

  let doc: RigDoc;
  try {
    doc = deserializeDoc(text);
  } catch (e) {
    return fail(`Not a valid Rig Studio project (${resolved}): ${messageOf(e)}`);
  }

  const diffs = diffJson(rawDoc, doc);
  const s1 = serializeDoc(doc);
  const s2 = serializeDoc(deserializeDoc(s1));
  const stable = s1 === s2;

  const lines: string[] = [resolved];
  lines.push(`  parts: ${doc.parts.length}`);
  lines.push(`  clips: ${doc.clips.length}`);
  lines.push(`  state machines: ${(doc.stateMachines ?? []).length}`);
  if (diffs.length === 0) {
    lines.push('  normalization: no changes (file already canonical)');
  } else {
    lines.push(`  normalization: ${diffs.length} field${diffs.length === 1 ? '' : 's'} changed by normalizeDoc`);
    for (const d of diffs.slice(0, 20)) {
      lines.push(`    ${d.path}: ${JSON.stringify(d.before)} -> ${JSON.stringify(d.after)}`);
    }
    if (diffs.length > 20) lines.push(`    ... and ${diffs.length - 20} more`);
  }
  lines.push(`  round-trip byte-stable: ${stable ? 'yes' : 'no'}`);
  lines.push(stable ? '  VALID' : '  INVALID');

  return { code: stable ? 0 : 1, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

// ---- export-riv ----

export function runExportRiv(args: string[]): CommandResult {
  const { positional, out } = parseArgs(args);
  const filePath = positional[0];
  if (!filePath) return fail('Usage: rig export-riv <file.rig.json> [-o out.riv]');
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return fail(`File not found: ${resolved}`);

  const text = fs.readFileSync(resolved, 'utf8');
  let doc: RigDoc;
  try {
    doc = deserializeDoc(text);
  } catch (e) {
    return fail(`Not a valid Rig Studio project (${resolved}): ${messageOf(e)}`);
  }

  let bytes: Uint8Array;
  try {
    bytes = exportRiv(doc);
  } catch (e) {
    return fail(`Export failed: ${messageOf(e)}`);
  }

  const outPath = path.resolve(out ?? defaultOutPath(resolved, '.riv'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, bytes);

  const names = doc.clips.map((c) => c.name);
  const stdout =
    `Wrote ${outPath} (${bytes.length} bytes)\n`
    + `Animations: ${names.length ? names.join(', ') : '(none)'}\n`;
  return ok(stdout);
}

// ---- render-frames ----

interface RenderFramesArgs {
  positional: string[];
  out: string | null;
  clip: string | null;
  times: number[] | null;
  count: number | null;
  width: number | null;
}

function parseRenderFramesArgs(args: string[]): RenderFramesArgs {
  const positional: string[] = [];
  let out: string | null = null;
  let clip: string | null = null;
  let times: number[] | null = null;
  let count: number | null = null;
  let width: number | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o' || a === '--out') out = args[++i] ?? null;
    else if (a === '--clip') clip = args[++i] ?? null;
    else if (a === '--times') {
      times = (args[++i] ?? '')
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
    } else if (a === '--count') count = Number(args[++i]);
    else if (a === '--width') width = Number(args[++i]);
    else positional.push(a);
  }
  return { positional, out, clip, times, count, width };
}

/** Default output directory: alongside the input file, named after it plus the clip. */
function defaultOutDir(inputPath: string, clipName: string): string {
  const base = path.basename(inputPath).replace(/\.[^.]+$/, '');
  const safeClip = clipName.replace(/[^a-zA-Z0-9_-]+/g, '_');
  return path.join(path.dirname(inputPath), `${base}-${safeClip}-frames`);
}

export function runRenderFrames(args: string[]): CommandResult {
  const { positional, out, clip: clipName, times, count, width } = parseRenderFramesArgs(args);
  const usage =
    'Usage: rig render-frames <file.rig.json> --clip <name> '
    + '[-o outdir] [--times 0,250,500 | --count N] [--width N]';
  const filePath = positional[0];
  if (!filePath) return fail(usage);
  if (!clipName) return fail(`Missing required --clip <name>\n\n${usage}`);
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return fail(`File not found: ${resolved}`);

  const text = fs.readFileSync(resolved, 'utf8');
  let doc: RigDoc;
  try {
    doc = deserializeDoc(text);
  } catch (e) {
    return fail(`Not a valid Rig Studio project (${resolved}): ${messageOf(e)}`);
  }

  let result: ReturnType<typeof renderFrames>;
  try {
    result = renderFrames(doc, clipName, {
      times: times ?? undefined,
      count: count ?? undefined,
      width: width ?? undefined,
    });
  } catch (e) {
    return fail(`render-frames failed: ${messageOf(e)}`);
  }

  const outDir = path.resolve(out ?? defaultOutDir(resolved, clipName));
  fs.mkdirSync(outDir, { recursive: true });
  const lines = result.frames.map((frame) => {
    fs.writeFileSync(path.join(outDir, frame.fileName), frame.png);
    return `  ${frame.timeMs}ms -> ${frame.fileName}`;
  });

  const dims = result.frames[0] ? `${result.frames[0].width}x${result.frames[0].height}` : 'n/a';
  let stdout =
    `Rendered ${result.frames.length} frame(s) of "${clipName}" (${dims}) to ${outDir}\n`
    + `${lines.join('\n')}\n`;
  if (result.hasSkinnedParts) {
    stdout +=
      '\nNote: this document has skinned part(s) — they render RIGID in headless mode '
      + '(bind-pose geometry, no linear-blend deformation). The .riv EXPORT of this doc '
      + 'does articulate them (Rive Skin/Tendon); only these frame renders are rigid.\n';
  }
  return ok(stdout);
}

// ---- dispatch ----

export function dispatch(argv: string[]): CommandResult {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'import': return runImport(rest);
    case 'validate': return runValidate(rest);
    case 'export-riv': return runExportRiv(rest);
    case 'render-frames': return runRenderFrames(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      return ok(USAGE);
    default:
      return fail(`Unknown command: ${cmd}\n\n${USAGE}`);
  }
}

/**
 * Output tools: render_filmstrip (PNGs via `headless/renderFrames.ts`, reusing the exact
 * A3 keyframe-cluster frame selection the in-app AI assistant's filmstrip vision uses),
 * export_riv, and export_lottie (kept for parity with the headless CLI; per CLAUDE.md's
 * Lottie-freeze note the exporter itself is frozen, not deprecated — this tool is a thin
 * pass-through either way).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RigDoc } from '../../core/model';
import { exportLottie } from '../../io/exportLottie';
import { exportRiv } from '../../io/riv';
import { renderFrames } from '../../headless/renderFrames';
import { McpToolError, errorMessage } from '../errors';
import { withSessionDoc } from '../sessions';

const DEFAULT_SESSION = 'default';

export interface RenderFilmstripParams {
  clip: string;
  times?: number[];
  count?: number;
  width?: number;
  out_dir?: string;
  session?: string;
}

export function handleRenderFilmstrip(params: RenderFilmstripParams) {
  const session = params.session ?? DEFAULT_SESSION;
  return withSessionDoc(session, (doc) => {
    let result;
    try {
      result = renderFrames(doc, params.clip, {
        times: params.times, count: params.count, width: params.width,
      });
    } catch (e) {
      throw new McpToolError(errorMessage(e));
    }
    const outDir = path.resolve(
      params.out_dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'rig-studio-mcp-filmstrip-')),
    );
    fs.mkdirSync(outDir, { recursive: true });
    const frames = result.frames.map((frame) => {
      const filePath = path.join(outDir, frame.fileName);
      fs.writeFileSync(filePath, frame.png);
      return { timeMs: frame.timeMs, filePath, width: frame.width, height: frame.height };
    });
    return {
      session,
      clip: params.clip,
      outDir,
      frames,
      hasSkinnedParts: result.hasSkinnedParts,
    };
  });
}

export interface ExportRivParams {
  file_path: string;
  session?: string;
}

export function handleExportRiv(params: ExportRivParams) {
  const session = params.session ?? DEFAULT_SESSION;
  return withSessionDoc(session, (doc) => {
    let bytes: Uint8Array;
    try {
      bytes = exportRiv(doc);
    } catch (e) {
      throw new McpToolError(`Export failed: ${errorMessage(e)}`);
    }
    const resolved = path.resolve(params.file_path);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, bytes);
    return {
      session,
      file_path: resolved,
      bytes: bytes.length,
      animations: doc.clips.map((c) => c.name),
    };
  });
}

export interface ExportLottieParams {
  file_path: string;
  clip: string;
  session?: string;
}

/** Resolve a clip name to its index in `doc.clips` — exportLottie takes an index. */
function clipIndexOf(doc: RigDoc, clipName: string): number {
  const idx = doc.clips.findIndex((c) => c.name === clipName);
  if (idx === -1) {
    throw new McpToolError(
      `Clip not found: "${clipName}" (available: ${doc.clips.map((c) => c.name).join(', ') || '(none)'})`,
    );
  }
  return idx;
}

export function handleExportLottie(params: ExportLottieParams) {
  const session = params.session ?? DEFAULT_SESSION;
  return withSessionDoc(session, (doc) => {
    const idx = clipIndexOf(doc, params.clip);
    let json: string;
    try {
      json = exportLottie(doc, idx);
    } catch (e) {
      throw new McpToolError(`Export failed: ${errorMessage(e)}`);
    }
    const resolved = path.resolve(params.file_path);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, json, 'utf8');
    return { session, file_path: resolved, bytes: Buffer.byteLength(json, 'utf8'), clip: params.clip };
  });
}

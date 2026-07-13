/**
 * Doc lifecycle tools: import_svg, load_project, save_project, list_parts, validate.
 * Plain handler functions (no MCP/zod types here) so the unit suite can call them
 * directly — `createServer.ts` is the only place that wires zod schemas + the
 * `McpServer.registerTool` protocol plumbing around these.
 */
import fs from 'node:fs';
import path from 'node:path';

import { deserializeDoc, normalizeDoc, RigDoc, serializeDoc } from '../../core/model';
import { importSvgHeadless } from '../../headless';
import { McpToolError, errorMessage } from '../errors';
import {
  buildBoneChainSummaries, buildPartTree, buildSkinnedPartSummaries,
} from '../partTreeJson';
import { setSessionDoc, withSessionDoc } from '../sessions';

const DEFAULT_SESSION = 'default';

export interface ImportSvgParams {
  svg_text?: string;
  file_path?: string;
  session?: string;
}

export function handleImportSvg(params: ImportSvgParams) {
  const session = params.session ?? DEFAULT_SESSION;
  let svgText = params.svg_text ?? null;
  let name = session;
  if (!svgText && params.file_path) {
    const resolved = path.resolve(params.file_path);
    if (!fs.existsSync(resolved)) throw new McpToolError(`SVG file not found: ${resolved}`);
    svgText = fs.readFileSync(resolved, 'utf8');
    name = path.basename(resolved).replace(/\.svg$/i, '');
  }
  if (!svgText) throw new McpToolError('Provide either svg_text or file_path.');

  let doc: RigDoc;
  try {
    doc = importSvgHeadless(svgText, name);
  } catch (e) {
    throw new McpToolError(`Import failed: ${errorMessage(e)}`);
  }
  normalizeDoc(doc);
  setSessionDoc(session, doc);

  return {
    session,
    name: doc.name,
    partCount: doc.parts.length,
    tree: buildPartTree(doc),
  };
}

export interface LoadProjectParams {
  file_path?: string;
  json_text?: string;
  session?: string;
}

export function handleLoadProject(params: LoadProjectParams) {
  const session = params.session ?? DEFAULT_SESSION;
  let text = params.json_text ?? null;
  if (!text && params.file_path) {
    const resolved = path.resolve(params.file_path);
    if (!fs.existsSync(resolved)) throw new McpToolError(`File not found: ${resolved}`);
    text = fs.readFileSync(resolved, 'utf8');
  }
  if (!text) throw new McpToolError('Provide either file_path or json_text.');

  let doc: RigDoc;
  try {
    doc = deserializeDoc(text);
  } catch (e) {
    throw new McpToolError(`Not a valid Rig Studio project: ${errorMessage(e)}`);
  }
  setSessionDoc(session, doc);

  return {
    session,
    name: doc.name,
    partCount: doc.parts.length,
    clips: doc.clips.map((c) => c.name),
    stateMachines: (doc.stateMachines ?? []).map((sm) => sm.name),
  };
}

export interface SaveProjectParams {
  file_path?: string;
  session?: string;
}

export function handleSaveProject(params: SaveProjectParams) {
  const session = params.session ?? DEFAULT_SESSION;
  return withSessionDoc(session, (doc) => {
    const text = serializeDoc(doc);
    if (params.file_path) {
      const resolved = path.resolve(params.file_path);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, text, 'utf8');
      return { session, file_path: resolved, bytes: Buffer.byteLength(text, 'utf8') };
    }
    return { session, json_text: text, bytes: Buffer.byteLength(text, 'utf8') };
  });
}

export interface SessionOnlyParams {
  session?: string;
}

export function handleListParts(params: SessionOnlyParams) {
  const session = params.session ?? DEFAULT_SESSION;
  return withSessionDoc(session, (doc) => ({
    session,
    tree: buildPartTree(doc),
    skinnedParts: buildSkinnedPartSummaries(doc),
    boneChains: buildBoneChainSummaries(doc),
    clips: doc.clips.map((c) => ({ name: c.name, duration: c.duration, trackCount: c.tracks.length })),
  }));
}

export function handleValidate(params: SessionOnlyParams) {
  const session = params.session ?? DEFAULT_SESSION;
  return withSessionDoc(session, (doc) => {
    const s1 = serializeDoc(doc);
    const s2 = serializeDoc(deserializeDoc(s1));
    const roundTripByteStable = s1 === s2;
    return {
      session,
      parts: doc.parts.length,
      clips: doc.clips.length,
      stateMachines: (doc.stateMachines ?? []).length,
      roundTripByteStable,
      valid: roundTripByteStable,
    };
  });
}


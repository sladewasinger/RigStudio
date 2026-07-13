/**
 * ROADMAP H2 handler-level tests: drive the MCP tool HANDLER FUNCTIONS directly (not the
 * stdio transport — see `mcpStdio.test.ts` for the one real-subprocess smoke test) through
 * a realistic flow: import PIP_MASTER -> analyze -> add_bones with explicit binds ->
 * apply_clip -> validate -> export_riv (decoded via rivDecoder) -> render_filmstrip
 * (decodable PNGs). Plus session isolation, the `state.doc` restore pin, and the
 * documented error paths (clamp report, unknown session, no-geometric-auto-bind).
 */
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

import { state } from '../core/model';
import {
  handleImportSvg, handleLoadProject, handleSaveProject, handleListParts, handleValidate,
} from '../mcp/tools/docTools';
import { handleAnalyzeRig } from '../mcp/tools/analyzeTools';
import { handleAddBones, handleAddStateMachine } from '../mcp/tools/rigTools';
import { handleApplyClip } from '../mcp/tools/clipTools';
import { handleRenderFilmstrip, handleExportRiv, handleExportLottie } from '../mcp/tools/exportTools';
import { McpToolError } from '../mcp/errors';
import { decodeRiv } from './rivDecoder';

const PIP_SVG_PATH = join(__dirname, '..', '..', 'public', 'PIP_MASTER.svg');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rig-studio-mcp-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('mcp doc lifecycle', () => {
  it('import_svg builds a session with a nested part tree', () => {
    const result = handleImportSvg({ file_path: PIP_SVG_PATH, session: 'lifecycle' }) as any;
    expect(result.session).toBe('lifecycle');
    expect(result.partCount).toBeGreaterThan(5);
    const labels = new Set(result.tree.map((n: any) => n.label));
    expect(labels.has('right_arm')).toBe(true);
    expect(labels.has('body')).toBe(true);
  });

  it('save_project / load_project round-trip via inline json_text', () => {
    const imported = handleImportSvg({ file_path: PIP_SVG_PATH, session: 'save1' }) as any;
    const saved = handleSaveProject({ session: 'save1' }) as any;
    expect(saved.json_text).toBeTruthy();
    const loaded = handleLoadProject({ json_text: saved.json_text, session: 'save2' }) as any;
    expect(loaded.partCount).toBe(imported.partCount);
    const original = handleListParts({ session: 'save1' }) as any;
    const reloaded = handleListParts({ session: 'save2' }) as any;
    expect(reloaded.tree).toEqual(original.tree);
  });

  it('save_project writes to file_path when given', () => {
    handleImportSvg({ file_path: PIP_SVG_PATH, session: 'save3' });
    const outPath = join(dir, 'pip.rig.json');
    const result = handleSaveProject({ file_path: outPath, session: 'save3' }) as any;
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath, 'utf8').length).toBe(result.bytes);
  });
});

describe('mcp realistic flow: import -> analyze -> bones -> clip -> validate -> export', () => {
  const SESSION = 'flow';

  beforeEach(() => {
    handleImportSvg({ file_path: PIP_SVG_PATH, session: SESSION });
  });

  it('analyze_rig finds the left/right arm+leg symmetry pairs', () => {
    const result = handleAnalyzeRig({ session: SESSION }) as any;
    const bases = result.profile.symmetryPairs.map((p: any) => p.base);
    expect(bases).toEqual(expect.arrayContaining(['arm', 'leg']));
    expect(typeof result.profileBlock).toBe('string');
  });

  it('add_bones creates an explicit joint and binds a named art part (no DOM auto-bind)', () => {
    const result = handleAddBones({
      bones: [{ label: 'shoulder_bone', x1: 66.64, y1: 119.59, x2: 66.64, y2: 160, bindParts: ['right_arm'] }],
      session: SESSION,
    }) as any;
    expect(result.addedBones).toEqual([{ label: 'shoulder_bone', id: expect.any(String) }]);
    expect(result.boundPartCount).toBe(1);

    const parts = handleListParts({ session: SESSION }) as any;
    const skinned = parts.skinnedParts.find((p: any) => p.label === 'right_arm');
    expect(skinned).toBeTruthy();
    expect(skinned.bones.map((b: any) => b.label)).toEqual(['shoulder_bone']);
  });

  it('apply_clip (mode new) creates a clip keying the new bone, validated + exported', () => {
    handleAddBones({
      bones: [{ label: 'shoulder_bone', x1: 66.64, y1: 119.59, x2: 66.64, y2: 160, bindParts: ['right_arm'] }],
      session: SESSION,
    });

    const applied = handleApplyClip({
      mode: 'new',
      clip: {
        name: 'wave',
        clipName: 'wave',
        duration: 1000,
        tracks: [{
          target: 'shoulder_bone',
          channel: 'rotate',
          keyframes: [
            { time: 0, value: 0, easing: 'easeInOut' },
            { time: 500, value: 30, easing: 'easeInOut' },
            { time: 1000, value: 0, easing: 'easeInOut' },
          ],
        }],
      },
      session: SESSION,
    }) as any;
    expect(applied.clipName).toBe('wave');
    expect(applied.trackCount).toBe(1);
    expect(applied.clampedCount).toBe(0);

    const validated = handleValidate({ session: SESSION }) as any;
    expect(validated.valid).toBe(true);
    expect(validated.clips).toBe(2); // the default 'idle' + 'wave'

    const rivPath = join(dir, 'pip.riv');
    const exported = handleExportRiv({ file_path: rivPath, session: SESSION }) as any;
    expect(exported.animations).toEqual(expect.arrayContaining(['idle', 'wave']));
    const bytes = readFileSync(rivPath);
    const decoded = decodeRiv(bytes);
    expect(decoded.major).toBe(7);
    expect(decoded.animations.map((a) => a.name)).toEqual(expect.arrayContaining(['wave']));

    const filmstrip = handleRenderFilmstrip({ clip: 'wave', count: 3, width: 64, out_dir: join(dir, 'frames'), session: SESSION }) as any;
    expect(filmstrip.frames).toHaveLength(3);
    for (const frame of filmstrip.frames) {
      expect(existsSync(frame.filePath)).toBe(true);
      const png = PNG.sync.read(readFileSync(frame.filePath));
      expect(png.width).toBeGreaterThan(0);
      expect(png.height).toBeGreaterThan(0);
    }
  });

  it('export_lottie writes parseable JSON for an existing clip', () => {
    const outPath = join(dir, 'pip.lottie.json');
    const result = handleExportLottie({ file_path: outPath, clip: 'idle', session: SESSION }) as any;
    expect(result.bytes).toBeGreaterThan(0);
    const parsed = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(parsed.layers.length).toBeGreaterThan(0);
  });

  it('add_state_machine wires inputs/states/transitions by name', () => {
    const result = handleAddStateMachine({
      machine: {
        name: 'main',
        inputs: [{ name: 'active', type: 'bool', default: false }],
        states: [{ name: 'Idle', clipName: 'idle' }],
        transitions: [{ from: 'Entry', to: 'Idle' }],
      },
      session: SESSION,
    }) as any;
    expect(result.stateCount).toBe(4); // entry+any+exit + the one animation state
    expect(result.transitionCount).toBe(1);
  });
});

describe('mcp session isolation and state.doc restoration', () => {
  it('two sessions never see each others parts', () => {
    handleImportSvg({ file_path: PIP_SVG_PATH, session: 'iso-a' });
    handleImportSvg({ file_path: PIP_SVG_PATH, session: 'iso-b' });
    handleAddBones({ bones: [{ label: 'only_in_b', x1: 0, y1: 0, x2: 10, y2: 10 }], session: 'iso-b' });

    const a = handleListParts({ session: 'iso-a' }) as any;
    const b = handleListParts({ session: 'iso-b' }) as any;
    const flatLabels = (tree: any[]): string[] => tree.flatMap((n) => [n.label, ...flatLabels(n.children)]);
    expect(flatLabels(a.tree)).not.toContain('only_in_b');
    expect(flatLabels(b.tree)).toContain('only_in_b');
  });

  it('restores state.doc (and every other state field) after a mutating tool call', () => {
    handleImportSvg({ file_path: PIP_SVG_PATH, session: 'restore' });
    const before = { ...state };
    handleAddBones({ bones: [{ label: 'temp_bone', x1: 1, y1: 1, x2: 5, y2: 5 }], session: 'restore' });
    expect(state.doc).toBe(before.doc);
    expect(state.selectedPartId).toBe(before.selectedPartId);
    expect(state.activeClipIndex).toBe(before.activeClipIndex);
  });

  it('restores state.doc even when the mutating call throws', () => {
    handleImportSvg({ file_path: PIP_SVG_PATH, session: 'restore-throw' });
    const before = state.doc;
    expect(() => handleAddBones({
      bones: [{ label: 'x', x1: 0, y1: 0, x2: 1, y2: 1, bindParts: ['not_a_real_part'] }],
      session: 'restore-throw',
    })).toThrow(McpToolError);
    expect(state.doc).toBe(before);
  });
});

describe('mcp error paths', () => {
  it('unknown session is a clear McpToolError', () => {
    expect(() => handleListParts({ session: 'does-not-exist' })).toThrow(/Unknown session/);
  });

  it('add_bones with a bindParts label that resolves to no art part errors clearly (no geometric fallback)', () => {
    handleImportSvg({ file_path: PIP_SVG_PATH, session: 'bad-bind' });
    expect(() => handleAddBones({
      bones: [{ label: 'x', x1: 0, y1: 0, x2: 1, y2: 1, bindParts: ['nope'] }],
      session: 'bad-bind',
    })).toThrow(/no geometric auto-bind/);
  });

  it('apply_clip clamps out-of-range keyframe times and reports the count', () => {
    handleImportSvg({ file_path: PIP_SVG_PATH, session: 'clamp' });
    const applied = handleApplyClip({
      mode: 'new',
      clip: {
        name: 'overshoot',
        clipName: 'overshoot',
        duration: 1000,
        tracks: [{
          target: 'body',
          channel: 'rotate',
          keyframes: [
            { time: 0, value: 0, easing: 'linear' },
            { time: 5000, value: 10, easing: 'linear' }, // out of [0, duration]
          ],
        }],
      },
      session: 'clamp',
    }) as any;
    expect(applied.clampedCount).toBeGreaterThan(0);
  });

  it('apply_clip drops sx/sy tracks on an already-skinned part and reports it via clampedCount', () => {
    handleImportSvg({ file_path: PIP_SVG_PATH, session: 'skin-drop' });
    handleAddBones({
      bones: [{ label: 'arm_bone', x1: 66.64, y1: 119.59, x2: 66.64, y2: 160, bindParts: ['right_arm'] }],
      session: 'skin-drop',
    });
    const applied = handleApplyClip({
      mode: 'new',
      clip: {
        name: 'bad_scale',
        clipName: 'bad_scale',
        duration: 500,
        tracks: [{
          target: 'right_arm',
          channel: 'sx',
          keyframes: [{ time: 0, value: 1.5, easing: 'linear' }],
        }],
      },
      session: 'skin-drop',
    }) as any;
    expect(applied.clampedCount).toBe(1);
    expect(applied.trackCount).toBe(0);
  });
});

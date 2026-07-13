/**
 * CLI-level tests for `rig render-frames`, function-call style like `headlessCli.test.ts`
 * (which owns import/validate/export-riv): call `runImport`/`runRenderFrames` directly —
 * real fs I/O against a scratch temp dir, no spawned process.
 */
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runImport, runRenderFrames } from '../headless/cliCommands';

const PIP_SVG_PATH = join(__dirname, '..', '..', 'public', 'PIP_MASTER.svg');

let dir: string;
let projectPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rig-headless-render-frames-'));
  projectPath = join(dir, 'pip.rig.json');
  const imported = runImport([PIP_SVG_PATH, '-o', projectPath]);
  expect(imported.code).toBe(0);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('rig render-frames', () => {
  it('renders PNG frames of an existing clip and prints a time -> filename manifest', () => {
    const outDir = join(dir, 'frames');
    const result = runRenderFrames([projectPath, '--clip', 'idle', '-o', outDir]);

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Rendered \d+ frame\(s\) of "idle"/);
    expect(result.stdout).toMatch(/^\s+\d+ms -> frame-\d{4}-\d+ms\.png$/m);

    const files = readdirSync(outDir).filter((f) => f.endsWith('.png'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(readFileSync(join(outDir, f)).length).toBeGreaterThan(0);
    }
  });

  it('honors --width and writes exactly the requested frame count with --count', () => {
    const outDir = join(dir, 'frames2');
    const result = runRenderFrames([projectPath, '--clip', 'idle', '-o', outDir, '--count', '3', '--width', '128']);

    expect(result.code).toBe(0);
    const files = readdirSync(outDir).filter((f) => f.endsWith('.png'));
    expect(files).toHaveLength(3);
    expect(result.stdout).toMatch(/\(128x\d+\)/);
  });

  it('defaults the output directory next to the input file when -o is omitted', () => {
    const result = runRenderFrames([projectPath, '--clip', 'idle', '--count', '2']);
    expect(result.code).toBe(0);
    // Mirrors the other commands' defaultOutPath: only the LAST extension component is
    // stripped ("pip.rig.json" -> "pip.rig"), matching e.g. export-riv's "pip.rig.riv".
    const defaultDir = join(dir, 'pip.rig-idle-frames');
    expect(existsSync(defaultDir)).toBe(true);
    expect(readdirSync(defaultDir).filter((f) => f.endsWith('.png'))).toHaveLength(2);
  });

  it('reports a missing clip name actionably (exit 1, lists available clips)', () => {
    const result = runRenderFrames([projectPath, '--clip', 'not_a_real_clip']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/render-frames failed/);
    expect(result.stderr).toMatch(/Clip not found: "not_a_real_clip"/);
    expect(result.stderr).toMatch(/idle/);
  });

  it('reports a missing --clip flag actionably (exit 1)', () => {
    const result = runRenderFrames([projectPath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Missing required --clip/);
  });

  it('reports a missing project file actionably (exit 1)', () => {
    const result = runRenderFrames([join(dir, 'nope.rig.json'), '--clip', 'idle']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/File not found/);
  });
});

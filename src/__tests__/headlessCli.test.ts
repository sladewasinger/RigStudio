/**
 * CLI-level tests for `rig import` / `rig validate` / `rig export-riv`: call the
 * command functions directly (real fs I/O against a scratch temp dir, no process
 * spawn) per most cases, plus one cheap spawn smoke test proving the actual `tsx
 * src/headless/cli.ts` entry point (what `npm run rig` and the `rig-studio` bin both
 * resolve to) runs end-to-end as a real subprocess.
 */
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch, runExportRiv, runImport, runValidate } from '../headless/cliCommands';

const PIP_SVG_PATH = join(__dirname, '..', '..', 'public', 'PIP_MASTER.svg');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rig-headless-cli-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('rig import', () => {
  it('writes a .rig.json and prints a part-tree summary', () => {
    const outPath = join(dir, 'pip.rig.json');
    const result = runImport([PIP_SVG_PATH, '-o', outPath]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Imported "PIP_MASTER" \(\d+ parts?\)/);
    expect(result.stdout).toMatch(/body \[art\]/);
    expect(existsSync(outPath)).toBe(true);
    const doc = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(doc.doc.parts.length).toBeGreaterThan(5);
  });

  it('defaults the output path next to the input when -o is omitted', () => {
    const svgCopy = join(dir, 'art.svg');
    writeFileSync(svgCopy, readFileSync(PIP_SVG_PATH, 'utf8'), 'utf8');
    const result = runImport([svgCopy]);
    expect(result.code).toBe(0);
    expect(existsSync(join(dir, 'art.rig.json'))).toBe(true);
  });

  it('reports a missing SVG file actionably', () => {
    const result = runImport([join(dir, 'nope.svg')]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/SVG file not found/);
  });
});

describe('rig validate', () => {
  function importedProject(): string {
    const outPath = join(dir, 'pip.rig.json');
    runImport([PIP_SVG_PATH, '-o', outPath]);
    return outPath;
  }

  it('reports a fresh import as valid and byte-stable with no normalization changes', () => {
    const result = runValidate([importedProject()]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/round-trip byte-stable: yes/);
    expect(result.stdout).toMatch(/VALID/);
    expect(result.stdout).toMatch(/normalization: no changes/);
  });

  it('reports normalization changes for an old-shaped file (missing back-compat fields)', () => {
    const filePath = importedProject();
    const wrapped = JSON.parse(readFileSync(filePath, 'utf8'));
    delete wrapped.doc.artboard; // absent on old files — normalizeDoc seeds it
    writeFileSync(filePath, JSON.stringify(wrapped), 'utf8');

    const result = runValidate([filePath]);
    expect(result.code).toBe(0); // still valid — normalization filling defaults is expected
    expect(result.stdout).toMatch(/normalization: \d+ field/);
    expect(result.stdout).toMatch(/artboard/);
  });

  it('rejects a file that is not a Rig Studio project', () => {
    const filePath = join(dir, 'not-a-project.json');
    writeFileSync(filePath, JSON.stringify({ hello: 'world' }), 'utf8');
    const result = runValidate([filePath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Not a valid Rig Studio project/);
  });

  it('reports invalid JSON with a line/column position', () => {
    const filePath = join(dir, 'broken.json');
    writeFileSync(filePath, '{ bad json', 'utf8'); // malformed early enough for V8 to report a position
    const result = runValidate([filePath]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Invalid JSON/);
    expect(result.stderr).toMatch(/line \d+/i);
  });

  it('reports a missing file actionably', () => {
    const result = runValidate([join(dir, 'nope.rig.json')]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/File not found/);
  });
});

describe('rig export-riv', () => {
  it('exports a .riv with a byte size and the clip names', () => {
    const projectPath = join(dir, 'pip.rig.json');
    runImport([PIP_SVG_PATH, '-o', projectPath]);
    const outPath = join(dir, 'pip.riv');

    const result = runExportRiv([projectPath, '-o', outPath]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Wrote .* \(\d+ bytes\)/);
    expect(result.stdout).toMatch(/Animations: idle/);
    expect(existsSync(outPath)).toBe(true);
    expect(readFileSync(outPath).length).toBeGreaterThan(100);
  });

  it('reports a missing file actionably', () => {
    const result = runExportRiv([join(dir, 'nope.rig.json')]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/File not found/);
  });
});

describe('dispatch', () => {
  it('prints usage for no command / --help / an unknown command', () => {
    expect(dispatch([]).stdout).toMatch(/rig <command>/);
    expect(dispatch(['--help']).stdout).toMatch(/rig <command>/);
    const unknown = dispatch(['frobnicate']);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toMatch(/Unknown command: frobnicate/);
  });
});

describe('cli.ts spawn smoke test', () => {
  it('runs end-to-end as a real subprocess through the same entry point npm run rig uses', () => {
    const cliPath = join(__dirname, '..', 'headless', 'cli.ts');
    const tsxBin = join(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const outPath = join(dir, 'pip.rig.json');

    const result = spawnSync(
      process.execPath,
      [tsxBin, cliPath, 'import', PIP_SVG_PATH, '-o', outPath],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Imported "PIP_MASTER"/);
    expect(existsSync(outPath)).toBe(true);
  });
});

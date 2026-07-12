/**
 * SIZE-RATCHET (see CLAUDE.md "Small, focused files"): pins every source file's line
 * count so architectural drift fails the suite instead of accumulating silently —
 * added 2026-07-11 after eight files outgrew the ~200-line standard unnoticed.
 *
 * Rules enforced here:
 *  - A file NOT in GRANDFATHERED may not exceed NEW_FILE_MAX lines.
 *  - A GRANDFATHERED file may not exceed its recorded ceiling — a wave that adds to
 *    one must split it (or shrink something else in it) in the same wave.
 *  - DO NOT raise a ceiling to make this test pass — that defeats the mechanism.
 *    Ceilings only go DOWN (the dedicated refactor pass burns this list to zero;
 *    when a file drops below NEW_FILE_MAX, delete its entry).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..');
const NEW_FILE_MAX = 300;

/** Ceilings recorded at introduction (2026-07-11). Shrink-only. */
const GRANDFATHERED = new Map<string, number>([
  ['ai/claude.ts', 666],
  ['core/model.ts', 1768],
  ['core/stateMachine.ts', 376],
  ['geometry/paths.ts', 553],
  ['io/exportLottie.ts', 449],
  ['io/exportRiv.ts', 1205],
  ['main.ts', 667],
  ['panels/ai.ts', 1004],
  ['panels/inspector.ts', 1065],
  ['panels/layers.ts', 457],
  ['panels/smPanel.ts', 1566],
  ['timeline/graph.ts', 511],
  ['timeline/timeline.ts', 902],
  ['ui/dialogs.ts', 339],
  ['view/interactions.ts', 1217],
  ['view/nodeEditing.ts', 681],
  ['view/overlay.ts', 848],
  ['view/rigOps.ts', 812],
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...sourceFiles(full));
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function lineCount(file: string): number {
  const text = readFileSync(file, 'utf8');
  if (text.length === 0) return 0;
  return text.split('\n').filter((_, i, arr) => i < arr.length - 1 || arr[i] !== '').length;
}

describe('architecture: file-size ratchet', () => {
  const files = sourceFiles(SRC).map((f) => ({
    rel: relative(SRC, f).split(sep).join('/'),
    lines: lineCount(f),
  }));

  it('finds the source tree (sanity)', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('new files stay under the budget; grandfathered files never grow', () => {
    const violations: string[] = [];
    for (const { rel, lines } of files) {
      const ceiling = GRANDFATHERED.get(rel) ?? NEW_FILE_MAX;
      if (lines > ceiling) {
        violations.push(
          `${rel}: ${lines} lines (ceiling ${ceiling})` +
          (GRANDFATHERED.has(rel)
            ? ' — grandfathered files may not grow; split it in this wave'
            : ' — new/small files must stay under the budget; split before landing'),
        );
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('grandfather entries stay honest (no stale entries for deleted/shrunk files)', () => {
    const byRel = new Map(files.map((f) => [f.rel, f.lines]));
    const stale: string[] = [];
    for (const [rel] of GRANDFATHERED) {
      const lines = byRel.get(rel);
      if (lines === undefined) stale.push(`${rel}: file no longer exists — delete its entry`);
      else if (lines <= NEW_FILE_MAX) stale.push(`${rel}: now ${lines} lines — delete its entry`);
    }
    expect(stale, stale.join('\n')).toEqual([]);
  });
});

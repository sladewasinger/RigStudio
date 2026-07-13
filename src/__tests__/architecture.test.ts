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

/** CODE-line ceilings recorded at introduction (2026-07-11). Shrink-only. Note that
 *  stateMachine.ts and dialogs.ts fell off the original raw-line list once comments
 *  became free — documentation-heavy files are the goal, not a violation. */
const GRANDFATHERED = new Map<string, number>([
  ['ai/claude.ts', 489],
  ['geometry/paths.ts', 434],
  ['io/exportLottie.ts', 327],
  ['main.ts', 522],
  ['panels/layers.ts', 347],
  ['timeline/graph.ts', 395],
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

/**
 * CODE lines only — comments and blank lines are FREE (user ruling 2026-07-11 after
 * an agent trimmed comment blocks to fit a ceiling: measuring raw lines incentivized
 * deleting documentation, the opposite of the goal). Heuristic, deliberately simple:
 * block comments are stripped textually (rare pathological strings containing comment
 * markers may miscount by a line or two — acceptable for a budget gate); a line counts
 * as code if anything non-comment, non-blank remains. Trailing comments on code lines
 * cost nothing extra; full-line comments cost nothing at all.
 */
function codeLineCount(file: string): number {
  const text = readFileSync(file, 'utf8');
  if (text.length === 0) return 0;
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));
  return noBlocks
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t !== '' && !t.startsWith('//');
    }).length;
}

describe('architecture: file-size ratchet', () => {
  const files = sourceFiles(SRC).map((f) => ({
    rel: relative(SRC, f).split(sep).join('/'),
    lines: codeLineCount(f),
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

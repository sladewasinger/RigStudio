/**
 * Structural enforcement of nodeEditing's chokepoint (`applyStructuralEdit`): the
 * THREE-WAY LOCKSTEP INVARIANT (path command count <-> `RigPath.nodeTypes` length <->
 * skin-override command-index validity) must be guarded by ONE door, not convention
 * alone. Two independent, complementary filesystem/regex checks, same spirit as
 * `headlessBoundary.test.ts` (no bundler/type info needed):
 *
 *  1. No file outside `src/view/nodeEditing/` (nor the single documented back-compat
 *     coercion in `core/serialization.ts`'s normalizeDoc, which nulls out a corrupt
 *     `nodeTypes` value read from an old/malformed project file on LOAD — not a live
 *     edit, so there's no path-command array to keep it in lockstep with) writes
 *     `.nodeTypes =` at all. This is the literal ask: "no other code path writes
 *     nodeTypes directly."
 *  2. `dropSkinOverridesForPath` — the override-drop half of the chokepoint's bundle —
 *     is called from nowhere except inside `view/nodeEditing/` (its own definition in
 *     `core/boneOps.ts` doesn't count as a call site). Anything else calling it ad hoc
 *     would mean a structural edit's override-drop escaped the chokepoint, which is
 *     exactly the failure mode this redesign exists to prevent (see the mutation-check
 *     note in the redesign's report: this is the check that catches a disabled drop).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..');

/** `view/nodeEditing.ts` (pre-split, single file) or the `view/nodeEditing/` package. */
function isNodeEditingModule(rel: string): boolean {
  return rel === 'view/nodeEditing.ts' || rel.startsWith('view/nodeEditing/');
}

// The one documented load-time back-compat coercion outside nodeEditing: normalizeDoc
// nulls a malformed nodeTypes value coming off disk. Not a structural edit.
const NODE_TYPES_WRITE_ALLOWLIST = new Set(['core/serialization.ts']);

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

describe('nodeEditing chokepoint: structural writes stay behind applyStructuralEdit', () => {
  const files = sourceFiles(SRC).map((f) => ({
    rel: relative(SRC, f).split(sep).join('/'),
    text: readFileSync(f, 'utf8'),
  }));

  it('finds the source tree and the nodeEditing module (sanity)', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => isNodeEditingModule(f.rel))).toBe(true);
  });

  it('no code path outside nodeEditing writes RigPath.nodeTypes directly', () => {
    const writeRe = /\.nodeTypes\s*=(?!=)/;
    const violations: string[] = [];
    for (const { rel, text } of files) {
      if (isNodeEditingModule(rel) || NODE_TYPES_WRITE_ALLOWLIST.has(rel)) continue;
      text.split('\n').forEach((line, i) => {
        if (writeRe.test(line)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('dropSkinOverridesForPath is called only from inside nodeEditing', () => {
    const callRe = /dropSkinOverridesForPath\(/;
    const defRe = /^export function dropSkinOverridesForPath\(/;
    const violations: string[] = [];
    for (const { rel, text } of files) {
      if (rel === 'core/boneOps.ts') continue; // the definition, not a call site
      if (isNodeEditingModule(rel)) continue; // the chokepoint's own package
      text.split('\n').forEach((line, i) => {
        if (callRe.test(line) && !defRe.test(line.trim())) {
          violations.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('sanity: applyStructuralEdit exists in nodeEditing and itself drops overrides', () => {
    const chokepoint = files.find(
      (f) => isNodeEditingModule(f.rel) && /export function applyStructuralEdit\(/.test(f.text),
    );
    expect(chokepoint, 'applyStructuralEdit not found in any nodeEditing module').toBeTruthy();
    expect(chokepoint!.text).toMatch(/dropSkinOverridesForPath\(/);
  });
});

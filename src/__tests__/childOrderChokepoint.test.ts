/**
 * Structural enforcement of the U1 childOrder chokepoint (`core/childOrder.ts`): no code
 * path outside that module may write `RigPart.childOrder` directly — every add/remove/
 * reorder of a path or child-part slot goes through its named helpers
 * (`slotAddPath`/`slotRemovePath`/`slotAddChild`/`slotRemoveChild`/`slotMoveWithin`) or
 * its `reconcileChildOrder` repair primitive. One filesystem/regex check, same spirit as
 * `nodeEditingChokepoint.test.ts` and `headlessBoundary.test.ts` (no bundler/type info
 * needed).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..');
const CHOKEPOINT_MODULE = 'core/childOrder.ts';

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

describe('childOrder chokepoint: RigPart.childOrder is written only from core/childOrder.ts', () => {
  const files = sourceFiles(SRC).map((f) => ({
    rel: relative(SRC, f).split(sep).join('/'),
    text: readFileSync(f, 'utf8'),
  }));

  it('finds the source tree and the chokepoint module (sanity)', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.rel === CHOKEPOINT_MODULE)).toBe(true);
  });

  it('no code path outside core/childOrder.ts assigns .childOrder directly', () => {
    // Matches `x.childOrder = ...` (an assignment) but not `x.childOrder ===`/`!==` (a
    // comparison, used freely elsewhere for the LAZY-rule presence check) or the
    // `childOrder?: ChildSlot[]` TYPE declaration in docTypes.ts (no leading dot there).
    const writeRe = /\.childOrder\s*=(?!=)/;
    const violations: string[] = [];
    for (const { rel, text } of files) {
      if (rel === CHOKEPOINT_MODULE) continue;
      text.split('\n').forEach((line, i) => {
        if (writeRe.test(line)) violations.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('sanity: the chokepoint module exports the five named slot helpers plus reconcileChildOrder', () => {
    const chokepoint = files.find((f) => f.rel === CHOKEPOINT_MODULE)!;
    for (const fn of [
      'slotAddPath', 'slotRemovePath', 'slotAddChild', 'slotRemoveChild', 'slotMoveWithin',
      'reconcileChildOrder', 'isChildOrderCoherent', 'childOrderAgreesWithCanonicalPartOrder',
      'docUsesChildOrder', 'seedChildOrderIfActive',
    ]) {
      expect(chokepoint.text, `${fn} not exported from ${CHOKEPOINT_MODULE}`).toMatch(
        new RegExp(`export function ${fn}\\(`),
      );
    }
  });
});

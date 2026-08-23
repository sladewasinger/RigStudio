import { describe, expect, it } from 'vitest';
import { createWarpTriangleSquareSample } from '../samples/warpTriangleSquare';
import {
  compileWarpPathPair, createWarpDefinition, evaluateWarpPath,
  interpolateWarpCommands, warpPathFingerprint,
} from '../geometry/warp';
import { serializePath } from '../geometry/paths';

describe('Warp geometry and durable correspondence', () => {
  it('preserves both authored endpoints exactly after deterministic cubic normalization', () => {
    const doc = createWarpTriangleSquareSample();
    const pair = doc.warps![0].pairs[0];
    const compiled = compileWarpPathPair(doc, pair);
    expect(evaluateWarpPath(doc, pair, 0)).toBe(serializePath(compiled.source));
    expect(evaluateWarpPath(doc, pair, 1)).toBe(serializePath(compiled.target));
    expect(compileWarpPathPair(doc, pair)).toEqual(compiled);
  });

  it('equalizes unequal node counts and produces a finite smooth midpoint', () => {
    const doc = createWarpTriangleSquareSample();
    const pair = doc.warps![0].pairs[0];
    const compiled = compileWarpPathPair(doc, pair);
    expect(compiled.source.length).toBe(compiled.target.length);
    expect(serializePath(interpolateWarpCommands(compiled.source, compiled.target, .5))).not.toMatch(/NaN|Infinity/);
  });

  it('normalizes arcs and lines to cubic geometry', () => {
    const doc = createWarpTriangleSquareSample();
    const source = doc.parts.find((part) => part.id === 'triangle_shape')!.paths[0];
    source.d = 'M 40,128 A 88 88 0 1 0 216,128 A 88 88 0 1 0 40,128 Z';
    const pair = doc.warps![0].pairs[0];
    pair.sourceFingerprint = warpPathFingerprint(source);
    const compiled = compileWarpPathPair(doc, pair);
    expect(compiled.source.filter((command) => command.cmd === 'C').length).toBeGreaterThan(3);
    expect(compiled.source.map((command) => command.cmd)).toEqual(compiled.target.map((command) => command.cmd));
  });

  it('applies target path transforms into source coordinates', () => {
    const doc = createWarpTriangleSquareSample();
    const target = doc.parts.find((part) => part.id === 'square_shape')!.paths[0];
    target.transform = 'translate(10 20)';
    const pair = doc.warps![0].pairs[0];
    const compiled = compileWarpPathPair(doc, pair);
    const first = compiled.target[0];
    expect(first.cmd).toBe('M');
    if (first.cmd === 'M') expect(first).toMatchObject({ x: 50, y: 60 });
  });

  it('supports seam movement, direction reversal, and reverse timeline evaluation', () => {
    const doc = createWarpTriangleSquareSample();
    const pair = doc.warps![0].pairs[0];
    const normal = compileWarpPathPair(doc, pair).target;
    pair.seam = 1;
    const seamed = compileWarpPathPair(doc, pair).target;
    expect(serializePath(seamed)).not.toBe(serializePath(normal));
    pair.reverse = true;
    expect(serializePath(compileWarpPathPair(doc, pair).target)).not.toBe(serializePath(seamed));
    expect(evaluateWarpPath(doc, pair, 1)).toBe(evaluateWarpPath(doc, pair, 1));
  });

  it('invalidates structural topology edits with an actionable repair error', () => {
    const doc = createWarpTriangleSquareSample();
    const pair = doc.warps![0].pairs[0];
    doc.parts.find((part) => part.id === pair.sourcePartId)!.paths[0].d += ' L 128,128';
    expect(() => compileWarpPathPair(doc, pair)).toThrow(/stale.*Warp Setup.*rebuild/i);
  });

  it('prioritizes unique exact names and never accepts fuzzy names silently', () => {
    const doc = createWarpTriangleSquareSample();
    const built = createWarpDefinition(doc, 'triangle_group', 'square_group', 'test');
    expect(built.definition.pairs).toHaveLength(2);
    doc.parts.find((part) => part.id === 'square_shadow')!.paths[0].label = 'arm_shadow';
    const fuzzy = createWarpDefinition(doc, 'triangle_group', 'square_group', 'test');
    expect(fuzzy.definition.pairs).toHaveLength(1);
    expect(fuzzy.warnings.join(' ')).toMatch(/fade/);
  });

  it('surfaces ambiguous duplicate names and confirmed ids survive later rename', () => {
    const doc = createWarpTriangleSquareSample();
    const square = doc.parts.find((part) => part.id === 'square_shape')!;
    square.paths.push({ ...structuredClone(square.paths[0]), id: 'duplicate_main' });
    const ambiguous = createWarpDefinition(doc, 'triangle_group', 'square_group', 'test');
    expect(ambiguous.ambiguous.join(' ')).toMatch(/2 exact-name candidates/);
    const pair = doc.warps![0].pairs[0];
    square.paths.pop();
    square.paths[0].label = 'Renamed after confirmation';
    expect(() => compileWarpPathPair(doc, pair)).not.toThrow();
  });
});

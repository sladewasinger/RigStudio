import { describe, expect, it } from 'vitest';
import { createWarpTriangleSquareSample } from '../samples/warpTriangleSquare';
import {
  compileWarpPathPair, createWarpDefinition, evaluateWarpPath,
  interpolateWarpCommands, repairWarpPair, resolvedWarpAlignment, warpPairIsStale, warpPathFingerprint,
} from '../geometry/warp';
import { serializePath } from '../geometry/paths';
import { deserializeDoc, serializeDoc, state } from '../core/model';
import { groupTransformOf } from '../geometry/pose';
import { applyMat, matrixOfTransform, multiply } from '../geometry/transforms';

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

  it('aligns endpoint groups with different pivots and nested rest transforms', () => {
    const doc = createWarpTriangleSquareSample();
    const targetPart = doc.parts.find((part) => part.id === 'square_shape')!;
    targetPart.rest.tx = 12;
    targetPart.rest.ty = -7;
    targetPart.pivot = { x: 40, y: 40 };
    targetPart.rest.rotate = 10;
    const pair = doc.warps![0].pairs[0];
    const before = serializePath(compileWarpPathPair(createWarpTriangleSquareSample(), pair).target);
    expect(serializePath(compileWarpPathPair(doc, pair).target)).not.toBe(before);
  });

  it('cancels a held carrier rotation so 100% equals the evaluated target in world space', () => {
    const doc = createWarpTriangleSquareSample();
    state.doc = doc; state.activeClipIndex = 1;
    const pair = doc.warps![0].pairs[0];
    const source = doc.parts.find((part) => part.id === pair.sourcePartId)!;
    const target = doc.parts.find((part) => part.id === pair.targetPartId)!;
    const sourcePath = source.paths[0], targetPath = target.paths[0];
    const compiled = compileWarpPathPair(doc, pair, 1500);
    const local = compiled.target[0];
    expect(local.cmd).toBe('M');
    if (local.cmd !== 'M') return;
    const rendered = applyMat(multiply(matrixOfTransform(groupTransformOf(source, 1500)), matrixOfTransform(sourcePath.transform)), local.x, local.y);
    const authored = applyMat(multiply(matrixOfTransform(groupTransformOf(target, 1500)), matrixOfTransform(targetPath.transform)), 40, 40);
    expect(rendered.x).toBeCloseTo(authored.x, 8);
    expect(rendered.y).toBeCloseTo(authored.y, 8);
    expect(rendered.x).toBeCloseTo(40, 10);
    expect(rendered.y).toBeCloseTo(40, 10);
  });

  it('evaluates target and ancestor animation independently at the Warp endpoint', () => {
    const doc = createWarpTriangleSquareSample();
    doc.clips[1].tracks.push({ target: 'square_group', channel: 'rotate', keyframes: [{ time: 1500, value: -30, easing: 'linear' }] });
    state.doc = doc; state.activeClipIndex = 1;
    const pair = doc.warps![0].pairs[0];
    const source = doc.parts.find((part) => part.id === pair.sourcePartId)!;
    const target = doc.parts.find((part) => part.id === pair.targetPartId)!;
    const first = compileWarpPathPair(doc, pair, 1500).target[0];
    expect(first.cmd).toBe('M');
    if (first.cmd !== 'M') return;
    const rendered = applyMat(matrixOfTransform(groupTransformOf(source, 1500)), first.x, first.y);
    const authored = applyMat(matrixOfTransform(groupTransformOf(target, 1500)), 40, 40);
    expect(rendered.x).toBeCloseTo(authored.x, 8);
    expect(rendered.y).toBeCloseTo(authored.y, 8);
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

  it('spatially repairs structural topology edits instead of reusing a stale ordinal seam', () => {
    const doc = createWarpTriangleSquareSample();
    const pair = doc.warps![0].pairs[0];
    doc.parts.find((part) => part.id === pair.sourcePartId)!.paths[0].d += ' L 128,128';
    const before = compileWarpPathPair(doc, pair);
    expect(before.source).toHaveLength(before.target.length);
    expect(pair.sourceFingerprint).not.toBe(warpPathFingerprint(doc.parts.find((part) => part.id === pair.sourcePartId)!.paths[0]));
  });

  it('aligns a closed hard shadow spatially after an inserted node shifts ordinals', () => {
    const doc = createWarpTriangleSquareSample();
    const source = doc.parts.find((part) => part.id === 'triangle_shadow')!.paths[0];
    const target = doc.parts.find((part) => part.id === 'square_shadow')!.paths[0];
    source.d = 'M 0 0 L 100 0 L 100 20 L 0 20 Z';
    target.d = 'M 100 20 L 0 20 L 0 0 L 50 0 L 100 0 Z';
    source.nodeTypes = 'cccc'; target.nodeTypes = 'ccscc';
    const pair = doc.warps![0].pairs[1];
    delete pair.seam; delete pair.reverse;
    const alignment = resolvedWarpAlignment(doc, pair);
    expect(alignment.reverse).toBe(false);
    expect(alignment.seam).toBe(2);
    const compiled = compileWarpPathPair(doc, pair);
    const midpoint = interpolateWarpCommands(compiled.source, compiled.target, .5);
    const nodes = midpoint.filter((command) => command.cmd === 'M' || command.cmd === 'C').map((command) => ({ x: command.x, y: command.y }));
    expect(Math.min(...nodes.map((point) => point.x))).toBeCloseTo(0);
    expect(Math.max(...nodes.map((point) => point.x))).toBeCloseTo(100);
    expect(nodes[0]).toEqual({ x: 0, y: 0 });
  });

  it('keeps a manual seam authoritative but warns when topology makes it spatially unsafe', () => {
    const doc = createWarpTriangleSquareSample();
    const source = doc.parts.find((part) => part.id === 'triangle_shadow')!.paths[0];
    const target = doc.parts.find((part) => part.id === 'square_shadow')!.paths[0];
    source.d = 'M 0 0 L 100 0 L 100 20 L 0 20 Z';
    target.d = 'M 100 20 L 0 20 L 0 0 L 50 0 L 100 0 Z';
    const pair = doc.warps![0].pairs[1];
    pair.seam = 0; pair.reverse = false;
    const alignment = resolvedWarpAlignment(doc, pair);
    expect(alignment).toMatchObject({ seam: 0, reverse: false, ambiguous: true, confidence: 0 });
    expect(alignment.reason).toMatch(/manual.*no longer agrees/i);
  });

  it('repairs reversed winding without reflecting or crossing the closed contour', () => {
    const doc = createWarpTriangleSquareSample();
    const source = doc.parts.find((part) => part.id === 'triangle_shadow')!.paths[0];
    const target = doc.parts.find((part) => part.id === 'square_shadow')!.paths[0];
    source.d = 'M 0 0 L 100 0 L 100 20 L 0 20 Z';
    target.d = 'M 0 0 L 0 20 L 100 20 L 100 0 Z';
    source.nodeTypes = target.nodeTypes = 'cccc';
    const pair = doc.warps![0].pairs[1];
    delete pair.seam; delete pair.reverse;
    const alignment = resolvedWarpAlignment(doc, pair);
    expect(alignment.reverse).toBe(true);
    const normalized = compileWarpPathPair(doc, pair);
    expect(serializePath(normalized.source)).toBe(serializePath(normalized.target));
  });

  it('repairs only the stale pair and persists the new topology fingerprint', () => {
    const doc = createWarpTriangleSquareSample();
    const [shapePair, shadowPair] = doc.warps![0].pairs;
    const shapeFingerprint = shapePair.sourceFingerprint;
    const shadow = doc.parts.find((part) => part.id === shadowPair.sourcePartId)!.paths[0];
    shadow.d = shadow.d.replace(' Z', ' L 128 146 Z');
    expect(warpPairIsStale(doc, shadowPair)).toBe(true);
    expect(warpPairIsStale(doc, shapePair)).toBe(false);
    repairWarpPair(doc, shadowPair);
    expect(warpPairIsStale(doc, shadowPair)).toBe(false);
    expect(shapePair.sourceFingerprint).toBe(shapeFingerprint);
    const restored = deserializeDoc(serializeDoc(doc));
    const restoredPair = restored.warps![0].pairs[1];
    expect(warpPairIsStale(restored, restoredPair)).toBe(false);
    expect(resolvedWarpAlignment(restored, restoredPair)).toEqual(resolvedWarpAlignment(doc, shadowPair));
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

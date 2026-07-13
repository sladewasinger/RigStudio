// @vitest-environment jsdom
/**
 * Unit tests for `view/rigOpsEdit.ts`'s `movePathToPart` — the render-neutral cross-part
 * path move behind the Layers panel's drag-a-path-into-another-part gesture — and its
 * `pathMoveRefusal` chokepoint.
 *
 * The load-bearing invariant: a path renders as `renderMat(part) · path.transform`
 * (renderMat = the part's full REST render matrix, `groupTransformOf(part, null)` from the
 * shared geometry/pose.ts kernel), and the move rebakes
 * `newPathTransform = inv(destRenderMat) · srcRenderMat · oldPathTransform`, so the
 * COMPOSED render matrix of the path must be IDENTICAL before/after the move — asserted
 * here component-wise to 1e-9 through deliberately nasty frames (rotated + translated
 * parent chains on both sides, rest rotate/scale/skew, baked part transforms, a baked
 * per-path transform). Runs under jsdom because the module reaches partDom/render for its
 * DOM sync — with no canvas built (`ctx` empty) those are guarded no-ops, so the doc math
 * is exercised pure.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { serializeDoc, state, RigPart } from '../core/model';
import { checkpoint, undo, resetHistory } from '../core/history';
import { groupTransformOf } from '../geometry/pose';
import { Mat, matrixOfTransform, multiply } from '../geometry/transforms';
import { movePathToPart, pathMoveRefusal } from '../view/rigOps';
import { makeDoc, makePart, makePath, resetState } from './helpers';

/** The composed REST render matrix of `pathId` inside `part` (kernel math). */
function pathRenderMat(part: RigPart, pathId: string): Mat {
  const path = part.paths.find((p) => p.id === pathId)!;
  return multiply(
    matrixOfTransform(groupTransformOf(part, null)),
    matrixOfTransform(path.transform),
  );
}

function expectMatEqual(a: Mat, b: Mat, eps = 1e-9): void {
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
    expect(Math.abs(a[k] - b[k]), `component ${k}: ${a[k]} vs ${b[k]}`).toBeLessThanOrEqual(eps);
  }
}

/** Two independent, deliberately nasty part chains + one path to move between them. */
function nastyDoc() {
  const srcParent = makePart('src_parent', {
    pivot: { x: 10, y: 20 },
    rest: { rotate: 30, tx: 5, ty: -3, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 },
  });
  const src = makePart('src', {
    parentId: 'src_parent',
    pivot: { x: 12, y: 8 },
    transform: 'translate(3,4) rotate(10)',
    rest: { rotate: 25, tx: 4, ty: 6, sx: 1.3, sy: 0.8, kx: 5, ky: 0, opacity: 1 },
    paths: [
      makePath('mover', {
        d: 'M 0,0 C 1,0 2,1 2,2 L 0,2 Z',
        transform: 'translate(1,2)',
        nodeTypes: 'cc',
        fill: '#123456',
        stroke: '#654321',
        strokeWidth: 2,
        strokeOpacity: 0.5,
      }),
      makePath('stays'),
    ],
  });
  const destParent = makePart('dest_parent', {
    pivot: { x: -4, y: 7 },
    rest: { rotate: -40, tx: -8, ty: 12, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 },
  });
  const dest = makePart('dest', {
    parentId: 'dest_parent',
    pivot: { x: 2, y: 3 },
    transform: 'matrix(1.1,0.2,-0.1,0.9,5,7)',
    rest: { rotate: 15, tx: -2, ty: 3, sx: 0.7, sy: 1.2, kx: 0, ky: -4, opacity: 1 },
    paths: [makePath('resident')],
  });
  return { srcParent, src, destParent, dest };
}

beforeEach(() => {
  resetState(null);
  resetHistory();
});

describe('movePathToPart — render-neutral frame compensation', () => {
  it('keeps the path\'s composed render matrix identical through nasty frames (1e-9)', () => {
    const { srcParent, src, destParent, dest } = nastyDoc();
    resetState(makeDoc([srcParent, src, destParent, dest]));
    const before = pathRenderMat(src, 'mover');
    const movedRef = src.paths[0];

    expect(movePathToPart(src, dest, 'mover')).toBe(true);

    expect(src.paths.map((p) => p.id)).toEqual(['stays']);
    expect(dest.paths.map((p) => p.id), 'appended last = topmost within the part').toEqual(['resident', 'mover']);
    expectMatEqual(pathRenderMat(dest, 'mover'), before);
    // The RigPath OBJECT travels — paints and nodeTypes untouched, same reference.
    const moved = dest.paths[1];
    expect(moved).toBe(movedRef);
    expect(moved.nodeTypes).toBe('cc');
    expect(moved.d).toBe('M 0,0 C 1,0 2,1 2,2 L 0,2 Z');
    expect(moved.fill).toBe('#123456');
    expect(moved.stroke).toBe('#654321');
    expect(moved.strokeWidth).toBe(2);
    expect(moved.strokeOpacity).toBe(0.5);
  });

  it('respects an explicit destIndex and stays render-neutral there too', () => {
    const { srcParent, src, destParent, dest } = nastyDoc();
    resetState(makeDoc([srcParent, src, destParent, dest]));
    const before = pathRenderMat(src, 'mover');

    expect(movePathToPart(src, dest, 'mover', 0)).toBe(true);

    expect(dest.paths.map((p) => p.id)).toEqual(['mover', 'resident']);
    expectMatEqual(pathRenderMat(dest, 'mover'), before);
  });

  it('keeps the transform string byte-identical when src and dest share a frame', () => {
    const src = makePart('src', { paths: [makePath('mover', { transform: 'translate(1,2)' })] });
    const dest = makePart('dest');
    resetState(makeDoc([src, dest]));

    expect(movePathToPart(src, dest, 'mover')).toBe(true);

    expect(dest.paths[0].transform, 'identity reframe never launders the string through floats')
      .toBe('translate(1,2)');
  });

  it('one checkpoint + one undo restores the document byte-exactly', () => {
    const { srcParent, src, destParent, dest } = nastyDoc();
    resetState(makeDoc([srcParent, src, destParent, dest]));
    const pristine = serializeDoc(state.doc!);

    checkpoint(); // the drop handler's single checkpoint
    expect(movePathToPart(src, dest, 'mover')).toBe(true);
    expect(serializeDoc(state.doc!)).not.toBe(pristine);

    undo();
    expect(serializeDoc(state.doc!), 'undo restores the exact pre-move document').toBe(pristine);
  });

  it('turns a group destination into an art part (kind \'art\' iff direct paths)', () => {
    const src = makePart('src', { paths: [makePath('mover')] });
    const group = makePart('grp', { kind: 'group' });
    resetState(makeDoc([src, group]));

    expect(movePathToPart(src, group, 'mover')).toBe(true);
    expect(group.kind).toBe('art');
  });
});

describe('movePathToPart — refusals (the pathMoveRefusal chokepoint)', () => {
  const skin = { bones: [] };

  it('refuses a skinned SOURCE and mutates nothing', () => {
    const src = makePart('src', { skin, paths: [makePath('mover')] });
    const dest = makePart('dest');
    resetState(makeDoc([src, dest]));
    const pristine = serializeDoc(state.doc!);

    expect(pathMoveRefusal(src, dest)).toMatch(/skinned/);
    expect(movePathToPart(src, dest, 'mover')).toBe(false);
    expect(serializeDoc(state.doc!)).toBe(pristine);
  });

  it('refuses a skinned DESTINATION and mutates nothing', () => {
    const src = makePart('src', { paths: [makePath('mover')] });
    const dest = makePart('dest', { skin });
    resetState(makeDoc([src, dest]));
    const pristine = serializeDoc(state.doc!);

    expect(pathMoveRefusal(src, dest)).toMatch(/skinned/);
    expect(movePathToPart(src, dest, 'mover')).toBe(false);
    expect(serializeDoc(state.doc!)).toBe(pristine);
  });

  it('refuses a BONE destination and same-part / missing-path calls', () => {
    const src = makePart('src', { paths: [makePath('mover')] });
    const bone = makePart('joint', { kind: 'bone' });
    resetState(makeDoc([src, bone]));

    expect(pathMoveRefusal(src, bone)).toMatch(/bone/i);
    expect(movePathToPart(src, bone, 'mover')).toBe(false);
    expect(movePathToPart(src, src, 'mover'), 'same part is the reorder path, not a move').toBe(false);
    expect(movePathToPart(src, makePart('x'), 'no_such_path')).toBe(false);
    expect(src.paths.map((p) => p.id)).toEqual(['mover']);
  });
});

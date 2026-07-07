import { describe, expect, it } from 'vitest';
import {
  IDENTITY,
  Mat,
  applyMat,
  invertMat,
  matrixOfTransform,
  multiply,
  parseTransformList,
  rotationMat,
  rotationPivotOf,
  translationMat,
} from '../transforms';

function expectMatClose(actual: Mat, expected: Mat, digits = 9): void {
  expect(actual.a).toBeCloseTo(expected.a, digits);
  expect(actual.b).toBeCloseTo(expected.b, digits);
  expect(actual.c).toBeCloseTo(expected.c, digits);
  expect(actual.d).toBeCloseTo(expected.d, digits);
  expect(actual.e).toBeCloseTo(expected.e, digits);
  expect(actual.f).toBeCloseTo(expected.f, digits);
}

/** Format a Mat the way Inkscape writes it into a transform attribute. */
function matrixString(m: Mat): string {
  return `matrix(${m.a},${m.b},${m.c},${m.d},${m.e},${m.f})`;
}

describe('parseTransformList', () => {
  it('parses every transform form with defaults', () => {
    expect(parseTransformList('translate(10 20)')).toEqual([
      { type: 'translate', tx: 10, ty: 20 },
    ]);
    expect(parseTransformList('translate(10)')).toEqual([
      { type: 'translate', tx: 10, ty: 0 },
    ]);
    expect(parseTransformList('scale(2)')).toEqual([{ type: 'scale', sx: 2, sy: 2 }]);
    expect(parseTransformList('scale(2, 3)')).toEqual([{ type: 'scale', sx: 2, sy: 3 }]);
    expect(parseTransformList('rotate(45)')).toEqual([
      { type: 'rotate', angle: 45, cx: 0, cy: 0 },
    ]);
    expect(parseTransformList('rotate(30, 10, 20)')).toEqual([
      { type: 'rotate', angle: 30, cx: 10, cy: 20 },
    ]);
    expect(parseTransformList('matrix(1,2,3,4,5,6)')).toEqual([
      { type: 'matrix', a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
    ]);
  });

  it('parses a whole list with mixed comma/space separators', () => {
    expect(parseTransformList('translate(1, 2) rotate(30 , 10 20),scale(2)')).toEqual([
      { type: 'translate', tx: 1, ty: 2 },
      { type: 'rotate', angle: 30, cx: 10, cy: 20 },
      { type: 'scale', sx: 2, sy: 2 },
    ]);
  });

  it('returns [] for null, undefined and empty input', () => {
    expect(parseTransformList(null)).toEqual([]);
    expect(parseTransformList(undefined)).toEqual([]);
    expect(parseTransformList('')).toEqual([]);
  });

  it('parses skewX/skewY and composes them as shear matrices', () => {
    expect(parseTransformList('skewX(10) translate(1,2)')).toEqual([
      { type: 'skewX', angle: 10 },
      { type: 'translate', tx: 1, ty: 2 },
    ]);
    // skewX(45): x' = x + tan(45°)·y = x + y.
    const px = applyMat(matrixOfTransform('skewX(45)'), 2, 3);
    expect(px.x).toBeCloseTo(5, 9);
    expect(px.y).toBeCloseTo(3, 9);
    // skewY(45): y' = y + x.
    const py = applyMat(matrixOfTransform('skewY(45)'), 2, 3);
    expect(py.x).toBeCloseTo(2, 9);
    expect(py.y).toBeCloseTo(5, 9);
  });
});

describe('matrix utilities', () => {
  it('multiply(m1, m2) applies m2 first', () => {
    const m = multiply(translationMat(10, 0), rotationMat(90));
    // (1,0) --rotate 90--> (0,1) --translate--> (10,1)
    const p = applyMat(m, 1, 0);
    expect(p.x).toBeCloseTo(10, 9);
    expect(p.y).toBeCloseTo(1, 9);
  });

  it('rotationMat rotates +y-down clockwise-positive around a pivot', () => {
    const p = applyMat(rotationMat(90), 1, 0);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(1, 9);
    const q = applyMat(rotationMat(90, 10, 10), 10, 0);
    expect(q.x).toBeCloseTo(20, 9);
    expect(q.y).toBeCloseTo(10, 9);
  });

  it('matrixOfTransform composes a list left-to-right', () => {
    const m = matrixOfTransform('translate(10,0) rotate(90)');
    const p = applyMat(m, 1, 0);
    expect(p.x).toBeCloseTo(10, 9);
    expect(p.y).toBeCloseTo(1, 9);
    expectMatClose(m, multiply(translationMat(10, 0), rotationMat(90)));
    // A pivoted rotation keeps its pivot fixed.
    const pivot = applyMat(matrixOfTransform('rotate(30,10,20)'), 10, 20);
    expect(pivot.x).toBeCloseTo(10, 9);
    expect(pivot.y).toBeCloseTo(20, 9);
  });

  it('invertMat: m times its inverse is the identity', () => {
    const m = matrixOfTransform('translate(3,4) rotate(37,5,6) scale(2,3)');
    expectMatClose(multiply(m, invertMat(m)), IDENTITY);
    expectMatClose(multiply(invertMat(m), m), IDENTITY);
  });

  it('invertMat returns identity for a singular matrix', () => {
    expect(invertMat({ a: 0, b: 0, c: 0, d: 0, e: 5, f: 5 })).toEqual(IDENTITY);
  });
});

describe('rotationPivotOf', () => {
  it("recovers (cx,cy) from 'rotate(30,10,20)'", () => {
    const p = rotationPivotOf('rotate(30,10,20)');
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(10, 6);
    expect(p!.y).toBeCloseTo(20, 6);
  });

  it('recovers the same pivot from the equivalent matrix() spelling', () => {
    const p = rotationPivotOf(matrixString(rotationMat(30, 10, 20)));
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(10, 6);
    expect(p!.y).toBeCloseTo(20, 6);
  });

  it('recovers the pivot of a 180-degree rotation', () => {
    const p = rotationPivotOf('rotate(180, 7, -3)');
    expect(p).not.toBeNull();
    expect(p!.x).toBeCloseTo(7, 6);
    expect(p!.y).toBeCloseTo(-3, 6);
  });

  it('returns null for pure translate, scale, reflection and identity', () => {
    expect(rotationPivotOf('translate(5,5)')).toBeNull();
    expect(rotationPivotOf('scale(2)')).toBeNull();
    expect(rotationPivotOf('matrix(-1,0,0,1,50,0)')).toBeNull(); // mirrored limb
    expect(rotationPivotOf('rotate(0,10,20)')).toBeNull(); // no unique fixed point
    expect(rotationPivotOf('')).toBeNull();
    expect(rotationPivotOf(null)).toBeNull();
  });
});

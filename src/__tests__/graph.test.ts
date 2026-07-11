/**
 * Unit tests for the graph (curve) editor's pure helpers: value-range padding, the
 * 1/2/5 grid-step series, and the preset-easing bezier equivalents (which must agree
 * with the model's cubicBezierEase sampling).
 */

import { describe, expect, it } from 'vitest';
import { PRESET_BEZIER, niceStep, valueRange } from '../timeline/graph';
import { Easing, Keyframe, cubicBezierEase } from '../core/model';

const key = (time: number, value: number, easing: Easing = 'linear'): Keyframe =>
  ({ time, value, easing });

describe('valueRange', () => {
  it('pads the key value span by 10% on each side', () => {
    const r = valueRange([key(0, 0), key(500, 10), key(1000, 5)]);
    expect(r.min).toBeCloseTo(-1, 9);
    expect(r.max).toBeCloseTo(11, 9);
  });

  it('falls back to ±1 around flat tracks', () => {
    expect(valueRange([key(0, 40), key(1000, 40)])).toEqual({ min: 39, max: 41 });
    expect(valueRange([key(0, 0)])).toEqual({ min: -1, max: 1 });
  });

  it('returns -1..1 for an empty list', () => {
    expect(valueRange([])).toEqual({ min: -1, max: 1 });
  });
});

describe('niceStep', () => {
  it('picks the smallest 1/2/5-series step that keeps within maxTicks', () => {
    expect(niceStep(2000, 8)).toBe(500); // raw 250 → 500
    expect(niceStep(10, 5)).toBe(2); // raw 2 → 2
    expect(niceStep(100, 5)).toBe(20); // raw 20 → 20
    expect(niceStep(1, 4)).toBeCloseTo(0.5, 9); // raw 0.25 → 0.5
  });

  it('never returns a non-positive step', () => {
    expect(niceStep(0, 5)).toBe(1);
    expect(niceStep(-3, 5)).toBe(1);
  });
});

describe('PRESET_BEZIER', () => {
  it('keeps every x component inside 0..1 (the CSS cubic-bezier domain)', () => {
    for (const [x1, , x2] of Object.values(PRESET_BEZIER)) {
      expect(x1).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(1);
      expect(x2).toBeGreaterThanOrEqual(0);
      expect(x2).toBeLessThanOrEqual(1);
    }
  });

  it('the linear preset is the identity through cubicBezierEase', () => {
    const [x1, y1, x2, y2] = PRESET_BEZIER.linear;
    for (const t of [0, 0.2, 0.5, 0.8, 1]) {
      expect(cubicBezierEase(x1, y1, x2, y2, t)).toBeCloseTo(t, 6);
    }
  });

  it('the easeInOut preset is symmetric around the midpoint', () => {
    const [x1, y1, x2, y2] = PRESET_BEZIER.easeInOut;
    expect(cubicBezierEase(x1, y1, x2, y2, 0.5)).toBeCloseTo(0.5, 6);
    const early = cubicBezierEase(x1, y1, x2, y2, 0.25);
    const late = cubicBezierEase(x1, y1, x2, y2, 0.75);
    expect(early + late).toBeCloseTo(1, 6);
    expect(early).toBeLessThan(0.25); // slow start
  });
});

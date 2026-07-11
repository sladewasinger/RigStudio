/**
 * alignDeltas/distributeDeltas — pure alignment and equal-gap distribution math.
 * Boxes here are root-space bboxes; every expected delta is hand-computed.
 */
import { describe, expect, it } from 'vitest';
import { AlignEdge, Box, alignDeltas, distributeDeltas } from '../geometry/align';

/** Three boxes with distinct edges/centers on both axes. */
function sampleBoxes(): Map<string, Box> {
  return new Map<string, Box>([
    ['a', { x: 0, y: 0, w: 10, h: 10 }],
    ['b', { x: 20, y: 30, w: 40, h: 20 }],
    ['c', { x: -5, y: 50, w: 10, h: 60 }],
  ]);
}

const IDS = ['a', 'b', 'c'];
const CANVAS: Box = { x: 100, y: 200, w: 300, h: 150 };

type Deltas = Record<string, { dx: number; dy: number }>;

function expectDeltas(actual: Map<string, { dx: number; dy: number }>, expected: Deltas): void {
  expect([...actual.keys()].sort()).toEqual(Object.keys(expected).sort());
  for (const [id, d] of Object.entries(expected)) {
    expect(actual.get(id)!.dx).toBeCloseTo(d.dx, 9);
    expect(actual.get(id)!.dy).toBeCloseTo(d.dy, 9);
  }
}

describe('alignDeltas', () => {
  describe('selection reference (union bbox: x -5..60, y 0..110)', () => {
    const cases: Array<[AlignEdge, Deltas]> = [
      ['left', { a: { dx: -5, dy: 0 }, b: { dx: -25, dy: 0 }, c: { dx: 0, dy: 0 } }],
      ['centerH', { a: { dx: 22.5, dy: 0 }, b: { dx: -12.5, dy: 0 }, c: { dx: 27.5, dy: 0 } }],
      ['right', { a: { dx: 50, dy: 0 }, b: { dx: 0, dy: 0 }, c: { dx: 55, dy: 0 } }],
      ['top', { a: { dx: 0, dy: 0 }, b: { dx: 0, dy: -30 }, c: { dx: 0, dy: -50 } }],
      ['middleV', { a: { dx: 0, dy: 50 }, b: { dx: 0, dy: 15 }, c: { dx: 0, dy: -25 } }],
      ['bottom', { a: { dx: 0, dy: 100 }, b: { dx: 0, dy: 60 }, c: { dx: 0, dy: 0 } }],
    ];
    for (const [edge, expected] of cases) {
      it(`aligns ${edge} to the union bbox`, () => {
        expectDeltas(alignDeltas(IDS, sampleBoxes(), edge, 'selection', CANVAS), expected);
      });
    }
  });

  describe('first reference (box a: 0,0 10x10)', () => {
    const cases: Array<[AlignEdge, Deltas]> = [
      ['left', { a: { dx: 0, dy: 0 }, b: { dx: -20, dy: 0 }, c: { dx: 5, dy: 0 } }],
      ['centerH', { a: { dx: 0, dy: 0 }, b: { dx: -35, dy: 0 }, c: { dx: 5, dy: 0 } }],
      ['right', { a: { dx: 0, dy: 0 }, b: { dx: -50, dy: 0 }, c: { dx: 5, dy: 0 } }],
      ['top', { a: { dx: 0, dy: 0 }, b: { dx: 0, dy: -30 }, c: { dx: 0, dy: -50 } }],
      ['middleV', { a: { dx: 0, dy: 0 }, b: { dx: 0, dy: -35 }, c: { dx: 0, dy: -75 } }],
      ['bottom', { a: { dx: 0, dy: 0 }, b: { dx: 0, dy: -40 }, c: { dx: 0, dy: -100 } }],
    ];
    for (const [edge, expected] of cases) {
      it(`aligns ${edge} to the first id's box (zero delta for it)`, () => {
        const deltas = alignDeltas(IDS, sampleBoxes(), edge, 'first', CANVAS);
        expectDeltas(deltas, expected);
        expect(deltas.get('a')).toEqual({ dx: 0, dy: 0 });
      });
    }
  });

  describe('last reference (box c: -5,50 10x60)', () => {
    const cases: Array<[AlignEdge, Deltas]> = [
      ['left', { a: { dx: -5, dy: 0 }, b: { dx: -25, dy: 0 }, c: { dx: 0, dy: 0 } }],
      ['centerH', { a: { dx: -5, dy: 0 }, b: { dx: -40, dy: 0 }, c: { dx: 0, dy: 0 } }],
      ['right', { a: { dx: -5, dy: 0 }, b: { dx: -55, dy: 0 }, c: { dx: 0, dy: 0 } }],
      ['top', { a: { dx: 0, dy: 50 }, b: { dx: 0, dy: 20 }, c: { dx: 0, dy: 0 } }],
      ['middleV', { a: { dx: 0, dy: 75 }, b: { dx: 0, dy: 40 }, c: { dx: 0, dy: 0 } }],
      ['bottom', { a: { dx: 0, dy: 100 }, b: { dx: 0, dy: 60 }, c: { dx: 0, dy: 0 } }],
    ];
    for (const [edge, expected] of cases) {
      it(`aligns ${edge} to the last id's box (zero delta for it)`, () => {
        const deltas = alignDeltas(IDS, sampleBoxes(), edge, 'last', CANVAS);
        expectDeltas(deltas, expected);
        expect(deltas.get('c')).toEqual({ dx: 0, dy: 0 });
      });
    }
  });

  describe('canvas reference (100,200 300x150)', () => {
    const cases: Array<[AlignEdge, Deltas]> = [
      ['left', { a: { dx: 100, dy: 0 }, b: { dx: 80, dy: 0 }, c: { dx: 105, dy: 0 } }],
      ['centerH', { a: { dx: 245, dy: 0 }, b: { dx: 210, dy: 0 }, c: { dx: 250, dy: 0 } }],
      ['right', { a: { dx: 390, dy: 0 }, b: { dx: 340, dy: 0 }, c: { dx: 395, dy: 0 } }],
      ['top', { a: { dx: 0, dy: 200 }, b: { dx: 0, dy: 170 }, c: { dx: 0, dy: 150 } }],
      ['middleV', { a: { dx: 0, dy: 270 }, b: { dx: 0, dy: 235 }, c: { dx: 0, dy: 195 } }],
      ['bottom', { a: { dx: 0, dy: 340 }, b: { dx: 0, dy: 300 }, c: { dx: 0, dy: 240 } }],
    ];
    for (const [edge, expected] of cases) {
      it(`aligns ${edge} to the canvas box`, () => {
        expectDeltas(alignDeltas(IDS, sampleBoxes(), edge, 'canvas', CANVAS), expected);
      });
    }
  });

  it('skips ids missing from the box map', () => {
    const deltas = alignDeltas(['a', 'ghost', 'b'], sampleBoxes(), 'left', 'selection', CANVAS);
    expect(deltas.has('ghost')).toBe(false);
    // Union of a+b only: x 0..60, so a is already flush left.
    expectDeltas(deltas, { a: { dx: 0, dy: 0 }, b: { dx: -20, dy: 0 } });
  });

  it('uses the first PRESENT id as the reference when the first id is missing', () => {
    const deltas = alignDeltas(['ghost', 'b', 'a'], sampleBoxes(), 'left', 'first', CANVAS);
    expect(deltas.has('ghost')).toBe(false);
    expect(deltas.get('b')).toEqual({ dx: 0, dy: 0 });
    expect(deltas.get('a')).toEqual({ dx: 20, dy: 0 });
  });

  it('is a no-op for a single id with selection reference (its box IS the union)', () => {
    for (const edge of ['left', 'centerH', 'right', 'top', 'middleV', 'bottom'] as AlignEdge[]) {
      const deltas = alignDeltas(['b'], sampleBoxes(), edge, 'selection', CANVAS);
      expect(deltas.get('b')).toEqual({ dx: 0, dy: 0 });
    }
  });

  it('returns an empty map when no ids resolve to boxes', () => {
    expect(alignDeltas(['ghost'], sampleBoxes(), 'left', 'selection', CANVAS).size).toBe(0);
    expect(alignDeltas([], sampleBoxes(), 'bottom', 'canvas', CANVAS).size).toBe(0);
  });
});

describe('distributeDeltas', () => {
  it('equalizes horizontal gaps between unequal-width boxes, keeping first/last fixed', () => {
    const boxes = new Map<string, Box>([
      ['a', { x: 0, y: 5, w: 10, h: 10 }],
      ['b', { x: 15, y: 50, w: 20, h: 10 }],
      ['c', { x: 50, y: -3, w: 5, h: 10 }],
      ['d', { x: 95, y: 12, w: 30, h: 10 }],
    ]);
    // gap = (95 - (10 + 20 + 5) - 0) / 3 = 20
    const deltas = distributeDeltas(['a', 'b', 'c', 'd'], boxes, 'horizontal');
    expectDeltas(deltas, {
      a: { dx: 0, dy: 0 },
      b: { dx: 15, dy: 0 }, // 0 + 10 + 20 = 30, from 15
      c: { dx: 20, dy: 0 }, // 30 + 20 + 20 = 70, from 50
      d: { dx: 0, dy: 0 },
    });
    // Resulting gaps are all exactly 20: 10->30, 50->70, 75->95.
    expect(deltas.get('b')!.dy).toBe(0);
    expect(deltas.get('c')!.dy).toBe(0);
  });

  it('equalizes vertical gaps, moving only y', () => {
    const boxes = new Map<string, Box>([
      ['a', { x: 40, y: 0, w: 10, h: 6 }],
      ['b', { x: -2, y: 10, w: 10, h: 4 }],
      ['c', { x: 7, y: 40, w: 10, h: 8 }],
    ]);
    // gap = (40 - (6 + 4) - 0) / 2 = 15; b moves to 0 + 6 + 15 = 21.
    const deltas = distributeDeltas(['a', 'b', 'c'], boxes, 'vertical');
    expectDeltas(deltas, {
      a: { dx: 0, dy: 0 },
      b: { dx: 0, dy: 11 },
      c: { dx: 0, dy: 0 },
    });
  });

  it('orders by axis position, not by id order', () => {
    const boxes = new Map<string, Box>([
      ['a', { x: 0, y: 5, w: 10, h: 10 }],
      ['b', { x: 15, y: 50, w: 20, h: 10 }],
      ['c', { x: 50, y: -3, w: 5, h: 10 }],
      ['d', { x: 95, y: 12, w: 30, h: 10 }],
    ]);
    const deltas = distributeDeltas(['c', 'a', 'd', 'b'], boxes, 'horizontal');
    expectDeltas(deltas, {
      a: { dx: 0, dy: 0 },
      b: { dx: 15, dy: 0 },
      c: { dx: 20, dy: 0 },
      d: { dx: 0, dy: 0 },
    });
  });

  it('is a no-op with fewer than 3 boxes', () => {
    const boxes = sampleBoxes();
    expectDeltas(distributeDeltas(['a', 'b'], boxes, 'horizontal'), {
      a: { dx: 0, dy: 0 },
      b: { dx: 0, dy: 0 },
    });
    expectDeltas(distributeDeltas(['c'], boxes, 'vertical'), { c: { dx: 0, dy: 0 } });
    expect(distributeDeltas([], boxes, 'horizontal').size).toBe(0);
  });

  it('is a no-op when the equal gap would be negative (overlapping boxes)', () => {
    const boxes = new Map<string, Box>([
      ['a', { x: 0, y: 0, w: 50, h: 50 }],
      ['b', { x: 10, y: 10, w: 50, h: 50 }],
      ['c', { x: 20, y: 20, w: 50, h: 50 }],
    ]);
    // gap = (20 - (50 + 50) - 0) / 2 = -40 on both axes.
    for (const mode of ['horizontal', 'vertical'] as const) {
      expectDeltas(distributeDeltas(['a', 'b', 'c'], boxes, mode), {
        a: { dx: 0, dy: 0 },
        b: { dx: 0, dy: 0 },
        c: { dx: 0, dy: 0 },
      });
    }
  });

  it('allows a zero gap (boxes exactly filling the span)', () => {
    const boxes = new Map<string, Box>([
      ['a', { x: 0, y: 0, w: 10, h: 10 }],
      ['b', { x: 13, y: 0, w: 10, h: 10 }],
      ['c', { x: 20, y: 0, w: 10, h: 10 }],
    ]);
    // gap = (20 - (10 + 10) - 0) / 2 = 0; b moves flush to a's right edge.
    const deltas = distributeDeltas(['a', 'b', 'c'], boxes, 'horizontal');
    expectDeltas(deltas, {
      a: { dx: 0, dy: 0 },
      b: { dx: -3, dy: 0 }, // 0 + 10 + 0 = 10, from 13
      c: { dx: 0, dy: 0 },
    });
  });

  it('skips ids missing from the box map and distributes the rest', () => {
    const boxes = new Map<string, Box>([
      ['a', { x: 0, y: 5, w: 10, h: 10 }],
      ['b', { x: 15, y: 50, w: 20, h: 10 }],
      ['c', { x: 50, y: -3, w: 5, h: 10 }],
      ['d', { x: 95, y: 12, w: 30, h: 10 }],
    ]);
    const deltas = distributeDeltas(['a', 'ghost', 'b', 'c', 'd'], boxes, 'horizontal');
    expect(deltas.has('ghost')).toBe(false);
    expectDeltas(deltas, {
      a: { dx: 0, dy: 0 },
      b: { dx: 15, dy: 0 },
      c: { dx: 20, dy: 0 },
      d: { dx: 0, dy: 0 },
    });
  });
});

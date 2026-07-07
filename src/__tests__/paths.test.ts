import { describe, expect, it } from 'vitest';
import {
  PathCmd,
  arcToCubics,
  insertNodeAfter,
  parsePath,
  pathToCubics,
  serializePath,
} from '../paths';

type CubicCmd = Extract<PathCmd, { cmd: 'C' }>;
type ArcCmd = Extract<PathCmd, { cmd: 'A' }>;

function asC(c: PathCmd | undefined): CubicCmd {
  if (!c || c.cmd !== 'C') throw new Error(`expected a C command, got ${c?.cmd}`);
  return c;
}

/** Point on a cubic at parameter t, given its start point. */
function cubicAt(x0: number, y0: number, c: CubicCmd, t: number): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
    y: u * u * u * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
  };
}

/** Sample a chain of cubics (each starting where the previous ended). */
function sampleChain(
  x0: number,
  y0: number,
  cubics: CubicCmd[],
  perSegment = 9,
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  let px = x0;
  let py = y0;
  for (const c of cubics) {
    for (let i = 0; i <= perSegment; i++) {
      pts.push(cubicAt(px, py, c, i / perSegment));
    }
    px = c.x;
    py = c.y;
  }
  return pts;
}

describe('parsePath', () => {
  it('parses absolute M/L/C/A/Z commands', () => {
    const cmds = parsePath('M 10 20 L 30 40 C 1 2 3 4 5 6 A 7 8 9 0 1 11 12 Z');
    expect(cmds).toEqual([
      { cmd: 'M', x: 10, y: 20 },
      { cmd: 'L', x: 30, y: 40 },
      { cmd: 'C', x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 },
      { cmd: 'A', rx: 7, ry: 8, rot: 9, large: 0, sweep: 1, x: 11, y: 12 },
      { cmd: 'Z' },
    ]);
  });

  it('resolves relative commands against the current point', () => {
    const cmds = parsePath('m 10 10 l 5 -5 c 1 2 3 4 5 6 a 2 2 0 0 1 4 0 z');
    expect(cmds).toEqual([
      { cmd: 'M', x: 10, y: 10 },
      { cmd: 'L', x: 15, y: 5 },
      { cmd: 'C', x1: 16, y1: 7, x2: 18, y2: 9, x: 20, y: 11 },
      { cmd: 'A', rx: 2, ry: 2, rot: 0, large: 0, sweep: 1, x: 24, y: 11 },
      { cmd: 'Z' },
    ]);
  });

  it('expands H/V (and relative h/v) to L', () => {
    expect(parsePath('M 10 10 H 50 V 20 h 5 v -3')).toEqual([
      { cmd: 'M', x: 10, y: 10 },
      { cmd: 'L', x: 50, y: 10 },
      { cmd: 'L', x: 50, y: 20 },
      { cmd: 'L', x: 55, y: 20 },
      { cmd: 'L', x: 55, y: 17 },
    ]);
  });

  it('expands S by reflecting the previous cubic control point', () => {
    const cmds = parsePath('M 0 0 C 10 0 20 10 30 10 S 50 20 60 10');
    const s = asC(cmds[2]);
    expect(s.x1).toBe(40); // 2*30 - 20
    expect(s.y1).toBe(10); // 2*10 - 10
    expect(s.x2).toBe(50);
    expect(s.y2).toBe(20);
    expect(s.x).toBe(60);
    expect(s.y).toBe(10);
  });

  it('S without a preceding C uses the current point as first control', () => {
    const cmds = parsePath('M 5 5 S 10 10 20 5');
    const s = asC(cmds[1]);
    expect(s.x1).toBe(5);
    expect(s.y1).toBe(5);
  });

  it('converts Q to an equivalent cubic', () => {
    const cmds = parsePath('M 0 0 Q 10 20 20 0');
    const c = asC(cmds[1]);
    expect(c.x1).toBeCloseTo(20 / 3, 9);
    expect(c.y1).toBeCloseTo(40 / 3, 9);
    expect(c.x2).toBeCloseTo(20 - 20 / 3, 9);
    expect(c.y2).toBeCloseTo(40 / 3, 9);
    expect(c.x).toBe(20);
    expect(c.y).toBe(0);
    // The cubic passes through the quadratic's midpoint B(0.5) = (10, 10).
    const mid = cubicAt(0, 0, c, 0.5);
    expect(mid.x).toBeCloseTo(10, 9);
    expect(mid.y).toBeCloseTo(10, 9);
  });

  it('expands T by reflecting the previous quadratic control point', () => {
    const cmds = parsePath('M 0 0 Q 10 20 20 0 T 40 0');
    const t = asC(cmds[2]);
    // Reflected quad control is (30, -20); converted to cubic controls.
    expect(t.x1).toBeCloseTo(20 + (2 / 3) * 10, 9);
    expect(t.y1).toBeCloseTo((2 / 3) * -20, 9);
    expect(t.x2).toBeCloseTo(40 + (2 / 3) * -10, 9);
    expect(t.y2).toBeCloseTo((2 / 3) * -20, 9);
    expect(t.x).toBe(40);
    expect(t.y).toBe(0);
  });

  it('T without a preceding Q degenerates to a line-like cubic', () => {
    const cmds = parsePath('M 5 5 T 15 5');
    const c = asC(cmds[1]);
    expect(c.x1).toBe(5);
    expect(c.y1).toBe(5);
    expect(c.x).toBe(15);
    expect(c.y).toBe(5);
  });

  it('treats extra pairs after M as implicit L (and after m as relative l)', () => {
    expect(parsePath('M 0 0 10 10 20 20')).toEqual([
      { cmd: 'M', x: 0, y: 0 },
      { cmd: 'L', x: 10, y: 10 },
      { cmd: 'L', x: 20, y: 20 },
    ]);
    expect(parsePath('m 5 5 10 0')).toEqual([
      { cmd: 'M', x: 5, y: 5 },
      { cmd: 'L', x: 15, y: 5 },
    ]);
  });

  it('repeats other commands implicitly', () => {
    expect(parsePath('M 0 0 L 1 1 2 2')).toEqual([
      { cmd: 'M', x: 0, y: 0 },
      { cmd: 'L', x: 1, y: 1 },
      { cmd: 'L', x: 2, y: 2 },
    ]);
    const cmds = parsePath('M 0 0 C 1 1 2 2 3 3 4 4 5 5 6 6');
    expect(cmds).toHaveLength(3);
    expect(cmds[2]).toEqual({ cmd: 'C', x1: 4, y1: 4, x2: 5, y2: 5, x: 6, y: 6 });
  });

  it('parses scientific-notation numbers', () => {
    expect(parsePath('M 1e2 2.5e-1 L 3E+1 -4e1')).toEqual([
      { cmd: 'M', x: 100, y: 0.25 },
      { cmd: 'L', x: 30, y: -40 },
    ]);
  });

  it('parses leading-dot decimals and negatives without separators', () => {
    expect(parsePath('M .5-.25 L-3 4')).toEqual([
      { cmd: 'M', x: 0.5, y: -0.25 },
      { cmd: 'L', x: -3, y: 4 },
    ]);
  });
});

describe('serializePath / parsePath roundtrip', () => {
  it('is stable after one normalization pass', () => {
    const d =
      'M 10 20 L 30.5 40 H 50 V 60 C 1 2 3 4 5 6 S 7 8 9 10 ' +
      'Q 11 12 13 14 T 15 16 A 5 8 30 0 1 20 20 L -3 .5 Z';
    const once = serializePath(parsePath(d));
    const twice = serializePath(parsePath(once));
    expect(twice).toBe(once);
    expect(parsePath(twice)).toEqual(parsePath(once));
  });

  it('serializes each command kind in absolute form', () => {
    const s = serializePath(parsePath('m 1 2 h 3 a 4 4 0 1 0 8 0 z'));
    expect(s).toBe('M 1,2 L 4,2 A 4 4 0 1 0 12,2 Z');
  });
});

describe('arcToCubics', () => {
  const arc = (over: Partial<ArcCmd>): ArcCmd => ({
    cmd: 'A', rx: 10, ry: 10, rot: 0, large: 0, sweep: 1, x: 0, y: 10, ...over,
  });

  it('converts a quarter circle to one cubic with exact endpoints', () => {
    const cubics = arcToCubics(10, 0, arc({}));
    expect(cubics).toHaveLength(1);
    expect(cubics[0].x).toBe(0);
    expect(cubics[0].y).toBe(10);
    for (const p of sampleChain(10, 0, cubics)) {
      expect(Math.abs(Math.hypot(p.x, p.y) - 10)).toBeLessThan(0.1); // within 1%
    }
  });

  it('converts a half circle to two cubics through the far point', () => {
    const cubics = arcToCubics(10, 0, arc({ x: -10, y: 0 }));
    expect(cubics).toHaveLength(2);
    expect(cubics[0].x).toBeCloseTo(0, 9);
    expect(cubics[0].y).toBeCloseTo(10, 9);
    expect(cubics[1].x).toBe(-10);
    expect(cubics[1].y).toBe(0);
    for (const p of sampleChain(10, 0, cubics)) {
      expect(Math.abs(Math.hypot(p.x, p.y) - 10)).toBeLessThan(0.1);
    }
  });

  it('converts a 270-degree arc to three cubics on the circle', () => {
    // large-arc from (10,0) to (0,10): circle centered at (10,10), radius 10.
    const cubics = arcToCubics(10, 0, arc({ large: 1 }));
    expect(cubics).toHaveLength(3);
    expect(cubics[2].x).toBe(0);
    expect(cubics[2].y).toBe(10);
    for (const p of sampleChain(10, 0, cubics)) {
      expect(Math.abs(Math.hypot(p.x - 10, p.y - 10) - 10)).toBeLessThan(0.1);
    }
  });

  it('keeps sampled points on a non-circular ellipse', () => {
    // Half of the ellipse ((x-10)/10)^2 + (y/5)^2 = 1, from (0,0) to (20,0).
    const cubics = arcToCubics(0, 0, arc({ rx: 10, ry: 5, large: 1, sweep: 0, x: 20, y: 0 }));
    expect(cubics[cubics.length - 1].x).toBe(20);
    expect(cubics[cubics.length - 1].y).toBe(0);
    for (const p of sampleChain(0, 0, cubics)) {
      const v = ((p.x - 10) / 10) ** 2 + (p.y / 5) ** 2;
      expect(Math.abs(v - 1)).toBeLessThan(0.02);
    }
  });

  it('degenerates zero-radius arcs to a line-like cubic', () => {
    const cubics = arcToCubics(0, 0, arc({ rx: 0, x: 30, y: 0 }));
    expect(cubics).toHaveLength(1);
    expect(cubics[0]).toEqual({ cmd: 'C', x1: 10, y1: 0, x2: 20, y2: 0, x: 30, y: 0 });
  });

  it('degenerates a zero-length arc to a point cubic', () => {
    const cubics = arcToCubics(5, 5, arc({ x: 5, y: 5 }));
    expect(cubics).toHaveLength(1);
    expect(cubics[0].x).toBe(5);
    expect(cubics[0].y).toBe(5);
  });
});

describe('pathToCubics', () => {
  it('removes every A command and leaves M/L/C/Z untouched', () => {
    const cmds = parsePath('M 0 0 L 10 0 A 10 10 0 0 1 20 10 C 1 1 2 2 3 3 Z');
    const out = pathToCubics(cmds);
    expect(out.some((c) => c.cmd === 'A')).toBe(false);
    expect(out[0]).toEqual({ cmd: 'M', x: 0, y: 0 });
    expect(out[1]).toEqual({ cmd: 'L', x: 10, y: 0 });
    expect(out[out.length - 2]).toEqual({ cmd: 'C', x1: 1, y1: 1, x2: 2, y2: 2, x: 3, y: 3 });
    expect(out[out.length - 1]).toEqual({ cmd: 'Z' });
    // Arc replacement lands where the endpoint was, with an exact endpoint.
    const lastArcCubic = asC(out[out.length - 3]);
    expect(lastArcCubic.x).toBe(20);
    expect(lastArcCubic.y).toBe(10);
  });

  it('passes an arc-free path through unchanged', () => {
    const cmds = parsePath('M 0 0 L 5 5 C 1 2 3 4 5 6 Z');
    expect(pathToCubics(cmds)).toEqual(cmds);
  });
});

describe('insertNodeAfter', () => {
  it('splits an L segment at its midpoint', () => {
    const cmds = parsePath('M 0 0 L 10 10');
    expect(insertNodeAfter(cmds, 0)).toBe(true);
    expect(cmds).toEqual([
      { cmd: 'M', x: 0, y: 0 },
      { cmd: 'L', x: 5, y: 5 },
      { cmd: 'L', x: 10, y: 10 },
    ]);
  });

  it('splits a C segment exactly (de Casteljau preserves the curve)', () => {
    const orig: CubicCmd = { cmd: 'C', x1: 10, y1: -5, x2: 20, y2: 15, x: 30, y: 0 };
    const cmds: PathCmd[] = [{ cmd: 'M', x: 0, y: 0 }, { ...orig }];
    expect(insertNodeAfter(cmds, 0)).toBe(true);
    expect(cmds).toHaveLength(3);
    const left = asC(cmds[1]);
    const right = asC(cmds[2]);
    expect(right.x).toBe(orig.x);
    expect(right.y).toBe(orig.y);
    for (let i = 0; i <= 20; i++) {
      const t = i / 20;
      const expected = cubicAt(0, 0, orig, t);
      const actual =
        t <= 0.5
          ? cubicAt(0, 0, left, t * 2)
          : cubicAt(left.x, left.y, right, (t - 0.5) * 2);
      expect(actual.x).toBeCloseTo(expected.x, 9);
      expect(actual.y).toBeCloseTo(expected.y, 9);
    }
  });

  it('converts a multi-quadrant A segment into cubics', () => {
    const cmds = parsePath('M 10 0 A 10 10 0 1 1 0 10');
    expect(insertNodeAfter(cmds, 0)).toBe(true);
    expect(cmds).toHaveLength(4); // M + three 90-degree cubics
    expect(cmds.every((c) => c.cmd !== 'A')).toBe(true);
    const last = asC(cmds[3]);
    expect(last.x).toBe(0);
    expect(last.y).toBe(10);
  });

  it('splits a quarter-turn A segment so a new node actually appears', () => {
    const cmds = parsePath('M 10 0 A 10 10 0 0 1 0 10');
    expect(insertNodeAfter(cmds, 0)).toBe(true);
    expect(cmds).toHaveLength(3); // single arc cubic was split in two
    expect(cmds.every((c) => c.cmd !== 'A')).toBe(true);
    const last = asC(cmds[2]);
    expect(last.x).toBe(0);
    expect(last.y).toBe(10);
    // The split point still sits on the circle.
    const mid = asC(cmds[1]);
    expect(Math.abs(Math.hypot(mid.x, mid.y) - 10)).toBeLessThan(0.1);
  });

  it('refuses to split after Z, at the end, or before M', () => {
    const closed = parsePath('M 0 0 L 5 5 Z');
    expect(insertNodeAfter(closed, 2)).toBe(false); // prev is Z
    expect(insertNodeAfter(closed, 5)).toBe(false); // out of range
    const twoSubpaths = parsePath('M 0 0 L 5 5 M 9 9 L 10 10');
    expect(insertNodeAfter(twoSubpaths, 1)).toBe(false); // next is M
  });
});

import { describe, expect, it } from 'vitest';
import {
  PathCmd,
  arcToCubics,
  insertNodeAfter,
  parsePath,
  pathToCubics,
  serializePath,
  deleteSegment,
  reversePath,
  closePath,
  joinPaths,
  isSingleSubpath,
  isClosedPath,
  nodeCount,
} from '../geometry/paths';

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

// ---- Structural editing (break / join / reverse) --------------------------------

/** nodeTypes length must always equal the node count (Z excluded). */
function typesInSync(cmds: PathCmd[], nodeTypes: string | null): boolean {
  return nodeTypes == null || nodeTypes.length === nodeCount(cmds);
}

describe('subpath predicates', () => {
  it('recognizes single subpaths and refuses compound ones', () => {
    expect(isSingleSubpath(parsePath('M 0 0 L 5 5'))).toBe(true);
    expect(isSingleSubpath(parsePath('M 0 0 L 5 5 Z'))).toBe(true);
    expect(isSingleSubpath(parsePath('M 0 0 L 5 5 M 9 9 L 8 8'))).toBe(false);
    expect(isSingleSubpath(parsePath('M 0 0 Z M 9 9 L 8 8 Z'))).toBe(false);
  });

  it('detects closed paths and counts nodes excluding Z', () => {
    expect(isClosedPath(parsePath('M 0 0 L 5 5 Z'))).toBe(true);
    expect(isClosedPath(parsePath('M 0 0 L 5 5'))).toBe(false);
    expect(nodeCount(parsePath('M 0 0 L 5 5 L 9 9 Z'))).toBe(3);
  });
});

describe('deleteSegment', () => {
  const square = 'M 0 0 L 10 0 L 10 10 L 0 10 Z'; // nodes A B C D closed

  it('opens a closed path at its closing (wrap) segment by dropping Z', () => {
    const cmds = parsePath(square);
    const pieces = deleteSegment(cmds, 'cssc', 0, 3)!; // M (0) and last node (3)
    expect(pieces).toHaveLength(1);
    expect(isClosedPath(pieces[0].cmds)).toBe(false);
    expect(pieces[0].cmds.map((c) => c.cmd)).toEqual(['M', 'L', 'L', 'L']);
    expect(pieces[0].nodeTypes).toBe('cssc'); // order unchanged
    expect(typesInSync(pieces[0].cmds, pieces[0].nodeTypes)).toBe(true);
  });

  it('opens a closed path at an interior segment, rotating so the break is the seam', () => {
    const cmds = parsePath(square);
    // Delete A->B (nodes 0,1). Result should traverse B C D A (the old Z becomes L to A).
    const pieces = deleteSegment(cmds, 'cssc', 0, 1)!;
    expect(pieces).toHaveLength(1);
    expect(isClosedPath(pieces[0].cmds)).toBe(false);
    expect(serializePath(pieces[0].cmds)).toBe('M 10,0 L 10,10 L 0,10 L 0,0');
    expect(pieces[0].nodeTypes).toBe('sscc'); // types follow their nodes: s(B) s(C) c(D) c(A)
    expect(typesInSync(pieces[0].cmds, pieces[0].nodeTypes)).toBe(true);
  });

  it('splits an open path into two pieces at the deleted segment', () => {
    const cmds = parsePath('M 0 0 L 10 0 L 20 0 L 30 0');
    const pieces = deleteSegment(cmds, 'cccc', 1, 2)!; // delete 10,0 -> 20,0
    expect(pieces).toHaveLength(2);
    expect(serializePath(pieces[0].cmds)).toBe('M 0,0 L 10,0');
    expect(serializePath(pieces[1].cmds)).toBe('M 20,0 L 30,0');
    expect(pieces[0].nodeTypes).toBe('cc');
    expect(pieces[1].nodeTypes).toBe('cc');
  });

  it('discards a resulting piece with fewer than 2 nodes', () => {
    const cmds = parsePath('M 0 0 L 10 0 L 20 0 L 30 0');
    const pieces = deleteSegment(cmds, null, 0, 1)!; // deleting the first segment
    expect(pieces).toHaveLength(1);
    expect(serializePath(pieces[0].cmds)).toBe('M 10,0 L 20,0 L 30,0');
    expect(pieces[0].nodeTypes).toBeNull(); // untyped stays untyped
  });

  it('returns null for non-adjacent nodes and compound paths', () => {
    expect(deleteSegment(parsePath('M 0 0 L 10 0 L 20 0 L 30 0'), null, 0, 2)).toBeNull();
    expect(deleteSegment(parsePath('M 0 0 L 5 5 M 9 9 L 8 8'), null, 0, 1)).toBeNull();
  });

  // Segment bending splices an EXPLICIT closing segment (endpoint == M point) in
  // front of the Z, so the Z closes a zero-length gap. Opening such a path must not
  // emit a zero-length L / phantom node stacked on node 0.
  describe('closed path with an explicit closing segment (zero-length Z)', () => {
    // Nodes: 0 (0,0) M · 1 (10,0) · 2 (10,10) · 3 (0,10) · 4 (0,0) explicit closing C.
    const explicit = 'M 0 0 L 10 0 L 10 10 L 0 10 C 0 6 0 3 0 0 Z';

    /** Consecutive node endpoints must all be distinct (no zero-length segment). */
    function minSegmentLength(cmds: PathCmd[]): number {
      let min = Infinity;
      let prev: { x: number; y: number } | null = null;
      for (const c of cmds) {
        if (c.cmd === 'Z') continue;
        const p = { x: (c as { x: number }).x, y: (c as { y: number }).y };
        if (prev) min = Math.min(min, Math.hypot(p.x - prev.x, p.y - prev.y));
        prev = p;
      }
      return min;
    }

    it('deleting the explicit closing segment drops it cleanly (no zero-length L)', () => {
      const pieces = deleteSegment(parsePath(explicit), 'csszc', 3, 4)!; // nodes D-2, D-1
      expect(pieces).toHaveLength(1);
      const p = pieces[0];
      expect(serializePath(p.cmds)).toBe('M 0,0 L 10,0 L 10,10 L 0,10');
      expect(nodeCount(p.cmds)).toBe(4); // D-1, phantom node collapsed
      expect(minSegmentLength(p.cmds)).toBeGreaterThan(0);
      expect(p.nodeTypes).toBe('cssz'); // coincident node 4's 'c' survives; node 0's dropped
      expect(typesInSync(p.cmds, p.nodeTypes)).toBe(true);
    });

    it('deleting an interior segment rotates without a zero-length seam', () => {
      const pieces = deleteSegment(parsePath(explicit), 'csszc', 1, 2)!;
      expect(pieces).toHaveLength(1);
      const p = pieces[0];
      // Traverses 2 3 4(=0-coincident, keeps its C) then wraps straight to 1 — the
      // coincident node absorbs node 0, so no L to (0,0) is inserted.
      expect(serializePath(p.cmds)).toBe('M 10,10 L 0,10 C 0,6 0,3 0,0 L 10,0');
      expect(nodeCount(p.cmds)).toBe(4); // D-1
      expect(minSegmentLength(p.cmds)).toBeGreaterThan(0);
      expect(p.nodeTypes).toBe('szcs'); // nt[2] nt[3] nt[4] nt[1]
      expect(typesInSync(p.cmds, p.nodeTypes)).toBe(true);
    });
  });
});

describe('reversePath', () => {
  function cubicAtLocal(x0: number, y0: number, c: CubicCmd, t: number) {
    const u = 1 - t;
    return {
      x: u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
      y: u * u * u * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
    };
  }

  it('reverses a cubic path, tracing the identical curve backwards', () => {
    const cmds = parsePath('M 0 0 C 3 10 7 10 10 0');
    const rev = reversePath(cmds, 'zs');
    expect(rev.cmds[0]).toEqual({ cmd: 'M', x: 10, y: 0 });
    expect(rev.nodeTypes).toBe('sz'); // reversed
    const orig = asC(cmds[1]);
    const back = asC(rev.cmds[1]);
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const a = cubicAtLocal(0, 0, orig, t);
      const b = cubicAtLocal(10, 0, back, 1 - t);
      expect(b.x).toBeCloseTo(a.x, 9);
      expect(b.y).toBeCloseTo(a.y, 9);
    }
  });

  it('reverses an arc by swapping endpoints and flipping the sweep flag', () => {
    const cmds = parsePath('M 10 0 A 10 10 0 0 1 0 10');
    const rev = reversePath(cmds, null);
    expect(rev.cmds[0]).toEqual({ cmd: 'M', x: 0, y: 10 });
    expect(rev.cmds[1]).toEqual({ cmd: 'A', rx: 10, ry: 10, rot: 0, large: 0, sweep: 0, x: 10, y: 0 });
  });
});

describe('closePath', () => {
  const open = 'M 0 0 L 10 0 L 10 10 L 0 10'; // 4 nodes, open

  it('segment mode appends Z and leaves nodes untouched', () => {
    const p = closePath(parsePath(open), 'cccc', 'segment')!;
    expect(serializePath(p.cmds)).toBe('M 0,0 L 10,0 L 10,10 L 0,10 Z');
    expect(p.nodeTypes).toBe('cccc');
    expect(typesInSync(p.cmds, p.nodeTypes)).toBe(true);
  });

  it('weld mode merges the two ends at their midpoint and closes', () => {
    const p = closePath(parsePath(open), 'cszc', 'weld')!;
    // Ends (0,0) and (0,10) -> midpoint (0,5); last segment folds into Z.
    expect(serializePath(p.cmds)).toBe('M 0,5 L 10,0 L 10,10 Z');
    expect(p.nodeTypes).toBe('csz'); // merged node 'c', then middle nodes, last dropped
    expect(typesInSync(p.cmds, p.nodeTypes)).toBe(true);
  });

  it('refuses an already-closed path', () => {
    expect(closePath(parsePath('M 0 0 L 10 0 L 10 10 Z'), null, 'segment')).toBeNull();
  });
});

describe('joinPaths', () => {
  const a = 'M 0 0 L 10 0';
  const b = 'M 20 0 L 30 0';

  it('bridges two paths with a straight segment (segment mode)', () => {
    const p = joinPaths(
      { cmds: parsePath(a), nodeTypes: 'cc', end: 'end' },
      { cmds: parsePath(b), nodeTypes: 'ss', end: 'start' },
      'segment',
    )!;
    expect(serializePath(p.cmds)).toBe('M 0,0 L 10,0 L 20,0 L 30,0');
    expect(p.nodeTypes).toBe('ccss');
    expect(typesInSync(p.cmds, p.nodeTypes)).toBe(true);
  });

  it('welds two path ends at their midpoint (weld mode)', () => {
    const p = joinPaths(
      { cmds: parsePath(a), nodeTypes: 'cc', end: 'end' },
      { cmds: parsePath(b), nodeTypes: 'ss', end: 'start' },
      'weld',
    )!;
    expect(serializePath(p.cmds)).toBe('M 0,0 L 15,0 L 30,0'); // 10,0 & 20,0 -> 15,0
    expect(p.nodeTypes).toBe('ccs'); // a(0) + merged 'c' + b(1)
    expect(nodeCount(p.cmds)).toBe(3); // Da + Db - 1
    expect(typesInSync(p.cmds, p.nodeTypes)).toBe(true);
  });

  it('reverses a path when needed so the chosen ends meet', () => {
    // Join a.start to b.end: both must be reversed internally.
    const p = joinPaths(
      { cmds: parsePath(a), nodeTypes: null, end: 'start' },
      { cmds: parsePath(b), nodeTypes: null, end: 'end' },
      'segment',
    )!;
    // a reversed -> 10,0 then 0,0 ; b reversed -> 30,0 then 20,0.
    expect(serializePath(p.cmds)).toBe('M 10,0 L 0,0 L 30,0 L 20,0');
    expect(p.nodeTypes).toBeNull();
  });

  it('returns null when either path is closed', () => {
    expect(joinPaths(
      { cmds: parsePath('M 0 0 L 10 0 Z'), nodeTypes: null, end: 'end' },
      { cmds: parsePath(b), nodeTypes: null, end: 'start' },
      'weld',
    )).toBeNull();
  });
});

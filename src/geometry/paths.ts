/**
 * Path-data parsing and editing.
 *
 * On import every path is normalized to absolute commands with all shorthand forms
 * (H/V/S/T/Q, relative coords) rewritten as M / L / C / A / Z. That gives the node
 * editor a uniform command list: every command has one draggable endpoint, and cubics
 * additionally expose two control handles. Arcs keep their parameters (only the
 * endpoint is editable) — good enough in practice, and lossless.
 */

export type PathCmd =
  | { cmd: 'M'; x: number; y: number }
  | { cmd: 'L'; x: number; y: number }
  | { cmd: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { cmd: 'A'; rx: number; ry: number; rot: number; large: number; sweep: number; x: number; y: number }
  | { cmd: 'Z' };

const TOKEN_RE = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;

export function parsePath(d: string): PathCmd[] {
  const tokens: (string | number)[] = [];
  for (const m of d.matchAll(TOKEN_RE)) {
    tokens.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }

  const out: PathCmd[] = [];
  let i = 0;
  let cx = 0, cy = 0;          // current point
  let sx = 0, sy = 0;          // subpath start
  let px: number | null = null; // previous cubic control (for S)
  let py: number | null = null;
  let qx: number | null = null; // previous quadratic control (for T)
  let qy: number | null = null;
  let cmd = '';

  const num = () => tokens[i++] as number;

  while (i < tokens.length) {
    if (typeof tokens[i] === 'string') {
      cmd = tokens[i++] as string;
    }
    // else: implicit repeat of the previous command (M repeats as L per spec)
    const rel = cmd === cmd.toLowerCase();
    const upper = cmd.toUpperCase();
    let keepCubicRef = false;
    let keepQuadRef = false;

    switch (upper) {
      case 'M': {
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        out.push({ cmd: 'M', x, y });
        cx = x; cy = y; sx = x; sy = y;
        cmd = rel ? 'l' : 'L'; // subsequent implicit pairs are lines
        break;
      }
      case 'L': {
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        out.push({ cmd: 'L', x, y });
        cx = x; cy = y;
        break;
      }
      case 'H': {
        const x = num() + (rel ? cx : 0);
        out.push({ cmd: 'L', x, y: cy });
        cx = x;
        break;
      }
      case 'V': {
        const y = num() + (rel ? cy : 0);
        out.push({ cmd: 'L', x: cx, y });
        cy = y;
        break;
      }
      case 'C': {
        const x1 = num() + (rel ? cx : 0);
        const y1 = num() + (rel ? cy : 0);
        const x2 = num() + (rel ? cx : 0);
        const y2 = num() + (rel ? cy : 0);
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        out.push({ cmd: 'C', x1, y1, x2, y2, x, y });
        px = x2; py = y2; keepCubicRef = true;
        cx = x; cy = y;
        break;
      }
      case 'S': {
        const x2 = num() + (rel ? cx : 0);
        const y2 = num() + (rel ? cy : 0);
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        const x1 = px !== null ? 2 * cx - px : cx;
        const y1 = py !== null ? 2 * cy - py! : cy;
        out.push({ cmd: 'C', x1, y1, x2, y2, x, y });
        px = x2; py = y2; keepCubicRef = true;
        cx = x; cy = y;
        break;
      }
      case 'Q': {
        const qx1 = num() + (rel ? cx : 0);
        const qy1 = num() + (rel ? cy : 0);
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        out.push(quadToCubic(cx, cy, qx1, qy1, x, y));
        qx = qx1; qy = qy1; keepQuadRef = true;
        cx = x; cy = y;
        break;
      }
      case 'T': {
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        const qx1: number = qx !== null ? 2 * cx - qx : cx;
        const qy1: number = qy !== null ? 2 * cy - qy : cy;
        out.push(quadToCubic(cx, cy, qx1, qy1, x, y));
        qx = qx1; qy = qy1; keepQuadRef = true;
        cx = x; cy = y;
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = num(), sweep = num();
        const x = num() + (rel ? cx : 0);
        const y = num() + (rel ? cy : 0);
        out.push({ cmd: 'A', rx, ry, rot, large, sweep, x, y });
        cx = x; cy = y;
        break;
      }
      case 'Z': {
        out.push({ cmd: 'Z' });
        cx = sx; cy = sy;
        break;
      }
      default:
        throw new Error(`Unsupported path command: ${cmd}`);
    }
    if (!keepCubicRef) { px = null; py = null; }
    if (!keepQuadRef) { qx = null; qy = null; }
  }
  return out;
}

function quadToCubic(x0: number, y0: number, qx: number, qy: number, x: number, y: number): PathCmd {
  return {
    cmd: 'C',
    x1: x0 + (2 / 3) * (qx - x0),
    y1: y0 + (2 / 3) * (qy - y0),
    x2: x + (2 / 3) * (qx - x),
    y2: y + (2 / 3) * (qy - y),
    x, y,
  };
}

const fmt = (n: number) => Number(n.toFixed(4)).toString();

export function serializePath(cmds: PathCmd[]): string {
  return cmds
    .map((c) => {
      switch (c.cmd) {
        case 'M': return `M ${fmt(c.x)},${fmt(c.y)}`;
        case 'L': return `L ${fmt(c.x)},${fmt(c.y)}`;
        case 'C': return `C ${fmt(c.x1)},${fmt(c.y1)} ${fmt(c.x2)},${fmt(c.y2)} ${fmt(c.x)},${fmt(c.y)}`;
        case 'A': return `A ${fmt(c.rx)} ${fmt(c.ry)} ${fmt(c.rot)} ${c.large} ${c.sweep} ${fmt(c.x)},${fmt(c.y)}`;
        case 'Z': return 'Z';
      }
    })
    .join(' ');
}

type CubicCmd = Extract<PathCmd, { cmd: 'C' }>;
type ArcCmd = Extract<PathCmd, { cmd: 'A' }>;

/**
 * Convert one elliptical arc to cubic Béziers (W3C F.6.5 endpoint→center
 * parametrization, split into ≤90° sweeps, each approximated with the standard
 * 4/3·tan(θ/4) control-point distance). Degenerate arcs become a line-like cubic.
 */
export function arcToCubics(x0: number, y0: number, arc: ArcCmd): CubicCmd[] {
  const lineTo = (x: number, y: number): CubicCmd[] => [{
    cmd: 'C',
    x1: x0 + (x - x0) / 3, y1: y0 + (y - y0) / 3,
    x2: x0 + (2 * (x - x0)) / 3, y2: y0 + (2 * (y - y0)) / 3,
    x, y,
  }];

  let rx = Math.abs(arc.rx), ry = Math.abs(arc.ry);
  if (rx < 1e-9 || ry < 1e-9 || (x0 === arc.x && y0 === arc.y)) return lineTo(arc.x, arc.y);

  const phi = (arc.rot * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);

  // Midpoint frame (F.6.5.1)
  const dx = (x0 - arc.x) / 2, dy = (y0 - arc.y) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;

  // Scale radii up if the endpoints can't be reached (F.6.6)
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s; ry *= s;
  }

  // Center (F.6.5.2/3)
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (arc.large !== arc.sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = coef * ((rx * y1p) / ry);
  const cyp = coef * (-(ry * x1p) / rx);
  const cx = cosP * cxp - sinP * cyp + (x0 + arc.x) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + arc.y) / 2;

  // Angles (F.6.5.5/6)
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!arc.sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (arc.sweep && dTheta < 0) dTheta += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / segments;
  const alpha = (4 / 3) * Math.tan(delta / 4);

  const pointAt = (t: number) => ({
    x: cx + rx * Math.cos(t) * cosP - ry * Math.sin(t) * sinP,
    y: cy + rx * Math.cos(t) * sinP + ry * Math.sin(t) * cosP,
  });
  const derivAt = (t: number) => ({
    x: -rx * Math.sin(t) * cosP - ry * Math.cos(t) * sinP,
    y: -rx * Math.sin(t) * sinP + ry * Math.cos(t) * cosP,
  });

  const out: CubicCmd[] = [];
  for (let s = 0; s < segments; s++) {
    const t0 = theta1 + s * delta;
    const t1 = t0 + delta;
    const p0 = pointAt(t0), p1 = pointAt(t1);
    const d0 = derivAt(t0), d1 = derivAt(t1);
    out.push({
      cmd: 'C',
      x1: p0.x + alpha * d0.x, y1: p0.y + alpha * d0.y,
      x2: p1.x - alpha * d1.x, y2: p1.y - alpha * d1.y,
      // Snap the final endpoint exactly so closed shapes stay closed.
      x: s === segments - 1 ? arc.x : p1.x,
      y: s === segments - 1 ? arc.y : p1.y,
    });
  }
  return out;
}

/** Rewrite every arc in a command list as cubics (M/L/C/Z pass through untouched). */
export function pathToCubics(cmds: PathCmd[]): PathCmd[] {
  const out: PathCmd[] = [];
  let cx = 0, cy = 0;
  let sx = 0, sy = 0;
  for (const c of cmds) {
    if (c.cmd === 'A') {
      out.push(...arcToCubics(cx, cy, c));
      cx = c.x; cy = c.y;
    } else {
      out.push(c);
      if (c.cmd === 'Z') {
        cx = sx; cy = sy;
      } else {
        cx = c.x; cy = c.y;
        if (c.cmd === 'M') { sx = c.x; sy = c.y; }
      }
    }
  }
  return out;
}

/**
 * Insert a node after command index `i`, splitting the following segment in half.
 * Cubics split exactly (de Casteljau at t=0.5); lines split at the midpoint; arcs are
 * first converted to cubics (which alone adds nodes on multi-quadrant arcs).
 */
export function insertNodeAfter(cmds: PathCmd[], i: number): boolean {
  const prev = cmds[i];
  const next = cmds[i + 1];
  if (!prev || !next || prev.cmd === 'Z') return false;
  const x0 = (prev as { x: number }).x;
  const y0 = (prev as { y: number }).y;

  if (next.cmd === 'A') {
    const cubics = arcToCubics(x0, y0, next);
    cmds.splice(i + 1, 1, ...cubics);
    // A quarter-turn-or-less arc yields a single cubic: split it so a node appears.
    if (cubics.length === 1) return insertNodeAfter(cmds, i);
    return true;
  }
  if (next.cmd === 'L') {
    cmds.splice(i + 1, 0, { cmd: 'L', x: (x0 + next.x) / 2, y: (y0 + next.y) / 2 });
    return true;
  }
  if (next.cmd === 'C') {
    const mid = (a: number, b: number) => (a + b) / 2;
    const ax = mid(x0, next.x1), ay = mid(y0, next.y1);
    const bx = mid(next.x1, next.x2), by = mid(next.y1, next.y2);
    const cxx = mid(next.x2, next.x), cyy = mid(next.y2, next.y);
    const dx = mid(ax, bx), dy = mid(ay, by);
    const ex = mid(bx, cxx), ey = mid(by, cyy);
    const mx = mid(dx, ex), my = mid(dy, ey);
    const left: PathCmd = { cmd: 'C', x1: ax, y1: ay, x2: dx, y2: dy, x: mx, y: my };
    const right: PathCmd = { cmd: 'C', x1: ex, y1: ey, x2: cxx, y2: cyy, x: next.x, y: next.y };
    cmds.splice(i + 1, 1, left, right);
    return true;
  }
  return false;
}

// ---- Structural editing: break / join / reverse whole subpaths -----------------
//
// A "node" is a drawing command's endpoint (M/L/C/A); Z is not a node. `nodeTypes` is
// one char per node (Inkscape's c/s/z, Z excluded) — every function here keeps it the
// same length as the node count. These operate on a SINGLE subpath (one M, optional
// trailing Z); compound paths are refused (return null) so callers can disable the UI.

/** One resulting subpath: absolute commands plus its node-type string (null = untyped). */
export interface PathPiece {
  cmds: PathCmd[];
  nodeTypes: string | null;
}

type WithXY = { x: number; y: number };

function endpointOf(c: PathCmd): WithXY {
  if (c.cmd === 'Z') throw new Error('Z has no endpoint');
  return { x: (c as unknown as WithXY).x, y: (c as unknown as WithXY).y };
}

function clonePathCmd(c: PathCmd): PathCmd {
  return { ...c };
}

/** nodeTypes padded/truncated to exactly `count` chars ('c' fill). */
function normTypes(nodeTypes: string | null | undefined, count: number): string {
  let t = nodeTypes ?? '';
  if (t.length > count) t = t.slice(0, count);
  while (t.length < count) t += 'c';
  return t;
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let k = a; k <= b; k++) out.push(k);
  return out;
}

function stripTrailingZ(cmds: PathCmd[]): PathCmd[] {
  return cmds.length && cmds[cmds.length - 1].cmd === 'Z' ? cmds.slice(0, -1) : cmds.slice();
}

/** A single subpath: M at index 0, no interior M, at most one Z (trailing). */
export function isSingleSubpath(cmds: PathCmd[]): boolean {
  if (cmds.length === 0 || cmds[0].cmd !== 'M') return false;
  for (let i = 1; i < cmds.length; i++) {
    if (cmds[i].cmd === 'M') return false;
    if (cmds[i].cmd === 'Z' && i !== cmds.length - 1) return false;
  }
  return true;
}

export function isClosedPath(cmds: PathCmd[]): boolean {
  return cmds.length > 0 && cmds[cmds.length - 1].cmd === 'Z';
}

/** Number of nodes (drawing commands; Z excluded). */
export function nodeCount(cmds: PathCmd[]): number {
  let n = 0;
  for (const c of cmds) if (c.cmd !== 'Z') n++;
  return n;
}

/**
 * Break the segment between two ADJACENT nodes (consecutive commands, or the closing
 * wrap of a closed path). A closed path OPENS (one piece, rotated so the opening lands
 * at the break; the old Z becomes a straight L). An open path SPLITS in two (the second
 * piece gets a fresh M). Pieces with fewer than 2 nodes are discarded. Returns null when
 * the nodes are not a single deletable segment of a single subpath.
 */
export function deleteSegment(
  cmds: PathCmd[], nodeTypes: string | null, ia: number, ib: number,
): PathPiece[] | null {
  if (!isSingleSubpath(cmds)) return null;
  const closed = isClosedPath(cmds);
  const draw = cmds.filter((c) => c.cmd !== 'Z');
  const D = draw.length;
  if (D < 2) return null;
  const lo = Math.min(ia, ib);
  const hi = Math.max(ia, ib);
  if (lo < 0 || hi >= D || lo === hi) return null;

  const nt = nodeTypes == null ? null : normTypes(nodeTypes, D);
  const pick = (order: number[]): string | null =>
    nt == null ? null : order.map((k) => nt[k]).join('');
  const pt = (k: number) => endpointOf(draw[k]);

  // Closing (wrap) segment of a closed path: nodes are M (0) and the last node (D-1).
  if (closed && lo === 0 && hi === D - 1 && D > 2) {
    return [{ cmds: draw.map(clonePathCmd), nodeTypes: pick(range(0, D - 1)) }];
  }

  if (hi !== lo + 1) return null; // not adjacent
  const j = hi; // deleted segment is the command producing node j

  if (closed) {
    // Rotate so the opening lands at node j; the old Z becomes a straight L to node 0.
    const order: number[] = [];
    const out: PathCmd[] = [];
    const m0 = pt(j);
    out.push({ cmd: 'M', x: m0.x, y: m0.y }); order.push(j);
    for (let k = j + 1; k <= D - 1; k++) { out.push(clonePathCmd(draw[k])); order.push(k); }
    // Paths with an EXPLICIT closing segment (last endpoint == M point, then a
    // zero-length Z — segment bending creates these) already sit at node 0 here:
    // skip the L so no zero-length segment / stacked phantom node appears. The
    // coincident node's type char survives; node 0's is dropped.
    const p0 = pt(0);
    const last = endpointOf(out[out.length - 1]);
    if (Math.abs(last.x - p0.x) > 1e-9 || Math.abs(last.y - p0.y) > 1e-9) {
      out.push({ cmd: 'L', x: p0.x, y: p0.y }); order.push(0);
    }
    for (let k = 1; k <= j - 1; k++) { out.push(clonePathCmd(draw[k])); order.push(k); }
    if (out.length < 2) return null; // degenerate (e.g. a 2-node explicit-closing path)
    return [{ cmds: out, nodeTypes: pick(order) }];
  }

  // Open path: split into two subpaths at node j.
  const aCmds = draw.slice(0, j).map(clonePathCmd);
  const bStart = pt(j);
  const bCmds: PathCmd[] = [{ cmd: 'M', x: bStart.x, y: bStart.y }];
  const bOrder = [j];
  for (let k = j + 1; k <= D - 1; k++) { bCmds.push(clonePathCmd(draw[k])); bOrder.push(k); }
  const pieces: PathPiece[] = [];
  if (aCmds.length >= 2) pieces.push({ cmds: aCmds, nodeTypes: pick(range(0, j - 1)) });
  if (bCmds.length >= 2) pieces.push({ cmds: bCmds, nodeTypes: pick(bOrder) });
  return pieces.length ? pieces : null;
}

/**
 * Reverse a single (open) subpath: node order flips, cubic control points swap, arcs
 * flip their sweep flag, and nodeTypes reverses in lockstep. A trailing Z is dropped
 * (its straight closing line is not reconstructed — reversal is used for open paths).
 */
export function reversePath(cmds: PathCmd[], nodeTypes: string | null): PathPiece {
  const open = stripTrailingZ(cmds);
  const D = open.length;
  if (D === 0) return { cmds: [], nodeTypes: null };
  const pts = open.map(endpointOf);
  const out: PathCmd[] = [{ cmd: 'M', x: pts[D - 1].x, y: pts[D - 1].y }];
  for (let i = D - 1; i >= 1; i--) {
    const seg = open[i];
    const to = pts[i - 1];
    if (seg.cmd === 'C') {
      out.push({ cmd: 'C', x1: seg.x2, y1: seg.y2, x2: seg.x1, y2: seg.y1, x: to.x, y: to.y });
    } else if (seg.cmd === 'A') {
      out.push({
        cmd: 'A', rx: seg.rx, ry: seg.ry, rot: seg.rot,
        large: seg.large, sweep: seg.sweep ? 0 : 1, x: to.x, y: to.y,
      });
    } else {
      out.push({ cmd: 'L', x: to.x, y: to.y });
    }
  }
  const nt = nodeTypes == null ? null : [...normTypes(nodeTypes, D)].reverse().join('');
  return { cmds: out, nodeTypes: nt };
}

/**
 * Close an OPEN subpath by joining its two free ends.
 *   'weld'    — collapse both ends to their midpoint (merge into one node) and close;
 *               the last drawing segment folds into the straight Z. Needs >= 3 nodes.
 *   'segment' — just append Z (the closing straight line IS the new segment); ends stay.
 * Returns null if the path is already closed or not a single subpath.
 */
export function closePath(
  cmds: PathCmd[], nodeTypes: string | null, mode: 'weld' | 'segment',
): PathPiece | null {
  if (!isSingleSubpath(cmds) || isClosedPath(cmds)) return null;
  const open = cmds.map(clonePathCmd);
  const D = open.length;
  if (D < 2) return null;
  const nt = nodeTypes == null ? null : normTypes(nodeTypes, D);

  if (mode === 'segment') {
    return { cmds: [...open, { cmd: 'Z' }], nodeTypes: nt };
  }
  if (D < 3) return null; // welding a 2-node path collapses it to a point
  const a = endpointOf(open[0]);
  const b = endpointOf(open[D - 1]);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const out = open.slice(0, D - 1);
  (out[0] as unknown as WithXY).x = mid.x;
  (out[0] as unknown as WithXY).y = mid.y;
  out.push({ cmd: 'Z' });
  const outNt = nt == null ? null : 'c' + nt.slice(1, D - 1);
  return { cmds: out, nodeTypes: outNt };
}

/**
 * Merge two different OPEN subpaths into one, joining the given end of each. One is
 * reversed if needed so a's chosen end meets b's chosen end.
 *   'weld'    — collapse the meeting ends to their midpoint (one merged node, 'c').
 *   'segment' — bridge them with a straight L; both nodes survive.
 * Arcs are preserved (reversal flips their sweep). Returns null unless both are single
 * open subpaths.
 */
export function joinPaths(
  a: { cmds: PathCmd[]; nodeTypes: string | null; end: 'start' | 'end' },
  b: { cmds: PathCmd[]; nodeTypes: string | null; end: 'start' | 'end' },
  mode: 'weld' | 'segment',
): PathPiece | null {
  if (!isSingleSubpath(a.cmds) || !isSingleSubpath(b.cmds)) return null;
  if (isClosedPath(a.cmds) || isClosedPath(b.cmds)) return null;
  // Arrange so a's LAST node and b's FIRST node are the meeting ends.
  const pa = a.end === 'start'
    ? reversePath(a.cmds, a.nodeTypes)
    : { cmds: stripTrailingZ(a.cmds).map(clonePathCmd), nodeTypes: a.nodeTypes };
  const pb = b.end === 'end'
    ? reversePath(b.cmds, b.nodeTypes)
    : { cmds: stripTrailingZ(b.cmds).map(clonePathCmd), nodeTypes: b.nodeTypes };
  const aCmds = pa.cmds.map(clonePathCmd);
  const bCmds = pb.cmds;
  const Da = aCmds.length, Db = bCmds.length;
  if (Da < 2 || Db < 2) return null;
  const typed = pa.nodeTypes != null || pb.nodeTypes != null;
  const aNt = normTypes(pa.nodeTypes, Da);
  const bNt = normTypes(pb.nodeTypes, Db);

  if (mode === 'weld') {
    const ae = endpointOf(aCmds[Da - 1]);
    const b0 = endpointOf(bCmds[0]);
    const mid = { x: (ae.x + b0.x) / 2, y: (ae.y + b0.y) / 2 };
    (aCmds[Da - 1] as unknown as WithXY).x = mid.x;
    (aCmds[Da - 1] as unknown as WithXY).y = mid.y;
    const out = aCmds.slice();
    for (let i = 1; i < Db; i++) out.push(clonePathCmd(bCmds[i]));
    const nt = typed ? aNt.slice(0, Da - 1) + 'c' + bNt.slice(1) : null;
    return { cmds: out, nodeTypes: nt };
  }
  // segment: straight L bridge from a's end to b's start, then b's body.
  const out = aCmds.slice();
  const b0 = endpointOf(bCmds[0]);
  out.push({ cmd: 'L', x: b0.x, y: b0.y });
  for (let i = 1; i < Db; i++) out.push(clonePathCmd(bCmds[i]));
  const nt = typed ? aNt + bNt : null;
  return { cmds: out, nodeTypes: nt };
}

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

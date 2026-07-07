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

/**
 * Insert a node after command index `i`, splitting the following segment in half.
 * Cubics split exactly (de Casteljau at t=0.5); lines split at the midpoint; arcs are
 * left alone (returns false).
 */
export function insertNodeAfter(cmds: PathCmd[], i: number): boolean {
  const prev = cmds[i];
  const next = cmds[i + 1];
  if (!prev || !next || prev.cmd === 'Z') return false;
  const x0 = (prev as { x: number }).x;
  const y0 = (prev as { y: number }).y;

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

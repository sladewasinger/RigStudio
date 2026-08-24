import { PathCmd } from './paths';

export type WarpCubic = Extract<PathCmd, { cmd: 'C' }>;
export type WarpSubpath = { start: { x: number; y: number }; curves: WarpCubic[]; closed: boolean };
export type WarpAlignment = { reverse: boolean; seam: number; confidence: number; ambiguous: boolean; reason: string };

const point = (start: { x: number; y: number }, curve: WarpCubic, t: number) => {
  const u = 1 - t;
  return {
    x: u ** 3 * start.x + 3 * u * u * t * curve.x1 + 3 * u * t * t * curve.x2 + t ** 3 * curve.x,
    y: u ** 3 * start.y + 3 * u * u * t * curve.y1 + 3 * u * t * t * curve.y2 + t ** 3 * curve.y,
  };
};

const length = (curve: WarpCubic, start: { x: number; y: number }, endT = 1) => {
  let total = 0, previous = start;
  for (let i = 1; i <= 16; i++) {
    const current = point(start, curve, endT * i / 16);
    total += Math.hypot(current.x - previous.x, current.y - previous.y);
    previous = current;
  }
  return total;
};

function split(curve: WarpCubic, start: { x: number; y: number }, t: number): [WarpCubic, WarpCubic] {
  const mix = (a: number, b: number) => a + (b - a) * t;
  const a = { x: mix(start.x, curve.x1), y: mix(start.y, curve.y1) };
  const b = { x: mix(curve.x1, curve.x2), y: mix(curve.y1, curve.y2) };
  const c = { x: mix(curve.x2, curve.x), y: mix(curve.y2, curve.y) };
  const d = { x: mix(a.x, b.x), y: mix(a.y, b.y) };
  const e = { x: mix(b.x, c.x), y: mix(b.y, c.y) };
  const p = { x: mix(d.x, e.x), y: mix(d.y, e.y) };
  return [
    { cmd: 'C', x1: a.x, y1: a.y, x2: d.x, y2: d.y, x: p.x, y: p.y },
    { cmd: 'C', x1: e.x, y1: e.y, x2: c.x, y2: c.y, x: curve.x, y: curve.y },
  ];
}

function splitLongest(subpath: WarpSubpath): void {
  let start = subpath.start, bestStart = start, best = 0, bestLength = -1;
  for (let i = 0; i < subpath.curves.length; i++) {
    const curveLength = length(subpath.curves[i], start);
    if (curveLength > bestLength) { best = i; bestLength = curveLength; bestStart = start; }
    start = { x: subpath.curves[i].x, y: subpath.curves[i].y };
  }
  const half = bestLength / 2;
  let low = 0, high = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (low + high) / 2;
    if (length(subpath.curves[best], bestStart, mid) < half) low = mid; else high = mid;
  }
  subpath.curves.splice(best, 1, ...split(subpath.curves[best], bestStart, (low + high) / 2));
}

export function rotateClosed(subpath: WarpSubpath, seam: number): void {
  if (!subpath.closed || !subpath.curves.length) return;
  const amount = ((seam % subpath.curves.length) + subpath.curves.length) % subpath.curves.length;
  if (!amount) return;
  const previous = subpath.curves[(amount - 1 + subpath.curves.length) % subpath.curves.length];
  subpath.start = { x: previous.x, y: previous.y };
  subpath.curves = [...subpath.curves.slice(amount), ...subpath.curves.slice(0, amount)];
}

export function reverseSubpath(subpath: WarpSubpath): void {
  const points = [subpath.start, ...subpath.curves.map((curve) => ({ x: curve.x, y: curve.y }))];
  subpath.start = points[points.length - 1];
  subpath.curves = subpath.curves.map((curve, index) => ({ curve, start: points[index] })).reverse().map(({ curve, start }) => ({
    cmd: 'C', x1: curve.x2, y1: curve.y2, x2: curve.x1, y2: curve.y1, x: start.x, y: start.y,
  }));
}

function samples(subpath: WarpSubpath, count: number) {
  const flat = [{ ...subpath.start }];
  let start = subpath.start;
  for (const curve of subpath.curves) {
    for (let i = 1; i <= 16; i++) flat.push(point(start, curve, i / 16));
    start = { x: curve.x, y: curve.y };
  }
  const sums = [0];
  for (let i = 1; i < flat.length; i++) sums.push(sums[i - 1] + Math.hypot(flat[i].x - flat[i - 1].x, flat[i].y - flat[i - 1].y));
  const total = sums[sums.length - 1] || 1;
  return Array.from({ length: count }, (_, index) => {
    const distance = total * index / (subpath.closed ? count : Math.max(1, count - 1));
    let hi = 1; while (hi < sums.length && sums[hi] < distance) hi++;
    hi = Math.min(hi, sums.length - 1);
    const lo = Math.max(0, hi - 1), t = (distance - sums[lo]) / (sums[hi] - sums[lo] || 1);
    return { x: flat[lo].x + (flat[hi].x - flat[lo].x) * t, y: flat[lo].y + (flat[hi].y - flat[lo].y) * t };
  });
}

function area(subpath: WarpSubpath): number {
  const contour = samples(subpath, Math.max(32, subpath.curves.length * 8));
  return contour.reduce((sum, a, i) => { const b = contour[(i + 1) % contour.length]; return sum + a.x * b.y - b.x * a.y; }, 0) / 2;
}

function cost(source: WarpSubpath, target: WarpSubpath, reverse: boolean, seam: number): number {
  const candidate = structuredClone(target);
  if (reverse) reverseSubpath(candidate); rotateClosed(candidate, seam);
  const count = 64, a = samples(source, count), b = samples(candidate, count);
  const xs = a.concat(b).map((p) => p.x), ys = a.concat(b).map((p) => p.y);
  const scale2 = Math.max(1, Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) ** 2);
  let total = 0;
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count, previous = (i - 1 + count) % count;
    const dx = a[i].x - b[i].x, dy = a[i].y - b[i].y;
    total += (dx * dx + dy * dy) / scale2;
    const av = { x: a[next].x - a[i].x, y: a[next].y - a[i].y }, bv = { x: b[next].x - b[i].x, y: b[next].y - b[i].y };
    const al = Math.hypot(av.x, av.y) || 1, bl = Math.hypot(bv.x, bv.y) || 1;
    total += .12 * (1 - (av.x * bv.x + av.y * bv.y) / (al * bl));
    const ac = Math.abs((a[i].x - a[previous].x) * av.y - (a[i].y - a[previous].y) * av.x) / (al * (Math.hypot(a[i].x - a[previous].x, a[i].y - a[previous].y) || 1));
    const bc = Math.abs((b[i].x - b[previous].x) * bv.y - (b[i].y - b[previous].y) * bv.x) / (bl * (Math.hypot(b[i].x - b[previous].x, b[i].y - b[previous].y) || 1));
    total += .04 * Math.abs(ac - bc);
  }
  return total / count;
}

export function resolveSubpathAlignment(source: WarpSubpath, target: WarpSubpath, reverse?: boolean, seam?: number): WarpAlignment {
  if (!source.closed) {
    const direct = cost(source, target, false, 0), flipped = cost(source, target, true, 0), explicit = reverse !== undefined;
    const gap = Math.abs(direct - flipped) / Math.max(1e-6, Math.max(direct, flipped));
    return { reverse: explicit ? reverse : flipped < direct * .75, seam: 0, confidence: explicit ? 1 : gap, ambiguous: !explicit && gap < .08, reason: explicit ? 'Manual open-path direction.' : 'Matched open-path endpoints spatially.' };
  }
  const windingReverse = area(source) * area(target) < 0;
  const candidates = Array.from({ length: target.curves.length }, (_, candidateSeam) => ({ reverse: windingReverse, seam: candidateSeam, cost: cost(source, target, windingReverse, candidateSeam) }))
    .sort((a, b) => a.cost - b.cost || a.seam - b.seam);
  const best = candidates[0] ?? { reverse: false, seam: 0, cost: 0 }, second = candidates[1];
  const gap = second ? (second.cost - best.cost) / Math.max(1e-6, second.cost) : 1;
  const ambiguous = reverse === undefined && seam === undefined && !!second && gap < .035;
  return { reverse: reverse ?? (ambiguous ? windingReverse : best.reverse), seam: seam ?? (ambiguous ? 0 : best.seam), confidence: reverse !== undefined || seam !== undefined ? 1 : Math.max(0, Math.min(1, gap / .2)), ambiguous, reason: ambiguous ? 'Several spatial seams are nearly equivalent; review the alternatives.' : reverse !== undefined || seam !== undefined ? 'Manual seam/direction.' : 'Matched by winding, position, tangent, and curvature.' };
}

export function alignAndEqualize(source: WarpSubpath, target: WarpSubpath, reverse?: boolean, seam?: number): WarpAlignment {
  const alignment = resolveSubpathAlignment(source, target, reverse, seam);
  if (alignment.reverse) reverseSubpath(target); rotateClosed(target, alignment.seam);
  const count = Math.max(source.curves.length, target.curves.length);
  while (source.curves.length < count) splitLongest(source);
  while (target.curves.length < count) splitLongest(target);
  return alignment;
}

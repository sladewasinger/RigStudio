/**
 * RigDoc → Lottie JSON exporter (one clip per animation, v5.7.0, 60 fps).
 *
 * The mapping mirrors the canvas renderer exactly: a null layer carries the root
 * figure channels (translate + scale around rootPivot) and every part becomes a shape
 * layer — anchor at the pivot, position = pivot + rest offset + tx/ty keyframes,
 * rotation = rest.rotate + rotate keyframes. Lottie layer parenting composes the same
 * way as the studio's bone hierarchy, so parented parts just reference their parent's
 * layer. Baked SVG transforms (part group + per-path) are static, so they are
 * flattened into the geometry, with arcs rewritten as cubics. Easings stored on the
 * ARRIVING keyframe become the cubic-bezier handles of the segment leaving the
 * previous key. Lottie shares SVG's conventions (+y down, clockwise rotation), so no
 * axis flipping is needed; the reference frame's origin (the artboard rect when the
 * doc has one enabled, else the viewBox) is baked into geometry and pivots.
 *
 * A keyed `z` (draw-order) channel is SILENTLY IGNORED here: Lottie layer order is fixed
 * for a composition (there is no animatable stacking property), so animated draw order
 * cannot be represented. Only the authored/rest stacking survives, via the doc.parts layer
 * order below. `trackOf` never looks up 'z', so z tracks simply don't participate.
 *
 * A keyed `opacity` channel and a non-1 `RestPose.opacity` are ALSO silently ignored this
 * wave — every layer's `ks.o` stays the static `{a:0, k:100}` it always was. Real opacity
 * export (rest AND keyed) is the next wave's work; exporting only the rest value while
 * dropping keys would silently strand mid-fade poses, a worse partial result than doing
 * neither yet.
 *
 * The Layers-panel eye (`RigPart.hidden`, editor-only, unrelated to the `opacity` channel
 * above) IS handled here: a hidden part's `shapes` array is emitted empty, so it paints
 * nothing. Its layer object, parenting, and transform tracks are otherwise untouched —
 * children may still ride a hidden part's pose (exactly like a bone/group today), so
 * removing the layer itself and remapping every descendant's `parent` index is left for a
 * future wave. `isEffectivelyHidden` cascades the flag down the parent chain per part.
 */

import {
  artboardFrame, Channel, Easing, isEffectivelyHidden, Keyframe, RigDoc, RigPart, RigPath, Track,
} from '../core/model';
import { parsePath, pathToCubics } from '../geometry/paths';
import { Mat, applyMat, invertMat, matrixOfTransform, multiply } from '../geometry/transforms';

const FR = 60;

type JsonObj = Record<string, unknown>;

/** Studio easings → cubic-bezier segment handles (o leaves the key, i arrives at the next). */
const EASING_BEZIER: Record<Easing, { o: [number, number]; i: [number, number] }> = {
  linear: { o: [0.333, 0.333], i: [0.667, 0.667] },
  easeIn: { o: [0.42, 0], i: [1, 1] },
  easeOut: { o: [0, 0], i: [0.58, 1] },
  easeInOut: { o: [0.42, 0], i: [0.58, 1] },
};

const rnd = (n: number): number => Number(n.toFixed(3));
const toFrames = (ms: number): number => rnd((ms * FR) / 1000);
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

export function exportLottie(doc: RigDoc, clipIndex: number): string {
  const clip = doc.clips[clipIndex];
  if (!clip) {
    throw new Error(
      `Clip ${clipIndex} does not exist (document has ${doc.clips.length} clip(s)).`,
    );
  }

  // Reference frame for the whole export: the artboard rect when the doc has one
  // enabled, else the viewBox (today's behavior, byte-identical when disabled/absent).
  const frame = artboardFrame(doc);
  const ox = frame.x;
  const oy = frame.y;
  const op = Math.max(1, Math.round((clip.duration / 1000) * FR));
  const trackOf = (target: string, channel: Channel): Track | undefined =>
    clip.tracks.find((t) => t.target === target && t.channel === channel);

  const NULL_IND = 1;
  const indOf = new Map<string, number>(doc.parts.map((p, idx) => [p.id, idx + 2]));

  // Root null: whole-figure translate + scale around rootPivot (never rotates).
  const rpx = doc.rootPivot.x - ox;
  const rpy = doc.rootPivot.y - oy;
  const nullLayer: JsonObj = {
    ddd: 0, ind: NULL_IND, ty: 3, nm: `${doc.name} root`, sr: 1,
    ks: {
      o: { a: 0, k: 100 },
      r: { a: 0, k: 0 },
      p: positionProp(rpx, rpx, rpy, rpy, trackOf('root', 'tx'), trackOf('root', 'ty')),
      a: { a: 0, k: [rnd(rpx), rnd(rpy), 0] },
      s: scaleProp(trackOf('root', 'sx'), trackOf('root', 'sy')),
    },
    ao: 0, ip: 0, op, st: 0, bm: 0,
  };

  const partLayers: JsonObj[] = doc.parts.map((part, idx) => {
    const px = part.pivot.x - ox;
    const py = part.pivot.y - oy;
    const parent = part.parentId && indOf.has(part.parentId)
      ? indOf.get(part.parentId)!
      : NULL_IND;
    // Lottie draws the first shape item on top, SVG paints the last one on top. A
    // Layers-eye-hidden part (or one riding a hidden ancestor) emits NO shapes — see the
    // module doc comment for why the layer itself stays (parenting/transform intact).
    const shapes = isEffectivelyHidden(part) ? [] : [...part.paths].reverse().flatMap((p) => {
      const group = shapeGroup(part, p, ox, oy);
      return group ? [group] : [];
    });
    const ks = {
      o: { a: 0, k: 100 }, // opacity CHANNEL export deferred — see the module doc comment
      // Keyed values are ABSOLUTE; the rest pose only fills unkeyed channels.
      r: scalarProp(0, part.rest.rotate, trackOf(part.id, 'rotate')),
      p: positionProp(
        px, px + part.rest.tx,
        py, py + part.rest.ty,
        trackOf(part.id, 'tx'), trackOf(part.id, 'ty'),
      ),
      a: { a: 0, k: [rnd(px), rnd(py), 0] },
      // Rest scale is baked into the geometry (see shapeGroup) so it scales along
      // the artwork's own axes, not the layer axes.
      s: { a: 0, k: [100, 100, 100] },
    };
    // Bones/groups are partless: emit them as native Lottie null layers.
    if (part.paths.length === 0) {
      return { ddd: 0, ind: idx + 2, ty: 3, nm: part.label, sr: 1, parent, ks, ao: 0, ip: 0, op, st: 0, bm: 0 };
    }
    return {
      ddd: 0, ind: idx + 2, ty: 4, nm: part.label, sr: 1, parent,
      ks, ao: 0, shapes, ip: 0, op, st: 0, bm: 0,
    };
  });

  // Lottie draws the first layer on top; doc.parts is bottom-to-top draw order.
  const layers: JsonObj[] = [...partLayers].reverse();
  layers.push(nullLayer);

  const animation: JsonObj = {
    v: '5.7.0',
    fr: FR,
    ip: 0,
    op,
    w: Math.round(frame.w),
    h: Math.round(frame.h),
    nm: `${doc.name} - ${clip.name}`,
    ddd: 0,
    assets: [],
    layers,
  };
  return JSON.stringify(animation);
}

// ---- Animated properties ----

/** Sorted copy of a track's keyframes (empty when the track is missing). */
function keysOf(track: Track | undefined): Keyframe[] {
  return [...(track?.keyframes ?? [])].sort((a, b) => a.time - b.time);
}

/**
 * A 1-D Lottie property. Keyed values are ABSOLUTE channel values offset by animBase
 * (the pivot coordinate for positions, 0 for rotation); a channel with no keyframes
 * emits staticValue (the rest pose). Static ({a:0}) for zero or one keyframes,
 * animated ({a:1}) otherwise, with each segment's bezier taken from the ARRIVING
 * key's easing (the studio stores easing on arrival; Lottie stores the handles on the
 * key the segment leaves).
 */
function scalarProp(animBase: number, staticValue: number, track: Track | undefined): JsonObj {
  const keys = keysOf(track);
  if (keys.length === 0) return { a: 0, k: rnd(staticValue) };
  if (keys.length === 1) return { a: 0, k: rnd(animBase + keys[0].value) };
  const k = keys.map((key, idx) => {
    const kf: JsonObj = { t: toFrames(key.time), s: [rnd(animBase + key.value)] };
    if (idx < keys.length - 1) {
      const next = keys[idx + 1];
      if (next.bezier) {
        // Custom curve-editor bezier on the arriving key: use its handles directly.
        kf.o = { x: [next.bezier[0]], y: [next.bezier[1]] };
        kf.i = { x: [next.bezier[2]], y: [next.bezier[3]] };
      } else {
        const bez = EASING_BEZIER[next.easing];
        kf.o = { x: [bez.o[0]], y: [bez.o[1]] };
        kf.i = { x: [bez.i[0]], y: [bez.i[1]] };
      }
    }
    return kf;
  });
  return { a: 1, k };
}

/**
 * Layer position. When either axis animates, use split dimensions (s:true with
 * independent x/y scalar properties) so the tx and ty keyframe timelines stay
 * independent instead of being merged onto a shared clock.
 */
function positionProp(
  animBaseX: number, staticX: number,
  animBaseY: number, staticY: number,
  txTrack: Track | undefined, tyTrack: Track | undefined,
): JsonObj {
  const txKeys = keysOf(txTrack);
  const tyKeys = keysOf(tyTrack);
  if (txKeys.length <= 1 && tyKeys.length <= 1) {
    const kx = txKeys.length === 1 ? animBaseX + txKeys[0].value : staticX;
    const ky = tyKeys.length === 1 ? animBaseY + tyKeys[0].value : staticY;
    return { a: 0, k: [rnd(kx), rnd(ky), 0] };
  }
  return {
    s: true,
    x: scalarProp(animBaseX, staticX, txTrack),
    y: scalarProp(animBaseY, staticY, tyTrack),
  };
}

/** Replica of model.ts ease() so merged scale keyframes sample exactly. */
function ease(t: number, easing: Easing): number {
  switch (easing) {
    case 'easeIn': return t * t;
    case 'easeOut': return 1 - (1 - t) * (1 - t);
    case 'easeInOut': return t * t * (3 - 2 * t); // smoothstep
    default: return t;
  }
}

/** Sample a keyframe list at a time with the model's interpolation semantics. */
function sampleKeys(keys: Keyframe[], time: number, fallback: number): number {
  if (keys.length === 0) return fallback;
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;
  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i];
    const k1 = keys[i + 1];
    if (time >= k0.time && time <= k1.time) {
      const span = k1.time - k0.time;
      const t = span === 0 ? 1 : (time - k0.time) / span;
      return k0.value + (k1.value - k0.value) * ease(t, k1.easing);
    }
  }
  return fallback;
}

/**
 * Bezier handles for one dimension of a merged segment [t0, t1]: exact when the
 * channel has consecutive keyframes at both times, linear otherwise (the segment is
 * a resampled slice of a longer one, or the channel is constant across it).
 */
function dimBezier(
  keys: Keyframe[], t0: number, t1: number,
): { o: [number, number]; i: [number, number] } {
  for (let i = 1; i < keys.length; i++) {
    if (keys[i - 1].time === t0 && keys[i].time === t1) {
      const b = keys[i].bezier;
      if (b) return { o: [b[0], b[1]], i: [b[2], b[3]] };
      return EASING_BEZIER[keys[i].easing];
    }
  }
  return EASING_BEZIER.linear;
}

/**
 * Root scale as one multi-dimensional property (×100). Lottie cannot split scale the
 * way it splits position, so the sx/sy timelines are merged on the union of their key
 * times, sampling each channel exactly and carrying per-dimension bezier handles.
 */
function scaleProp(sxTrack: Track | undefined, syTrack: Track | undefined): JsonObj {
  const sxKeys = keysOf(sxTrack);
  const syKeys = keysOf(syTrack);
  const times = [...new Set([...sxKeys, ...syKeys].map((k) => k.time))].sort((a, b) => a - b);
  const at = (t: number): [number, number] => [
    sampleKeys(sxKeys, t, 1) * 100,
    sampleKeys(syKeys, t, 1) * 100,
  ];
  if (times.length <= 1) {
    const [vx, vy] = at(times[0] ?? 0);
    return { a: 0, k: [rnd(vx), rnd(vy), 100] };
  }
  const k = times.map((t, idx) => {
    const [vx, vy] = at(t);
    const kf: JsonObj = { t: toFrames(t), s: [rnd(vx), rnd(vy), 100] };
    if (idx < times.length - 1) {
      const bx = dimBezier(sxKeys, t, times[idx + 1]);
      const by = dimBezier(syKeys, t, times[idx + 1]);
      kf.o = { x: [bx.o[0], by.o[0], 0.333], y: [bx.o[1], by.o[1], 0.333] };
      kf.i = { x: [bx.i[0], by.i[0], 0.667], y: [bx.i[1], by.i[1], 0.667] };
    }
    return kf;
  });
  return { a: 1, k };
}

// ---- Geometry ----

interface SubPath {
  v: number[][];
  i: number[][];
  o: number[][];
  c: boolean;
}

/**
 * Parse path data, rewrite arcs as cubics, flatten the baked matrix into every point,
 * and emit one Lottie bezier per subpath. Tangents (i/o) are stored relative to their
 * vertex, so the viewBox offset cancels out of them.
 */
function pathToBeziers(d: string, m: Mat, ox: number, oy: number): SubPath[] {
  const cmds = pathToCubics(parsePath(d));
  const subs: SubPath[] = [];
  let cur: SubPath | null = null;
  let curX = 0, curY = 0;     // current point in untransformed doc coords
  let startX = 0, startY = 0; // subpath start

  const point = (x: number, y: number): number[] => {
    const p = applyMat(m, x, y);
    return [rnd(p.x - ox), rnd(p.y - oy)];
  };
  const tangent = (cx: number, cy: number, vx: number, vy: number): number[] => {
    const c = applyMat(m, cx, cy);
    const v = applyMat(m, vx, vy);
    return [rnd(c.x - v.x), rnd(c.y - v.y)];
  };
  const makeSub = (x: number, y: number): SubPath =>
    ({ v: [point(x, y)], i: [[0, 0]], o: [[0, 0]], c: false });
  const flush = (s: SubPath | null): null => {
    if (s && s.v.length >= 2) subs.push(s);
    return null;
  };

  for (const c of cmds) {
    switch (c.cmd) {
      case 'M':
        cur = flush(cur);
        cur = makeSub(c.x, c.y);
        curX = c.x; curY = c.y; startX = c.x; startY = c.y;
        break;
      case 'L': {
        const s = cur ?? (cur = makeSub(curX, curY));
        s.v.push(point(c.x, c.y)); s.i.push([0, 0]); s.o.push([0, 0]);
        curX = c.x; curY = c.y;
        break;
      }
      case 'C': {
        const s = cur ?? (cur = makeSub(curX, curY));
        s.o[s.o.length - 1] = tangent(c.x1, c.y1, curX, curY);
        s.v.push(point(c.x, c.y)); s.i.push(tangent(c.x2, c.y2, c.x, c.y)); s.o.push([0, 0]);
        curX = c.x; curY = c.y;
        break;
      }
      case 'Z': {
        if (cur) {
          cur.c = true;
          // An explicit final segment back to the start duplicates the first vertex:
          // fold its incoming tangent into vertex 0 and drop the duplicate — Lottie's
          // implicit closing segment runs last.o → first.i.
          const n = cur.v.length;
          if (
            n > 1 &&
            Math.hypot(cur.v[n - 1][0] - cur.v[0][0], cur.v[n - 1][1] - cur.v[0][1]) < 1e-3
          ) {
            cur.i[0] = cur.i[n - 1];
            cur.v.pop(); cur.i.pop(); cur.o.pop();
          }
          cur = flush(cur);
        }
        curX = startX; curY = startY;
        break;
      }
      case 'A':
        break; // unreachable: pathToCubics rewrote all arcs
    }
  }
  flush(cur);
  return subs;
}

// ---- Shape layers ----

/**
 * One Lottie group per RigPath: subpath beziers, then fill and/or stroke, then the
 * mandatory default group transform. The baked part + path transforms are applied to
 * the geometry itself since they never animate.
 */
function shapeGroup(part: RigPart, path: RigPath, ox: number, oy: number): JsonObj | null {
  const baked = matrixOfTransform(part.transform);
  let m = baked;
  // Rest scale/skew: innermost (after baked), around the pivot mapped into pre-baked
  // local space — the artwork reshapes along its own axes and the joint stays fixed.
  // Baked into geometry because Lottie layer scale/skew would act along layer axes.
  const sx = part.rest?.sx ?? 1;
  const sy = part.rest?.sy ?? 1;
  const kx = part.rest?.kx ?? 0;
  const ky = part.rest?.ky ?? 0;
  if (sx !== 1 || sy !== 1 || kx !== 0 || ky !== 0) {
    const pl = applyMat(invertMat(baked), part.pivot.x, part.pivot.y);
    const local = matrixOfTransform(
      `translate(${pl.x},${pl.y}) scale(${sx},${sy}) ` +
      `skewX(${kx}) skewY(${ky}) translate(${-pl.x},${-pl.y})`,
    );
    m = multiply(baked, local);
  }
  m = multiply(m, matrixOfTransform(path.transform));
  const beziers = pathToBeziers(path.d, m, ox, oy);
  if (beziers.length === 0) return null;

  const items: JsonObj[] = beziers.map((b, idx) => ({
    ind: idx,
    ty: 'sh',
    ks: { a: 0, k: { i: b.i, o: b.o, v: b.v, c: b.c } },
    nm: `${path.label} ${idx + 1}`,
  }));
  if (path.fill) {
    items.push({
      ty: 'fl',
      c: { a: 0, k: hexColor(path.fill) },
      o: { a: 0, k: rnd(clamp01(path.fillOpacity) * 100) },
      r: 1, // nonzero winding, the SVG default
      nm: 'fill',
    });
  }
  if (path.stroke) {
    // Uniform-scale approximation of the baked matrix for the stroke width.
    const widthScale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    items.push({
      ty: 'st',
      c: { a: 0, k: hexColor(path.stroke) },
      o: { a: 0, k: rnd(clamp01(path.strokeOpacity) * 100) },
      w: { a: 0, k: rnd(path.strokeWidth * widthScale) },
      lc: 2, lj: 2, // round cap/join
      nm: 'stroke',
    });
  }
  items.push({
    ty: 'tr',
    p: { a: 0, k: [0, 0] },
    a: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] },
    r: { a: 0, k: 0 },
    o: { a: 0, k: 100 },
    nm: 'transform',
  });
  return { ty: 'gr', it: items, nm: path.label };
}

/** #rgb / #rrggbb → [r, g, b] in 0..1 (anything unparseable falls back to black). */
function hexColor(value: string): number[] {
  let hex = value.trim().replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return [0, 0, 0];
  return [
    rnd(parseInt(hex.slice(0, 2), 16) / 255),
    rnd(parseInt(hex.slice(2, 4), 16) / 255),
    rnd(parseInt(hex.slice(4, 6), 16) / 255),
  ];
}

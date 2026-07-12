/**
 * Linear-blend skinning render path.
 *
 * A skinned part deforms per frame from its REST path data (never mutating `path.d` —
 * only the DOM `d` attribute). This module owns the runtime cache of parsed rest
 * geometry + per-point weights; it is invalidated when the rest data changes (node
 * edits) or the binding changes, via `invalidateSkinCache`.
 */

import { state, RigPart } from '../core/model';
import { parsePath, serializePath, pathToCubics, PathCmd } from '../geometry/paths';
import { skinWeights, overrideWeightRow, Seg } from '../geometry/skin';
import { Mat, matrixOfTransform, multiply } from '../geometry/transforms';
import { fullPoseTransform, effectivePivot, effectiveTip } from './pose';

/**
 * Auto-weight falloff exponent for the render path (see skinWeights). A long thin limb
 * with a 3-bone chain bends mushily at inverse-square (2) — the joint folds don't
 * localize; 4 concentrates each point on its nearest bone so an elbow actually creases,
 * while distant bones still contribute enough to avoid tearing.
 */
const SKIN_WEIGHT_POWER = 4;

// Runtime cache: parsed rest geometry + per-point weights, invalidated when the
// rest path data changes (node edits) or the binding changes.
const skinCache = new Map<string, {
  sig: string;
  paths: { id: string; cmds: PathCmd[]; pts: { x: number; y: number }[][]; weights: number[][] }[];
}>();

/** Drop a part's cached rest geometry/weights (bind, unbind, structural node edits). */
export function invalidateSkinCache(partId: string): void {
  skinCache.delete(partId);
}

function skinDataFor(part: RigPart): NonNullable<ReturnType<typeof skinCache.get>> {
  const overrides = part.skin?.overrides ?? {};
  const sig =
    part.paths.map((p) => `${p.id}:${p.d.length}`).join('|') +
    '#' + (part.skin?.bones.map((b) => b.id).join(',') ?? '') +
    '#' + JSON.stringify(overrides);
  const hit = skinCache.get(part.id);
  if (hit && hit.sig === sig) return hit;

  const boneIds = (part.skin?.bones ?? []).map((b) => b.id);
  const segs: Seg[] = (part.skin?.bones ?? []).map((b) => b.bindSeg);
  const paths = part.paths.map((p) => {
    const cmds = pathToCubics(parsePath(p.d));
    // Every coordinate pair in order — endpoints and control points alike.
    const pts: { x: number; y: number }[][] = cmds.map((c) => {
      if (c.cmd === 'C') {
        return [{ x: c.x1, y: c.y1 }, { x: c.x2, y: c.y2 }, { x: c.x, y: c.y }];
      }
      if (c.cmd === 'Z') return [];
      return [{ x: (c as { x: number }).x, y: (c as { y: number }).y }];
    });
    const flat = pts.flat();
    const auto = skinWeights(flat, segs, SKIN_WEIGHT_POWER);

    // Which node's override governs each flattened point (parallel to `flat`). A C
    // command's outgoing handle (x1) belongs to the PREVIOUS node it leaves; its
    // incoming handle (x2) and endpoint belong to this node — so overriding node i
    // makes its whole corner (endpoint + both handles) ride the pinned bone rigidly.
    const nodeKeyFlat: number[] = [];
    cmds.forEach((c, i) => {
      if (c.cmd === 'C') nodeKeyFlat.push(Math.max(0, i - 1), i, i);
      else if (c.cmd !== 'Z') nodeKeyFlat.push(i);
    });

    const pathOverrides = overrides[p.id] ?? {};
    const hasOverrides = Object.keys(pathOverrides).length > 0;
    const weights = hasOverrides
      ? auto.map((row, k) => {
        const ov = pathOverrides[String(nodeKeyFlat[k])];
        return (ov && overrideWeightRow(boneIds, ov)) || row;
      })
      : auto;
    return { id: p.id, cmds, pts, weights };
  });
  const entry = { sig, paths };
  skinCache.set(part.id, entry);
  return entry;
}

/** A bone's per-frame contribution: the rigid delta from its bind pose plus a stretch of
 *  the along-axis component (so a lengthened bone stretches the limb, a shortened one
 *  compresses it) applied in the BIND frame before the delta rotates it onto the current
 *  axis. `s === 1` (unchanged length) reduces to the plain rigid delta. */
interface BoneXform {
  m: Mat;
  bx: number; by: number; // bind-segment origin (root)
  ax: number; ay: number; // bind-segment unit axis (zero when degenerate)
  s: number; // stretch factor curLen / bindLen (clamped)
}

const STRETCH_MIN = 0.2;
const STRETCH_MAX = 5;

/** Per-frame linear-blend deformation: rewrite each path's d attribute. */
export function renderSkinnedPart(part: RigPart, g: SVGGElement, t: number | null): void {
  const skin = part.skin;
  if (!skin) return;
  const data = skinDataFor(part);

  // Each bone's rigid delta from its bind pose (identity at rest → rest geometry) plus a
  // length-stretch factor: dragging a bone tip rotates AND stretches the limb.
  const xf: BoneXform[] = skin.bones.map((b) => {
    const bone = state.doc?.parts.find((p) => p.id === b.id);
    const m = bone
      ? multiply(matrixOfTransform(fullPoseTransform(bone, t)), b.restWorldInv)
      : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const bindLen = Math.hypot(b.bindSeg.q.x - b.bindSeg.p.x, b.bindSeg.q.y - b.bindSeg.p.y);
    let ax = 0, ay = 0, s = 1;
    if (bone && bindLen > 1e-3) {
      ax = (b.bindSeg.q.x - b.bindSeg.p.x) / bindLen;
      ay = (b.bindSeg.q.y - b.bindSeg.p.y) / bindLen;
      const pv = effectivePivot(bone, t);
      const tp = effectiveTip(bone, t);
      const curLen = tp ? Math.hypot(tp.x - pv.x, tp.y - pv.y) : bindLen;
      s = Math.min(STRETCH_MAX, Math.max(STRETCH_MIN, curLen / bindLen));
    }
    return { m, bx: b.bindSeg.p.x, by: b.bindSeg.p.y, ax, ay, s };
  });

  for (const pd of data.paths) {
    let k = 0;
    const out: PathCmd[] = pd.cmds.map((c, i) => {
      const mapped = pd.pts[i].map((pt) => {
        const w = pd.weights[k++];
        let x = 0, y = 0;
        for (let bi = 0; bi < xf.length; bi++) {
          const { m, s } = xf[bi];
          let sx = pt.x, sy = pt.y;
          if (s !== 1) {
            // Scale the along-bone-axis component (bind frame) by s before the rigid delta.
            const along = (pt.x - xf[bi].bx) * xf[bi].ax + (pt.y - xf[bi].by) * xf[bi].ay;
            sx += (s - 1) * along * xf[bi].ax;
            sy += (s - 1) * along * xf[bi].ay;
          }
          x += w[bi] * (m.a * sx + m.c * sy + m.e);
          y += w[bi] * (m.b * sx + m.d * sy + m.f);
        }
        return { x, y };
      });
      if (c.cmd === 'C') {
        return {
          cmd: 'C' as const,
          x1: mapped[0].x, y1: mapped[0].y,
          x2: mapped[1].x, y2: mapped[1].y,
          x: mapped[2].x, y: mapped[2].y,
        };
      }
      if (c.cmd === 'Z') return c;
      return { ...c, x: mapped[0].x, y: mapped[0].y } as PathCmd;
    });
    const el = g.querySelector(`[data-path-id="${pd.id}"]`);
    el?.setAttribute('d', serializePath(out));
  }
}

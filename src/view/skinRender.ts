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
import { fullPoseTransform } from './pose';

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

/** Per-frame linear-blend deformation: rewrite each path's d attribute. */
export function renderSkinnedPart(part: RigPart, g: SVGGElement, t: number | null): void {
  const skin = part.skin;
  if (!skin) return;
  const data = skinDataFor(part);

  // Each bone's delta from its bind pose (identity at rest → rest geometry).
  const deltas: Mat[] = skin.bones.map((b) => {
    const bone = state.doc?.parts.find((p) => p.id === b.id);
    if (!bone) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    return multiply(matrixOfTransform(fullPoseTransform(bone, t)), b.restWorldInv);
  });

  for (const pd of data.paths) {
    let k = 0;
    const out: PathCmd[] = pd.cmds.map((c, i) => {
      const mapped = pd.pts[i].map((pt) => {
        const w = pd.weights[k++];
        let x = 0, y = 0;
        for (let bi = 0; bi < deltas.length; bi++) {
          const m = deltas[bi];
          x += w[bi] * (m.a * pt.x + m.c * pt.y + m.e);
          y += w[bi] * (m.b * pt.x + m.d * pt.y + m.f);
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

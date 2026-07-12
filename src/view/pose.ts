/**
 * Pose evaluation: the transform strings and matrices that place each part in the scene.
 *
 * A part's rendered transform is its ancestors' poses (outermost first) followed by its
 * own pose, then the baked SVG transform, then the innermost rest scale/skew. Keyed
 * channels are ABSOLUTE; the rest pose only fills unkeyed channels (model.channelValue).
 * `ctx.poseSampler`, when set by the state-machine editor, overrides normal sampling.
 */

import { state, RigPart, sampleChannel, channelValue, ancestorChain } from '../core/model';
import { Mat, applyMat, invertMat, matrixOfTransform } from '../geometry/transforms';
import { ctx } from './context';

/** The time to sample animation at, or null when Setup mode shows the bare rest pose. */
export function poseTime(): number | null {
  return state.editorMode === 'animate' ? state.currentTime : null;
}

export function rootPoseTransform(t: number | null): string {
  const doc = state.doc!;
  const rtx = ctx.poseSampler ? ctx.poseSampler('root', 'tx') : t === null ? 0 : sampleChannel('root', 'tx', t);
  const rty = ctx.poseSampler ? ctx.poseSampler('root', 'ty') : t === null ? 0 : sampleChannel('root', 'ty', t);
  const rsx = ctx.poseSampler ? ctx.poseSampler('root', 'sx') : t === null ? 1 : sampleChannel('root', 'sx', t);
  const rsy = ctx.poseSampler ? ctx.poseSampler('root', 'sy') : t === null ? 1 : sampleChannel('root', 'sy', t);
  const rp = doc.rootPivot;
  return (
    `translate(${rtx},${rty}) translate(${rp.x},${rp.y}) ` +
    `scale(${rsx},${rsy}) translate(${-rp.x},${-rp.y})`
  );
}

/** A part's own pose transform: keyed channels are absolute, rest fills the gaps. */
export function ownPoseTransform(part: RigPart, t: number | null): string {
  const rot = ctx.poseSampler ? ctx.poseSampler(part.id, 'rotate') : channelValue(part, 'rotate', t);
  const tx = ctx.poseSampler ? ctx.poseSampler(part.id, 'tx') : channelValue(part, 'tx', t);
  const ty = ctx.poseSampler ? ctx.poseSampler(part.id, 'ty') : channelValue(part, 'ty', t);
  return `translate(${tx},${ty}) rotate(${rot},${part.pivot.x},${part.pivot.y})`;
}

/** The pivot mapped into the part's pre-baked local space (where rest scale applies). */
export function localPivotOf(part: RigPart, pivot = part.pivot): { x: number; y: number } {
  return applyMat(invertMat(matrixOfTransform(part.transform)), pivot.x, pivot.y);
}

/**
 * Rest scale AND skew, applied innermost (after the baked transform) around the local
 * pivot: the artwork reshapes along its own axes and the joint stays exactly in place.
 * `pivot` overrides the stored pivot (pivot drags evaluate candidate positions).
 */
export function innerLocalTransform(part: RigPart, pivot = part.pivot): string {
  const { sx, sy, kx, ky } = part.rest;
  if (sx === 1 && sy === 1 && kx === 0 && ky === 0) return '';
  const pl = localPivotOf(part, pivot);
  const ops = [`translate(${pl.x},${pl.y})`];
  if (sx !== 1 || sy !== 1) ops.push(`scale(${sx},${sy})`);
  if (kx !== 0) ops.push(`skewX(${kx})`);
  if (ky !== 0) ops.push(`skewY(${ky})`);
  ops.push(`translate(${-pl.x},${-pl.y})`);
  return ops.join(' ');
}

/**
 * A part's effective draw-order OFFSET right now (keyed `z` is ABSOLUTE + stepped, rest
 * fallback 0). This governs paint-order SORTING only (render.ts's applyDrawOrder) — it
 * never enters the rendered transform. Mirrors the pose.ts pattern of deferring to the
 * state-machine preview sampler when one is installed.
 */
export function effectiveZ(part: RigPart, t: number | null): number {
  return ctx.poseSampler ? ctx.poseSampler(part.id, 'z') : channelValue(part, 'z', t);
}

/** Ancestor poses composed with the part's own pose (bone hierarchy). */
export function fullPoseTransform(part: RigPart, t: number | null): string {
  const pieces = ancestorChain(part).map((a) => ownPoseTransform(a, t));
  pieces.push(ownPoseTransform(part, t));
  return pieces.join(' ');
}

/** The complete transform string a part group renders with. */
export function groupTransformOf(part: RigPart, t: number | null): string {
  return [fullPoseTransform(part, t), part.transform, innerLocalTransform(part)]
    .filter(Boolean)
    .join(' ');
}

/** Matrix of the ancestors' poses only (maps a part's rest space into root space). */
export function chainMatOf(part: RigPart, t: number | null): Mat {
  return matrixOfTransform(ancestorChain(part).map((a) => ownPoseTransform(a, t)).join(' '));
}

export function ownTranslateOf(part: RigPart, t: number | null): { x: number; y: number } {
  return { x: channelValue(part, 'tx', t), y: channelValue(part, 'ty', t) };
}

/** Where the part's joint actually sits right now, in root coordinates. */
export function effectivePivot(part: RigPart, t: number | null): { x: number; y: number } {
  const m = chainMatOf(part, t);
  const ot = ownTranslateOf(part, t);
  return applyMat(m, part.pivot.x + ot.x, part.pivot.y + ot.y);
}

/** A bone's tip in root coordinates (follows the bone's own rotation), or null. */
export function effectiveTip(part: RigPart, t: number | null): { x: number; y: number } | null {
  if (!part.boneTip) return null;
  return applyMat(
    matrixOfTransform(fullPoseTransform(part, t)), part.boneTip.x, part.boneTip.y,
  );
}

/** Every part inside `group` at any depth (excludes the group itself) — any kind (art,
 *  bone, nested group), for distributed group-wide rest edits (scale/rotate handles). */
export function groupDescendants(group: RigPart): RigPart[] {
  const doc = state.doc;
  if (!doc) return [];
  return doc.parts.filter(
    (p) => p.id !== group.id && ancestorChain(p).some((a) => a.id === group.id),
  );
}

/**
 * Root-space union AABB of a group's descendant ARTWORK (partRootBoxes, which only
 * measures parts with their own paths) — the same box the dashed group outline draws,
 * now also the anchor rect for the group's scale/rotate handle sets (overlay.ts,
 * interactions.ts). Null when the group contains no rendered geometry yet (nothing to
 * box or handle).
 */
export function groupUnionBox(
  group: RigPart,
): { x0: number; y0: number; x1: number; y1: number } | null {
  const ids = groupDescendants(group).filter((p) => p.paths.length > 0).map((p) => p.id);
  const boxes = [...partRootBoxes(ids).values()];
  if (boxes.length === 0) return null;
  return {
    x0: Math.min(...boxes.map((b) => b.x)),
    y0: Math.min(...boxes.map((b) => b.y)),
    x1: Math.max(...boxes.map((b) => b.x + b.w)),
    y1: Math.max(...boxes.map((b) => b.y + b.h)),
  };
}

/** Rendered root-space AABBs of the given parts (for align/distribute). */
export function partRootBoxes(ids: string[]): Map<string, { x: number; y: number; w: number; h: number }> {
  const out = new Map<string, { x: number; y: number; w: number; h: number }>();
  const doc = state.doc;
  if (!doc) return out;
  const t = poseTime();
  for (const id of ids) {
    const part = doc.parts.find((p) => p.id === id);
    const g = part ? ctx.partGroups.get(id) : null;
    if (!part || !g || part.paths.length === 0) continue;
    const box = g.getBBox();
    const m = matrixOfTransform(groupTransformOf(part, t));
    const corners = [
      applyMat(m, box.x, box.y),
      applyMat(m, box.x + box.width, box.y),
      applyMat(m, box.x + box.width, box.y + box.height),
      applyMat(m, box.x, box.y + box.height),
    ];
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    out.set(id, { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 });
  }
  return out;
}

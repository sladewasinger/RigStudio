/**
 * Pose evaluation: the canvas's view onto the shared pose kernel now in
 * `geometry/pose.ts` (H1b extraction — see that file for the actual math and its doc
 * comments, moved there verbatim). This module is a THIN delegator adding only the two
 * things geometry/pose.ts can't know about:
 *   - `poseTime()`: Setup mode shows the bare rest pose (t = null); Animate samples
 *     `state.currentTime`.
 *   - `ctx.poseSampler`: the state-machine preview's channel-sampling override
 *     (`view/context.ts`) — threaded into every geometry/pose.ts call below as its
 *     optional `sampler` argument, so the running SMInstance can hijack sampling without
 *     either module importing the other.
 * `groupDescendants`/`groupUnionBox`/`partRootBoxes` also stay here in full: they measure
 * LIVE DOM boxes (`ctx.partGroups`' `getBBox()`), which has no headless equivalent.
 */

import {
  state, RigPart, ancestorChain, isEffectivelyHidden,
} from '../core/model';
import { Mat, applyMat, matrixOfTransform } from '../geometry/transforms';
import * as pose from '../geometry/pose';
import { ctx } from './context';

/** The time to sample animation at, or null when Setup mode shows the bare rest pose. */
export function poseTime(): number | null {
  return state.editorMode === 'animate' ? state.currentTime : null;
}

export function rootPoseTransform(t: number | null): string {
  return pose.rootPoseTransform(t, ctx.poseSampler ?? undefined);
}

/** A part's own pose transform: keyed channels are absolute, rest fills the gaps. */
export function ownPoseTransform(part: RigPart, t: number | null): string {
  return pose.ownPoseTransform(part, t, ctx.poseSampler ?? undefined);
}

/** The pivot mapped into the part's pre-baked local space (where rest scale applies). */
export function localPivotOf(part: RigPart, pivot = part.pivot): { x: number; y: number } {
  return pose.localPivotOf(part, pivot);
}

/** A part's effective scale x/y right now — see geometry/pose.ts. Defers to the
 *  state-machine preview sampler when installed. */
export function effectiveScaleX(part: RigPart, t: number | null): number {
  return pose.effectiveScaleX(part, t, ctx.poseSampler ?? undefined);
}

export function effectiveScaleY(part: RigPart, t: number | null): number {
  return pose.effectiveScaleY(part, t, ctx.poseSampler ?? undefined);
}

/** Scale AND skew, applied innermost around the local pivot — see geometry/pose.ts.
 *  `pivot` overrides the stored pivot (pivot drags evaluate candidate positions). */
export function innerLocalTransform(part: RigPart, t: number | null, pivot = part.pivot): string {
  return pose.innerLocalTransform(part, t, pivot, ctx.poseSampler ?? undefined);
}

/** A part's effective draw-order OFFSET right now — see geometry/pose.ts. Governs
 *  paint-order SORTING only (render.ts's applyDrawOrder); never enters the transform. */
export function effectiveZ(part: RigPart, t: number | null): number {
  return pose.effectiveZ(part, t, ctx.poseSampler ?? undefined);
}

/** A part's effective opacity right now — see geometry/pose.ts. NOT clamped here —
 *  render.ts clamps at the point it writes the DOM attribute. */
export function effectiveOpacity(part: RigPart, t: number | null): number {
  return pose.effectiveOpacity(part, t, ctx.poseSampler ?? undefined);
}

/** Ancestor poses composed with the part's own pose (bone hierarchy). */
export function fullPoseTransform(part: RigPart, t: number | null): string {
  return pose.fullPoseTransform(part, t, ctx.poseSampler ?? undefined);
}

/** The complete transform string a part group renders with. */
export function groupTransformOf(part: RigPart, t: number | null): string {
  return pose.groupTransformOf(part, t, ctx.poseSampler ?? undefined);
}

/** Matrix of the ancestors' poses only (maps a part's rest space into root space). */
export function chainMatOf(part: RigPart, t: number | null): Mat {
  return pose.chainMatOf(part, t, ctx.poseSampler ?? undefined);
}

export function ownTranslateOf(part: RigPart, t: number | null): { x: number; y: number } {
  return pose.ownTranslateOf(part, t);
}

/** Where the part's joint actually sits right now, in root coordinates. */
export function effectivePivot(part: RigPart, t: number | null): { x: number; y: number } {
  return pose.effectivePivot(part, t, ctx.poseSampler ?? undefined);
}

/** A bone's tip in root coordinates (follows the bone's own rotation), or null. */
export function effectiveTip(part: RigPart, t: number | null): { x: number; y: number } | null {
  return pose.effectiveTip(part, t, ctx.poseSampler ?? undefined);
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
    if (isEffectivelyHidden(part)) continue; // Layers eye — excluded from bbox unions too
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

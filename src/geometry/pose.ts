/**
 * Pose evaluation: the pure math kernel for the transform strings and matrices that
 * place each part in the scene. Extracted from `view/pose.ts` (H1b, the headless render-
 * frames wave) so the live canvas and the DOM-free headless renderer
 * (`headless/composePose.ts`) share ONE implementation — `view/pose.ts` is now a thin
 * delegator over this module adding only its view-specific concerns (ctx/DOM); this file
 * must never import from `src/view` or touch the DOM.
 *
 * A part's rendered transform is its ancestors' poses (outermost first) followed by its
 * own pose, then the baked SVG transform, then the innermost scale/skew. The innermost
 * SCALE is keyable (channels 'sx'/'sy', absolute with rest.sx/sy as the unkeyed
 * fallback — model.channelValue), so Animate playback/scrub shows part scale exactly as
 * the .riv export replays it; SKEW (kx/ky) stays REST-ONLY (not a channel). Keyed
 * channels are ABSOLUTE; the rest pose only fills unkeyed channels (model.channelValue).
 *
 * Every function below reads the current document through `state.doc` (core/model's
 * app-state singleton) — the same thing `ancestorChain`/`channelValue`/`sampleChannel`
 * already do internally, and the established headless convention (`headless/index.ts`'s
 * header: "a script sets `state.doc = doc` before calling it, exactly like the editor's
 * own call sites do"). `headless/composePose.ts` follows the same pattern.
 *
 * `sampler`, when passed, overrides normal channel sampling for a `(target, channel)`
 * pair — the ONLY hook the state-machine preview needs. It exists purely so
 * `view/pose.ts`'s wrappers can thread `ctx.poseSampler` through without this module
 * knowing anything about the canvas or the state-machine editor. Headless callers never
 * pass one.
 */

import {
  state, RigPart, Channel, sampleChannel, channelValue, ancestorChain,
} from '../core/model';
import { Mat, applyMat, invertMat, matrixOfTransform } from './transforms';

/** Channel-sampling override — see the module doc comment. */
export type PoseSampler = (target: string, channel: Channel) => number;

export function rootPoseTransform(t: number | null, sampler?: PoseSampler): string {
  const doc = state.doc!;
  const rtx = sampler ? sampler('root', 'tx') : t === null ? 0 : sampleChannel('root', 'tx', t);
  const rty = sampler ? sampler('root', 'ty') : t === null ? 0 : sampleChannel('root', 'ty', t);
  const rsx = sampler ? sampler('root', 'sx') : t === null ? 1 : sampleChannel('root', 'sx', t);
  const rsy = sampler ? sampler('root', 'sy') : t === null ? 1 : sampleChannel('root', 'sy', t);
  const rp = doc.rootPivot;
  return (
    `translate(${rtx},${rty}) translate(${rp.x},${rp.y}) ` +
    `scale(${rsx},${rsy}) translate(${-rp.x},${-rp.y})`
  );
}

/** A part's own pose transform: keyed channels are absolute, rest fills the gaps. */
export function ownPoseTransform(part: RigPart, t: number | null, sampler?: PoseSampler): string {
  const rot = sampler ? sampler(part.id, 'rotate') : channelValue(part, 'rotate', t);
  const tx = sampler ? sampler(part.id, 'tx') : channelValue(part, 'tx', t);
  const ty = sampler ? sampler(part.id, 'ty') : channelValue(part, 'ty', t);
  return `translate(${tx},${ty}) rotate(${rot},${part.pivot.x},${part.pivot.y})`;
}

/** The pivot mapped into the part's pre-baked local space (where rest scale applies). */
export function localPivotOf(part: RigPart, pivot = part.pivot): { x: number; y: number } {
  return applyMat(invertMat(matrixOfTransform(part.transform)), pivot.x, pivot.y);
}

/**
 * A part's effective scale x/y right now: the ABSOLUTE keyed value when 'sx'/'sy' is
 * keyed in the active clip, otherwise rest.sx/sy (channelValue's rule). This is the SAME
 * innermost slot the .riv export scales at (an absolute Node scaleX/scaleY anchored at
 * the pivot), so editor and runtime agree. Defers to `sampler` when passed — see the
 * module doc comment.
 */
export function effectiveScaleX(part: RigPart, t: number | null, sampler?: PoseSampler): number {
  return sampler ? sampler(part.id, 'sx') : channelValue(part, 'sx', t);
}

export function effectiveScaleY(part: RigPart, t: number | null, sampler?: PoseSampler): number {
  return sampler ? sampler(part.id, 'sy') : channelValue(part, 'sy', t);
}

/**
 * Scale AND skew, applied innermost (after the baked transform) around the local pivot:
 * the artwork reshapes along its own axes and the joint stays exactly in place. Scale is
 * time-sampled (keyed sx/sy absolute, rest fallback) so Animate scrub shows keyed scale;
 * SKEW is rest-only (kx/ky are not channels). Pass t = null for the bare rest pose
 * (Setup). `pivot` overrides the stored pivot (pivot drags evaluate candidate positions).
 */
export function innerLocalTransform(
  part: RigPart, t: number | null, pivot = part.pivot, sampler?: PoseSampler,
): string {
  const sx = effectiveScaleX(part, t, sampler);
  const sy = effectiveScaleY(part, t, sampler);
  const { kx, ky } = part.rest;
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
 * fallback 0). This governs paint-order SORTING only (view/render.ts's applyDrawOrder,
 * headless/composePose.ts's own sort) — it never enters the rendered transform.
 */
export function effectiveZ(part: RigPart, t: number | null, sampler?: PoseSampler): number {
  return sampler ? sampler(part.id, 'z') : channelValue(part, 'z', t);
}

/**
 * A part's effective opacity right now (keyed `opacity` is ABSOLUTE and CONTINUOUS — it
 * eases normally, unlike the stepped `z` channel — rest fallback `part.rest.opacity`).
 * NOT clamped here — callers clamp at the point they write/consume it (view/render.ts's
 * applyOpacity, headless/composePose.ts); this stays a plain sample.
 */
export function effectiveOpacity(part: RigPart, t: number | null, sampler?: PoseSampler): number {
  return sampler ? sampler(part.id, 'opacity') : channelValue(part, 'opacity', t);
}

/** Ancestor poses composed with the part's own pose (bone hierarchy). */
export function fullPoseTransform(part: RigPart, t: number | null, sampler?: PoseSampler): string {
  const pieces = ancestorChain(part).map((a) => ownPoseTransform(a, t, sampler));
  pieces.push(ownPoseTransform(part, t, sampler));
  return pieces.join(' ');
}

/** The complete transform string a part group renders with. */
export function groupTransformOf(part: RigPart, t: number | null, sampler?: PoseSampler): string {
  return [
    fullPoseTransform(part, t, sampler),
    part.transform,
    innerLocalTransform(part, t, part.pivot, sampler),
  ]
    .filter(Boolean)
    .join(' ');
}

/** Matrix of the ancestors' poses only (maps a part's rest space into root space). */
export function chainMatOf(part: RigPart, t: number | null, sampler?: PoseSampler): Mat {
  return matrixOfTransform(ancestorChain(part).map((a) => ownPoseTransform(a, t, sampler)).join(' '));
}

export function ownTranslateOf(part: RigPart, t: number | null): { x: number; y: number } {
  return { x: channelValue(part, 'tx', t), y: channelValue(part, 'ty', t) };
}

/** Where the part's joint actually sits right now, in root coordinates. */
export function effectivePivot(
  part: RigPart, t: number | null, sampler?: PoseSampler,
): { x: number; y: number } {
  const m = chainMatOf(part, t, sampler);
  const ot = ownTranslateOf(part, t);
  return applyMat(m, part.pivot.x + ot.x, part.pivot.y + ot.y);
}

/** A bone's tip in root coordinates (follows the bone's own rotation), or null. */
export function effectiveTip(
  part: RigPart, t: number | null, sampler?: PoseSampler,
): { x: number; y: number } | null {
  if (!part.boneTip) return null;
  return applyMat(
    matrixOfTransform(fullPoseTransform(part, t, sampler)), part.boneTip.x, part.boneTip.y,
  );
}

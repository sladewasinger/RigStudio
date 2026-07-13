/**
 * Unified Skeleton (Phase 1): world-preserving cross-chain bone attach/detach — the
 * Layers-panel drag that parents one chain's root bone onto another chain's bone (e.g.
 * an arm chain's root onto the spine) WITHOUT a visual jump, so unrelated skeletons can
 * be linked into one hierarchy after the fact. Split out as its own module (CLAUDE.md
 * "Small, focused files") rather than folded into rigOpsEdit.ts; shares that layer (may
 * reach pose.ts/geometry, never interactions.ts or higher).
 *
 * THE FOLD: a plain reparent (`setParent`) changes which ancestor poses compose into a
 * bone's WORLD transform, so the bone (and everything riding it) would jump by whatever
 * the new ancestor contributes. Instead this solves the bone's OWN rest (rotate + the
 * translate around its UNCHANGED pivot) so
 *
 *   newChainMat · newOwnPose  ==  oldChainMat · oldOwnPose  (=: W, the bone's full pose
 *                                                             matrix captured before the
 *                                                             reparent)
 *
 * — the same closed form as `rigOpsBind.ts`'s `foldLostArtPoseIntoBoneRest` (duplicated
 * here rather than imported: that helper is private to its module, and this op sits
 * above it in the `src/view/` layering). Because a bone's `effectivePivot`/`effectiveTip`
 * reduce to `W · pivot` / `W · boneTip` (the pivot is by definition the fixed point of
 * the bone's own rotation, so only `W` — not the bone's own rotate — maps it), preserving
 * `W` exactly preserves BOTH, and therefore every descendant's full pose too (a
 * descendant's chain matrix is built from this bone's OWN pose, which is exactly what got
 * refolded) — render-neutral all the way down, bind data (skin `restWorldInv`/`bindSeg`,
 * which are themselves derived from a bone's `W` at bind time) included.
 *
 * `attachedRoot` marks the loose link (see its doc comment in docTypes.ts): set true when
 * the new parent is a bone (the bone's origin no longer needs to sit at that bone's tip —
 * `carryChildOrigins`/`carryChildBoneOrigins` skip flagged children accordingly, and
 * `boneChain` stops chain resolution at the boundary), cleared when the new parent isn't.
 * Detaching (drag to the Layers "un-parent" strip, or onto a non-bone part while already
 * attached) reuses the identical fold against the new (possibly empty) ancestor chain —
 * there is no separate "reverse" formula, just the same solve with a different target.
 */

import { state, RigPart, setParent } from '../core/model';
import { Mat, invertMat, matrixOfTransform, multiply } from '../geometry/transforms';
import { round3 } from './context';
import { chainMatOf, fullPoseTransform } from './pose';

/**
 * Whether `bone` currently sits at the root of its own bone chain per `boneChain`'s stop
 * rule: no bone parent, or already flagged `attachedRoot` (a chain root even though its
 * `parentId` reaches into another chain). Only a chain-root bone is eligible to be
 * (re)attached — mid-chain bones keep today's plain-reparent behavior (out of Phase 1's
 * scope; see the module doc's deliverable).
 */
function isChainRootBone(parts: RigPart[], bone: RigPart): boolean {
  if (bone.kind !== 'bone') return false;
  if (bone.attachedRoot) return true;
  const parent = bone.parentId ? parts.find((p) => p.id === bone.parentId) : undefined;
  return !parent || parent.kind !== 'bone';
}

/**
 * Solve `bone`'s own rest (rotate + translate around its UNCHANGED pivot) so its full
 * pose transform reproduces the WORLD matrix `W` under `bone`'s CURRENT parent chain
 * (read live via `chainMatOf`, so call this AFTER `bone.parentId` has already changed).
 * See the module doc for the closed form and why it is render-neutral.
 */
function foldWorldIntoBoneRest(bone: RigPart, W: Mat): void {
  const target = multiply(invertMat(chainMatOf(bone, null)), W);
  const rotDeg = round3((Math.atan2(target.b, target.a) * 180) / Math.PI);
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const { x: px, y: py } = bone.pivot;
  // ownPose = translate(tx,ty)·rotate(rotDeg, pivot); its matrix translation is
  // (tx,ty) + pivot − Rot·pivot, so solve (tx,ty) to reproduce target's translation.
  bone.rest.rotate = rotDeg;
  bone.rest.tx = round3(target.e - px + (cos * px - sin * py));
  bone.rest.ty = round3(target.f - py + (sin * px + cos * py));
}

/**
 * The Unified Skeleton Phase 1 op: reparent a chain-root bone onto `newParentId`,
 * world-preserving, for a Layers-panel drop. Returns false WITHOUT mutating anything
 * when this drop isn't the special cross-chain-attach/detach gesture — callers fall back
 * to plain `setParent` for every other combination (non-root bones, any drag touching a
 * non-bone part on either side), keeping today's behavior exactly as documented:
 *
 *   - `bone` isn't currently a chain-root bone (per `isChainRootBone`) — out of scope.
 *   - the new parent is a BONE — the classic cross-chain ATTACH: fold + `attachedRoot =
 *     true` (re-attaching an already-attached root to a different bone recomputes the
 *     fold against the new anchor and simply keeps the flag).
 *   - the new parent is `null` (the Layers "un-parent" drop strip) AND `bone` is
 *     currently `attachedRoot` — DETACH to root level: fold against the now-empty
 *     ancestor chain + clear the flag. A never-attached root dropped at root level isn't
 *     this op's concern (it's usually already there, or today's raw un-parent is fine).
 *   - anything else (new parent is a non-bone part) — bone→non-bone keeps today's
 *     behavior exactly, even for an already-attached root; the Layers "un-parent" strip
 *     is the documented detach gesture.
 *
 * One checkpoint (the caller's — this never calls `checkpoint()` itself, matching every
 * other `view/rigOps*` mutator). Bind data (skin `restWorldInv`/`bindSeg`) is untouched:
 * the fold keeps every affected bone's WORLD matrix byte-stable, so LBS deltas stay valid
 * at the instant of attach (render-neutral, < 0.01px — interaction-tested).
 */
export function reattachRootBone(bone: RigPart, newParentId: string | null): boolean {
  const doc = state.doc;
  if (!doc) return false;
  if (!isChainRootBone(doc.parts, bone)) return false;
  if (newParentId === bone.id) return false;
  const newParent = newParentId ? doc.parts.find((p) => p.id === newParentId) : null;
  if (newParentId && !newParent) return false;
  const attaching = newParent?.kind === 'bone';
  const detaching = !newParent && !!bone.attachedRoot;
  if (!attaching && !detaching) return false; // bone→non-bone: not this op's gesture
  const W = matrixOfTransform(fullPoseTransform(bone, null));
  if (!setParent(bone.id, newParentId)) return false; // cycle-safe; no-op on refusal
  foldWorldIntoBoneRest(bone, W);
  if (attaching) bone.attachedRoot = true;
  else delete bone.attachedRoot;
  return true;
}

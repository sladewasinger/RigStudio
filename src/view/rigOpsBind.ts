/**
 * Linear-blend skin bind/unbind, plus the freeze-mode bind-refresh cycle that lets a
 * bone chain be reshaped against STATIC art (the rig is fitted, the art holds still).
 * Split out of rigOps.ts (CLAUDE.md "Small, focused files"); shares its layer (may
 * reach render.ts/partDom.ts/skinRender.ts, never interactions.ts or higher).
 */

import {
  state, selectedParts, ancestorChain, boneChain, RigPart, SkinBone,
} from '../core/model';
import { parsePath, serializePath, pathToCubics, PathCmd } from '../geometry/paths';
import { spliceNodeTypesForBake } from './nodeEditing/structural';
import { applyMat, invertMat, matrixOfTransform, multiply, Mat } from '../geometry/transforms';
import { ctx, round3 } from './context';
import {
  poseTime, groupTransformOf, chainMatOf, effectivePivot, effectiveTip, fullPoseTransform,
} from './pose';
import { applyPathAttrs, partOwnPathElements } from './partDom';
import { invalidateSkinCache } from './skinRender';
import { renderPose } from './render';

/** One bone's bind-time record (rest world + segment) for weights and per-frame deltas. */
function skinBoneOf(bone: RigPart): SkinBone {
  const p = effectivePivot(bone, null);
  const q = effectiveTip(bone, null) ?? { x: p.x + 5, y: p.y };
  return {
    id: bone.id,
    restWorldInv: invertMat(matrixOfTransform(fullPoseTransform(bone, null))),
    bindSeg: { p: { ...p }, q: { ...q } },
  };
}

/**
 * Bind art parts to bones (linear-blend skinning) — the shared core behind the Bind
 * button and Bones 2.0 auto-bind. For an UNSKINNED part it bakes every static transform
 * (parent chain, rest pose, baked SVG transform, rest scale, per-path transforms) into
 * the path data — the current Edit look becomes the bind pose — zeroes the part's own
 * pose, and captures each bone's rest world + segment. For an ALREADY-skinned part
 * (auto-bind re-derives an existing arm's weights as the chain grows), the geometry is
 * already in its bind pose, so re-baking would be a float-drifting no-op: instead the
 * bone set is refreshed in place and any surviving per-node overrides are kept.
 * Mutates the DOM `d` attributes; does NOT checkpoint or renderPose — the caller does.
 *
 * MULTI-PART SAFE (Group-level auto-bind): `arts` may contain an art part AND one of its
 * own descendant art parts in the SAME call (Pip's nested body-in-body — an outer "body"
 * with its own path plus a nested "body" carrying the pill/red/outline paths, both bound
 * together by one chain). Baking the ancestor zeroes its rest pose; a descendant's chain
 * matrix composes THROUGH that ancestor, so bakes are ANCESTOR-FIRST (shallower
 * `ancestorChain` first, mirroring `groupScaleMembers`) and every part's pre-bake
 * transform + root pivot is snapshotted BEFORE any mutation runs — otherwise a
 * later-processed descendant would read its ancestor's already-zeroed (wrong) pose and
 * bake its own geometry into the wrong root position.
 */
export function bindPartsToBones(artsIn: RigPart[], bones: RigPart[]): void {
  if (artsIn.length === 0 || bones.length === 0) return;
  const doc = state.doc;
  if (!doc) return;
  const arts = [...artsIn].sort((a, b) => ancestorChain(a).length - ancestorChain(b).length);
  const skinBones = bones.map(skinBoneOf);
  const freshBones = (): SkinBone[] =>
    skinBones.map((b) => ({ ...b, bindSeg: { p: { ...b.bindSeg.p }, q: { ...b.bindSeg.q } } }));
  // Each bone's WORLD matrix BEFORE any art mutation — needed to keep a bone's world
  // fixed when its parent art's rest pose (which it rides) gets baked away below.
  const boneWorlds = new Map(
    bones.map((b) => [b.id, matrixOfTransform(fullPoseTransform(b, null))]),
  );
  const bakedArtIds = new Set<string>();

  // Snapshot every UNSKINNED art's pre-bake full transform + root pivot BEFORE any part
  // is mutated (see the function doc): all bakes below read from this frozen snapshot
  // instead of recomputing mid-loop.
  const preBake = new Map<string, { full: Mat; rootPivot: { x: number; y: number } }>();
  for (const part of arts) {
    if (part.skin) continue;
    preBake.set(part.id, {
      full: matrixOfTransform(groupTransformOf(part, null)),
      rootPivot: effectivePivot(part, null), // capture with the ORIGINAL rest still live
    });
  }

  for (const part of arts) {
    if (part.skin) {
      const overrides = part.skin.overrides;
      part.skin = { bones: freshBones(), ...(overrides ? { overrides } : {}) };
      invalidateSkinCache(part.id);
      continue;
    }
    const { full, rootPivot } = preBake.get(part.id)!;
    for (const path of part.paths) {
      const m = multiply(full, matrixOfTransform(path.transform));
      const parsed = parsePath(path.d);
      // nodeTypes lockstep: pathToCubics below expands a literal 'A' into MULTIPLE
      // cubics, so the one-char-per-command string must be spliced in the same pass
      // (the chokepoint wave's flagged latent desync — a bound arc path used to keep
      // its old, now-too-short string). The write lives in the chokepoint module.
      spliceNodeTypesForBake(path, parsed);
      const cmds = pathToCubics(parsed).map((c) => {
        if (c.cmd === 'C') {
          const p1 = applyMat(m, c.x1, c.y1);
          const p2 = applyMat(m, c.x2, c.y2);
          const p = applyMat(m, c.x, c.y);
          return { cmd: 'C' as const, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p.x, y: p.y };
        }
        if (c.cmd === 'Z') return c;
        const p = applyMat(m, (c as { x: number }).x, (c as { y: number }).y);
        return { ...c, x: p.x, y: p.y } as PathCmd;
      });
      path.d = serializePath(cmds);
      path.transform = '';
      path.strokeWidth = path.strokeWidth * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
      const el = ctx.svg?.querySelector<SVGPathElement>(`[data-path-id="${path.id}"]`);
      if (el) applyPathAttrs(el, path);
    }
    // Bind bakes/zeroes the GEOMETRIC rest fields (they're now baked into path.d); opacity
    // is a paint property, not a transform, so it survives the reset untouched.
    part.transform = '';
    part.rest = { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: part.rest.opacity };
    // KEEP the art parented — never hoist it out of its group (the reported "bones leave
    // their parent object on assign" regression: zeroing parentId detached a nested art,
    // and its whole bone sub-chain, from its group). The geometry is baked to ROOT space and
    // render forces transform='' for a skinned part (render.ts renderPartRigid also), so the
    // baked-in chain is never double-applied; and the bones compose THROUGH the preserved
    // chain, so the limb still follows a group move. Store the joint in the art's LOCAL
    // (post-chain) frame so effectivePivot — which still composes the chain — lands the
    // overlay crosshair on the true joint; for FLAT art (chain == identity) invert(chain) is
    // identity, so this is byte-identical to the old root-space pivot + parentId stays null.
    // chainMatOf is read LIVE here, at this part's natural turn in the ancestor-first loop:
    // any of ITS OWN ancestors that are also in `arts` have ALREADY been baked/zeroed by
    // now, so this matches the FINAL post-bind chain matrix the render pipeline will
    // actually use — not a stale pre-bake one (see the function doc).
    part.pivot = applyMat(invertMat(chainMatOf(part, null)), rootPivot.x, rootPivot.y);
    part.skin = { bones: freshBones() };
    invalidateSkinCache(part.id);
    bakedArtIds.add(part.id);
  }

  // RENDER-NEUTRAL bind for a rest-posed art: a bone placed while an art was selected is
  // parented to that art, so it RODE the art's rest rotate/translate (children inherit a
  // parent's ownPose). Baking bakes that rest INTO the geometry and zeroes it on the art,
  // but the bone still referenced the art — so at render its world lost the rotation while
  // the LBS rest record kept it, and the delta un-did the rotation, visibly shifting the
  // baked art (the reported "bind moved rest-rotated art" bug; identity-rest arts, and
  // arts whose rotation lived in `part.transform` not `rest`, never showed it). Fix: FOLD
  // the (rigid) art pose the bone lost into the bone's OWN rest, KEEPING it parented to the
  // art, so its world — hence the identity rest delta and the whole child sub-chain — is
  // preserved exactly while the layers tree still shows the chain under the art part
  // (hierarchy-as-assignment; the older design re-parented the chain to root, breaking it).
  for (const bone of bones) {
    if (!bone.parentId || !bakedArtIds.has(bone.parentId)) continue;
    foldLostArtPoseIntoBoneRest(bone, boneWorlds.get(bone.id)!);
    invalidateSkinCache(bone.id);
  }
}

/**
 * Keep a bone parented to its (now baked) art while preserving its world transform `W`
 * byte-stable: solve the bone's OWN rest so `chainMat(bone)·ownPose(bone) == W`. Bind bakes
 * the art's rest into geometry and zeroes it, so the bone loses the ancestor pose it rode;
 * this folds that loss into the bone's rest (rotate + translate around its unchanged pivot).
 * After baking the art sits at root with an identity pose, so chainMat is identity and the
 * target reduces to `W` — but the general form stays correct if the art itself had ancestors.
 * `W` is a product of rigid ownPoses (rotate + translate, no scale), so the decomposition is
 * exact; the pivot stays put so effectivePivot/effectiveTip — and child bones riding this
 * one — are unchanged. Unlike the older design the bone is NOT re-parented to root, so the
 * chain stays under the art part in the layers tree.
 */
function foldLostArtPoseIntoBoneRest(bone: RigPart, W: Mat): void {
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
 * Bind the selected art parts to the selected bones. Returns an error message, or null
 * on success. Caller checkpoints first.
 */
export function bindSelectedToBones(): string | null {
  if (state.editorMode !== 'setup') return 'Bind in Setup mode.';
  const arts = selectedParts().filter((p) => p.paths.length > 0);
  const bones = selectedParts().filter((p) => p.kind === 'bone');
  if (arts.length === 0 || bones.length === 0) {
    return 'Select at least one art part and one bone (Shift+click), then bind.';
  }
  bindPartsToBones(arts, bones);
  renderPose();
  return null;
}

/** Remove the skin binding (geometry keeps its baked rest look, part turns rigid). */
export function unbindSelectedSkin(): boolean {
  const parts = selectedParts().filter((p) => p.skin);
  if (parts.length === 0) return false;
  for (const part of parts) {
    part.skin = null;
    invalidateSkinCache(part.id);
  }
  renderPose();
  return true;
}

// ---- Freeze-mode bind refresh (the freeze / non-freeze pose model) ----
//
// A bone is posed by ROTATION (around its origin) + LENGTH (its tip) — see
// rigOpsEdit.ts's aimBoneAtTip, which does the actual reshaping. Reshaping a bone
// deforms any skinned art through the existing LBS delta-from-bind (art follows). In
// FREEZE mode the SAME reshapes run but the bind reference below is refreshed so the
// art stays put (the rig is fitted against static art).

/**
 * FREEZE-mode bind refresh: re-capture the bind reference (restWorldInv + bindSeg) of every
 * bone bound to any part whose skin includes a bone in `boneId`'s chain, at the bones'
 * CURRENT pose. This resets the LBS delta to identity (and the bind length to the current
 * length) so the art does NOT move while the rig is edited against static art. Weights are
 * NOT recomputed here — the skin cache signature omits bindSeg, so cached weight rows survive
 * the gesture ("keep existing weights during the gesture"); call refreshFrozenSkinWeights()
 * at gesture END to rebuild auto weights from the new segments.
 */
export function refreshBindForChain(boneId: string, t: number | null): void {
  const doc = state.doc;
  if (!doc) return;
  const chainIds = new Set(boneChain(doc.parts, boneId).map((b) => b.id));
  for (const part of doc.parts) {
    if (!part.skin || !part.skin.bones.some((b) => chainIds.has(b.id))) continue;
    for (const sb of part.skin.bones) {
      const bone = doc.parts.find((p) => p.id === sb.id);
      if (!bone) continue;
      sb.restWorldInv = invertMat(matrixOfTransform(fullPoseTransform(bone, t)));
      const pp = effectivePivot(bone, t);
      const qq = effectiveTip(bone, t) ?? { x: pp.x + 5, y: pp.y };
      sb.bindSeg = { p: { x: pp.x, y: pp.y }, q: { x: qq.x, y: qq.y } };
    }
  }
}

/**
 * Rebuild auto weights for every skinned part bound to the chain (freeze gesture END). Parts
 * WITH per-node overrides keep them (overrides reference bone ids, not positions) — the cache
 * rebuild recomputes only the auto weight rows from the refreshed bind segments.
 */
export function refreshFrozenSkinWeights(boneId: string): void {
  const doc = state.doc;
  if (!doc) return;
  const chainIds = new Set(boneChain(doc.parts, boneId).map((b) => b.id));
  for (const part of doc.parts) {
    if (part.skin && part.skin.bones.some((b) => chainIds.has(b.id))) invalidateSkinCache(part.id);
  }
}

/**
 * FREEZE gesture START: snapshot the art's CURRENT rendered appearance as its bind baseline
 * so a freeze bone edit doesn't snap the art. Bakes each bound part's current rendered `d`
 * (whatever it looks like now — possibly already deformed by earlier NON-freeze posing) into
 * its rest path data, then re-binds every bone at its CURRENT pose so the LBS delta is
 * identity and the stretch is unit for that new baseline. From here the per-move
 * refreshBindForChain holds the art on this frozen look while the bones move. When the art is
 * already at its bind appearance (the documented "static art" flow) this is a no-op in effect
 * — the baked geometry round-trips byte-identically. Call BEFORE the bone pose is mutated so
 * the DOM still shows the pre-edit look.
 */
export function captureFrozenBaseline(boneId: string, t: number | null): void {
  const doc = state.doc;
  if (!doc) return;
  const chainIds = new Set(boneChain(doc.parts, boneId).map((b) => b.id));
  for (const part of doc.parts) {
    if (!part.skin || !part.skin.bones.some((b) => chainIds.has(b.id))) continue;
    // Every one of the part's own <path> elements, across all its runs (U2 interleaving).
    const byPathId = new Map(partOwnPathElements(part.id).map((el) => [el.dataset.pathId, el]));
    for (const path of part.paths) {
      const dNow = byPathId.get(path.id)?.getAttribute('d');
      if (dNow) path.d = dNow; // freeze the current look into the rest geometry
    }
    for (const sb of part.skin.bones) {
      const bone = doc.parts.find((p) => p.id === sb.id);
      if (!bone) continue;
      sb.restWorldInv = invertMat(matrixOfTransform(fullPoseTransform(bone, t)));
      const pp = effectivePivot(bone, t);
      const qq = effectiveTip(bone, t) ?? { x: pp.x + 5, y: pp.y };
      sb.bindSeg = { p: { x: pp.x, y: pp.y }, q: { x: qq.x, y: qq.y } };
    }
    invalidateSkinCache(part.id);
  }
}

/**
 * DISCRETE freeze-mode bone edit (the inspector rotation/length/position fields): re-baseline
 * the art to its pre-edit look (still in the DOM, since poseEdited's repaint hasn't run yet)
 * and re-bind at the new bone pose — the field-edit equivalent of a canvas drag's freeze
 * baseline capture. Call AFTER mutating the bone but BEFORE the repaint.
 */
export function rebindFrozenChain(boneId: string): void {
  captureFrozenBaseline(boneId, poseTime());
}

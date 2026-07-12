/**
 * Rig-structure operations invoked from the toolbar / inspector / keyboard: flip,
 * arrow-key nudge, align/distribute application, linear-blend skin bind/unbind, and
 * click-to-place bone arming. These mutate the doc (rest pose, geometry, skin) and
 * repaint; the caller checkpoints history where appropriate.
 */

import {
  state, selectedParts, selectedPart, setKeyframe, channelValue, boneChain, chainBonesOfPart,
  ancestorChain, RigPart, SkinBone, SkinOverride,
} from '../core/model';
import { parsePath, serializePath, pathToCubics, PathCmd } from '../geometry/paths';
import { applyMat, invertMat, matrixOfTransform, multiply, Mat } from '../geometry/transforms';
import { ctx, linearOnly, parseNodeKey, round1, round2, round3, wrapToPi } from './context';
import {
  poseTime, groupTransformOf, chainMatOf, effectivePivot, effectiveTip, fullPoseTransform,
  ownTranslateOf, groupDescendants,
} from './pose';
import { applyPathAttrs } from './partDom';
import { invalidateSkinCache } from './skinRender';
import { renderPose } from './render';

// ---- Vector-editing operations (Setup mode) ----

/**
 * Flip the selected art parts in place — around each part's own rendered bbox center,
 * stored as negated rest scale (axes follow the artwork like all rest scaling), with
 * the bbox center pinned by rest-translation compensation. The joint doesn't move.
 */
export function flipSelected(axis: 'h' | 'v'): boolean {
  if (state.editorMode !== 'setup') return false;
  const parts = selectedParts().filter((p) => p.paths.length > 0 && ctx.partGroups.has(p.id));
  if (parts.length === 0) return false;
  const t = poseTime();
  for (const part of parts) {
    const g = ctx.partGroups.get(part.id)!;
    const box = g.getBBox();
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const before = applyMat(matrixOfTransform(groupTransformOf(part, t)), c.x, c.y);
    if (axis === 'h') part.rest.sx = -part.rest.sx;
    else part.rest.sy = -part.rest.sy;
    const after = applyMat(matrixOfTransform(groupTransformOf(part, t)), c.x, c.y);
    const local = applyMat(
      linearOnly(invertMat(chainMatOf(part, t))), before.x - after.x, before.y - after.y,
    );
    part.rest.tx = round1(part.rest.tx + local.x);
    part.rest.ty = round1(part.rest.ty + local.y);
  }
  renderPose();
  return true;
}

/** One descendant's frozen drag-start snapshot for a group scale (see applyGroupScale). */
export interface GroupScaleMember {
  part: RigPart;
  startSx: number; startSy: number;
  /** Root-space effective pivot at drag start — the position that scales about the
   *  group's own pivot. */
  startPivotRoot: { x: number; y: number };
}

/**
 * Snapshot every descendant of `group` for a distributed group-scale drag, ANCESTOR-
 * FIRST (shallower ancestorChain first). Order matters: applyGroupScale re-solves each
 * member's chain matrix LIVE (not frozen) against the CURRENT doc, so a member must be
 * processed only after every member that is one of its own ancestors — otherwise a
 * grandchild (e.g. an art part nested inside another member) would read a stale,
 * pre-correction chain for that ancestor.
 */
export function groupScaleMembers(group: RigPart, t: number | null): GroupScaleMember[] {
  const members = groupDescendants(group).map((part) => ({
    part,
    startSx: part.rest.sx, startSy: part.rest.sy,
    startPivotRoot: effectivePivot(part, t),
  }));
  members.sort((a, b) => ancestorChain(a.part).length - ancestorChain(b.part).length);
  return members;
}

/**
 * Group scale handle drag (the flipSelected family, generalized from reflection to
 * non-uniform scale): apply a (fx,fy) scale about `pivotRoot` to every snapshotted
 * descendant. Each part's OWN rest scale multiplies — its artwork grows/shrinks about
 * its own local pivot, per the rest-scale convention (innerLocalTransform) — and its
 * rendered PIVOT position scales about the GROUP's pivot: a true root-space point-scale
 * (target = pivotRoot + f*(startPivot - pivotRoot)). The local rest.tx/ty needed to land
 * there is solved by inverting the part's CURRENT (not frozen) chain matrix — members
 * are processed ancestor-first (groupScaleMembers), so by the time a nested member is
 * solved, any of ITS OWN ancestors that are also members already carry their corrected
 * rest.tx/ty, and chainMatOf reads that live value. Solving against a frozen ancestor
 * chain instead double-applies the ancestor's own shift on top of the nested member's —
 * the bug this replaced (caught live on an imported nested group, girl_example.svg's
 * RightArm ⊃ Arm ⊃ g291-2). A part whose own axes are rotated relative to root only
 * gets this exactly right when fx==fy (uniform) — a non-uniform scale of a rotated
 * child would need a local shear this model has no field for; same pragmatic
 * limitation as flipSelected's local-axis negation, accepted by design. Idempotent per
 * pointermove: solved fresh from the FROZEN start pivots every call, so per-frame
 * rounding never compounds.
 */
export function applyGroupScale(
  members: GroupScaleMember[], t: number | null,
  pivotRoot: { x: number; y: number }, fx: number, fy: number,
): void {
  for (const m of members) {
    m.part.rest.sx = round2(m.startSx * fx);
    m.part.rest.sy = round2(m.startSy * fy);
    const target = {
      x: pivotRoot.x + fx * (m.startPivotRoot.x - pivotRoot.x),
      y: pivotRoot.y + fy * (m.startPivotRoot.y - pivotRoot.y),
    };
    // chainMatOf recomputes FRESH from live doc state on every call (not cached) — for
    // an ancestor-member processed earlier in this same loop, that live read already
    // reflects its just-written rest.tx/ty.
    const chain = chainMatOf(m.part, t);
    const local = applyMat(invertMat(chain), target.x, target.y);
    m.part.rest.tx = round1(local.x - m.part.pivot.x);
    m.part.rest.ty = round1(local.y - m.part.pivot.y);
  }
}

/**
 * Nudge the selected parts by a SCREEN-pixel delta (arrow keys), converted through
 * the current zoom and each part's parent chain — the keyboard twin of a translate
 * drag (Setup writes rest, Animate keys tx/ty at the playhead). Sub-0.1 steps at
 * high zoom survive thanks to finer rounding. Returns whether anything moved.
 */
export function nudgeSelectedParts(dxPx: number, dyPx: number): boolean {
  if (!ctx.svg) return false;
  const parts = selectedParts().filter((p) => !p.skin);
  if (parts.length === 0) return false;
  const ctm = ctx.svg.getScreenCTM();
  const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
  const dx = dxPx / scale;
  const dy = dyPx / scale;
  const t = poseTime();
  const setup = state.editorMode === 'setup';
  for (const part of parts) {
    const local = applyMat(linearOnly(invertMat(chainMatOf(part, t))), dx, dy);
    if (setup) {
      part.rest.tx = round3(part.rest.tx + local.x);
      part.rest.ty = round3(part.rest.ty + local.y);
    } else {
      setKeyframe(part.id, 'tx', round3(channelValue(part, 'tx', t) + local.x));
      setKeyframe(part.id, 'ty', round3(channelValue(part, 'ty', t) + local.y));
    }
  }
  renderPose();
  return true;
}

/** Apply root-space translation deltas (from align/distribute) via rest translation. */
export function applyRootDeltas(deltas: Map<string, { dx: number; dy: number }>): void {
  const doc = state.doc;
  if (!doc) return;
  const t = poseTime();
  for (const [id, d] of deltas) {
    if (d.dx === 0 && d.dy === 0) continue;
    const part = doc.parts.find((p) => p.id === id);
    if (!part) continue;
    const local = applyMat(linearOnly(invertMat(chainMatOf(part, t))), d.dx, d.dy);
    part.rest.tx = round1(part.rest.tx + local.x);
    part.rest.ty = round1(part.rest.ty + local.y);
  }
  renderPose();
}

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
 */
export function bindPartsToBones(arts: RigPart[], bones: RigPart[]): void {
  if (arts.length === 0 || bones.length === 0) return;
  const doc = state.doc;
  if (!doc) return;
  const skinBones = bones.map(skinBoneOf);
  const freshBones = (): SkinBone[] =>
    skinBones.map((b) => ({ ...b, bindSeg: { p: { ...b.bindSeg.p }, q: { ...b.bindSeg.q } } }));
  // Each bone's WORLD matrix BEFORE any art mutation — needed to keep a bone's world
  // fixed when its parent art's rest pose (which it rides) gets baked away below.
  const boneWorlds = new Map(
    bones.map((b) => [b.id, matrixOfTransform(fullPoseTransform(b, null))]),
  );
  const bakedArtIds = new Set<string>();

  for (const part of arts) {
    if (part.skin) {
      const overrides = part.skin.overrides;
      part.skin = { bones: freshBones(), ...(overrides ? { overrides } : {}) };
      invalidateSkinCache(part.id);
      continue;
    }
    const full = matrixOfTransform(groupTransformOf(part, null));
    for (const path of part.paths) {
      const m = multiply(full, matrixOfTransform(path.transform));
      const cmds = pathToCubics(parsePath(path.d)).map((c) => {
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
    part.pivot = effectivePivot(part, null);
    part.transform = '';
    part.rest = { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 };
    part.parentId = null;
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

/**
 * Fraction of a bone chain's length that actually lies inside an art part's FILLED
 * geometry (Bones 2.0 auto-bind targeting). Each chain segment is sampled and every
 * sample is hit-tested against the part's rendered <path> fills via the live DOM
 * `isPointInFill` — mapping root→screen (rootGroup CTM) →path-local (path CTM). A bbox
 * that merely brushes the joint (the old test) no longer counts; a real limb the chain
 * runs down does. Returns 0 when the DOM/geometry isn't measurable.
 */
function chainFillCoverage(part: RigPart, segs: { p: { x: number; y: number }; q: { x: number; y: number } }[]): number {
  const g = ctx.partGroups.get(part.id);
  const rootCTM = ctx.rootGroup?.getScreenCTM();
  if (!g || !rootCTM || !ctx.svg) return 0;
  const paths = Array.from(g.querySelectorAll<SVGPathElement>('path'))
    .filter((pe) => typeof pe.isPointInFill === 'function' && pe.getAttribute('fill') !== 'none');
  if (paths.length === 0) return 0;
  const invByPath = paths.map((pe) => {
    const m = pe.getScreenCTM();
    return m ? { pe, inv: m.inverse() } : null;
  }).filter((x): x is { pe: SVGPathElement; inv: DOMMatrix } => !!x);
  const SAMPLES_PER_SEG = 12;
  let total = 0, inside = 0;
  const sp = ctx.svg.createSVGPoint();
  for (const s of segs) {
    for (let i = 0; i <= SAMPLES_PER_SEG; i++) {
      const f = i / SAMPLES_PER_SEG;
      total++;
      sp.x = s.p.x + (s.q.x - s.p.x) * f;
      sp.y = s.p.y + (s.q.y - s.p.y) * f;
      const screen = sp.matrixTransform(rootCTM); // root-content → screen
      for (const { pe, inv } of invByPath) {
        const lp = screen.matrixTransform(inv); // screen → path-local (`d` space)
        const dp = ctx.svg.createSVGPoint();
        dp.x = lp.x; dp.y = lp.y;
        if (pe.isPointInFill(dp)) { inside++; break; }
      }
    }
  }
  return total > 0 ? inside / total : 0;
}

/** A meaningful fraction of the chain must lie inside a part's fill to auto-bind it. */
const AUTO_BIND_COVERAGE = 0.34;

/**
 * Bones 2.0 AUTO-BIND (redesigned): after a bone is placed, resolve its full chain
 * (root bone + every descendant bone) and skin the RIGHT art with zero manual steps —
 * the arm bends, the body does NOT. Targeting order (most predictable first):
 *   1. Art already skinned by any bone in this chain — keep it bound as the chain grows
 *      (later child bones extend the same limb; they never grab new parts).
 *   2. Otherwise, if the user has art SELECTED when placement finishes, bind exactly
 *      that (limit to selection — predictable "I'm rigging THIS part").
 *   3. Otherwise, the geometric fallback: bind every art part whose FILLED geometry a
 *      meaningful fraction of the chain runs through (`chainFillCoverage`), replacing
 *      the old far-too-eager segment↔bbox test that bound anything the joint grazed.
 * Binds nothing when no art qualifies (silent). Does NOT checkpoint/render — the
 * placement gesture owns the single checkpoint and final repaint.
 */
export function autoBindPlacedBone(boneId: string): void {
  const doc = state.doc;
  if (!doc) return;
  const chain = boneChain(doc.parts, boneId);
  if (chain.length === 0) return;
  const chainIds = new Set(chain.map((b) => b.id));

  // 1. Art already bound to this chain — always refresh it (keeps the limb set stable).
  const alreadyBound = doc.parts.filter(
    (p) => p.kind === 'art' && p.paths.length > 0 && p.skin
      && p.skin.bones.some((b) => chainIds.has(b.id)),
  );
  if (alreadyBound.length > 0) {
    bindPartsToBones(alreadyBound, chain);
    return;
  }

  // 2. A selected art part limits the bind to itself (predictable).
  const selectedArt = selectedParts().filter((p) => p.kind === 'art' && p.paths.length > 0);
  if (selectedArt.length > 0) {
    bindPartsToBones(selectedArt, chain);
    return;
  }

  // 3. Geometric fallback: which filled art does the chain actually run through?
  const t = poseTime();
  const segs = chain.map((b) => {
    const p = effectivePivot(b, t);
    const q = effectiveTip(b, t) ?? { x: p.x + 5, y: p.y };
    return { p, q };
  });
  const targets = doc.parts.filter(
    (p) => p.kind === 'art' && p.paths.length > 0 && chainFillCoverage(p, segs) >= AUTO_BIND_COVERAGE,
  );
  if (targets.length === 0) return; // no art under the chain — bind nothing
  bindPartsToBones(targets, chain);
}

// ---- Per-node weight overrides (Bones 2.0 manual refinement) ----

export interface NodeBindingInfo {
  pathId: string;
  cmdIndex: number;
  override: SkinOverride | null;
}

/** The primary selected node's current binding (auto vs override), for the inspector. */
export function primaryNodeBinding(): NodeBindingInfo | null {
  const part = selectedPart();
  if (!part?.skin || !ctx.selectedNode) return null;
  const { pathId, cmdIndex } = ctx.selectedNode;
  const ov = part.skin.overrides?.[pathId]?.[String(cmdIndex)];
  return { pathId, cmdIndex, override: ov ? { ...ov } : null };
}

/**
 * Pin every selected node's weight to bone `a` at (1−t) blended with bone `b` at t
 * (b null = 100% a). Both ids must reference the part's bound bones. Caller checkpoints.
 */
export function setNodeBinding(a: string, b: string | null, t: number): boolean {
  const part = selectedPart();
  if (!part?.skin || ctx.selectedNodes.size === 0) return false;
  const boneIds = new Set(part.skin.bones.map((bb) => bb.id));
  if (!boneIds.has(a)) return false;
  const bb = b && b !== a && boneIds.has(b) ? b : null;
  const overrides = part.skin.overrides ?? (part.skin.overrides = {});
  const value: SkinOverride = { a, b: bb, t: Math.min(1, Math.max(0, t)) };
  for (const key of ctx.selectedNodes) {
    const { pathId, cmdIndex } = parseNodeKey(key);
    (overrides[pathId] ?? (overrides[pathId] = {}))[String(cmdIndex)] = { ...value };
  }
  invalidateSkinCache(part.id);
  renderPose();
  return true;
}

/**
 * The (a,b,t) override target for the node-editing "bind to bone…" quick action: bone
 * `boneId` plus which of ITS ends the selected nodes sit at — its origin (the joint
 * shared with its parent) or its tip (the joint shared with its child). `a` is always
 * the picked bone; `b` is the neighbor bone on that side WITHIN the part's own chain, or
 * null when none exists there (a chain root has no parent bone; a leaf has no child) —
 * `overrideWeightRow` collapses a null `b` to 100% `a` regardless of `t`, so that case is
 * "100% single-bone" automatically. When a neighbor does exist, t=0.5 blends evenly
 * across the shared joint (refinable afterward with the inspector's existing % slider).
 */
export function quickNodeBindTarget(
  part: RigPart, boneId: string, end: 'origin' | 'tip',
): { a: string; b: string | null; t: number } | null {
  const chain = chainBonesOfPart(state.doc?.parts ?? [], part);
  const x = chain.find((b) => b.id === boneId);
  if (!x) return null;
  const neighbor = end === 'tip'
    ? chain.find((b) => b.parentId === x.id) ?? null
    : chain.find((b) => b.id === x.parentId) ?? null;
  return { a: x.id, b: neighbor?.id ?? null, t: neighbor ? 0.5 : 0 };
}

/**
 * Node-editing "bind to bone…" (replaces the old top-bar whole-part bind button):
 * selecting a bone tip/origin ALONGSIDE node selection is structurally impossible (node
 * mode's pointerdown routing claims every canvas click for bend/marquee before a part
 * selection could land — `interactions.ts`), so this always drives the picker dialog
 * rather than trying a "co-selected bone" fast path. If `part` isn't already skinned by
 * its own chain, this binds it first (the whole-part bind stays available
 * PROGRAMMATICALLY — `bindPartsToBones`, which auto-bind also calls — just not from a
 * toolbar button any more), then pins every selected node per `quickNodeBindTarget`.
 * Caller checkpoints.
 */
export function bindSelectedNodesToBone(
  part: RigPart, boneId: string, end: 'origin' | 'tip',
): boolean {
  const chain = chainBonesOfPart(state.doc?.parts ?? [], part);
  if (chain.length === 0 || ctx.selectedNodes.size === 0) return false;
  if (!part.skin) bindPartsToBones([part], chain);
  const target = quickNodeBindTarget(part, boneId, end);
  if (!target) return false;
  return setNodeBinding(target.a, target.b, target.t);
}

/** Clear per-node overrides on every selected node (caller checkpoints). */
export function clearNodeBinding(): boolean {
  const part = selectedPart();
  const overrides = part?.skin?.overrides;
  if (!part || !overrides || ctx.selectedNodes.size === 0) return false;
  let changed = false;
  for (const key of ctx.selectedNodes) {
    const { pathId, cmdIndex } = parseNodeKey(key);
    const rec = overrides[pathId];
    if (rec && String(cmdIndex) in rec) {
      delete rec[String(cmdIndex)];
      changed = true;
      if (Object.keys(rec).length === 0) delete overrides[pathId];
    }
  }
  if (Object.keys(overrides).length === 0) delete part.skin!.overrides;
  if (changed) {
    invalidateSkinCache(part.id);
    renderPose();
  }
  return changed;
}

/** Drop ALL per-node overrides on the selected part ("recompute auto weights"). */
export function resetNodeBindings(): boolean {
  const part = selectedPart();
  if (!part?.skin?.overrides) return false;
  delete part.skin.overrides;
  invalidateSkinCache(part.id);
  renderPose();
  return true;
}

/**
 * Recompute auto weights for the selected skinned part: drop any per-node overrides and
 * rebuild the runtime weight cache from the current bones. Enabled whenever the part is
 * skinned (the inspector button used to gray out unless overrides existed — the reported
 * "always disabled" bug). Returns whether overrides were actually dropped, so the caller
 * only spends an undo step when the doc changed.
 */
export function recomputeAutoWeights(): boolean {
  const part = selectedPart();
  if (!part?.skin) return false;
  const hadOverrides = !!part.skin.overrides;
  if (hadOverrides) delete part.skin.overrides;
  invalidateSkinCache(part.id);
  renderPose();
  return hadOverrides;
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

// ---- Bone reshaping (the freeze / non-freeze pose model) ----
//
// A bone is posed by ROTATION (around its origin) + LENGTH (its tip). There is no free
// translation of a bone — a child bone's origin IS its parent's tip (one shared joint),
// so translating a bone independently would tear the chain apart. Reshaping a bone rotates
// its rest, which deforms any skinned art through the existing LBS delta-from-bind (art
// follows). In FREEZE mode the SAME reshapes run but the bind reference is refreshed so the
// art stays put (the rig is fitted against static art) — see refreshBindForChain below.

/**
 * Reshape a bone to reach `targetRoot` (root coords): AIM it (rotate `rest.rotate` so the
 * origin→tip ray points at the target — this rotates any skinned art via the LBS delta) and
 * set its LENGTH (its tip lands exactly on the target). Direct child origins ride the new tip
 * (the shared joint stays connected; deeper joints stay connected through inheritance). The
 * caller owns the checkpoint, freeze re-bind, and repaint.
 */
export function aimBoneAtTip(
  bone: RigPart, targetRoot: { x: number; y: number }, t: number | null,
): void {
  const doc = state.doc;
  if (!doc) return;
  const origin = effectivePivot(bone, t);
  const curTip = effectiveTip(bone, t) ?? { x: origin.x + 5, y: origin.y };
  const curAng = Math.atan2(curTip.y - origin.y, curTip.x - origin.x);
  const tgtAng = Math.atan2(targetRoot.y - origin.y, targetRoot.x - origin.x);
  const dDeg = (wrapToPi(tgtAng - curAng) * 180) / Math.PI;
  bone.rest.rotate = round1(bone.rest.rotate + dDeg);
  // Set the tip so the rendered tip lands exactly on the target (length captured), measured
  // against the freshly-rotated pose so effectiveTip == targetRoot.
  const invNew = invertMat(matrixOfTransform(fullPoseTransform(bone, t)));
  const tipLocal = applyMat(invNew, targetRoot.x, targetRoot.y);
  bone.boneTip = { x: round1(tipLocal.x), y: round1(tipLocal.y) };
  carryChildOrigins(bone, t);
}

/**
 * Glue each direct child bone's origin to this bone's tip (the shared joint), preserving
 * every descendant's own LOCAL geometry: a child's `boneTip − pivot` vector (its length
 * and direction relative to its own rotation) must stay byte-identical when its origin is
 * carried onto a moved joint, or it silently shortens/lengthens as a side effect of its
 * PARENT reshaping (the reported bug). Shifting `boneTip` by the exact same delta as
 * `pivot` keeps that vector exactly unchanged — the delta cancels algebraically — then
 * recurses so grandchildren ride this child's (now also moved) tip. round3, not round1:
 * double-rounding pivot and boneTip independently at the coarser 0.1 grid could itself
 * introduce up to ~0.1 of drift in the preserved length. Mirrors `core/model.ts`'s
 * `carryChildBoneOrigins` (the inspector length-field path); freeze mode's bind refresh
 * runs on top of this and needs no separate handling — the geometry it re-binds is
 * already correct either way.
 */
export function carryChildOrigins(bone: RigPart, t: number | null): void {
  const doc = state.doc;
  if (!doc || !bone.boneTip) return;
  for (const child of doc.parts) {
    if (child.kind !== 'bone' || child.parentId !== bone.id) continue;
    const ot = ownTranslateOf(child, t);
    const newPivot = { x: round3(bone.boneTip.x - ot.x), y: round3(bone.boneTip.y - ot.y) };
    if (child.boneTip) {
      const dx = newPivot.x - child.pivot.x;
      const dy = newPivot.y - child.pivot.y;
      child.boneTip = { x: round3(child.boneTip.x + dx), y: round3(child.boneTip.y + dy) };
    }
    child.pivot = newPivot;
    carryChildOrigins(child, t);
  }
}

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
    const g = ctx.partGroups.get(part.id);
    if (g) {
      for (const path of part.paths) {
        const el = g.querySelector<SVGPathElement>(`[data-path-id="${path.id}"]`);
        const dNow = el?.getAttribute('d');
        if (dNow) path.d = dNow; // freeze the current look into the rest geometry
      }
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

// ---- Bone placement ----

/** Arm click-to-place: the next canvas click drops a bone (parented to the selection). */
export function startBonePlacement(): void {
  ctx.placingBone = true;
  if (ctx.svg) ctx.svg.style.cursor = 'crosshair';
}

/** Returns whether placement was active (Escape handling). */
export function cancelBonePlacement(): boolean {
  const was = ctx.placingBone;
  ctx.placingBone = false;
  if (ctx.svg) ctx.svg.style.cursor = '';
  return was;
}

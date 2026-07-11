/**
 * Rig-structure operations invoked from the toolbar / inspector / keyboard: flip,
 * arrow-key nudge, align/distribute application, linear-blend skin bind/unbind, and
 * click-to-place bone arming. These mutate the doc (rest pose, geometry, skin) and
 * repaint; the caller checkpoints history where appropriate.
 */

import {
  state, selectedParts, selectedPart, setKeyframe, channelValue, boneChain,
  RigPart, SkinBone, SkinOverride,
} from '../core/model';
import { parsePath, serializePath, pathToCubics, PathCmd } from '../geometry/paths';
import { applyMat, invertMat, matrixOfTransform, multiply, Mat } from '../geometry/transforms';
import { ctx, linearOnly, parseNodeKey, round1, round3 } from './context';
import {
  poseTime, groupTransformOf, chainMatOf, effectivePivot, effectiveTip, fullPoseTransform,
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
  // arts whose rotation lived in `part.transform` not `rest`, never showed it). Fix: move
  // each such bone to root and FOLD the (rigid) art pose it lost into the bone's own rest,
  // so its world — hence the identity rest delta and the whole child sub-chain — is
  // preserved exactly.
  for (const bone of bones) {
    if (!bone.parentId || !bakedArtIds.has(bone.parentId)) continue;
    reparentBoneToRootPreservingWorld(bone, boneWorlds.get(bone.id)!);
    invalidateSkinCache(bone.id);
  }
}

/**
 * Re-parent a bone to root while keeping its world transform `W` byte-stable: fold the
 * ancestor pose it loses into its own rest (rotate + translate around its unchanged
 * pivot). `W` is a product of rigid ownPoses (rotate + translate, no scale), so the
 * decomposition is exact; the pivot stays put so effectivePivot/effectiveTip — and any
 * child bones riding this one — are unchanged.
 */
function reparentBoneToRootPreservingWorld(bone: RigPart, W: Mat): void {
  bone.parentId = null;
  const rotDeg = round3((Math.atan2(W.b, W.a) * 180) / Math.PI);
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const { x: px, y: py } = bone.pivot;
  // ownPose = translate(tx,ty)·rotate(rotDeg, pivot); its matrix translation is
  // (tx,ty) + pivot − Rot·pivot, so solve (tx,ty) to reproduce W's translation.
  bone.rest.rotate = rotDeg;
  bone.rest.tx = round3(W.e - px + (cos * px - sin * py));
  bone.rest.ty = round3(W.f - py + (sin * px + cos * py));
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

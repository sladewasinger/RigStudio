/**
 * Skeletal-deformation emission for the .riv exporter: Skin + Tendon per skinned
 * PointsPath, one CubicWeight per vertex — so bone rotation keys articulate skinned
 * limbs in the official Rive runtimes instead of the old rigid-at-rest export.
 *
 * THE FRAME MODEL (why this reproduces the editor's LBS exactly). The editor deforms a
 * skinned part's bind-baked, DOC-SPACE rest geometry by per-bone deltas
 * `fullPose(bone, t) · restWorldInv` (view/skinRender.ts). The exporter's verified node
 * placement gives every part's Rive world transform as
 * `T(-frameOrigin) · fullPose(part, t) · T(part.pivot)` — the same pose matrix, shifted
 * by the artboard reference frame and the pivot-relative node origin. So:
 *
 *   - Skin bind (xx..ty) = T(part.pivot - frameOrigin): stored vertices are
 *     `docPoint - pivot` (scene.ts's geometry emission, identity baked matrix for a
 *     bind-baked path), and the runtime applies the skin matrix FIRST
 *     (weight.cpp: `blended * (world * inPoint)`), reconstructing the doc-space bind
 *     position in artboard coordinates. The pivot subtraction cancels EXACTLY whatever
 *     frame `part.pivot` lives in (a bind-baked part stores it post-chain-local).
 *   - Tendon bind (xx..ty) = the bone's Rive world transform AT THE BIND POSE:
 *     `invert(restWorldInv) · T(bone.pivot)`, frame-shifted. The runtime computes
 *     `boneWorldNow · invert(tendonBind)` per frame (skin.cpp), which telescopes to
 *     `T(-frameOrigin) · fullPose(bone, t) · restWorldInv · T(+frameOrigin)` — the
 *     editor's delta conjugated into artboard space. Using the STORED restWorldInv
 *     (not a recomputed rest world) matters: after a non-freeze bone reshape the rest
 *     pose deforms away from the bind pose ON PURPOSE, and the export must show it.
 *   - Weights: the same auto rows (`skinWeights` at each sample's own position,
 *     `SKIN_WEIGHT_POWER`) + per-node overrides as skinRender, quantized to Rive's
 *     4-influence byte model (values sum to 255; indices are 1-BASED tendon slots —
 *     skin.cpp keeps identity at slot 0).
 *
 * Known divergence (documented, matches the editor's own animation-time behavior): the
 * editor's per-bone LENGTH-stretch term only differs from identity while a rest length
 * differs from its bind length (an Edit-mode reshape state); length is not keyable, so
 * runtime playback never stretches — the rigid tendon delta is the faithful export.
 *
 * PIN-TO-REST (2026-07-14). A pinned node (SkinOverride.pin, CLAUDE.md's Bone system
 * section) holds a fraction of its position at its own BIND/rest coordinate regardless
 * of what any real bone does — matching view/skinRender.ts's `pin` lerp exactly. Real
 * Tendons can't express "stay put"; a WEIGHT can, though, so a part with ANY pinned node
 * gets ONE extra synthetic, NEVER-ANIMATED RootBone ("<part> anchor", identity local
 * transform, child of the part's own Node — see `attachPinAnchor`) plus its own Tendon,
 * and each pinned node's `pin` fraction becomes an extra quantized influence on that
 * anchor's tendon slot: `newRow[bone] = row[bone]*(1-pin)` for every real bone,
 * `newRow[anchor] = pin` (sums to 1, since `row` already does). The anchor's tendon bind
 * is computed as the part's own STATIC (never-keyed) Rive-world matrix, so its per-frame
 * delta (`boneWorldNow · invert(tendonBind)`) is IDENTITY whenever nothing about the part
 * or its ancestors is keyed (the overwhelmingly common case — a skinned part's own
 * rotate/tx/ty is rarely itself animated; when it IS, the anchor rides along with that
 * rigid motion but still ignores individual bone bends, which is the useful behavior:
 * "stay with the body, not with THIS bone" — a documented latent divergence in the same
 * class as CLAUDE.md's keyed-scale-propagation note). A skin with ZERO pinned nodes never
 * calls into this machinery at all (`attachPinAnchor` is a strict no-op) — the byte-
 * identity requirement for pin-less docs (goldenRiv.test.ts's two pins) depends on that.
 */

import { RigDoc, RigPart, SkinOverride } from '../../core/model';
import { Seg, skinWeights, overrideWeightRow, SKIN_WEIGHT_POWER } from '../../geometry/skin';
import {
  Mat, invertMat, multiply, rotationMat, translationMat,
} from '../../geometry/transforms';
import { RivSubpath, WeightSample } from './geometry';
import { Scene } from './writer';
import {
  P_NAME, P_PARENT_ID, P_ROOT_BONE_X, P_ROOT_BONE_Y, P_SKIN_TX, P_SKIN_TY, P_SKIN_XX,
  P_SKIN_XY, P_SKIN_YX, P_SKIN_YY, P_TENDON_BONE_ID, P_TENDON_TX, P_TENDON_TY,
  P_TENDON_XX, P_TENDON_XY, P_TENDON_YX, P_TENDON_YY, P_WEIGHT_IN_INDICES,
  P_WEIGHT_IN_VALUES, P_WEIGHT_INDICES, P_WEIGHT_OUT_INDICES, P_WEIGHT_OUT_VALUES,
  P_WEIGHT_VALUES, T_CUBIC_WEIGHT, T_ROOT_BONE, T_SKIN, T_TENDON,
} from './keys';

/** Everything needed to emit one part's Skin objects, resolved once per part. */
export interface SkinPlan {
  boneIds: string[];
  boneNodeIndex: number[];
  /** Per bone: its Rive-world bind matrix (frame-shifted) — the Tendon properties. */
  tendonBinds: Mat[];
  segs: Seg[];
  skinTx: number;
  skinTy: number;
  overrides: Record<string, Record<string, SkinOverride>>;
  /**
   * Set by `attachPinAnchor` (called once per part, after `buildSkinPlan`, before any of
   * its paths are emitted) when ANY node in `overrides` carries a pin > 0: the synthetic
   * anchor RootBone's component index and its (translate+rotate) tendon bind matrix. Null
   * for every plan with zero pins — see this file's header for why that must stay a
   * strict no-op.
   */
  anchorBoneIndex: number | null;
  anchorTendonBind: Mat | null;
}

/**
 * Resolve a part's skin into an emission plan, or null for the RIGID FALLBACK (exactly
 * the pre-wave bytes): no skin, an empty bone list, a bone that is hidden (it got no
 * component — hidden parts are FULLY excluded), a dangling/non-bone reference, or
 * non-finite bind data. The live renderer degrades per-bone; the export prefers the
 * predictable whole-part fallback over emitting a tendon the runtime would reject.
 */
export function buildSkinPlan(
  doc: RigDoc, part: RigPart, partIndex: Map<string, number>, ox: number, oy: number,
): SkinPlan | null {
  const skin = part.skin;
  if (!skin || !Array.isArray(skin.bones) || skin.bones.length === 0) return null;
  const byId = new Map(doc.parts.map((p) => [p.id, p]));
  const plan: SkinPlan = {
    boneIds: [], boneNodeIndex: [], tendonBinds: [], segs: [],
    skinTx: part.pivot.x - ox, skinTy: part.pivot.y - oy,
    overrides: skin.overrides ?? {},
    anchorBoneIndex: null, anchorTendonBind: null,
  };
  for (const sb of skin.bones) {
    const bone = byId.get(sb.id);
    const nodeIndex = partIndex.get(sb.id);
    if (!bone || bone.kind !== 'bone' || nodeIndex === undefined) return null;
    const bindWorld = multiply(invertMat(sb.restWorldInv), {
      a: 1, b: 0, c: 0, d: 1, e: bone.pivot.x, f: bone.pivot.y,
    });
    const bind = { ...bindWorld, e: bindWorld.e - ox, f: bindWorld.f - oy };
    if (![bind.a, bind.b, bind.c, bind.d, bind.e, bind.f].every(Number.isFinite)) return null;
    plan.boneIds.push(sb.id);
    plan.boneNodeIndex.push(nodeIndex);
    plan.tendonBinds.push(bind);
    plan.segs.push(sb.bindSeg);
  }
  return plan;
}

/** Emit the Skin (child of `pathComponentIndex`) and its Tendons, in skin.bones order —
 *  tendon k is the runtime's bone-transform slot k+1, which packRow encodes below. When
 *  `plan.anchorBoneIndex` is set (PIN-TO-REST), one more Tendon is appended for the
 *  synthetic anchor, at slot `boneIds.length + 1` — see subpathWeights/packRow. */
export function emitSkin(scene: Scene, plan: SkinPlan, pathComponentIndex: number): void {
  const skinIndex = scene.begin(T_SKIN);
  scene.propUint(P_PARENT_ID, pathComponentIndex);
  scene.propDouble(P_SKIN_XX, 1);
  scene.propDouble(P_SKIN_YX, 0);
  scene.propDouble(P_SKIN_XY, 0);
  scene.propDouble(P_SKIN_YY, 1);
  scene.propDouble(P_SKIN_TX, plan.skinTx);
  scene.propDouble(P_SKIN_TY, plan.skinTy);
  scene.end();
  const emitTendon = (boneNodeIndex: number, bind: Mat) => {
    scene.begin(T_TENDON);
    scene.propUint(P_PARENT_ID, skinIndex);
    scene.propUint(P_TENDON_BONE_ID, boneNodeIndex);
    scene.propDouble(P_TENDON_XX, bind.a);
    scene.propDouble(P_TENDON_YX, bind.c);
    scene.propDouble(P_TENDON_XY, bind.b);
    scene.propDouble(P_TENDON_YY, bind.d);
    scene.propDouble(P_TENDON_TX, bind.e);
    scene.propDouble(P_TENDON_TY, bind.f);
    scene.end();
  };
  for (let k = 0; k < plan.boneIds.length; k++) {
    emitTendon(plan.boneNodeIndex[k], plan.tendonBinds[k]);
  }
  if (plan.anchorBoneIndex != null && plan.anchorTendonBind) {
    emitTendon(plan.anchorBoneIndex, plan.anchorTendonBind);
  }
}

/** Whether ANY node override in `plan` carries a pin fraction > 0 — gates the synthetic
 *  anchor bone emission below. Pure, no scene/doc access needed. */
function planHasPin(plan: SkinPlan): boolean {
  return Object.values(plan.overrides).some(
    (rec) => Object.values(rec).some((ov) => (ov.pin ?? 0) > 0),
  );
}

/**
 * Mirrors scene.ts's per-part Node placement (translate to the pivot-relative base +
 * rest.tx/ty, then rotate by rest.rotate about that NEW local origin — Rive's Node
 * transform order), composed root-to-leaf, so it reconstructs the exact STATIC (unkeyed)
 * Rive-world matrix of `part`'s own Node in frame-shifted (artboard) space. Real bones
 * capture this via a live-measured `restWorldInv` (which also encodes any post-bind
 * reshape); a part's OWN world has no such bind history to encode — recomputing it fresh
 * from rest.* is exact PROVIDED neither the part nor an ancestor has a KEYED rotate/tx/ty
 * (see this file's header for why that's an acceptable, documented latent divergence).
 */
function staticPartWorld(doc: RigDoc, part: RigPart, ox: number, oy: number): Mat {
  const byId = new Map(doc.parts.map((p) => [p.id, p]));
  const chain: RigPart[] = [];
  const seen = new Set<string>();
  let cur: RigPart | undefined = part;
  while (cur && !seen.has(cur.id)) {
    chain.unshift(cur);
    seen.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  let world = translationMat(doc.rootPivot.x - ox, doc.rootPivot.y - oy);
  let parentRef = doc.rootPivot;
  for (const p of chain) {
    const baseX = p.pivot.x - parentRef.x;
    const baseY = p.pivot.y - parentRef.y;
    const local = multiply(
      translationMat(baseX + p.rest.tx, baseY + p.rest.ty),
      rotationMat(p.rest.rotate),
    );
    world = multiply(world, local);
    parentRef = p.pivot;
  }
  return world;
}

/**
 * When `plan` has any pinned node, emit ONE synthetic STATIC anchor RootBone (identity
 * local transform, child of the part's own Node, never animated/keyed) and resolve its
 * tendon bind, recording both on `plan` — `emitSkin` then adds its Tendon and
 * `subpathWeights` folds each node's pin fraction in as one more quantized influence.
 * A strict no-op (`plan.anchorBoneIndex` stays null) when nothing is pinned — the
 * byte-identity requirement for pin-less docs depends on that. Must run once per part,
 * AFTER `buildSkinPlan` and BEFORE any of that part's paths are emitted (its Tendon
 * needs an already-emitted bone component to reference).
 */
export function attachPinAnchor(
  scene: Scene, doc: RigDoc, part: RigPart, plan: SkinPlan, partNodeIndex: number,
  ox: number, oy: number,
): void {
  if (!planHasPin(plan)) return;
  const anchorIndex = scene.begin(T_ROOT_BONE);
  scene.propUint(P_PARENT_ID, partNodeIndex);
  scene.propString(P_NAME, `${part.label} anchor`);
  scene.propDouble(P_ROOT_BONE_X, 0);
  scene.propDouble(P_ROOT_BONE_Y, 0);
  scene.end();
  plan.anchorBoneIndex = anchorIndex;
  plan.anchorTendonBind = staticPartWorld(doc, part, ox, oy);
}

/** One vertex's packed CubicWeight payload (point + in-handle + out-handle). */
export interface PackedVertexWeight {
  values: number; indices: number;
  inValues: number; inIndices: number;
  outValues: number; outIndices: number;
}

/**
 * Weight rows for every vertex of one emitted subpath, mirroring skinRender: the auto
 * row is computed at each sample's OWN position; a per-node override (keyed by the
 * sample's recorded command index) replaces it. Null handle samples reuse the point's
 * row (zero-distance handle — stays glued to its endpoint). PIN-TO-REST: when the plan
 * has an anchor (see attachPinAnchor), a sample's pin fraction scales down its bone row
 * by (1-pin) and appends `pin` as one more entry at the anchor's row position
 * (`boneIds.length`) — mirrors skinRender.ts's `lerp(lbsResult, restPosition, pin)`
 * exactly, since the anchor's own contribution reconstructs the rest position (see this
 * file's header).
 */
export function subpathWeights(
  plan: SkinPlan, pathId: string, sub: RivSubpath,
): PackedVertexWeight[] {
  const pathOverrides = plan.overrides[pathId] ?? {};
  const anchorRowIndex = plan.anchorBoneIndex != null ? plan.boneIds.length : null;
  const rowFor = (s: WeightSample): number[] => {
    const ov = pathOverrides[String(s.node)];
    const pinned = ov && overrideWeightRow(plan.boneIds, ov);
    const base = pinned || skinWeights([{ x: s.x, y: s.y }], plan.segs, SKIN_WEIGHT_POWER)[0];
    if (anchorRowIndex == null) return base;
    const pin = ov && Number.isFinite(ov.pin) ? Math.min(1, Math.max(0, ov.pin!)) : 0;
    if (pin <= 0) return base;
    const row = base.map((w) => w * (1 - pin));
    row[anchorRowIndex] = pin;
    return row;
  };
  return sub.verts.map((v) => {
    const pt = packRow(rowFor(v.src.pt), anchorRowIndex ?? undefined);
    const inW = v.src.in ? packRow(rowFor(v.src.in), anchorRowIndex ?? undefined) : pt;
    const outW = v.src.out ? packRow(rowFor(v.src.out), anchorRowIndex ?? undefined) : pt;
    return {
      values: pt.values, indices: pt.indices,
      inValues: inW.values, inIndices: inW.indices,
      outValues: outW.values, outIndices: outW.indices,
    };
  });
}

/**
 * Quantize one normalized weight row into Rive's packed 4-influence bytes: keep the 4
 * largest influences, renormalize, and largest-remainder round so the bytes sum to
 * EXACTLY 255 (weight.cpp divides each byte by 255 and sums — a short total scales the
 * vertex toward the origin). Indices are 1-based tendon slots, packed little-endian
 * byte-per-influence, sorted by tendon for deterministic bytes; unused slots stay 0/0.
 *
 * `mustKeepIndex` (PIN-TO-REST): when given and `row[mustKeepIndex] > 0`, that influence
 * is GUARANTEED to survive the 4-influence cap — a user who pins a node expects it held,
 * not silently dropped because 4 real bones already out-weigh it. If the natural top-4
 * selection already includes it, this is a no-op; otherwise the WEAKEST currently-picked
 * influence is evicted to make room (ties broken toward the lowest currently-picked index,
 * found first by the scan below — deterministic). Note: "evict" is always the right move
 * here, never "append" — a genuine nonzero must-keep candidate is only EVER missing from
 * the plain top-4 selection when MORE than 4 candidates existed overall (a shorter
 * candidate list keeps everything, must-keep included), so `picked` is already exactly at
 * the 4-cap whenever eviction is needed. Omitted/undefined (every call site without a
 * pinned plan) reproduces the exact pre-existing algorithm byte-for-byte.
 */
export function packRow(row: number[], mustKeepIndex?: number): { values: number; indices: number } {
  const nonZero = row.map((w, i) => ({ w, i })).filter((e) => e.w > 0);
  let picked = nonZero.slice().sort((a, b) => b.w - a.w || a.i - b.i).slice(0, 4);
  if (mustKeepIndex !== undefined) {
    const anchor = nonZero.find((e) => e.i === mustKeepIndex);
    if (anchor && !picked.some((e) => e.i === mustKeepIndex) && picked.length > 0) {
      let weakest = 0;
      for (let i = 1; i < picked.length; i++) if (picked[i].w < picked[weakest].w) weakest = i;
      picked[weakest] = anchor;
    }
  }
  picked = picked.sort((a, b) => a.i - b.i);
  if (picked.length === 0) return { values: 255, indices: 1 }; // degenerate: pin to tendon 1
  const sum = picked.reduce((acc, e) => acc + e.w, 0);
  const exact = picked.map((e) => (e.w / sum) * 255);
  const bytes = exact.map(Math.floor);
  let remainder = 255 - bytes.reduce((acc, b) => acc + b, 0);
  const order = exact
    .map((x, k) => ({ frac: x - bytes[k], k }))
    .sort((a, b) => b.frac - a.frac || a.k - b.k);
  for (let j = 0; remainder > 0; j = (j + 1) % order.length, remainder--) {
    bytes[order[j].k]++;
  }
  let values = 0, indices = 0;
  picked.forEach((e, k) => {
    values |= bytes[k] << (k * 8);
    indices |= (e.i + 1) << (k * 8);
  });
  return { values: values >>> 0, indices: indices >>> 0 };
}

/** Emit one vertex's CubicWeight (child of the vertex component just written). */
export function emitVertexWeight(
  scene: Scene, vertexComponentIndex: number, w: PackedVertexWeight,
): void {
  scene.begin(T_CUBIC_WEIGHT);
  scene.propUint(P_PARENT_ID, vertexComponentIndex);
  scene.propUint(P_WEIGHT_VALUES, w.values);
  scene.propUint(P_WEIGHT_INDICES, w.indices);
  scene.propUint(P_WEIGHT_IN_VALUES, w.inValues);
  scene.propUint(P_WEIGHT_IN_INDICES, w.inIndices);
  scene.propUint(P_WEIGHT_OUT_VALUES, w.outValues);
  scene.propUint(P_WEIGHT_OUT_INDICES, w.outIndices);
  scene.end();
}

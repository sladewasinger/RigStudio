/**
 * Keyframed DRAW ORDER (the editor's stepped `z` channel, core/docTypes.ts's Channel doc
 * comment) via Rive's DrawRules/DrawTarget mechanism. Zero overhead for docs that never key
 * `z`: nothing in this file runs unless a part actually has z keyframes.
 *
 * MECHANISM (rive-runtime, main branch, fetched 2026-07-13 — dev/defs + src, not memory):
 *  - dev/defs/draw_rules.json: DrawRules (typeKey 49) has ONE animatable property,
 *    drawTargetId (propertyKey 121, Id/uint, "Id of the DrawTarget that is currently
 *    active for this set of rules"). It is a normal artboard COMPONENT (consumes an
 *    index), parented (component.json's parentId) to whatever it governs.
 *    src/artboard.cpp's Artboard::initialize() walks EVERY Drawable up its OWN parent
 *    chain (starting at the drawable itself) and assigns it the flattenedDrawRules of the
 *    FIRST ancestor with a DrawRules parented to it. We parent a part's DrawRules directly
 *    to that PART's own Node, so it governs exactly that part's own Shapes (which are
 *    Shape's children) and nothing beyond it UNLESS a descendant part lacks its own
 *    DrawRules — see hasUnguardedShapeDescendant below, which is why such parts are
 *    skipped rather than risking a hierarchy-independence violation.
 *  - dev/defs/draw_target.json: DrawTarget (typeKey 48) has drawableId (119, Id — the
 *    ANCHOR drawable) and placementValue (120, uint — DrawTargetPlacement,
 *    include/rive/draw_target_placement.hpp: before=0, after=1). DrawTargets are parented
 *    to the DrawRules that owns them (src/artboard.cpp reads `target->parent()` to collect
 *    "the targets that belong to this rule").
 *  - src/artboard.cpp Artboard::sortDrawOrder(): every drawable whose flattenedDrawRules
 *    has a non-null activeTarget() (== the DrawTarget drawTargetId currently resolves to)
 *    is spliced out of the normal file-order chain and placed immediately before/after its
 *    DrawTarget's anchor instead. Tracing that splice against this exporter's established
 *    REVERSED-shape-emission convention (scene.ts: first-in-file = topmost) gives:
 *    placement `before` -> renders IN FRONT OF (more topmost than) the anchor; `after` ->
 *    renders BEHIND it. (Full trace in keys.ts's header table.)
 *  - src/animation/keyframe_id.cpp: KeyFrameId (typeKey 50, value propertyKey 122) always
 *    hard-SETS drawTargetId to the frame's raw value in BOTH apply() and
 *    applyInterpolation() — interpolationType/mix are ignored — i.e. it is inherently a
 *    HOLD keyframe, exactly matching this app's stepped `z` (sampleKeyList's `stepped`
 *    flag). No interpolator object is ever needed for it.
 *  - A DrawRules with drawTargetId left at its default (-1/missing, never keyed) resolves
 *    `activeTarget() == nullptr` (draw_rules.cpp's onAddedDirty/drawTargetIdChanged), so the
 *    drawable renders at its normal/authored file-order position — this is exactly our
 *    REST semantics (an unkeyed `z` channel, or a clip that doesn't touch it, must render
 *    in plain doc.parts order), so no static drawTargetId property is ever written here.
 *
 * FAITHFUL SUBSET: this editor's `z` is a per-part, HIERARCHY-INDEPENDENT scalar offset
 * (ROADMAP.md: "paint order stays flat/hierarchy-independent, by design"), but a single
 * DrawTarget can only express "this whole group goes before/after ONE fixed anchor" — a
 * general N-part simultaneously-interacting reorder has no exact encoding. What's encoded
 * exactly is the documented, common case this shipped for (ROADMAP's "reach-behind-grab-
 * pill": one part passing in front of/behind an otherwise-static stack):
 *
 *   1. A part gets this machinery at all only if it owns >=1 Shape (nothing to reorder
 *      otherwise) and has NO shape-owning descendant that ISN'T itself z-keyed somewhere
 *      (hasUnguardedShapeDescendant) — such a descendant has no DrawRules of its own to
 *      stop Rive's ancestor walk, so it would incorrectly inherit this part's reordering,
 *      violating hierarchy-independence. A z-keyed descendant is always safe regardless
 *      (its OWN DrawRules, present or inactive, always wins for its own Shapes first).
 *   2. Per CLIP, at each of the part's own z-track keyframe times, the full draw order at
 *      that instant (core/structuralOps.ts's `drawOrder` rule: z ascending, doc.parts
 *      index ascending as tiebreak, restricted to visible shape-owning parts) locates the
 *      part's immediate neighbors. If the FRONT neighbor has no z-track IN THIS CLIP (so
 *      it holds its default/inactive — i.e. static — position for this clip's whole
 *      playback, even if some OTHER clip keys it), the part anchors AFTER it (renders
 *      directly behind — exactly where the sort placed it). Otherwise the BACK neighbor is
 *      tried the same way, anchoring BEFORE it. If neither is usable (both dynamic in this
 *      clip, or no neighbor exists), that one instant is skipped: drawTargetId simply holds
 *      whatever it last resolved to (or stays inactive/default). Simultaneous multi-part
 *      z crossings degrade to "hold the last resolvable position" rather than erroring —
 *      documented limitation, not a crash.
 *
 * DrawTarget objects are cached per (owning part's DrawRules, anchor part, placement) since
 * a DrawTarget's parentId is fixed to one DrawRules (can't be shared across parts).
 *
 * U3 DIVERGENCE NOTE (keyed z vs childOrder slots — documented, deliberately NOT
 * redesigned in the U3 wave; DEFERRED FOR AUSTIN). This planner was built under the
 * pre-U3 GLOBAL-order semantics and keeps them; since U3 the editor's animate-time z
 * re-sort is SIBLING-SCOPED (core/paintOrder.ts re-sorts PART slots within their
 * parent's childOrder only) and the static drawable order is the slot flatten. For
 * every doc whose childOrders are the synthesized paths-first shape (every pre-U4
 * save; NOTE — U4 has now LANDED: fresh imports record true document order and the
 * Layers panel reorders slots freely, so interleaved docs are ordinary user documents
 * and the divergence below is user-reachable; the deferred decision stands) the two
 * models coincide and the export is byte-identical to pre-U3; for an INTERLEAVED doc
 * that ALSO keys z, editor and runtime can diverge in three narrow ways:
 *   (a) SCOPE: rule 2 above ranks core/structuralOps.ts's `drawOrder` — the doc-wide,
 *       hierarchy-blind z sort — to pick neighbors/anchors, so a z-keyed part nested
 *       under an interleaved parent may resolve different neighbors than the canvas's
 *       sibling-scoped re-sort shows.
 *   (b) ANCHOR GRANULARITY: the DrawTarget anchors to the anchor part's FIRST-EMITTED
 *       Shape (partShapeIndex). Pre-U3 a part's Shapes were one contiguous file-order
 *       block, so before/after that shape bracketed the whole part; a MULTI-RUN anchor
 *       part's Shapes are now split around its interleaved children, and the single
 *       anchor only brackets its topmost run.
 *   (c) MOVER GRANULARITY: an active target splices ALL the z-keyed part's own Shapes
 *       (every run) to the anchor together, while its interleaved child parts hold
 *       their file positions — the editor instead moves the part's whole SLOT (subtree
 *       included). Rule 1's hasUnguardedShapeDescendant already refuses the machinery
 *       to any part with a non-z-keyed shape-owning descendant, so the exposed case is
 *       a multi-run part whose interleaved children own no shapes (or are themselves
 *       z-keyed).
 * Reconciling this (slot-aware neighbor ranking + per-run targets, or a redesigned
 * mechanism) is a follow-up decision, not a silent change.
 */

import { Clip, RigDoc, RigPart, drawOrder, sampleKeyList, subtreeIds } from '../../core/model';
import { Scene } from './writer';
import {
  INTERP_LINEAR, P_DRAWABLE_ID, P_DRAW_TARGET_ID, P_FRAME, P_INTERP_TYPE,
  P_KEYFRAME_ID_VALUE, P_OBJECT_ID, P_PARENT_ID, P_PLACEMENT_VALUE, P_PROPERTY_KEY,
  PLACEMENT_AFTER, PLACEMENT_BEFORE, T_DRAW_RULES, T_DRAW_TARGET, T_KEYED_OBJECT,
  T_KEYED_PROPERTY, T_KEYFRAME_ID,
} from './keys';

export interface DrawRulesEntry {
  rulesIndex: number;
  /** `${anchorPartId}|${placement}` -> this DrawRules' DrawTarget component index. */
  targets: Map<string, number>;
}

/** Owning-part-id -> its DrawRules entry. A part absent here gets no z draw-order
 *  machinery (documented no-op fallback to plain doc.parts order — see module doc). */
export type DrawRulesSetup = Map<string, DrawRulesEntry>;

/**
 * Emit a DrawRules component (parented to the part's own Node) for every part eligible
 * per the module doc's rule 1. Must run AFTER every Node+Shape is emitted (DrawTarget
 * anchors reference already-emitted Shapes, created lazily by planZDrawTargets) and
 * BEFORE any animation object (DrawRules consumes a component index).
 */
export function setupDrawRules(
  scene: Scene, doc: RigDoc, partIndex: Map<string, number>, partShapeIndex: Map<string, number>,
): DrawRulesSetup {
  const zKeyedPartIds = new Set<string>();
  for (const clip of doc.clips) {
    for (const track of clip.tracks) {
      if (track.channel === 'z' && track.keyframes.length > 0) zKeyedPartIds.add(track.target);
    }
  }
  const setup: DrawRulesSetup = new Map();
  if (zKeyedPartIds.size === 0) return setup;
  const byId = new Map(doc.parts.map((p) => [p.id, p]));
  for (const partId of zKeyedPartIds) {
    const part = byId.get(partId);
    const nodeIdx = partIndex.get(partId);
    if (!part || nodeIdx === undefined || !partShapeIndex.has(partId)) continue;
    if (hasUnguardedShapeDescendant(part, doc, zKeyedPartIds, partShapeIndex)) continue;
    const rulesIndex = scene.begin(T_DRAW_RULES);
    scene.propUint(P_PARENT_ID, nodeIdx);
    scene.end();
    setup.set(partId, { rulesIndex, targets: new Map() });
  }
  return setup;
}

/** See module doc rule 1: a shape-owning descendant with no z-track of its own would
 *  leak into `part`'s reordering (Rive's ancestor walk has nothing closer to stop at). */
function hasUnguardedShapeDescendant(
  part: RigPart, doc: RigDoc, zKeyedPartIds: Set<string>, partShapeIndex: Map<string, number>,
): boolean {
  for (const id of subtreeIds(part, doc.parts)) {
    if (id !== part.id && partShapeIndex.has(id) && !zKeyedPartIds.has(id)) return true;
  }
  return false;
}

function targetFor(
  scene: Scene, entry: DrawRulesEntry, anchorPartId: string, anchorShapeIndex: number, placement: number,
): number {
  const key = `${anchorPartId}|${placement}`;
  const cached = entry.targets.get(key);
  if (cached !== undefined) return cached;
  const idx = scene.begin(T_DRAW_TARGET);
  scene.propUint(P_PARENT_ID, entry.rulesIndex);
  scene.propUint(P_DRAWABLE_ID, anchorShapeIndex);
  scene.propUint(P_PLACEMENT_VALUE, placement);
  scene.end();
  entry.targets.set(key, idx);
  return idx;
}

export interface ZPlanKey { frame: number; targetIndex: number }

/**
 * Per (clip, z-keyed part) plan: one KeyFrameId per resolvable instant (module doc rule 2).
 * Lazily creates DrawTarget objects on `scene` for newly-discovered (anchor, placement)
 * pairs — safe only BEFORE any LinearAnimation begins (DrawTarget consumes an index), same
 * constraint as animation.ts's interpolator cache.
 */
export function planZDrawTargets(
  scene: Scene, doc: RigDoc, clip: Clip, part: RigPart, entry: DrawRulesEntry,
  partShapeIndex: Map<string, number>, hiddenIds: Set<string>, fps: number,
): ZPlanKey[] {
  const track = clip.tracks.find((t) => t.target === part.id && t.channel === 'z');
  if (!track || track.keyframes.length === 0) return [];
  const times = [...new Set(track.keyframes.map((k) => k.time))].sort((a, b) => a - b);

  // Candidates for both the ranking itself and anchor eligibility: visible, own a Shape.
  // (partShapeIndex is already hidden-filtered by scene.ts, so `!hiddenIds.has` here is
  // belt-and-suspenders, matching the direct guard pattern scene.ts's shape loop uses.)
  const candidates = doc.parts.filter((p) => !hiddenIds.has(p.id) && partShapeIndex.has(p.id));
  // Dynamic FOR THIS CLIP specifically (not globally) — see module doc rule 2.
  const dynamicHere = new Set(
    clip.tracks.filter((t) => t.channel === 'z' && t.keyframes.length > 0).map((t) => t.target),
  );

  const out: ZPlanKey[] = [];
  for (const t of times) {
    const zOf = (p: RigPart): number => {
      const tr = clip.tracks.find((c) => c.target === p.id && c.channel === 'z');
      return sampleKeyList(tr?.keyframes ?? [], t, 0, true);
    };
    const order = drawOrder(candidates, zOf);
    const pi = order.findIndex((p) => p.id === part.id);
    if (pi === -1) continue;
    const front = order[pi + 1];
    const back = order[pi - 1];
    let anchor: RigPart | undefined;
    let placement = PLACEMENT_AFTER;
    if (front && !dynamicHere.has(front.id)) {
      anchor = front; placement = PLACEMENT_AFTER; // renders directly behind the front neighbor
    } else if (back && !dynamicHere.has(back.id)) {
      anchor = back; placement = PLACEMENT_BEFORE; // renders directly in front of the back neighbor
    }
    if (!anchor) continue; // unresolvable instant (module doc rule 2) — hold, don't guess
    const targetIndex = targetFor(scene, entry, anchor.id, partShapeIndex.get(anchor.id)!, placement);
    out.push({ frame: Math.round((t / 1000) * fps), targetIndex });
  }
  return out;
}

/**
 * Emit the KeyedObject/KeyedProperty(drawTargetId)/KeyFrameId* block for one clip's plan.
 * Call from WITHIN that clip's LinearAnimation emission (animation objects nest by import-
 * stack order, not parentId — see writer.ts's header). No-op for an empty plan (a clip
 * that doesn't resolve any instant for this part).
 */
export function emitZKeyedProperty(scene: Scene, entry: DrawRulesEntry, keys: ZPlanKey[]): void {
  if (keys.length === 0) return;
  scene.begin(T_KEYED_OBJECT, false);
  scene.propUint(P_OBJECT_ID, entry.rulesIndex);
  scene.end();
  scene.begin(T_KEYED_PROPERTY, false);
  scene.propUint(P_PROPERTY_KEY, P_DRAW_TARGET_ID);
  scene.end();
  for (const k of keys) {
    scene.begin(T_KEYFRAME_ID, false);
    if (k.frame !== 0) scene.propUint(P_FRAME, k.frame);
    scene.propUint(P_INTERP_TYPE, INTERP_LINEAR); // ignored by KeyFrameId (always a hard hold)
    scene.propUint(P_KEYFRAME_ID_VALUE, k.targetIndex);
    scene.end();
  }
}

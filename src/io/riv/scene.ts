/**
 * RigDoc -> Rive (.riv) binary exporter entry point. Exports the WHOLE document (every
 * clip) as one .riv that PLAYS in the official Rive runtimes (@rive-app/canvas / webgl).
 * It is a playback/distribution format alongside the Lottie export; it is NOT meant to
 * reopen in the Rive editor (the editor cannot import .riv).
 *
 * The scene mapping mirrors exportLottie.ts decisions exactly (they solved the same
 * problems):
 *   - one Node per part (art/bone/group), positioned at the part's effective pivot so
 *     rotation happens about the joint; geometry is baked with all static SVG
 *     transforms + rest scale/skew and shifted by -pivot into the node's local space
 *     (Rive Nodes rotate about their own origin, so the -pivot shift is the same trick
 *     as Lottie anchor points);
 *   - a synthetic `root` Node carries whole-figure translate + scale about rootPivot,
 *     like Lottie's root null layer; every top-level part parents to it;
 *   - parts parent via `parentId` following the bone hierarchy (ancestors outermost);
 *   - each RigPath -> Shape + PointsPath(s) of cubic vertices from pathToCubics, with
 *     Fill/Stroke SolidColors; rest scale/skew and baked transforms flattened into the
 *     geometry, arcs converted to cubics, stroke width scaled by the baked matrix norm;
 *   - shape clusters are emitted in REVERSE paint order because Rive draws the
 *     first drawable in the file LAST (topmost) — see the draw-order comment below
 *     citing rive-runtime/src/artboard.cpp;
 *   - keyed values are ABSOLUTE; rest fills only unkeyed channels (a channel with no
 *     keyframes stays a static Node property, a keyed channel becomes a LinearAnimation
 *     KeyedProperty, emitted by animation.ts). Easing lives on the ARRIVING keyframe and
 *     Keyframe.bezier overrides the preset (both mirrored in animation.ts);
 *   - BONES emit as RootBone (typeKey 41) — same x/y/rotation transform semantics as a
 *     Node (keys.ts's skeletal table cites root_bone.cpp), so the placement math below
 *     is shared verbatim; being real Bones lets Tendons reference them;
 *   - SKINNED parts (part.skin) emit real skeletal deformation (skinned-part export
 *     wave, 2026-07-13): each PointsPath gets a Skin + one Tendon per skin bone and
 *     every vertex a CubicWeight, built by io/riv/skin.ts from the stored bind data
 *     (restWorldInv/bindSeg) and the same weight model as the live canvas — see
 *     skin.ts's header for the frame math. A skin that references a hidden or dangling
 *     bone falls back to the old rigid emission (skin.ts's buildSkinPlan).
 *
 * Export-completions wave (2026-07-13): keyed `z` (draw order) via DrawRules/DrawTarget
 * (drawRules.ts — its header has the full mechanism + citations + the faithful-subset
 * documented limits), keyed `opacity` via per-frame Fill/Stroke SolidColor alpha (NOT
 * Node.opacity — see animation.ts's header for why), and hidden parts (`RigPart.hidden`)
 * now FULLY excluded (no Node either, not just no Shape) matching the live renderer and
 * headless/composePose.ts exactly.
 */

import { artboardFrame, RigDoc, RigPart, RigPath } from '../../core/model';
import { assemble, Scene } from './writer';
import { emitAnimations, OpacityColorTarget } from './animation';
import { emitStateMachines } from './stateMachine';
import { setupDrawRules } from './drawRules';
import { bakedMatrix, pathToLocalSubpaths } from './geometry';
import { buildSkinPlan, emitSkin, emitVertexWeight, SkinPlan, subpathWeights } from './skin';
import {
  argb, DEG2RAD, P_BONE_LENGTH, P_COLOR, P_HEIGHT, P_IN_DISTANCE, P_IN_ROTATION,
  P_IS_CLOSED, P_NAME, P_NODE_X, P_NODE_Y, P_OUT_DISTANCE, P_OUT_ROTATION, P_PARENT_ID,
  P_ROOT_BONE_X, P_ROOT_BONE_Y, P_ROTATION, P_THICKNESS, P_VERT_X, P_VERT_Y, P_WIDTH,
  T_ARTBOARD, T_BACKBOARD, T_CUBIC_VERTEX, T_FILL, T_NODE, T_POINTS_PATH, T_ROOT_BONE,
  T_SHAPE, T_SOLID_COLOR, T_STROKE,
} from './keys';

/**
 * Effectively-hidden part ids for `doc` (RigPart.hidden cascades down the parent chain) —
 * a LOCAL, pure reimplementation of core/model's `isEffectivelyHidden`/`ancestorChain`.
 * The core helpers resolve ancestors through the global `state.doc` singleton
 * (core/partHierarchy.ts's `partById`), which is correct for the live editor (state.doc
 * IS the doc being edited) but WRONG for this exporter: `exportRiv` is a pure function of
 * its `doc` PARAMETER and its real callers do not all install it as `state.doc` first —
 * `headless/cliCommands.ts` and the MCP tools call `exportRiv(doc)` directly (only
 * `main.ts`'s toolbar button happens to pass `state.doc` itself). Computed
 * ONCE per export and threaded through scene.ts/animation.ts/drawRules.ts as a plain id
 * Set so every hidden-part check in this package agrees, regardless of global state.
 */
function effectivelyHiddenIds(doc: RigDoc): Set<string> {
  const byId = new Map(doc.parts.map((p) => [p.id, p]));
  const hidden = new Set<string>();
  for (const part of doc.parts) {
    let cur: RigPart | undefined = part;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      if (cur.hidden) { hidden.add(part.id); break; }
      seen.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return hidden;
}

/**
 * Serialize the whole document (all clips) to a Rive .riv binary. Deterministic:
 * identical input -> identical bytes.
 */
export function exportRiv(doc: RigDoc): Uint8Array {
  const scene = new Scene();
  const hiddenIds = effectivelyHiddenIds(doc);
  // Reference frame for the whole export: the artboard rect when the doc has one
  // enabled, else the viewBox (today's behavior, byte-identical when disabled/absent).
  const frame = artboardFrame(doc);
  const ox = frame.x;
  const oy = frame.y;

  // Backboard: no properties; not part of the artboard index space.
  scene.begin(T_BACKBOARD, false);
  scene.end();

  // Artboard = component index 0. Origin (0,0), size = the reference frame above,
  // transparent (no bg).
  const artboardIndex = scene.begin(T_ARTBOARD); // 0
  scene.propString(P_NAME, doc.name);
  scene.propDouble(P_WIDTH, frame.w);
  scene.propDouble(P_HEIGHT, frame.h);
  scene.end();

  // Root Node: whole-figure translate + scale about rootPivot (never rotates). Its
  // origin sits at rootPivot in artboard space (doc minus the reference frame's origin).
  const rootBaseX = doc.rootPivot.x - ox;
  const rootBaseY = doc.rootPivot.y - oy;
  const rootIndex = scene.begin(T_NODE); // 1
  scene.propUint(P_PARENT_ID, artboardIndex);
  scene.propString(P_NAME, `${doc.name} root`);
  scene.propDouble(P_NODE_X, rootBaseX);
  scene.propDouble(P_NODE_Y, rootBaseY);
  scene.end();

  // Emit ALL part nodes first, ancestors before descendants (parentId must reference
  // an earlier index; doc.parts order is the tiebreak). Shape clusters follow below —
  // their order carries draw order, node order does not (Nodes are not Drawables).
  const partIndex = new Map<string, number>();
  const inProgress = new Set<string>();
  const byId = new Map(doc.parts.map((p) => [p.id, p]));

  const emitPart = (part: RigPart): void => {
    if (partIndex.has(part.id) || inProgress.has(part.id)) return;
    // Layers eye, FULL exclusion (matches view/render.ts and headless/composePose.ts): a
    // hidden part gets no Node at all, not just no Shape. Hiding CASCADES down the parent
    // chain (effectivelyHiddenIds above), so no non-hidden part can ever have a hidden
    // ancestor — there is nothing to "orphan" or parentId-remap here; any part that
    // reaches this point with a hidden ancestor is itself already hidden and will hit
    // this same guard when the outer loop calls emitPart on it directly.
    if (hiddenIds.has(part.id)) return;
    inProgress.add(part.id);
    const parent = part.parentId ? byId.get(part.parentId) ?? null : null;
    if (parent) emitPart(parent);
    inProgress.delete(part.id);

    const parentNodeIndex = parent ? partIndex.get(parent.id)! : rootIndex;
    // Node origin is expressed in the parent's local frame; the reference frame's
    // origin cancels for part->part and part->root (both refs are pivots).
    // base = pivot - parentRef.
    const parentRef = parent ? parent.pivot : doc.rootPivot;
    const baseX = part.pivot.x - parentRef.x;
    const baseY = part.pivot.y - parentRef.y;

    // Bones are REAL Rive bones (RootBone) so Tendons can reference them; RootBone's
    // x(90)/y(91)/rotation(15) compose exactly like a Node's x/y/rotation (keys.ts's
    // skeletal table cites root_bone.cpp skipping the Bone parent/derived-origin rules),
    // so the placement math below is one shared path. A plain Bone (40) would snap its
    // origin to the parent's tip and demand a Bone parent — wrong for chains rooted on
    // art parts and for attachedRoot bones carrying loose offsets.
    const isBone = part.kind === 'bone';
    const nodeIndex = scene.begin(isBone ? T_ROOT_BONE : T_NODE);
    partIndex.set(part.id, nodeIndex);
    scene.propUint(P_PARENT_ID, parentNodeIndex);
    scene.propString(P_NAME, part.label);
    // Static Node transform = rest pose; keyed channels override it via animations.
    scene.propDouble(isBone ? P_ROOT_BONE_X : P_NODE_X, baseX + part.rest.tx);
    scene.propDouble(isBone ? P_ROOT_BONE_Y : P_NODE_Y, baseY + part.rest.ty);
    if (part.rest.rotate !== 0) scene.propDouble(P_ROTATION, part.rest.rotate * DEG2RAD);
    // Bone length is cosmetic for a RootBone-only rig (only a plain Bone CHILD reads its
    // parent's length for positioning) but cheap and faithful — the tip is real data.
    if (isBone && part.boneTip) {
      scene.propDouble(
        P_BONE_LENGTH,
        Math.hypot(part.boneTip.x - part.pivot.x, part.boneTip.y - part.pivot.y),
      );
    }
    // Rest scale/skew are baked into geometry (below), so the STATIC Node scale stays 1.
    // A part MAY still key sx/sy (see animation.ts's channelSpecs) — an absolute Node
    // scaleX/scaleY that rides on top of the baked-in rest scale, so a part authored at
    // rest scale 1 keys a clean 1..0 (e.g. an object shrinking to nothing). Unkeyed parts
    // emit no scale channel, so this is byte-identical to before for every doc that never
    // keys it.
    scene.end();
  };

  for (const part of doc.parts) emitPart(part);

  // DRAW ORDER (pinned from rive-runtime/src/artboard.cpp): Artboard::initialize()
  // fills m_Drawables in file/component order; sortDrawOrder() links them in that
  // order and then sets `m_FirstDrawable = lastDrawable` (the LAST drawable in file
  // order); drawInternal() iterates `drawable = m_FirstDrawable; ...; drawable =
  // drawable->prev`. Net effect: the FIRST drawable component in the file is drawn
  // LAST — first-in-file = TOPMOST, like the Rive editor's layer panel. The studio's
  // convention is the opposite (doc.parts order is paint order, last = topmost; a
  // part's paths array likewise). So shape clusters are emitted fully REVERSED:
  // parts in reverse doc order, each part's paths in reverse array order. Only Shape
  // (typeKey 3) is a Drawable — plain Nodes and PointsPaths never enter m_Drawables —
  // and every part Node was emitted above, so all parentIds still point backward and
  // the animation objectIds (recorded in partIndex at node-emit time) are unaffected.
  //
  // LAYERS EYE (full exclusion, completed this wave): a hidden part already got no Node
  // above, so it can't reach here as a PARENT (`partIndex.get(part.id)!` below is only
  // ever called for a part whose Node was actually emitted); this loop's own hidden check
  // additionally skips a hidden part's OWN Shapes (redundant with the Node-level skip for
  // any part reached only through its own doc.parts slot, but kept as a direct guard since
  // this loop iterates ALL parts independently of the Node pass above).
  //
  // partShapeIndex records, per part, the component index of the FIRST Shape emitted for
  // it (arbitrary among a multi-path part's shapes — they're always a contiguous file-order
  // block, see drawRules.ts) — used as the anchor drawable for OTHER parts' keyed z draw
  // order. opacityTargets records every Fill/Stroke SolidColor this part owns (with its
  // base path opacity) so a KEYED `opacity` channel can animate them (animation.ts).
  const partShapeIndex = new Map<string, number>();
  const opacityTargets = new Map<string, OpacityColorTarget[]>();
  for (let pi = doc.parts.length - 1; pi >= 0; pi--) {
    const part = doc.parts[pi];
    if (hiddenIds.has(part.id)) continue; // Layers eye: fully excluded, no Shapes either.
    // Skeletal deformation plan (skinned parts): resolved once per part, null = the
    // rigid fallback (skin.ts's buildSkinPlan documents when and why).
    const skinPlan = part.skin ? buildSkinPlan(doc, part, partIndex, ox, oy) : null;
    for (let qi = part.paths.length - 1; qi >= 0; qi--) {
      const shapeIndex = emitShape(scene, part, part.paths[qi], partIndex.get(part.id)!, opacityTargets, skinPlan);
      if (shapeIndex !== null && !partShapeIndex.has(part.id)) partShapeIndex.set(part.id, shapeIndex);
    }
  }

  // ---- Keyed draw order (DrawRules/DrawTarget) setup ----
  // Static DrawRules objects only (consumes component indices) — must run after every
  // Node+Shape exists (DrawTarget anchors reference already-emitted Shapes) and before any
  // animation object. Zero overhead for docs that never key `z`: see drawRules.ts.
  const drawRules = setupDrawRules(scene, doc, partIndex, partShapeIndex);

  // ---- Animations ----
  // channelSpecs/plan building writes any needed CubicEaseInterpolators (which consume
  // component indices) BEFORE any animation object is emitted; see animation.ts.
  emitAnimations(
    scene, doc, partIndex, rootIndex, rootBaseX, rootBaseY,
    partShapeIndex, opacityTargets, drawRules, hiddenIds,
  );

  // ---- State machines ----
  // Emitted AFTER the animations (animationId is a positional index into the artboard's
  // LinearAnimation list, so file position relative to the animations is irrelevant).
  // A doc with no stateMachines (field absent OR []) emits nothing here, so its bytes
  // stay byte-identical to the pre-state-machine exporter.
  emitStateMachines(scene, doc, partIndex);

  return assemble(scene);
}

// ---- Geometry (mirrors exportLottie.ts shapeGroup/pathToBeziers) ----

/**
 * One RigPath -> Shape (child of the part node) with PointsPath(s), Fill, Stroke. Returns
 * the Shape's component index (for partShapeIndex/draw-order anchoring), or null when the
 * path produced no geometry (degenerate — no Shape was emitted at all).
 *
 * With a `skinPlan`, each PointsPath additionally gets its Skin + Tendons (emitted right
 * after the path, before its vertices) and EVERY vertex a CubicWeight (right after the
 * vertex — parentId always points backward). The runtime then renders the path in world
 * space through the skin and ignores the shape's own transform (points_path.cpp's
 * identity pathTransform), so the node hierarchy above only matters for the BONES.
 */
function emitShape(
  scene: Scene, part: RigPart, path: RigPath, partNodeIndex: number,
  opacityTargets: Map<string, OpacityColorTarget[]>, skinPlan: SkinPlan | null,
): number | null {
  const m = bakedMatrix(part, path);
  const subs = pathToLocalSubpaths(path.d, m, part.pivot.x, part.pivot.y);
  if (subs.length === 0) return null;

  const shapeIndex = scene.begin(T_SHAPE);
  scene.propUint(P_PARENT_ID, partNodeIndex);
  scene.propString(P_NAME, path.label);
  scene.end();

  for (const sub of subs) {
    const pathIndex = scene.begin(T_POINTS_PATH);
    scene.propUint(P_PARENT_ID, shapeIndex);
    scene.propBool(P_IS_CLOSED, sub.closed);
    scene.end();
    if (skinPlan) emitSkin(scene, skinPlan, pathIndex);
    const weights = skinPlan ? subpathWeights(skinPlan, path.id, sub) : null;
    sub.verts.forEach((v, vi) => {
      const vertexIndex = scene.begin(T_CUBIC_VERTEX);
      scene.propUint(P_PARENT_ID, pathIndex);
      scene.propDouble(P_VERT_X, v.x);
      scene.propDouble(P_VERT_Y, v.y);
      scene.propDouble(P_IN_ROTATION, v.inRot);
      scene.propDouble(P_IN_DISTANCE, v.inDist);
      scene.propDouble(P_OUT_ROTATION, v.outRot);
      scene.propDouble(P_OUT_DISTANCE, v.outDist);
      scene.end();
      if (weights) emitVertexWeight(scene, vertexIndex, weights[vi]);
    });
  }

  // Part-level `opacity` (RestPose.opacity / the keyable 'opacity' channel) folds
  // multiplicatively into each paint's alpha, exactly like path fill/stroke-opacity
  // already do — see animation.ts's header comment for why the KEYED case targets these
  // SAME SolidColors (not Node.opacity, which cascades to children and would mismatch
  // this editor's non-propagating part opacity) and how it avoids double-applying rest.
  const restOpacity = Math.min(1, Math.max(0, part.rest.opacity));
  if (path.fill) {
    const fillIndex = scene.begin(T_FILL);
    scene.propUint(P_PARENT_ID, shapeIndex);
    scene.end();
    const colorIndex = scene.begin(T_SOLID_COLOR);
    scene.propUint(P_PARENT_ID, fillIndex);
    scene.propColor(P_COLOR, argb(path.fill, path.fillOpacity * restOpacity));
    scene.end();
    pushOpacityTarget(opacityTargets, part.id, { colorIndex, hex: path.fill, baseOpacity: path.fillOpacity });
  }
  if (path.stroke) {
    // Uniform-scale approximation of the baked matrix for the stroke width (as Lottie).
    const widthScale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    const strokeIndex = scene.begin(T_STROKE);
    scene.propUint(P_PARENT_ID, shapeIndex);
    scene.propDouble(P_THICKNESS, path.strokeWidth * widthScale);
    scene.end();
    const colorIndex = scene.begin(T_SOLID_COLOR);
    scene.propUint(P_PARENT_ID, strokeIndex);
    scene.propColor(P_COLOR, argb(path.stroke, path.strokeOpacity * restOpacity));
    scene.end();
    pushOpacityTarget(opacityTargets, part.id, { colorIndex, hex: path.stroke, baseOpacity: path.strokeOpacity });
  }
  return shapeIndex;
}

function pushOpacityTarget(
  map: Map<string, OpacityColorTarget[]>, partId: string, target: OpacityColorTarget,
): void {
  let arr = map.get(partId);
  if (!arr) { arr = []; map.set(partId, arr); }
  arr.push(target);
}

// bakedMatrix/pathToLocalSubpaths/toPolar live in ./geometry (moved verbatim in the
// skinned-part export wave, extended with the per-vertex weight-source records
// io/riv/skin.ts consumes — see geometry.ts's header).


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
 *   - skinned parts export RIGIDLY at rest (Rive Skin/Tendon left for a future wave),
 *     which happens for free since binding already baked their geometry.
 */

import {
  artboardFrame, isEffectivelyHidden, RigDoc, RigPart, RigPath,
} from '../../core/model';
import { parsePath, pathToCubics } from '../../geometry/paths';
import { Mat, applyMat, invertMat, matrixOfTransform, multiply } from '../../geometry/transforms';
import { assemble, Scene } from './writer';
import { emitAnimations } from './animation';
import { emitStateMachines } from './stateMachine';
import {
  DEG2RAD, P_COLOR, P_HEIGHT, P_IN_DISTANCE, P_IN_ROTATION, P_IS_CLOSED, P_NAME,
  P_NODE_X, P_NODE_Y, P_OUT_DISTANCE, P_OUT_ROTATION, P_PARENT_ID, P_ROTATION, P_THICKNESS,
  P_VERT_X, P_VERT_Y, P_WIDTH, T_ARTBOARD, T_BACKBOARD, T_CUBIC_VERTEX, T_FILL, T_NODE,
  T_POINTS_PATH, T_SHAPE, T_SOLID_COLOR, T_STROKE,
} from './keys';

/**
 * Serialize the whole document (all clips) to a Rive .riv binary. Deterministic:
 * identical input -> identical bytes.
 */
export function exportRiv(doc: RigDoc): Uint8Array {
  const scene = new Scene();
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

    const nodeIndex = scene.begin(T_NODE);
    partIndex.set(part.id, nodeIndex);
    scene.propUint(P_PARENT_ID, parentNodeIndex);
    scene.propString(P_NAME, part.label);
    // Static Node transform = rest pose; keyed channels override it via animations.
    scene.propDouble(P_NODE_X, baseX + part.rest.tx);
    scene.propDouble(P_NODE_Y, baseY + part.rest.ty);
    if (part.rest.rotate !== 0) scene.propDouble(P_ROTATION, part.rest.rotate * DEG2RAD);
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
  // LAYERS EYE (not fully mapped this wave): the eye (`RigPart.hidden`) IS handled,
  // PARTIALLY — a hidden part's Shapes are skipped below, so it paints nothing (Shape
  // is the only Drawable typeKey here, so a part with zero Shapes is exactly as
  // invisible as an unbound bone/group already is). Its Node, channelSpecs entries
  // (keyed transform tracks, in animation.ts), and any state-machine listener
  // targeting it are all left INTACT, on purpose: a hidden part may still be a parent
  // bone driving VISIBLE children, and dropping its Node would require reindexing every
  // descendant's parentId plus re-deriving their base positions relative to a new
  // parent — the "nontrivial index remapping" this file's callers were warned to avoid.
  // Full object-level removal (Node + tracks + orphan reparenting) is deferred to the
  // export wave that also finishes the opacity channel (see animation.ts).
  for (let pi = doc.parts.length - 1; pi >= 0; pi--) {
    const part = doc.parts[pi];
    if (isEffectivelyHidden(part)) continue; // Layers eye: skip Shapes, keep the Node.
    for (let qi = part.paths.length - 1; qi >= 0; qi--) {
      emitShape(scene, part, part.paths[qi], partIndex.get(part.id)!);
    }
  }

  // ---- Animations ----
  // channelSpecs/plan building writes any needed CubicEaseInterpolators (which consume
  // component indices) BEFORE any animation object is emitted; see animation.ts.
  emitAnimations(scene, doc, partIndex, rootIndex, rootBaseX, rootBaseY);

  // ---- State machines ----
  // Emitted AFTER the animations (animationId is a positional index into the artboard's
  // LinearAnimation list, so file position relative to the animations is irrelevant).
  // A doc with no stateMachines (field absent OR []) emits nothing here, so its bytes
  // stay byte-identical to the pre-state-machine exporter.
  emitStateMachines(scene, doc, partIndex);

  return assemble(scene);
}

// ---- Geometry (mirrors exportLottie.ts shapeGroup/pathToBeziers) ----

/** One RigPath -> Shape (child of the part node) with PointsPath(s), Fill, Stroke. */
function emitShape(scene: Scene, part: RigPart, path: RigPath, partNodeIndex: number): void {
  const m = bakedMatrix(part, path);
  const subs = pathToLocalSubpaths(path.d, m, part.pivot.x, part.pivot.y);
  if (subs.length === 0) return;

  const shapeIndex = scene.begin(T_SHAPE);
  scene.propUint(P_PARENT_ID, partNodeIndex);
  scene.propString(P_NAME, path.label);
  scene.end();

  for (const sub of subs) {
    const pathIndex = scene.begin(T_POINTS_PATH);
    scene.propUint(P_PARENT_ID, shapeIndex);
    scene.propBool(P_IS_CLOSED, sub.closed);
    scene.end();
    for (const v of sub.verts) {
      scene.begin(T_CUBIC_VERTEX);
      scene.propUint(P_PARENT_ID, pathIndex);
      scene.propDouble(P_VERT_X, v.x);
      scene.propDouble(P_VERT_Y, v.y);
      scene.propDouble(P_IN_ROTATION, v.inRot);
      scene.propDouble(P_IN_DISTANCE, v.inDist);
      scene.propDouble(P_OUT_ROTATION, v.outRot);
      scene.propDouble(P_OUT_DISTANCE, v.outDist);
      scene.end();
    }
  }

  if (path.fill) {
    const fillIndex = scene.begin(T_FILL);
    scene.propUint(P_PARENT_ID, shapeIndex);
    scene.end();
    const colorIndex = scene.begin(T_SOLID_COLOR);
    scene.propUint(P_PARENT_ID, fillIndex);
    scene.propColor(P_COLOR, argb(path.fill, path.fillOpacity));
    scene.end();
    void colorIndex;
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
    scene.propColor(P_COLOR, argb(path.stroke, path.strokeOpacity));
    scene.end();
    void colorIndex;
  }
}

/**
 * Baked matrix for a path: part group transform, then rest scale/skew innermost around
 * the pivot (mapped into pre-baked local space) so artwork reshapes on its own axes and
 * the joint stays fixed, then the per-path transform. Identical to exportLottie.ts.
 */
function bakedMatrix(part: RigPart, path: RigPath): Mat {
  const baked = matrixOfTransform(part.transform);
  let m = baked;
  const sx = part.rest?.sx ?? 1;
  const sy = part.rest?.sy ?? 1;
  const kx = part.rest?.kx ?? 0;
  const ky = part.rest?.ky ?? 0;
  if (sx !== 1 || sy !== 1 || kx !== 0 || ky !== 0) {
    const pl = applyMat(invertMat(baked), part.pivot.x, part.pivot.y);
    const local = matrixOfTransform(
      `translate(${pl.x},${pl.y}) scale(${sx},${sy}) ` +
      `skewX(${kx}) skewY(${ky}) translate(${-pl.x},${-pl.y})`,
    );
    m = multiply(baked, local);
  }
  return multiply(m, matrixOfTransform(path.transform));
}

interface RivVertex {
  x: number; y: number;
  inRot: number; inDist: number;
  outRot: number; outDist: number;
}
interface RivSubpath { verts: RivVertex[]; closed: boolean }

/**
 * Parse path data, rewrite arcs as cubics, flatten the baked matrix, subtract the pivot
 * to land in the part node's local space, and convert each vertex's in/out tangent
 * offsets to Rive's polar (rotation, distance) form. Straight segments become
 * zero-distance handles (Rive renders a degenerate cubic as a line). The subpath fold
 * for an explicit closing segment mirrors exportLottie.ts's pathToBeziers.
 */
function pathToLocalSubpaths(d: string, m: Mat, pivotX: number, pivotY: number): RivSubpath[] {
  const cmds = pathToCubics(parsePath(d));
  const subs: RivSubpath[] = [];
  // Working buffers for the current subpath: vertex point + in/out tangent OFFSETS.
  let v: { x: number; y: number }[] = [];
  let inv: { x: number; y: number }[] = [];
  let outv: { x: number; y: number }[] = [];
  let curX = 0, curY = 0, startX = 0, startY = 0;
  let open = false;

  const local = (x: number, y: number) => {
    const p = applyMat(m, x, y);
    return { x: p.x - pivotX, y: p.y - pivotY };
  };
  const tangent = (cx: number, cy: number, vx: number, vy: number) => {
    const c = applyMat(m, cx, cy);
    const w = applyMat(m, vx, vy);
    return { x: c.x - w.x, y: c.y - w.y };
  };
  const finish = (closed: boolean) => {
    if (v.length >= 2) {
      subs.push({ verts: v.map((pt, i) => toPolar(pt, inv[i], outv[i])), closed });
    }
    v = []; inv = []; outv = []; open = false;
  };
  const startSub = (x: number, y: number) => {
    v = [local(x, y)]; inv = [{ x: 0, y: 0 }]; outv = [{ x: 0, y: 0 }]; open = true;
  };

  for (const c of cmds) {
    switch (c.cmd) {
      case 'M':
        if (open) finish(false);
        startSub(c.x, c.y);
        curX = c.x; curY = c.y; startX = c.x; startY = c.y;
        break;
      case 'L': {
        if (!open) startSub(curX, curY);
        v.push(local(c.x, c.y)); inv.push({ x: 0, y: 0 }); outv.push({ x: 0, y: 0 });
        curX = c.x; curY = c.y;
        break;
      }
      case 'C': {
        if (!open) startSub(curX, curY);
        outv[outv.length - 1] = tangent(c.x1, c.y1, curX, curY);
        v.push(local(c.x, c.y));
        inv.push(tangent(c.x2, c.y2, c.x, c.y));
        outv.push({ x: 0, y: 0 });
        curX = c.x; curY = c.y;
        break;
      }
      case 'Z': {
        if (open) {
          const n = v.length;
          // Explicit final segment back to the start duplicates vertex 0: fold its
          // incoming tangent into vertex 0 and drop it (Rive auto-closes last->first).
          if (n > 1 && Math.hypot(v[n - 1].x - v[0].x, v[n - 1].y - v[0].y) < 1e-3) {
            inv[0] = inv[n - 1];
            v.pop(); inv.pop(); outv.pop();
          }
          finish(true);
        }
        curX = startX; curY = startY;
        break;
      }
      case 'A':
        break; // unreachable: pathToCubics rewrote all arcs
    }
  }
  if (open) finish(false);
  return subs;
}

/** Vertex point + in/out tangent offsets -> Rive detached-cubic polar handles. */
function toPolar(
  pt: { x: number; y: number },
  inOff: { x: number; y: number },
  outOff: { x: number; y: number },
): RivVertex {
  return {
    x: pt.x, y: pt.y,
    inRot: Math.atan2(inOff.y, inOff.x),
    inDist: Math.hypot(inOff.x, inOff.y),
    outRot: Math.atan2(outOff.y, outOff.x),
    outDist: Math.hypot(outOff.x, outOff.y),
  };
}

/**
 * #rgb / #rrggbb + opacity -> packed ARGB uint32 (0xAARRGGBB). Rive folds paint opacity
 * into the SolidColor's alpha (there is no separate paint-opacity property). Unparseable
 * colors fall back to opaque black.
 */
export function argb(value: string, opacity: number): number {
  let hex = value.trim().replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
  let r = 0, g = 0, b = 0;
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  }
  const a = Math.round(Math.min(1, Math.max(0, opacity)) * 255);
  return (((a << 24) | (r << 16) | (g << 8) | b) >>> 0);
}

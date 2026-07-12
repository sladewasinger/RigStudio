/**
 * Direct-manipulation wiring for the editing canvas: the single set of pointer/wheel
 * listeners installed on the live SVG (by buildCanvas) and the drag pipelines they run.
 *
 * `wireInteractions` attaches wheel-zoom, the drill-down dblclick, the pointerdown
 * router (which handle/gizmo/part/pivot/node/bend/marquee a press starts), the
 * pointermove drag pipelines, and the pointerup/pointercancel `end()`. `activateDrag`
 * enforces the checkpoint-once-per-gesture deferral (a plain click never touches
 * history); `notifyTimelineOnly` fires the lightweight keyframe-refresh event during a
 * drag instead of the full-panel `notify()`.
 */

import {
  RigPart, RigPath, state, notify, setKeyframe, selectedPart, selectedParts,
  selectPart, ancestorChain, channelValue, addNullPart, translateBoneChain,
} from '../core/model';
import {
  parsePath, serializePath, PathCmd,
} from '../geometry/paths';
import { Mat, applyMat, invertMat, matrixOfTransform, multiply } from '../geometry/transforms';
import { solveAim, solveTwoBone } from '../geometry/ik';
import { snapPoint, snapDelta, SnapAxis } from '../geometry/snap';
import { checkpoint } from '../core/history';
import {
  ctx, DragState, ROTATE_SNAP_DEGREES, DRAG_THRESHOLD_PX, MIN_SCALE, MAX_SCALE,
  round1, round2, round3, linearOnly, nodeKey, parseNodeKey, snappingActive, wrapToPi,
} from './context';
import {
  svgPoint, pointerInRoot, snapThreshold, rootToUser,
  pointerInPathSpace, handleSize,
} from './coords';
import {
  poseTime, innerLocalTransform, fullPoseTransform, groupTransformOf,
  chainMatOf, ownTranslateOf, effectivePivot, effectiveTip, groupUnionBox,
} from './pose';
import {
  clearGroupEntry, artworkUnderPointer, stepOutFocus,
} from './focus';
import { renderOverlay } from './overlay';
import { renderPose } from './render';
import { registerPart } from './partDom';
import {
  pivotSnapCandidates, translateSnapFeatures,
} from './snapping';
import {
  nodeIndexOf, ensureNodeTypes, segmentStart, pointOnSegment, segmentHit, subpathStart,
  applyMirrorConstraint, editNodeStructure, moveNode,
} from './nodeEditing';
import {
  cancelBonePlacement, autoBindPlacedBone, aimBoneAtTip,
  refreshBindForChain, refreshFrozenSkinWeights, captureFrozenBaseline,
  groupScaleMembers, applyGroupScale,
} from './rigOps';
import { applyViewRect, zoomAround } from './camera';

/** First real movement of a drag: fire the deferred checkpoint exactly once. */
function activateDrag(
  d: Exclude<DragState, { kind: 'pan' } | { kind: 'placeBone' } | { kind: 'nodeMarquee' }>,
  ev: PointerEvent,
): boolean {
  if (d.active) return true;
  const dx = ev.clientX - d.startClient.x;
  const dy = ev.clientY - d.startClient.y;
  if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return false;
  checkpoint();
  d.active = true;
  return true;
}

export function wireInteractions(): void {
  if (!ctx.svg) return;

  // Middle-drag pan + wheel zoom (navigation, not editing — no checkpoints).
  ctx.svg.addEventListener('wheel', (ev) => {
    if (!ctx.viewRect || !ctx.svg) return;
    ev.preventDefault();
    const m = ctx.svg.getScreenCTM();
    if (!m) return;
    const p = svgPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    const factor = Math.pow(1.0015, -ev.deltaY);
    zoomAround(p.x, p.y, factor);
  }, { passive: false });

  // Double-click steps INTO things, SVG-editor style: group → part → path. Escape or
  // a blank click steps back out.
  ctx.svg.addEventListener('dblclick', (ev) => {
    // Resolve the ARTWORK under the cursor with elementsFromPoint, skipping overlay
    // widgets: the first click of a double-click selects a part and draws its pivot
    // grab circle — often right where the second click lands. The overlay must never
    // eat a drill-down.
    const hit = artworkUnderPointer(ev);
    if (!hit) {
      // In node-editing mode, a dblclick that lands off the shape (blank canvas, or a
      // dimmed/click-through part) exits the whole editing context: leave the entered
      // path, drop the node selection, close entered groups, and deselect everything.
      if (state.editorMode === 'setup' && state.mode === 'nodes') {
        state.selectedPathId = null;
        ctx.selectedNodes.clear();
        ctx.selectedNode = null;
        clearGroupEntry();
        selectPart(null);
        notify();
        renderPose();
      }
      return;
    }
    const { part, pathEl } = hit;
    // DIVE into the outermost still-closed group as a CONTEXT, selecting NOTHING
    // (Inkscape "enter group" / temporary ungrouping): its children become directly
    // clickable, and the NEXT single click selects the child under the cursor — which
    // may itself be a nested group (selected, not dived). A further double-click on a
    // nested group dives one level deeper.
    const closed = ancestorChain(part).find(
      (a) => a.kind === 'group' && !ctx.enteredGroups.has(a.id),
    );
    if (closed) {
      ctx.enteredGroups.add(closed.id);
      selectPart(null);
      state.selectedPathId = null;
      notify();
      renderPose();
      return;
    }
    // Deepest level (no un-entered group ancestor): enter the part and select the path
    // under the cursor (Setup only) — path/node scope.
    if (state.editorMode !== 'setup') return;
    const pathId = pathEl?.dataset?.pathId;
    if (!pathId) return;
    selectPart(part.id);
    state.selectedPathId = pathId;
    notify();
    renderPose();
  });

  ctx.svg.addEventListener('pointerdown', (ev) => {
    const target = ev.target as Element;
    const doc = state.doc;
    if (!doc) return;

    // Bone placement: press to set the origin (the joint), drag to aim, release to
    // set the tip — like drawing a bone in Rive/Blender. CHILD BONES (Bones 2.0): when
    // a bone is selected the new bone's origin is anchored at that bone's effective TIP
    // (the press only arms it), so a chain grows joint-to-joint without hunting for the
    // exact tip pixel. With no bone selected, placement stays free-form at the press.
    if (ctx.placingBone && ev.button === 0) {
      const sel = selectedPart();
      const parentTip = sel && sel.kind === 'bone' ? effectiveTip(sel, poseTime()) : null;
      const p = pointerInRoot(ev);
      const origin = parentTip ?? { x: p.x, y: p.y };
      ctx.drag = { kind: 'placeBone', originRoot: origin, current: null };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    // Transform-gizmo handles (translate arrows / rotate ring).
    if (target instanceof SVGElement && target.dataset.gizmoAxis) {
      const part = selectedPart();
      if (!part) return;
      const p = pointerInRoot(ev);
      const t = poseTime();
      const setup = state.editorMode === 'setup';
      const axisAttr = target.dataset.gizmoAxis;
      ctx.drag = {
        kind: 'translate',
        // Bones never translate (see the body-drag branch); the arrows only move art/nulls.
        targets: selectedParts().filter((sp) => sp.kind !== 'bone').map((sp) => ({
          part: sp,
          startTx: setup ? sp.rest.tx : channelValue(sp, 'tx', state.currentTime),
          startTy: setup ? sp.rest.ty : channelValue(sp, 'ty', state.currentTime),
          invLinear: linearOnly(invertMat(chainMatOf(sp, t))),
        })),
        startX: p.x, startY: p.y,
        current: { x: p.x, y: p.y },
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
        axis: axisAttr === 'x' || axisAttr === 'y' ? axisAttr : null,
        toggleOnClick: false,
      };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }
    if (target instanceof SVGElement && target.dataset.role === 'gizmo-ring') {
      const part = selectedPart();
      if (!part) return;
      const p = pointerInRoot(ev);
      const setup = state.editorMode === 'setup';
      const pivot = effectivePivot(part, poseTime());
      const startAngle0 = Math.atan2(p.y - pivot.y, p.x - pivot.x);
      ctx.drag = {
        kind: 'rotate',
        targets: selectedParts().map((sp) => ({
          part: sp,
          start: setup ? sp.rest.rotate : channelValue(sp, 'rotate', state.currentTime),
        })),
        pivotX: pivot.x, pivotY: pivot.y,
        startAngle: startAngle0,
        lastAngle: startAngle0,
        accumDeg: 0,
        current: { x: p.x, y: p.y },
        currentDelta: 0,
        snapped: false,
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    // Bone tip: re-aim + stretch the bone (both editor modes). A leaf tip and a shared
    // JOINT tip (a child bone hangs off it) drag identically — the reshape rotates+stretches
    // the bone and carries child origins onto the new tip. Outside freeze the skinned art
    // deforms with it; inside freeze the bind refreshes so the art stays put (see the
    // pointermove branch). No freeze gate: posing the limb via its bones is the point.
    if (target instanceof SVGElement && target.dataset.role === 'bone-tip') {
      const part = selectedPart();
      if (!part) return;
      ctx.drag = { kind: 'boneTip', part, startClient: { x: ev.clientX, y: ev.clientY }, active: false };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    if (ev.button === 1) {
      ev.preventDefault(); // no middle-click autoscroll
      ctx.drag = { kind: 'pan', startClient: { x: ev.clientX, y: ev.clientY }, startRect: { ...ctx.viewRect! } };
      ctx.svg!.style.cursor = 'grabbing';
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }
    if (ev.button !== 0) return;

    // Scale handle (Setup mode). A GROUP has no artwork/local frame of its own — its
    // handle grabs the root-space union bbox (groupUnionBox, same box the dashed outline
    // draws) and starts a DISTRIBUTED rest edit across every descendant instead of the
    // single-part pipeline below (rigOps.ts's groupScaleMembers/applyGroupScale).
    if (target instanceof SVGElement && target.dataset.handle) {
      const part = selectedPart();
      if (!part) return;
      if (part.kind === 'group') {
        const ub = groupUnionBox(part);
        if (!ub) return; // nothing inside yet — nothing to scale
        const t = poseTime();
        const pad = handleSize() * 0.8; // matches overlay.ts's group-box padding
        const x0 = ub.x0 - pad, y0 = ub.y0 - pad, x1 = ub.x1 + pad, y1 = ub.y1 + pad;
        const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const spots: Record<string, { x: number; y: number }> = {
          nw: { x: x0, y: y0 }, ne: { x: x1, y: y0 }, se: { x: x1, y: y1 }, sw: { x: x0, y: y1 },
          n: { x: cx, y: y0 }, s: { x: cx, y: y1 }, e: { x: x1, y: cy }, w: { x: x0, y: cy },
        };
        const grab = spots[target.dataset.handle];
        if (!grab) return;
        ctx.drag = {
          kind: 'groupScale',
          group: part,
          handle: target.dataset.handle,
          pivotRoot: effectivePivot(part, t),
          grabRoot: grab,
          members: groupScaleMembers(part, t),
          poseT: t,
          current: null,
          startClient: { x: ev.clientX, y: ev.clientY },
          active: false,
        };
        try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
        return;
      }
      const g = ctx.partGroups.get(part.id);
      if (!g) return;
      const box = g.getBBox();
      const pad = handleSize() * 0.6;
      const x0 = box.x - pad, y0 = box.y - pad;
      const x1 = box.x + box.width + pad, y1 = box.y + box.height + pad;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const spots: Record<string, { g: { x: number; y: number }; a: { x: number; y: number } }> = {
        nw: { g: { x: x0, y: y0 }, a: { x: x1, y: y1 } },
        ne: { g: { x: x1, y: y0 }, a: { x: x0, y: y1 } },
        se: { g: { x: x1, y: y1 }, a: { x: x0, y: y0 } },
        sw: { g: { x: x0, y: y1 }, a: { x: x1, y: y0 } },
        n: { g: { x: cx, y: y0 }, a: { x: cx, y: y1 } },
        s: { g: { x: cx, y: y1 }, a: { x: cx, y: y0 } },
        e: { g: { x: x1, y: cy }, a: { x: x0, y: cy } },
        w: { g: { x: x0, y: cy }, a: { x: x1, y: cy } },
      };
      const spot = spots[target.dataset.handle];
      if (!spot) return;
      const t = poseTime();
      // groupTransformOf is the part's full rootGroup-relative transform; frozen at
      // drag start so scale factors are measured in a stable local frame.
      const mStart = matrixOfTransform(groupTransformOf(part, t));
      const chainM = chainMatOf(part, t);
      ctx.drag = {
        kind: 'scale',
        part,
        handle: target.dataset.handle,
        startSx: part.rest.sx, startSy: part.rest.sy,
        startTx: part.rest.tx, startTy: part.rest.ty,
        grabLocal: spot.g,
        anchorLocal: spot.a,
        anchorRoot: applyMat(mStart, spot.a.x, spot.a.y),
        invStart: invertMat(mStart),
        invChainLinear: linearOnly(invertMat(chainM)),
        current: null,
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    // Skew handle (Setup mode, rotate handle set): shear along the box edge with the
    // opposite edge pinned — Inkscape's rotate-mode side handles.
    if (target instanceof SVGElement && target.dataset.skewSide) {
      const part = selectedPart();
      const g = part ? ctx.partGroups.get(part.id) : null;
      if (!part || !g) return;
      const box = g.getBBox();
      const pad = handleSize() * 0.6;
      const x0 = box.x - pad, y0 = box.y - pad;
      const x1 = box.x + box.width + pad, y1 = box.y + box.height + pad;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const spots: Record<string, { g: { x: number; y: number }; a: { x: number; y: number } }> = {
        n: { g: { x: cx, y: y0 }, a: { x: cx, y: y1 } },
        s: { g: { x: cx, y: y1 }, a: { x: cx, y: y0 } },
        e: { g: { x: x1, y: cy }, a: { x: x0, y: cy } },
        w: { g: { x: x0, y: cy }, a: { x: x1, y: cy } },
      };
      const side = target.dataset.skewSide as 'n' | 'e' | 's' | 'w';
      const spot = spots[side];
      const t = poseTime();
      const mStart = matrixOfTransform(groupTransformOf(part, t));
      ctx.drag = {
        kind: 'skew',
        part,
        side,
        startTanKx: Math.tan((part.rest.kx * Math.PI) / 180),
        startTanKy: Math.tan((part.rest.ky * Math.PI) / 180),
        startTx: part.rest.tx, startTy: part.rest.ty,
        grabLocal: spot.g,
        anchorLocal: spot.a,
        anchorRoot: applyMat(mStart, spot.a.x, spot.a.y),
        invStart: invertMat(mStart),
        invChainLinear: linearOnly(invertMat(chainMatOf(part, t))),
        current: null,
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    // Rotate handle (rotate/skew handle set's corner circles): spin the rest pose in
    // Edit, or key rotate at the playhead in Animate (bug fix — these now render in
    // Animate too, see overlay.ts, so the drag must mirror the body-drag/gizmo-ring
    // rotate pipelines' setup-awareness instead of always writing rest).
    if (target instanceof SVGElement && target.dataset.role === 'rotate-handle') {
      const part = selectedPart();
      if (!part) return;
      const p = pointerInRoot(ev);
      const setup = state.editorMode === 'setup';
      const pivot = effectivePivot(part, poseTime());
      const startAngle0 = Math.atan2(p.y - pivot.y, p.x - pivot.x);
      ctx.drag = {
        kind: 'rotate',
        targets: selectedParts().map((sp) => ({
          part: sp,
          start: setup ? sp.rest.rotate : channelValue(sp, 'rotate', state.currentTime),
        })),
        pivotX: pivot.x, pivotY: pivot.y,
        startAngle: startAngle0,
        lastAngle: startAngle0,
        accumDeg: 0,
        current: { x: p.x, y: p.y },
        currentDelta: 0,
        snapped: false,
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    if (target instanceof SVGElement && target.dataset.role === 'node') {
      const part = selectedPart();
      if (!part) return;
      const pathId = target.dataset.pathId!;
      const cmdIndex = Number(target.dataset.cmdIndex);
      const field = target.dataset.field as 'x' | 'x1' | 'x2';
      if (field === 'x') {
        // Endpoint selection: Shift toggles membership; a node already in the
        // selection keeps the group (so dragging moves them all); plain click solos.
        const key = nodeKey(pathId, cmdIndex);
        if (ev.shiftKey) {
          if (ctx.selectedNodes.has(key)) ctx.selectedNodes.delete(key);
          else ctx.selectedNodes.add(key);
        } else if (!ctx.selectedNodes.has(key)) {
          ctx.selectedNodes.clear();
          ctx.selectedNodes.add(key);
        }
        ctx.selectedNode = ctx.selectedNodes.has(key) ? { pathId, cmdIndex } : null;
      }
      const nodeDrag: DragState = {
        kind: 'node',
        part,
        pathId,
        cmdIndex,
        field,
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      if (ev.altKey || ev.ctrlKey) {
        checkpoint();
        editNodeStructure(nodeDrag, ev.altKey ? 'insert' : 'delete');
        return;
      }
      ctx.drag = nodeDrag;
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      renderOverlay(); // show the new node selection immediately
      return;
    }

    const pivotEl = (target as Element).closest('[data-role="pivot"]');
    if (pivotEl) {
      const part = selectedPart();
      if (!part) return;
      // A CHILD bone's origin IS its parent bone's tip — one shared joint. Dragging it moves
      // that joint (rotating+stretching the parent, art follows outside freeze), so it is
      // LIVE in both modes. Everything else that is an origin — a ROOT bone's origin, an art
      // part's pivot — is freeze-gated: visible but INERT outside freeze so a stray press
      // never re-anchors it (the accidental-origin-drag complaint). Swallow the press as a
      // hard no-op (no drag, no selection change) rather than fall through to a body drag.
      const parentBone = part.kind === 'bone' && part.parentId
        ? doc.parts.find((pp) => pp.id === part.parentId && pp.kind === 'bone')
        : null;
      const isChildJoint = !!parentBone;
      if (!isChildJoint && !state.freezeMode) return;
      ctx.drag = {
        kind: 'pivot',
        part,
        startPivot: { ...part.pivot },
        startTranslate: ownTranslateOf(part, poseTime()),
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    // Node mode owns all remaining clicks: near the edited path's outline they BEND
    // that segment (lines grow handles automatically); everywhere else — blank space
    // OR artwork, faded parts are click-through anyway — they rubber-band nodes.
    // Canvas clicks never switch parts here; use Layers or Escape to leave.
    if (state.mode === 'nodes' && state.editorMode === 'setup' && selectedPart()) {
      const part = selectedPart()!;
      const scoped = state.selectedPathId
        ? part.paths.filter((p) => p.id === state.selectedPathId)
        : part.paths;
      // Hit-test the EDITED paths' geometry directly (nearest segment within
      // tolerance wins) — the event target is irrelevant, so sibling paths drawn on
      // top (e.g. an inner shadow) can't swallow a bend on the path being edited.
      let bestBend: { path: RigPath; cmdIndex: number; t: number; d: number } | null = null;
      for (const path of scoped) {
        const local = pointerInPathSpace(ev, part, path);
        const hit = segmentHit(parsePath(path.d), local, handleSize() * 1.8);
        if (hit && (!bestBend || hit.d < bestBend.d)) {
          bestBend = { path, cmdIndex: hit.cmdIndex, t: hit.t, d: hit.d };
        }
      }
      if (bestBend) {
        ctx.drag = {
          kind: 'bendSegment', part, pathId: bestBend.path.id,
          cmdIndex: bestBend.cmdIndex, t: bestBend.t,
          startClient: { x: ev.clientX, y: ev.clientY }, active: false,
        };
        try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
        return;
      }
      const rect = document.createElement('div');
      rect.className = 'node-marquee';
      ctx.svg!.parentElement?.appendChild(rect);
      ctx.drag = {
        kind: 'nodeMarquee',
        startClient: { x: ev.clientX, y: ev.clientY },
        rect,
        additive: ev.shiftKey,
      };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    const partEl = (target as Element).closest('[data-part-id]') as SVGGElement | null;
    if (partEl) {
      let part = doc.parts.find((p) => p.id === partEl.dataset.partId) ?? null;
      // Group-aware selection: clicking artwork inside a closed group selects the
      // group (double-click opens it). Context-aware exception: a part that is
      // ALREADY selected (e.g. picked in the Layers tree) is manipulated directly —
      // never hijacked back to its group.
      if (part && state.mode === 'rig' && !state.selectedPartIds.includes(part.id)) {
        const closed = ancestorChain(part).find(
          (a) => a.kind === 'group' && !ctx.enteredGroups.has(a.id),
        );
        if (closed) part = closed;
      }
      const wasPrimary = part !== null && state.selectedPartId === part.id;
      if (part) {
        // Shift OR Ctrl adds to the multi-selection (a plain Ctrl+click on artwork in
        // pose mode joins, mirroring Shift — Ctrl-during-a-DRAG still axis-locks, since
        // that is read live in pointermove and pressing an already-selected part is a
        // selection no-op). Clicking an already-selected part keeps the group selected
        // so multi-part drags work.
        if (ev.shiftKey || ev.ctrlKey || state.selectedPartIds.includes(part.id)) {
          selectPart(part.id, true);
        } else {
          selectPart(part.id);
        }
      } else {
        selectPart(null);
      }
      if (part && state.mode === 'rig') {
        const p = pointerInRoot(ev);
        const t = poseTime();
        const setup = state.editorMode === 'setup';
        // Unified V "gizmo" tool: a body drag TRANSLATES in the translate/scale handle
        // set (first click) and ROTATES in the rotate/skew set (second click), in BOTH
        // Edit and Animate. Shift always translates (muscle memory). The T/R tools force
        // their manipulation; the IK tool solves the ancestor chain toward the pointer.
        let action: 'translate' | 'rotate' | 'ik' =
          state.tool === 'select'
            ? (ev.shiftKey || ctx.handleMode === 'scale' ? 'translate' : 'rotate')
            : state.tool;
        // A bone has no free translation — its origin is either the chain root (moved only
        // via its origin handle in freeze) or a shared joint (a parent's tip). A body drag
        // on a bone therefore always ROTATES around its origin (art follows), never slides
        // it: the child-bone-tears-from-parent gap the user reported can't happen.
        if (part.kind === 'bone' && action === 'translate') action = 'rotate';

        // Skinned art deforms through its BONES, not a group transform, so translate/
        // rotate/scale drags are meaningless on it (and would be lies). The one pose
        // gesture it supports is IK: dragging the art bends the bone chain that deforms
        // it (drag near the chain end → the limb folds, art follows live). Any other
        // click just (re)selects; we still repaint so the selection box + "skinned" hint
        // show immediately instead of staying stale until the next pan/zoom.
        if (part.skin) {
          if (action === 'ik') {
            const bones = part.skin.bones
              .map((b) => doc.parts.find((pp) => pp.id === b.id))
              .filter((b): b is RigPart => !!b && b.kind === 'bone');
            if (bones.length > 0) {
              // Deepest-in-chain bone is the tip joint; the effector rides it at the grab.
              bones.sort((a, b) => ancestorChain(a).length - ancestorChain(b).length);
              const p1 = bones[bones.length - 1];
              const p2 = bones.length >= 2 ? bones[bones.length - 2] : null;
              const grabLocal = applyMat(
                invertMat(matrixOfTransform(fullPoseTransform(p1, t))), p.x, p.y,
              );
              ctx.drag = {
                kind: 'ik', p1, p2, grabbed: p1,
                grabLocal: { x: grabLocal.x, y: grabLocal.y },
                current: { x: p.x, y: p.y },
                startClient: { x: ev.clientX, y: ev.clientY },
                active: false,
              };
              try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
              notify();
              renderPose();
              return;
            }
          }
          notify();
          renderPose(); // selection box + skinned hint appear without a pan/zoom
          return;
        }

        // A motionless body click on the already-primary part cycles the handle set
        // (scale ↔ rotate), which is what flips the drag between translate and rotate.
        const canToggle =
          state.tool === 'select' && wasPrimary && !ev.shiftKey && !ev.ctrlKey;

        if (action === 'ik') {
          // The joints of a chain are its BONES. For a grabbed BONE, walk only bone
          // ancestors so the art the chain is rooted on is never mistaken for a joint
          // (that made a 2-bone chain's end wildly over-rotate a single link). Art
          // grabbed inside a plain art hierarchy keeps using its real ancestors.
          const ancestors = part.kind === 'bone'
            ? ancestorChain(part).filter((a) => a.kind === 'bone')
            : ancestorChain(part); // outermost first
          const p1 = ancestors[ancestors.length - 1] ?? null;
          const p2 = ancestors[ancestors.length - 2] ?? null;
          if (p1) {
            const grabLocal = applyMat(
              invertMat(matrixOfTransform(fullPoseTransform(part, t))), p.x, p.y,
            );
            ctx.drag = {
              kind: 'ik', p1, p2, grabbed: part,
              grabLocal: { x: grabLocal.x, y: grabLocal.y },
              current: { x: p.x, y: p.y },
              startClient: { x: ev.clientX, y: ev.clientY },
              active: false,
            };
            try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
            notify();
            return;
          }
          // No ancestors: fall through to a plain rotate below.
        }

        if (action === 'translate') {
          ctx.drag = {
            kind: 'translate',
            // Bones are excluded from translation entirely (shared-joint chains stay
            // connected — a bone moves only by rotation/length or a freeze origin edit).
            targets: selectedParts().filter((sp) => sp.kind !== 'bone').map((sp) => ({
              part: sp,
              startTx: setup ? sp.rest.tx : channelValue(sp, 'tx', state.currentTime),
              startTy: setup ? sp.rest.ty : channelValue(sp, 'ty', state.currentTime),
              invLinear: linearOnly(invertMat(chainMatOf(sp, t))),
            })),
            startX: p.x, startY: p.y,
            current: { x: p.x, y: p.y },
            startClient: { x: ev.clientX, y: ev.clientY },
            active: false,
            axis: null,
            toggleOnClick: canToggle,
          };
        } else {
          const pivot = effectivePivot(part, t);
          const startAngle0 = Math.atan2(p.y - pivot.y, p.x - pivot.x);
          ctx.drag = {
            kind: 'rotate',
            targets: selectedParts().map((sp) => ({
              part: sp,
              start: setup
                ? sp.rest.rotate
                : channelValue(sp, 'rotate', state.currentTime),
            })),
            pivotX: pivot.x, pivotY: pivot.y,
            startAngle: startAngle0,
            lastAngle: startAngle0,
            accumDeg: 0,
            current: { x: p.x, y: p.y },
            currentDelta: 0,
            snapped: false,
            startClient: { x: ev.clientX, y: ev.clientY },
            active: false,
            toggleOnClick: canToggle,
          };
        }
        try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      }
      notify();
      return;
    }


    // Blank canvas (incl. a click-through fall from dimmed artwork): step out ONE
    // drill-down level — leave an entered path → deselect → pop the innermost entered
    // group — Inkscape parity. renderPose (not just renderOverlay) because popping a
    // group changes the drill-down dimming, and no drag follows a blank click to
    // otherwise repaint it.
    stepOutFocus();
    notify();
    renderPose();
  });

  ctx.svg.addEventListener('pointermove', (ev) => {
    if (!ctx.drag) return;

    if (ctx.drag.kind === 'pan') {
      if (!ctx.svg || !ctx.viewRect) return;
      const ctm = ctx.svg.getScreenCTM();
      const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
      ctx.viewRect.x = ctx.drag.startRect.x - (ev.clientX - ctx.drag.startClient.x) / scale;
      ctx.viewRect.y = ctx.drag.startRect.y - (ev.clientY - ctx.drag.startClient.y) / scale;
      applyViewRect();
      return;
    }
    if (ctx.drag.kind === 'placeBone') {
      const p = pointerInRoot(ev);
      ctx.drag.current = { x: p.x, y: p.y };
      renderOverlay(); // live bone preview
      return;
    }
    if (ctx.drag.kind === 'nodeMarquee') {
      const host = ctx.svg!.parentElement!.getBoundingClientRect();
      const x0 = Math.min(ctx.drag.startClient.x, ev.clientX);
      const y0 = Math.min(ctx.drag.startClient.y, ev.clientY);
      ctx.drag.rect.style.left = `${x0 - host.left}px`;
      ctx.drag.rect.style.top = `${y0 - host.top}px`;
      ctx.drag.rect.style.width = `${Math.abs(ev.clientX - ctx.drag.startClient.x)}px`;
      ctx.drag.rect.style.height = `${Math.abs(ev.clientY - ctx.drag.startClient.y)}px`;
      return;
    }

    const wasActive = 'active' in ctx.drag ? ctx.drag.active : true;
    if (!activateDrag(ctx.drag, ev)) return;
    const setup = state.editorMode === 'setup';

    // FREEZE: at the FIRST activated move of a bone reshape, snapshot the art's CURRENT look
    // as its bind baseline (BEFORE the bone moves), so the reshape edits the rig against the
    // static art even when the art was already posed in non-freeze. Per-move refreshBind then
    // holds that look. A no-op in effect when the art is at its bind appearance.
    if (!wasActive && state.freezeMode) {
      const bid = frozenChainBoneId(ctx.drag);
      if (bid) captureFrozenBaseline(bid, poseTime());
    }

    if (ctx.drag.kind === 'rotate') {
      const p = pointerInRoot(ev);
      const angle = Math.atan2(p.y - ctx.drag.pivotY, p.x - ctx.drag.pivotX);
      // Accumulate the WRAPPED per-step angle rather than diffing against the drag's
      // start snapshot: a raw (angle - startAngle) jumps by ±360° the instant the drag
      // crosses the atan2 ±180° branch cut, and since keyed values are absolute and
      // sampled linearly, that jump got recorded (and played back) verbatim — a
      // multi-turn wind-up rotated the "wrong direction". Each step is bounded to
      // (-180°, 180°], so accumDeg tracks the honest total no matter how many times
      // the pointer crosses the ray.
      const step = wrapToPi(angle - ctx.drag.lastAngle);
      ctx.drag.accumDeg += (step * 180) / Math.PI;
      ctx.drag.lastAngle = angle;
      const deltaDeg = ctx.drag.accumDeg;
      ctx.drag.snapped = ev.ctrlKey;
      ctx.drag.current = { x: p.x, y: p.y };
      for (const { part, start } of ctx.drag.targets) {
        let value = start + deltaDeg;
        if (ev.ctrlKey) value = Math.round(value / ROTATE_SNAP_DEGREES) * ROTATE_SNAP_DEGREES;
        value = round1(value);
        if (part.id === ctx.drag.targets[0]?.part.id) ctx.drag.currentDelta = round1(value - start);
        if (setup) part.rest.rotate = value;
        else setKeyframe(part.id, 'rotate', value);
      }
      // Freeze: a bone rotate reshapes the rig against static art — refresh the bind so the
      // skinned art doesn't swing with the bone (outside freeze it deforms, as intended).
      if (state.freezeMode) {
        for (const { part } of ctx.drag.targets) {
          if (part.kind === 'bone') refreshBindForChain(part.id, poseTime());
        }
      }
      renderPose();
      notifyTimelineOnly();
    } else if (ctx.drag.kind === 'translate') {
      const p = pointerInRoot(ev);
      let dx = p.x - ctx.drag.startX;
      let dy = p.y - ctx.drag.startY;
      // Axis lock (gizmo arrow or Ctrl) applies to the delta BEFORE snapping; the FREE
      // axis is the one still moving, so snapping can only correct along it — the lock
      // is never broken.
      let freeAxis: SnapAxis = null;
      if (ctx.drag.axis === 'x') { dy = 0; freeAxis = 'x'; }
      else if (ctx.drag.axis === 'y') { dx = 0; freeAxis = 'y'; }
      else if (ev.ctrlKey) {
        // Ctrl constrains a free move to the dominant axis (Inkscape-style).
        if (Math.abs(dx) >= Math.abs(dy)) { dy = 0; freeAxis = 'x'; }
        else { dx = 0; freeAxis = 'y'; }
      }
      ctx.snapMarker = null;
      const primary = selectedPart();
      if (snappingActive() && primary) {
        if (!ctx.drag.snapFeatures) ctx.drag.snapFeatures = translateSnapFeatures(primary, poseTime());
        const snapped = snapDelta(
          ctx.drag.snapFeatures.moving, ctx.drag.snapFeatures.targets,
          { dx, dy }, snapThreshold(), freeAxis,
        );
        dx = snapped.dx;
        dy = snapped.dy;
        if (snapped.target) ctx.snapMarker = rootToUser(snapped.target);
      }
      // The constrained point, so the dashed line + Δ readout show the applied move.
      ctx.drag.current = { x: ctx.drag.startX + dx, y: ctx.drag.startY + dy };
      for (const { part, startTx, startTy, invLinear } of ctx.drag.targets) {
        const local = applyMat(invLinear, dx, dy);
        const tx = round1(startTx + local.x);
        const ty = round1(startTy + local.y);
        if (setup) {
          part.rest.tx = tx;
          part.rest.ty = ty;
        } else {
          setKeyframe(part.id, 'tx', tx);
          setKeyframe(part.id, 'ty', ty);
        }
      }
      renderPose();
      notifyTimelineOnly();
    } else if (ctx.drag.kind === 'groupScale') {
      const d = ctx.drag;
      const p = pointerInRoot(ev);
      d.current = { x: p.x, y: p.y };
      const clampF = (f: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, f));
      let fx = 1, fy = 1;
      const denX = d.grabRoot.x - d.pivotRoot.x;
      const denY = d.grabRoot.y - d.pivotRoot.y;
      if (Math.abs(denX) > 1e-6) fx = clampF((p.x - d.pivotRoot.x) / denX);
      if (Math.abs(denY) > 1e-6) fy = clampF((p.y - d.pivotRoot.y) / denY);
      if (['n', 's'].includes(d.handle)) fx = 1;
      if (['e', 'w'].includes(d.handle)) fy = 1;
      if (ev.ctrlKey && !['n', 's', 'e', 'w'].includes(d.handle)) {
        // Uniform: follow whichever axis moved more (mirrors the per-part scale drag).
        const f = Math.abs(fx - 1) > Math.abs(fy - 1) ? fx : fy;
        fx = f; fy = f;
      }
      applyGroupScale(d.members, d.poseT, d.pivotRoot, fx, fy);
      renderPose();
    } else if (ctx.drag.kind === 'scale') {
      const d = ctx.drag;
      const p = pointerInRoot(ev);
      d.current = { x: p.x, y: p.y };
      const local = applyMat(d.invStart, p.x, p.y);
      const clampF = (f: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, f));
      let fx = 1, fy = 1;
      const denX = d.grabLocal.x - d.anchorLocal.x;
      const denY = d.grabLocal.y - d.anchorLocal.y;
      if (Math.abs(denX) > 1e-6) fx = clampF((local.x - d.anchorLocal.x) / denX);
      if (Math.abs(denY) > 1e-6) fy = clampF((local.y - d.anchorLocal.y) / denY);
      if (['n', 's'].includes(d.handle)) fx = 1;
      if (['e', 'w'].includes(d.handle)) fy = 1;
      if (ev.ctrlKey && !['n', 's', 'e', 'w'].includes(d.handle)) {
        // Uniform: follow whichever axis moved more.
        const f = Math.abs(fx - 1) > Math.abs(fy - 1) ? fx : fy;
        fx = f; fy = f;
      }
      d.part.rest.sx = round2(d.startSx * fx);
      d.part.rest.sy = round2(d.startSy * fy);
      // Keep the anchor (opposite corner/side) pinned: measure where it lands with the
      // new scale and push the difference back into the rest translation.
      d.part.rest.tx = d.startTx;
      d.part.rest.ty = d.startTy;
      const mNew = matrixOfTransform(groupTransformOf(d.part, poseTime()));
      const after = applyMat(mNew, d.anchorLocal.x, d.anchorLocal.y);
      const deltaLocal = applyMat(
        d.invChainLinear, d.anchorRoot.x - after.x, d.anchorRoot.y - after.y,
      );
      d.part.rest.tx = round1(d.startTx + deltaLocal.x);
      d.part.rest.ty = round1(d.startTy + deltaLocal.y);
      renderPose();
    } else if (ctx.drag.kind === 'skew') {
      const d = ctx.drag;
      const p = pointerInRoot(ev);
      d.current = { x: p.x, y: p.y };
      const local = applyMat(d.invStart, p.x, p.y);
      const clampTan = (v: number) => Math.min(11.4, Math.max(-11.4, v)); // ±≈85°
      if (d.side === 'n' || d.side === 's') {
        // Horizontal shear: displacement along x relative to the pinned edge's height.
        const h = d.grabLocal.y - d.anchorLocal.y;
        if (Math.abs(h) > 1e-6) {
          const tan = clampTan(d.startTanKx + (local.x - d.grabLocal.x) / h);
          d.part.rest.kx = round1((Math.atan(tan) * 180) / Math.PI);
        }
      } else {
        const w = d.grabLocal.x - d.anchorLocal.x;
        if (Math.abs(w) > 1e-6) {
          const tan = clampTan(d.startTanKy + (local.y - d.grabLocal.y) / w);
          d.part.rest.ky = round1((Math.atan(tan) * 180) / Math.PI);
        }
      }
      // Pin the opposite edge midpoint, same recipe as the scale drag.
      d.part.rest.tx = d.startTx;
      d.part.rest.ty = d.startTy;
      const mNew = matrixOfTransform(groupTransformOf(d.part, poseTime()));
      const after = applyMat(mNew, d.anchorLocal.x, d.anchorLocal.y);
      const deltaLocal = applyMat(
        d.invChainLinear, d.anchorRoot.x - after.x, d.anchorRoot.y - after.y,
      );
      d.part.rest.tx = round1(d.startTx + deltaLocal.x);
      d.part.rest.ty = round1(d.startTy + deltaLocal.y);
      renderPose();
    } else if (ctx.drag.kind === 'ik') {
      const d = ctx.drag;
      const p = pointerInRoot(ev);
      const t = poseTime();
      d.current = { x: p.x, y: p.y }; // drives the overlay's effector→pointer target line
      // Current geometry (recomputed every move — the solve is incremental).
      const e = applyMat(matrixOfTransform(fullPoseTransform(d.grabbed, t)), d.grabLocal.x, d.grabLocal.y);
      const bPiv = effectivePivot(d.p1, t);
      const applyDelta = (part: RigPart, delta: number) => {
        if (Math.abs(delta) < 1e-4) return;
        if (setup) part.rest.rotate = round1(part.rest.rotate + delta);
        else {
          setKeyframe(part.id, 'rotate', round1(channelValue(part, 'rotate', state.currentTime) + delta));
        }
      };
      if (d.p2) {
        const aPiv = effectivePivot(d.p2, t);
        const { delta1, delta2 } = solveTwoBone(aPiv, bPiv, e, { x: p.x, y: p.y });
        applyDelta(d.p2, delta1);
        applyDelta(d.p1, delta2);
      } else {
        applyDelta(d.p1, solveAim(bPiv, e, { x: p.x, y: p.y }));
      }
      renderPose();
      notifyTimelineOnly();
    } else if (ctx.drag.kind === 'boneTip') {
      const p = pointerInRoot(ev);
      const part = ctx.drag.part;
      const tt = poseTime();
      // Rotate + stretch the bone toward the pointer; child origins ride the new tip (the
      // shared joint stays connected). Outside freeze the LBS delta rotates+stretches the
      // skinned art (posing the limb from its bones); inside freeze the bind refreshes each
      // move so the art stays put (fitting the rig against static art).
      aimBoneAtTip(part, { x: p.x, y: p.y }, tt);
      if (state.freezeMode) refreshBindForChain(part.id, tt);
      renderPose();
    } else if (ctx.drag.kind === 'pivot') {
      const d = ctx.drag;
      const p = pointerInRoot(ev);
      const part = d.part;
      const t = poseTime();
      // Snap the target joint position (root space) onto the part's own nodes or other joints.
      let sx = p.x, sy = p.y;
      ctx.snapMarker = null;
      if (snappingActive()) {
        const match = snapPoint({ x: sx, y: sy }, pivotSnapCandidates(part, t), snapThreshold());
        if (match) {
          sx = match.point.x;
          sy = match.point.y;
          ctx.snapMarker = rootToUser(match.point);
        }
      }
      const parentBone = part.kind === 'bone' && part.parentId
        ? state.doc?.parts.find((pp) => pp.id === part.parentId && pp.kind === 'bone')
        : null;
      if (part.kind === 'bone' && parentBone) {
        // A child bone's origin IS the shared joint with its parent's tip. Move the joint by
        // reshaping the PARENT toward the pointer (aim + stretch); the child origin is carried
        // onto the new tip, so the chain never disconnects. Identical to dragging the parent's
        // tip handle. Freeze refreshes the bind so the art stays put; otherwise it deforms.
        aimBoneAtTip(parentBone, { x: sx, y: sy }, t);
        if (state.freezeMode) refreshBindForChain(parentBone.id, t);
        renderPose();
      } else if (part.kind === 'bone') {
        // ROOT bone origin (reached only in freeze): translate the whole chain so every shared
        // joint stays connected, then refresh the bind so the art stays put. Approximate for a
        // chain baked with rest rotation (translateBoneChain), but the anchors stay connected.
        const cur = effectivePivot(part, t);
        const localDelta = applyMat(
          linearOnly(invertMat(chainMatOf(part, t))), sx - cur.x, sy - cur.y,
        );
        translateBoneChain(state.doc!.parts, part.id, round3(localDelta.x), round3(localDelta.y));
        if (state.freezeMode) refreshBindForChain(part.id, t);
        renderPose();
      } else {
        // Art-part pivot (freeze-only): re-anchor the joint WITHOUT moving the artwork. The
        // pivot anchors the part's own rotation AND innermost rest scale/skew, so re-anchoring
        // it shifts the render unless the rest translation absorbs the difference. Solve both:
        // find pivot pv with pv + translate(pv) = pointer, where translate(pv) keeps the
        // drag-start own matrix intact — affine in pv, so one Jacobian step solves it exactly.
        const local = applyMat(invertMat(chainMatOf(part, t)), sx, sy);
        const rot = channelValue(part, 'rotate', t);
        const ownMat = (pv: { x: number; y: number }): Mat =>
          matrixOfTransform(
            [`rotate(${rot},${pv.x},${pv.y})`, part.transform, innerLocalTransform(part, pv)]
              .filter(Boolean)
              .join(' '),
          );
        const m0 = ownMat(d.startPivot);
        const translateFor = (pv: { x: number; y: number }) => {
          // m0 · ownMat(pv)⁻¹ is a pure translation (identical linear parts).
          const dm = multiply(m0, invertMat(ownMat(pv)));
          return { x: d.startTranslate.x + dm.e, y: d.startTranslate.y + dm.f };
        };
        const F = (pv: { x: number; y: number }) => {
          const tn = translateFor(pv);
          return { x: pv.x + tn.x, y: pv.y + tn.y };
        };
        const seed = { x: local.x - d.startTranslate.x, y: local.y - d.startTranslate.y };
        const f0 = F(seed);
        const fx = F({ x: seed.x + 1, y: seed.y });
        const fy = F({ x: seed.x, y: seed.y + 1 });
        const ja = fx.x - f0.x, jb = fx.y - f0.y, jc = fy.x - f0.x, jd = fy.y - f0.y;
        const det = ja * jd - jb * jc;
        let pv = seed;
        if (Math.abs(det) > 1e-9) {
          const rx = local.x - f0.x, ry = local.y - f0.y;
          pv = {
            x: seed.x + (jd * rx - jc * ry) / det,
            y: seed.y + (ja * ry - jb * rx) / det,
          };
        }
        part.pivot = { x: round1(pv.x), y: round1(pv.y) };
        // Recompute the compensation for the ROUNDED pivot so the artwork stays put exactly
        // (finer rounding — 0.1 on the translation would visibly wiggle the art).
        const tn = translateFor(part.pivot);
        part.rest.tx = round3(tn.x);
        part.rest.ty = round3(tn.y);
        renderPose();
      }
    } else if (ctx.drag.kind === 'bendSegment') {
      const d = ctx.drag;
      const path = d.part.paths.find((p) => p.id === d.pathId);
      if (!path) return;
      const cmds = parsePath(path.d);
      const p0 = segmentStart(cmds, d.cmdIndex);
      let c = cmds[d.cmdIndex];
      if (!p0 || !c || (c.cmd !== 'L' && c.cmd !== 'C' && c.cmd !== 'Z')) return;
      if (c.cmd === 'Z') {
        // The implicit closing line becomes a REAL segment: an explicit cubic back
        // to the subpath start, in front of the Z (which then closes a zero-length
        // gap). This is how a handle-less closing edge grows handles.
        const s0 = subpathStart(cmds, d.cmdIndex);
        if (!s0) return;
        const closing: PathCmd = {
          cmd: 'C',
          x1: p0.x + (s0.x - p0.x) / 3, y1: p0.y + (s0.y - p0.y) / 3,
          x2: p0.x + (2 * (s0.x - p0.x)) / 3, y2: p0.y + (2 * (s0.y - p0.y)) / 3,
          x: s0.x, y: s0.y,
        };
        cmds.splice(d.cmdIndex, 0, closing);
        if (path.nodeTypes) {
          // The new node duplicates the subpath start; give it a corner flag at the
          // exact position so every later node keeps its type.
          const types = ensureNodeTypes(path); // pre-splice length — recompute below
          const ni = nodeIndexOf(cmds, d.cmdIndex);
          path.nodeTypes = types.slice(0, ni) + 'c' + types.slice(ni);
        }
        ctx.selectedNodes.clear(); // command indexes shifted
        ctx.selectedNode = null;
        c = closing;
      }
      if (c.cmd === 'L') {
        // Auto-add handles: the straight segment becomes an equivalent cubic.
        c = {
          cmd: 'C',
          x1: p0.x + (c.x - p0.x) / 3, y1: p0.y + (c.y - p0.y) / 3,
          x2: p0.x + (2 * (c.x - p0.x)) / 3, y2: p0.y + (2 * (c.y - p0.y)) / 3,
          x: c.x, y: c.y,
        };
        cmds[d.cmdIndex] = c;
      }
      const local = pointerInPathSpace(ev, d.part, path);
      const cur = pointOnSegment(p0, c, d.t);
      // Move both control points (minimal-norm solve) so the curve point at t
      // follows the pointer exactly while the segment's endpoints stay fixed.
      const u = 1 - d.t;
      const b1 = 3 * u * u * d.t;
      const b2 = 3 * u * d.t * d.t;
      const denom = b1 * b1 + b2 * b2;
      const dx = local.x - cur.x;
      const dy = local.y - cur.y;
      c.x1 += (dx * b1) / denom;
      c.y1 += (dy * b1) / denom;
      c.x2 += (dx * b2) / denom;
      c.y2 += (dy * b2) / denom;
      // Re-apply the smooth/symmetric mirror constraint at BOTH endpoint nodes of the
      // bent segment — writing x1/x2 directly above bypassed the mirroring moveNode
      // gives ordinary handle drags, so an 's'/'z' node silently degraded to a corner
      // when its segment was bent instead of dragged (P2b bug fix).
      applyMirrorConstraint(cmds, d.cmdIndex, 'x1', path.nodeTypes ?? null);
      applyMirrorConstraint(cmds, d.cmdIndex, 'x2', path.nodeTypes ?? null);
      path.d = serializePath(cmds);
      ctx.svg!.querySelector(`[data-path-id="${path.id}"]`)?.setAttribute('d', path.d);
      renderOverlay();
    } else if (ctx.drag.kind === 'node') {
      moveNode(ctx.drag, ev);
    }
  });

  const end = () => {
    if (ctx.drag) {
      if (ctx.drag.kind === 'pan') ctx.svg!.style.cursor = '';
      if (ctx.drag.kind === 'placeBone') {
        // Release finishes the bone: origin = press point, tip = release point.
        const origin = ctx.drag.originRoot;
        const tipRoot = ctx.drag.current ?? origin;
        const parent = selectedPart();
        const t = poseTime();
        const inv = parent
          ? invertMat(matrixOfTransform(fullPoseTransform(parent, t)))
          : null;
        const toLocal = (pt: { x: number; y: number }) =>
          inv ? applyMat(inv, pt.x, pt.y) : pt;
        const pivotL = toLocal(origin);
        let tipL = toLocal(tipRoot);
        if (Math.hypot(tipL.x - pivotL.x, tipL.y - pivotL.y) < 2) {
          // A bare click still yields a usable bone: short and pointing right.
          tipL = { x: pivotL.x + (state.doc?.viewBox.w ?? 200) * 0.06, y: pivotL.y };
        }
        checkpoint();
        const bone = addNullPart(
          'bone', { x: round1(pivotL.x), y: round1(pivotL.y) }, parent?.id ?? null,
        );
        bone.boneTip = { x: round1(tipL.x), y: round1(tipL.y) };
        registerPart(bone);
        // AUTO-BIND ON PLACEMENT (Bones 2.0): resolve the whole chain this bone belongs
        // to and skin every overlapping art part — under the SAME checkpoint, so undo
        // reverts placement + binding as one gesture.
        autoBindPlacedBone(bone.id);
        cancelBonePlacement();
        selectPart(bone.id);
      }
      if (ctx.drag.kind === 'nodeMarquee') {
        // Select every node handle whose center sits inside the rubber band.
        const r = ctx.drag.rect.getBoundingClientRect();
        ctx.drag.rect.remove();
        if (!ctx.drag.additive) ctx.selectedNodes.clear();
        const isClick = r.width < 3 && r.height < 3;
        if (!isClick && ctx.svg) {
          for (const h of ctx.svg.querySelectorAll<SVGCircleElement>('.node-handle')) {
            const hb = h.getBoundingClientRect();
            const cx = hb.left + hb.width / 2;
            const cy = hb.top + hb.height / 2;
            if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
              ctx.selectedNodes.add(nodeKey(h.dataset.pathId!, Number(h.dataset.cmdIndex)));
            }
          }
        }
        const last = [...ctx.selectedNodes].pop();
        ctx.selectedNode = last ? parseNodeKey(last) : null;
      }
      // A motionless click on the already-selected part cycles scale ↔ rotate handles
      // (from either a translate or a rotate body-drag press, so the set cycles both
      // ways and the body drag flips translate↔rotate to match).
      if (
        (ctx.drag.kind === 'translate' || ctx.drag.kind === 'rotate') &&
        !ctx.drag.active && ctx.drag.toggleOnClick
      ) {
        ctx.handleMode = ctx.handleMode === 'scale' ? 'rotate' : 'scale';
      }
      // A FREEZE-mode bone reshape kept the art frozen per-move via the bind refresh (using
      // the cached weights); rebuild each bound part's auto weights ONCE now, from the final
      // bind segments, so later posing deforms correctly from the new bone layout.
      if (state.freezeMode) {
        for (const id of frozenReshapedBoneIds(ctx.drag)) refreshFrozenSkinWeights(id);
      }
      ctx.drag = null;
      ctx.snapMarker = null; // drop any snap marker before the final repaint
      notify();
      renderPose(); // clears gizmos + snap marker
    }
  };
  ctx.svg.addEventListener('pointerup', end);
  ctx.svg.addEventListener('pointercancel', end);
}

/** The bone whose chain a freeze bone drag edits (any chain member — the helpers resolve
 *  the full chain from it), or null when the drag isn't a bone reshape. */
function frozenChainBoneId(d: DragState): string | null {
  if (d.kind === 'boneTip') return d.part.kind === 'bone' ? d.part.id : null;
  if (d.kind === 'pivot') return d.part.kind === 'bone' ? d.part.id : null;
  if (d.kind === 'rotate') return d.targets.find((tt) => tt.part.kind === 'bone')?.part.id ?? null;
  return null;
}

/**
 * The bone(s) a drag reshaped, for the freeze gesture-end weight refresh (empty when the
 * gesture didn't reshape a bone). A pivot drag on a CHILD bone reshapes its PARENT (the
 * shared joint); on a ROOT bone it translates that bone's chain. refreshFrozenSkinWeights
 * resolves the full chain from any member, so returning one id per touched chain suffices.
 */
function frozenReshapedBoneIds(d: DragState): string[] {
  if (d.kind === 'boneTip' && d.active) return d.part.kind === 'bone' ? [d.part.id] : [];
  if (d.kind === 'pivot' && d.active && d.part.kind === 'bone') {
    const parent = d.part.parentId
      ? state.doc?.parts.find((p) => p.id === d.part.parentId && p.kind === 'bone')
      : null;
    return [parent?.id ?? d.part.id];
  }
  if (d.kind === 'rotate' && d.active) {
    return d.targets.filter((tt) => tt.part.kind === 'bone').map((tt) => tt.part.id);
  }
  return [];
}

// The timeline listens for this to redraw keyframe diamonds during a drag without the
// heavier full-panel rebuild that notify() triggers on pointer-up.
function notifyTimelineOnly(): void {
  document.dispatchEvent(new CustomEvent('rig-keys-changed'));
}

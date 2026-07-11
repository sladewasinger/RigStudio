/**
 * The editing canvas: renders the rig as live SVG and handles direct manipulation.
 *
 * Global editing modes (state.editorMode):
 *   Setup   — edit the character itself, Inkscape-style: dragging a part MOVES it
 *             (rest tx/ty); the selected part shows corner/side SCALE handles, and
 *             clicking it again swaps them for corner ROTATE handles (drag to spin the
 *             rest pose around the pivot). Pivots are draggable, node editing is
 *             available, double-clicking enters a part and selects the path under the
 *             cursor. Nothing here ever creates keyframes.
 *   Animate — dragging a part rotates it around its pivot (Shift+drag translates),
 *             recording keyframes at the playhead. Keyed values are ABSOLUTE; channels
 *             without keys fall back to the rest pose (see model.channelValue).
 *
 * Navigation: scroll wheel zooms around the cursor, middle-button drag pans, and
 * resetView() re-fits the document.
 *
 * Parts may be parented (part.parentId): a part's pose rides on its ancestors' poses,
 * so rotating an upper arm carries the forearm. Overlay pivots track the LIVE joint
 * positions. Rest scale (sx/sy) applies along the artwork's own local axes around the
 * joint — innermost, after the baked transform — so the selection box scales cleanly
 * and the pivot never moves; like baked transforms, it does not propagate to children.
 */

import {
  RigPart, RigPath, state, notify, setKeyframe, selectedPart, selectedParts,
  selectPart, ancestorChain, channelValue, addNullPart,
} from './model';
import {
  parsePath, serializePath, PathCmd,
} from './paths';
import { Mat, applyMat, invertMat, matrixOfTransform, multiply } from './transforms';
import { solveAim, solveTwoBone } from './ik';
import { snapPoint, snapDelta, SnapAxis } from './snap';
import { checkpoint } from './history';
import {
  ctx, DragState, SVG_NS, ROTATE_SNAP_DEGREES, DRAG_THRESHOLD_PX, MIN_SCALE, MAX_SCALE,
  round1, round2, round3, linearOnly, nodeKey, parseNodeKey, snappingActive,
} from './view/context';
import {
  svgPoint, pointerInRoot, snapThreshold, rootToUser,
  pointerInPathSpace, handleSize,
} from './view/coords';
import {
  poseTime, innerLocalTransform, fullPoseTransform, groupTransformOf,
  chainMatOf, ownTranslateOf, effectivePivot, partRootBoxes,
} from './view/pose';
import {
  clearGroupEntry, enterGroupsFor, artworkUnderPointer,
} from './view/focus';
import { renderOverlay } from './view/overlay';
import { renderPose, setPoseSampler } from './view/render';
import {
  applyPathAttrs, updatePathAttrs, reorderCanvas, registerPart, unregisterPart,
} from './view/partDom';
import {
  pivotSnapCandidates, translateSnapFeatures,
} from './view/snapping';
import {
  nodeIndexOf, ensureNodeTypes, segmentStart, pointOnSegment, segmentHit, subpathStart,
  mirrorInfoFor, editNodeStructure, moveNode,
} from './view/nodeEditing';
import { cancelBonePlacement } from './view/rigOps';
import { applyViewRect, zoomAround } from './view/camera';

export { partRootBoxes };
export { clearGroupEntry, enterGroupsFor };
export { renderPose, setPoseSampler };
export { updatePathAttrs, reorderCanvas, registerPart, unregisterPart };
export {
  hasSelectedNode, selectedNodeCount, selectAllNodes, primaryNodeType, applyNodeOp,
  deleteSelectedNodes, nudgeSelectedNodes, canDeleteSegment, canJoinNodes,
  deleteSelectedSegment, joinSelectedNodes,
} from './view/nodeEditing';
export type { NodeOp } from './view/nodeEditing';
export {
  flipSelected, nudgeSelectedParts, applyRootDeltas, bindSelectedToBones,
  unbindSelectedSkin, startBonePlacement, cancelBonePlacement,
} from './view/rigOps';
export { resetView, zoomBy } from './view/camera';

export function buildCanvas(container: HTMLElement): void {
  container.innerHTML = '';
  const doc = state.doc;
  if (!doc) return;

  ctx.svg = document.createElementNS(SVG_NS, 'svg');
  if (!ctx.viewRect) ctx.viewRect = { ...doc.viewBox };
  applyViewRect();
  ctx.svg.id = 'rig-svg';

  ctx.onionGroup = document.createElementNS(SVG_NS, 'g');
  ctx.onionGroup.id = 'onion';
  ctx.svg.appendChild(ctx.onionGroup);
  ctx.rootGroup = document.createElementNS(SVG_NS, 'g');
  ctx.svg.appendChild(ctx.rootGroup);
  ctx.overlay = document.createElementNS(SVG_NS, 'g');
  ctx.overlay.id = 'overlay';
  ctx.svg.appendChild(ctx.overlay);

  ctx.partGroups.clear();
  for (const part of doc.parts) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.dataset.partId = part.id;
    for (const p of part.paths) {
      const el = document.createElementNS(SVG_NS, 'path');
      applyPathAttrs(el, p);
      el.dataset.pathId = p.id;
      g.appendChild(el);
    }
    ctx.rootGroup.appendChild(g);
    ctx.partGroups.set(part.id, g);
  }
  container.appendChild(ctx.svg);

  // Apply the rest pose first so each group carries its baked transform, THEN measure:
  // bbox centers must be mapped through the part transform into root coordinates.
  renderPose();
  for (const part of doc.parts) {
    const needsSeed = part.pivotHint || (part.pivot.x === 0 && part.pivot.y === 0);
    if (!needsSeed) continue;
    const g = ctx.partGroups.get(part.id)!;
    const box = g.getBBox();
    const local = svgPoint(box.x + box.width / 2, box.y + box.height / 2);
    const m = g.getCTM();
    const rootM = ctx.rootGroup.getCTM();
    if (!m || !rootM) continue;
    const center = local.matrixTransform(m).matrixTransform(rootM.inverse());
    if (part.pivotHint) {
      // Authored rotation center (Inkscape crosshair), offset from the bbox center.
      part.pivot = { x: center.x + part.pivotHint.dx, y: center.y + part.pivotHint.dy };
      part.pivotHint = null;
    } else {
      part.pivot = { x: center.x, y: center.y };
    }
  }

  wireInteractions();
  renderPose();
}

// ---- Interactions ----

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

function wireInteractions(): void {
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
    // First: open the outermost still-closed group and select the next level.
    const closed = ancestorChain(part).find(
      (a) => a.kind === 'group' && !ctx.enteredGroups.has(a.id),
    );
    if (closed) {
      ctx.enteredGroups.add(closed.id);
      const next = ancestorChain(part).find(
        (a) => a.kind === 'group' && !ctx.enteredGroups.has(a.id),
      );
      selectPart(next?.id ?? part.id);
      notify();
      renderPose();
      return;
    }
    // Then: enter the part and select the path under the cursor (Setup only).
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
    // set the tip — like drawing a bone in Rive/Blender.
    if (ctx.placingBone && ev.button === 0) {
      const p = pointerInRoot(ev);
      ctx.drag = { kind: 'placeBone', originRoot: { x: p.x, y: p.y }, current: null };
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
        targets: selectedParts().map((sp) => ({
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
      ctx.drag = {
        kind: 'rotate',
        targets: selectedParts().map((sp) => ({
          part: sp,
          start: setup ? sp.rest.rotate : channelValue(sp, 'rotate', state.currentTime),
        })),
        pivotX: pivot.x, pivotY: pivot.y,
        startAngle: Math.atan2(p.y - pivot.y, p.x - pivot.x),
        current: { x: p.x, y: p.y },
        currentDelta: 0,
        snapped: false,
        startClient: { x: ev.clientX, y: ev.clientY },
        active: false,
      };
      try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      return;
    }

    // Bone tip: re-aim/re-length the bone (Setup).
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

    // Scale handle (Setup mode)
    if (target instanceof SVGElement && target.dataset.handle) {
      const part = selectedPart();
      const g = part ? ctx.partGroups.get(part.id) : null;
      if (!part || !g) return;
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

    // Rotate handle (Setup mode): spin the rest pose around the pivot.
    if (target instanceof SVGElement && target.dataset.role === 'rotate-handle') {
      const part = selectedPart();
      if (!part) return;
      const p = pointerInRoot(ev);
      const pivot = effectivePivot(part, poseTime());
      ctx.drag = {
        kind: 'rotate',
        targets: selectedParts().map((sp) => ({ part: sp, start: sp.rest.rotate })),
        pivotX: pivot.x, pivotY: pivot.y,
        startAngle: Math.atan2(p.y - pivot.y, p.x - pivot.x),
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
      const path = part.paths.find((p) => p.id === pathId);
      const nodeDrag: DragState = {
        kind: 'node',
        part,
        pathId,
        cmdIndex,
        field,
        mirror:
          field === 'x' || !path
            ? null
            : mirrorInfoFor(parsePath(path.d), cmdIndex, field, path.nodeTypes ?? null),
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
        // Shift adds to the selection; clicking an already-selected part keeps the
        // group selected so multi-part drags work.
        if (ev.shiftKey || state.selectedPartIds.includes(part.id)) {
          selectPart(part.id, true);
        } else {
          selectPart(part.id);
        }
      } else {
        selectPart(null);
      }
      if (part && state.mode === 'rig' && !part.skin) {
        const p = pointerInRoot(ev);
        const t = poseTime();
        const setup = state.editorMode === 'setup';
        // Which manipulation does a body drag perform?
        //   select tool — Setup moves the part, Animate rotates (Shift moves);
        //   translate/rotate tools force that manipulation in both modes;
        //   ik tool solves the ancestor chain toward the pointer.
        const action: 'translate' | 'rotate' | 'ik' =
          state.tool === 'select'
            ? (setup || ev.shiftKey ? 'translate' : 'rotate')
            : state.tool;

        if (action === 'ik') {
          const ancestors = ancestorChain(part); // outermost first
          const p1 = ancestors[ancestors.length - 1] ?? null;
          const p2 = ancestors[ancestors.length - 2] ?? null;
          if (p1) {
            const grabLocal = applyMat(
              invertMat(matrixOfTransform(fullPoseTransform(part, t))), p.x, p.y,
            );
            ctx.drag = {
              kind: 'ik', p1, p2, grabbed: part,
              grabLocal: { x: grabLocal.x, y: grabLocal.y },
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
            targets: selectedParts().map((sp) => ({
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
            toggleOnClick:
              state.tool === 'select' && setup && wasPrimary && !ev.shiftKey,
          };
        } else {
          const pivot = effectivePivot(part, t);
          ctx.drag = {
            kind: 'rotate',
            targets: selectedParts().map((sp) => ({
              part: sp,
              start: setup
                ? sp.rest.rotate
                : channelValue(sp, 'rotate', state.currentTime),
            })),
            pivotX: pivot.x, pivotY: pivot.y,
            startAngle: Math.atan2(p.y - pivot.y, p.x - pivot.x),
            current: { x: p.x, y: p.y },
            currentDelta: 0,
            snapped: false,
            startClient: { x: ev.clientX, y: ev.clientY },
            active: false,
          };
        }
        try { ctx.svg!.setPointerCapture(ev.pointerId); } catch { /* synthetic */ }
      }
      notify();
      return;
    }


    // Blank canvas: clear the selection, close entered groups, leave any "entered"
    // path. No drag follows a blank click, so repaint the overlay here — notify()
    // only rebuilds the side panels, and the stale selection box would linger.
    state.selectedPathId = null;
    ctx.enteredGroups.clear();
    selectPart(null);
    notify();
    renderOverlay();
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

    if (!activateDrag(ctx.drag, ev)) return;
    const setup = state.editorMode === 'setup';

    if (ctx.drag.kind === 'rotate') {
      const p = pointerInRoot(ev);
      const angle = Math.atan2(p.y - ctx.drag.pivotY, p.x - ctx.drag.pivotX);
      const deltaDeg = ((angle - ctx.drag.startAngle) * 180) / Math.PI;
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
      const local = applyMat(
        invertMat(matrixOfTransform(fullPoseTransform(part, poseTime()))), p.x, p.y,
      );
      part.boneTip = { x: round1(local.x), y: round1(local.y) };
      renderPose();
    } else if (ctx.drag.kind === 'pivot') {
      const d = ctx.drag;
      const p = pointerInRoot(ev);
      const part = d.part;
      const t = poseTime();
      // Snap the target joint position (root space) onto the part's own nodes or other
      // joints. The pivot-compensation solve below then keeps the artwork fixed, so the
      // joint lands on the target WITHOUT moving the art.
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
      // Un-apply the ancestors' motion so we work in the part's parent-chain frame
      // (pivot + own translate live there: effectivePivot = chain · (pivot + ot)).
      const local = applyMat(invertMat(chainMatOf(part, t)), sx, sy);
      // Moving the joint must never move the artwork. The pivot anchors the part's
      // own rotation AND the innermost rest scale/skew, so re-anchoring it shifts
      // the rendered art unless the rest translation absorbs the difference. Solve
      // both together: find pivot pv with pv + translate(pv) = pointer, where
      // translate(pv) is the own-translate that keeps the drag-start own matrix
      // intact. translate(pv) is affine in pv, so one Jacobian step (from finite
      // differences) solves it exactly.
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
      // Recompute the compensation for the ROUNDED pivot so the artwork stays put
      // exactly (finer rounding here — 0.1 on the translation would visibly wiggle
      // the art while the pivot slides).
      const tn = translateFor(part.pivot);
      part.rest.tx = round3(tn.x);
      part.rest.ty = round3(tn.y);
      renderPose();
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
      // A motionless click on the already-selected part cycles scale ↔ rotate handles.
      if (ctx.drag.kind === 'translate' && !ctx.drag.active && ctx.drag.toggleOnClick) {
        ctx.handleMode = ctx.handleMode === 'scale' ? 'rotate' : 'scale';
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

// The timeline listens for this to redraw keyframe diamonds during a drag without the
// heavier full-panel rebuild that notify() triggers on pointer-up.
function notifyTimelineOnly(): void {
  document.dispatchEvent(new CustomEvent('rig-keys-changed'));
}

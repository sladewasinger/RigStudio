/**
 * Artwork body press: select (with group-aware substitution + Shift/Ctrl multi-select),
 * then translate/rotate/IK the pose — or, for a skinned part, IK-only (its geometry
 * follows its bones, not a group transform). This is the deepest DOM-driven row: it
 * fires for ANY element carrying data-part-id (art, bone glyph, group glyph alike), so
 * the skinned-art and bone-glyph-IK special cases live INLINE here rather than as
 * separate priority-table rows — they share this press's group-substitution + selection
 * side effect, which must run exactly once regardless of which sub-case ultimately
 * applies (splitting them into independent claim()s would either duplicate that effect
 * or risk skipping it). Must be the LAST DOM-driven row before the blank-canvas
 * fallback — everything above (gizmo/boneTip/handles/node/pivot/nodesBendMarquee) is a
 * more specific hit target that should win first.
 */

import {
  state, notify, selectedParts, selectPart, ancestorChain, channelValue, isGroupLike,
} from '../../../core/model';
import { invertMat } from '../../../geometry/transforms';
import { ctx, DragState, linearOnly } from '../../context';
import { pointerInRoot } from '../../coords';
import { poseTime, chainMatOf, effectivePivot } from '../../pose';
import { renderPose } from '../../render';
import { startIkDrag, startIkDragOnSkinnedArt, updateIkDrag } from '../../ikDrag';
import { capturePointer, moveTranslate, moveRotate } from '../lifecycle';
import { GesturePipeline } from '../priority';

export const ARTWORK_PIPELINE: GesturePipeline = {
  name: 'artwork',
  claim(hit, ev) {
    if (!hit.partEl) return null;
    let part = hit.part;
    // Group-aware selection: clicking artwork inside a closed group selects the
    // group (double-click opens it). Context-aware exception: a part that is
    // ALREADY selected (e.g. picked in the Layers tree) is manipulated directly —
    // never hijacked back to its group.
    if (part && state.mode === 'rig' && !state.selectedPartIds.includes(part.id)) {
      const closed = ancestorChain(part).find(
        (a) => isGroupLike(a, hit.doc.parts) && !ctx.enteredGroups.has(a.id),
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
        // Deepest-in-chain bone is the effector: FABRIK solves the whole chain root→that
        // bone, driving the ACTUAL grabbed point to the pointer (grab-point-relative —
        // not always the tip).
        if (action === 'ik' && startIkDragOnSkinnedArt(part, p, ev)) {
          notify();
          renderPose();
          return 'handled';
        }
        notify();
        renderPose(); // selection box + skinned hint appear without a pan/zoom
        return 'handled';
      }

      // A motionless body click on the already-primary part cycles the handle set
      // (scale ↔ rotate), which is what flips the drag between translate and rotate.
      const canToggle =
        state.tool === 'select' && wasPrimary && !ev.shiftKey && !ev.ctrlKey;

      if (action === 'ik' && part.kind === 'bone') {
        // Grabbing a BONE glyph: FABRIK solves the whole bone chain root→this bone,
        // driving the GRABBED POINT to the pointer (tip or mid-body — grab-point-
        // relative). Every joint in the chain participates, INCLUDING the grabbed bone's
        // own rotation (the reported "only two joints move" fix). A grabbed non-bone
        // (plain art with the IK tool, no skin) has no bone chain to solve, so it falls
        // through to a plain rotate below.
        startIkDrag(part, p, ev);
        notify();
        return 'handled';
      }

      if (action === 'translate') {
        const d: DragState = {
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
        capturePointer(ev);
        notify();
        return d;
      }
      const pivot = effectivePivot(part, t);
      const startAngle0 = Math.atan2(p.y - pivot.y, p.x - pivot.x);
      const d: DragState = {
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
      capturePointer(ev);
      notify();
      return d;
    }
    notify();
    return 'handled';
  },
  move(ev, d) {
    if (d.kind === 'ik') updateIkDrag(ev);
    else if (d.kind === 'translate') moveTranslate(ev, d);
    else if (d.kind === 'rotate') moveRotate(ev, d);
  },
};

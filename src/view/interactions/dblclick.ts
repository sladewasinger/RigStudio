/**
 * The dblclick drill-down handler — a separate DOM listener from the pointerdown
 * gesture-pipeline cascade (a double-click is two full clicks, each already resolved
 * by the pipeline table, plus this dblclick event on top), so it isn't itself a
 * GesturePipeline row. Verbatim extraction from the old interactions.ts.
 */

import {
  state, notify, ancestorChain, selectPart, isGroupLike,
} from '../../core/model';
import { ctx } from '../context';
import { clearGroupEntry, artworkUnderPointer } from '../focus';
import { renderPose } from '../render';
import { endBoneChain } from '../rigOps';

export function wireDblClick(svg: SVGSVGElement): void {
  svg.addEventListener('dblclick', (ev) => {
    // Pen-tool chains: a double-click FINISHES the chain (its two clicks already committed
    // any bones via pointerdown; the second lands on the first, so the MIN_BONE_LENGTH guard
    // drops it). Consume the dblclick so it can't also drill down.
    if (ctx.boneChain || ctx.placingBone) {
      ev.preventDefault();
      endBoneChain();
      notify();
      return;
    }
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
      (a) => isGroupLike(a, state.doc!.parts) && !ctx.enteredGroups.has(a.id),
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
}

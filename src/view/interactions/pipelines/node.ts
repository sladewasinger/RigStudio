/**
 * Node endpoint / control-handle drag (data-role="node", field x|x1|x2 — a plain click
 * selects/toggles, Alt/Ctrl inserts or deletes a node instead of starting a drag). Must
 * precede `pivot` and the node-mode bend/marquee row below it: a node handle sits ON the
 * edited outline, exactly where a bend-hit-test or a pivot marker could also match.
 */

import { selectedPart } from '../../../core/model';
import { checkpoint } from '../../../core/history';
import { ctx, DragState, nodeKey } from '../../context';
import { renderOverlay } from '../../overlay';
import { editNodeStructure, moveNode } from '../../nodeEditing';
import { capturePointer } from '../lifecycle';
import { GesturePipeline } from '../priority';

export const NODE_PIPELINE: GesturePipeline = {
  name: 'node',
  claim(hit, ev) {
    if (!hit.node) return null;
    const part = selectedPart();
    if (!part) return 'handled';
    const { pathId, cmdIndex, field } = hit.node;
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
      return 'handled';
    }
    capturePointer(ev);
    renderOverlay(); // show the new node selection immediately
    return nodeDrag;
  },
  move(ev, d) {
    if (d.kind !== 'node') return;
    moveNode(d, ev);
  },
};

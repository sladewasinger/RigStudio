/**
 * Node endpoint / control-handle drag (data-role="node", field x|x1|x2 — a plain click
 * selects/toggles, Ctrl deletes the node instead of starting a drag). Must precede
 * `pivot` and the node-mode bend/marquee row below it: a node handle sits ON the edited
 * outline, exactly where a bend-hit-test or a pivot marker could also match.
 *
 * Alt+click-to-insert used to live here too (insert AFTER the clicked node, always at
 * its following segment's midpoint) — RETIRED (CLAUDE.md item 1): a node's own hit
 * radius sits well within any adjacent segment's Alt+click-insert tolerance anyway, so
 * the two gestures overlapped and confused more than they helped. Alt+click now only
 * does anything when it lands ON a segment (not a node) — `nodesBendMarquee.ts`, which
 * inserts at the EXACT point clicked instead of an approximate midpoint.
 */

import { selectedPart } from '../../../core/model';
import { checkpoint } from '../../../core/history';
import { parsePath } from '../../../geometry/paths';
import { ctx, DragState, nodeKey } from '../../context';
import { renderOverlay } from '../../overlay';
import { deleteNode, moveNode, seamPartnerIndex } from '../../nodeEditing';
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
      // A merged closing-seam glyph (CLAUDE.md item 3) always selects/deselects its
      // coincident partner index too, so moveNode's existing multi-node same-delta
      // drag path moves both points as one with no drag-code changes at all.
      const key = nodeKey(pathId, cmdIndex);
      const path = part.paths.find((p) => p.id === pathId);
      const partnerIdx = path ? seamPartnerIndex(parsePath(path.d), cmdIndex) : null;
      const partnerKey = partnerIdx != null ? nodeKey(pathId, partnerIdx) : null;
      if (ev.shiftKey) {
        if (ctx.selectedNodes.has(key)) {
          ctx.selectedNodes.delete(key);
          if (partnerKey) ctx.selectedNodes.delete(partnerKey);
        } else {
          ctx.selectedNodes.add(key);
          if (partnerKey) ctx.selectedNodes.add(partnerKey);
        }
      } else if (!ctx.selectedNodes.has(key)) {
        ctx.selectedNodes.clear();
        ctx.selectedNodes.add(key);
        if (partnerKey) ctx.selectedNodes.add(partnerKey);
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
    if (ev.ctrlKey) {
      checkpoint();
      deleteNode(nodeDrag);
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

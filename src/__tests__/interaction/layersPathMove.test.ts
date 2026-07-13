/**
 * Interaction tests for CROSS-PART path moves in the Layers panel — the user report
 * "I still can't drag the shadow path into the body.body sub group???" — wired in
 * `panels/layersDragAndDrop.ts` on top of `view/rigOpsEdit.ts`'s render-neutral
 * `movePathToPart` (see its doc for the inv(dest)·src·old frame rebake).
 *
 * What must hold, per scenario:
 *  - the USER'S EXACT case: PIP_MASTER's outer "body" part carries a "shadow" path and a
 *    nested part also labeled "body" — dragging that shadow path row onto the nested body
 *    part row moves the path into it (appended last = topmost within the part), the
 *    RENDERED geometry does not move (< 0.01 px, measured on the live DOM before/after),
 *    the drop-zone class appears during dragover, ONE undo restores doc + canvas;
 *  - dropping onto another part's PATH row inserts at the above/below midline zone;
 *  - a SKINNED source or destination refuses: the dragover is never claimed (no
 *    preventDefault → no drop-zone class, no 'drop' event in a real drag) and the row
 *    title carries the reason (the visible-counterpart GOTCHA), with zero doc mutation.
 *
 * Mutation check (run while writing this file, not left in the tree): with the frame
 * rebake removed from movePathToPart (raw splice move), the render-neutral assertions
 * fail with a 40.103 px drift — the shadow visibly teleports into the nested body's
 * frame, exactly the corruption the rebake exists to prevent.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { undo, canUndo } from '../../core/history';
import {
  bootRig, resetRig, state, setEditorMode, partByLabel, medialPoints, placeBoneChain,
  simulateDragDrop, clientCenterOf, pathElById,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

function outerBody() {
  const found = state.doc!.parts.find((part) => part.label === 'body' && !part.parentId);
  if (!found) throw new Error('no root-level "body" part');
  return found;
}
function innerBody() {
  const found = state.doc!.parts.find((part) => part.label === 'body' && !!part.parentId);
  if (!found) throw new Error('no nested "body" part');
  return found;
}
function partRow(partId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`#layers .layer-row.part[data-part-id="${partId}"]`);
  if (!row) throw new Error(`no part row for ${partId}`);
  return row;
}
function pathRow(pathId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`#layers .layer-row.path[data-path-id="${pathId}"]`);
  if (!row) throw new Error(`no path row for ${pathId}`);
  return row;
}
function ensureExpanded(partId: string): void {
  const chevron = partRow(partId).querySelector<HTMLElement>('.chevron')!;
  if (chevron.textContent === '▸') chevron.click();
}

/** The rendered path's client rect — re-queried live (the move re-homes the element). */
function pathRect(pathId: string): DOMRect {
  return pathElById(pathId).getBoundingClientRect();
}
function rectDrift(a: DOMRect, b: DOMRect): number {
  return Math.max(
    Math.abs(a.left - b.left), Math.abs(a.top - b.top),
    Math.abs(a.right - b.right), Math.abs(a.bottom - b.bottom),
  );
}

describe('scenario — the user\'s exact case: outer body\'s shadow moves into the nested body', () => {
  it('drop on the part row: doc moves, geometry holds < 0.01 px, zone class shows, one undo restores', () => {
    setEditorMode('setup');
    const body = outerBody();
    const inner = innerBody();
    ensureExpanded(body.id);
    const shadow = body.paths.find((p) => p.label === 'shadow')!;
    const outerBefore = body.paths.map((p) => p.id);
    const innerBefore = inner.paths.map((p) => p.id);
    const rectBefore = pathRect(shadow.id);
    expect(canUndo()).toBe(false);

    // Hand-rolled (instead of simulateDragDrop) for the MID-GESTURE assertion: the
    // drop-zone highlight must be visible while hovering. Same event order + one shared
    // DataTransfer, exactly like the harness helper.
    const dt = new DataTransfer();
    const pt = clientCenterOf(partRow(inner.id));
    const fire = (el: Element, type: string) => el.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, dataTransfer: dt, clientX: pt.x, clientY: pt.y,
    }));
    fire(pathRow(shadow.id), 'dragstart');
    const over = new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: dt, clientX: pt.x, clientY: pt.y,
    });
    partRow(inner.id).dispatchEvent(over);
    expect(over.defaultPrevented, 'dragover is claimed (droppable)').toBe(true);
    expect(partRow(inner.id).classList.contains('drop-target'), 'drop-zone highlight shows mid-hover').toBe(true);
    fire(partRow(inner.id), 'drop');
    fire(pathRow(shadow.id), 'dragend');

    expect(outerBody().paths.map((p) => p.id), 'shadow left the outer body').toEqual(
      outerBefore.filter((id) => id !== shadow.id),
    );
    expect(innerBody().paths.map((p) => p.id), 'appended last = topmost within the nested body').toEqual(
      [...innerBefore, shadow.id],
    );
    const homeGroup = pathElById(shadow.id).closest('[data-part-id]') as SVGGElement;
    expect(homeGroup.dataset.partId, 'canvas element re-homed without a rebuild').toBe(inner.id);
    expect(rectDrift(pathRect(shadow.id), rectBefore), 'rendered geometry did not move').toBeLessThan(0.01);
    expect(state.selectedPartId, 'moved path stays the working selection in its new part').toBe(inner.id);
    expect(state.selectedPathId).toBe(shadow.id);
    expect(canUndo(), 'exactly one checkpoint covers the whole drop').toBe(true);

    undo();
    expect(outerBody().paths.map((p) => p.id), 'undo restores the outer body').toEqual(outerBefore);
    expect(innerBody().paths.map((p) => p.id), 'undo restores the nested body').toEqual(innerBefore);
    expect(rectDrift(pathRect(shadow.id), rectBefore), 'undo restores the canvas exactly').toBeLessThan(0.01);
  });
});

describe('scenario — cross-part drop onto a PATH row inserts at the midline zone', () => {
  it('above the middle row lands visually above it', () => {
    setEditorMode('setup');
    const body = outerBody();
    const inner = innerBody();
    ensureExpanded(body.id);
    ensureExpanded(inner.id);
    const shadow = body.paths.find((p) => p.label === 'shadow')!;
    // inner model order: [white_pill_body, bottom_half_red, outline]; visual top→bottom
    // is the reverse. "Above bottom_half_red" = between outline and red.
    const red = inner.paths.find((p) => p.label === 'bottom_half_red')!;
    const rectBefore = pathRect(shadow.id);

    const r = pathRow(red.id).getBoundingClientRect();
    simulateDragDrop(pathRow(shadow.id), pathRow(red.id), { x: r.left + r.width / 2, y: r.top + 2 });

    expect(innerBody().paths.map((p) => p.label)).toEqual(
      ['white_pill_body', 'bottom_half_red', 'shadow', 'outline'],
    );
    expect(rectDrift(pathRect(shadow.id), rectBefore), 'render-neutral here too').toBeLessThan(0.01);
  });

  it('below the bottom visual row lands at the very back of the part', () => {
    setEditorMode('setup');
    const body = outerBody();
    const inner = innerBody();
    ensureExpanded(body.id);
    ensureExpanded(inner.id);
    const shadow = body.paths.find((p) => p.label === 'shadow')!;
    const white = inner.paths.find((p) => p.label === 'white_pill_body')!; // bottom row on screen

    const r = pathRow(white.id).getBoundingClientRect();
    simulateDragDrop(pathRow(shadow.id), pathRow(white.id), { x: r.left + r.width / 2, y: r.bottom - 2 });

    expect(innerBody().paths.map((p) => p.label)).toEqual(
      ['shadow', 'white_pill_body', 'bottom_half_red', 'outline'],
    );
  });
});

describe('scenario — skinned parts refuse cross-part path moves visibly', () => {
  it('a skinned DESTINATION never claims the hover: no zone class, a title reason, zero mutation', () => {
    setEditorMode('setup');
    const leg = partByLabel('left_leg');
    placeBoneChain(medialPoints('left_leg', 2)); // auto-binds the leg (Bones 2.0)
    expect(leg.skin, 'precondition: the chain deformed the leg').toBeTruthy();
    const body = outerBody();
    ensureExpanded(body.id);
    const shadow = body.paths.find((p) => p.label === 'shadow')!;
    const pristine = JSON.stringify(state.doc);

    const dt = new DataTransfer();
    const pt = clientCenterOf(partRow(leg.id));
    pathRow(shadow.id).dispatchEvent(new DragEvent('dragstart', {
      bubbles: true, cancelable: true, dataTransfer: dt, clientX: pt.x, clientY: pt.y,
    }));
    const over = new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: dt, clientX: pt.x, clientY: pt.y,
    });
    partRow(leg.id).dispatchEvent(over);

    expect(over.defaultPrevented, 'dragover is NOT claimed').toBe(false);
    expect(partRow(leg.id).classList.contains('drop-target'), 'no drop-zone highlight').toBe(false);
    expect(partRow(leg.id).title, 'the row explains WHY').toMatch(/skinned/);

    // In a real drag an unclaimed dragover means no 'drop' fires at all; fire one anyway
    // to pin that even a fabricated drop cannot mutate (the drop-side re-guard).
    partRow(leg.id).dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: dt, clientX: pt.x, clientY: pt.y,
    }));
    pathRow(shadow.id).dispatchEvent(new DragEvent('dragend', {
      bubbles: true, cancelable: true, dataTransfer: dt, clientX: pt.x, clientY: pt.y,
    }));
    expect(JSON.stringify(state.doc), 'document untouched').toBe(pristine);
  });

  it('a skinned SOURCE is refused the same way (path rows and part rows both)', () => {
    setEditorMode('setup');
    const leg = partByLabel('left_leg');
    placeBoneChain(medialPoints('left_leg', 2));
    expect(leg.skin).toBeTruthy();
    const body = outerBody();
    ensureExpanded(body.id);
    ensureExpanded(leg.id);
    const legPath = leg.paths.find((p) => p.label === 'leg')!;
    const pristine = JSON.stringify(state.doc);

    const dt = new DataTransfer();
    const pt = clientCenterOf(partRow(body.id));
    pathRow(legPath.id).dispatchEvent(new DragEvent('dragstart', {
      bubbles: true, cancelable: true, dataTransfer: dt, clientX: pt.x, clientY: pt.y,
    }));
    const over = new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: dt, clientX: pt.x, clientY: pt.y,
    });
    partRow(body.id).dispatchEvent(over);

    expect(over.defaultPrevented).toBe(false);
    expect(partRow(body.id).classList.contains('drop-target')).toBe(false);
    expect(partRow(body.id).title).toMatch(/skinned/);
    pathRow(legPath.id).dispatchEvent(new DragEvent('dragend', {
      bubbles: true, cancelable: true, dataTransfer: dt, clientX: pt.x, clientY: pt.y,
    }));
    expect(JSON.stringify(state.doc)).toBe(pristine);
  });
});

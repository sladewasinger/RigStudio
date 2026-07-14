/**
 * U4 (unified child ordering — the user-visible layer): full drag-reorder between ANY
 * Layers rows, paths and parts as siblings.
 *
 * THE ORIGINATING COMPLAINT (verbatim, the acceptance test): "I STILL can't move PIPs
 * body shading (called shadow) up or down in this layer" — PIP_MASTER's outer `body`
 * part holds a nested `body` part AND its own `shadow` path as sibling rows; dragging
 * the shadow row below/above the nested-body row must restack them like Inkscape/GIMP.
 * Each scenario asserts ALL THREE layers of truth agree after the real drag gesture:
 * the model slots (childOrder), the panel row order (DOM), and the canvas paint order
 * (DOM) — then that ONE undo restores every one of them.
 *
 * Mutation checks (run while writing this file, not left in the tree — exact failures
 * recorded in the wave report):
 *  - `moveChildSlot` with its `slotMoveWithin` call removed → the shadow-below-body
 *    scenario fails at the model-slot assertion (order stays ['part','path']);
 *  - the importer's `slotAddChild` recording dropped → the same scenario fails in
 *    `beforeEach` sanity (recorded order arrives paths-first, not the document order).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { undo, redo, canUndo } from '../../core/history';
import { flattenPaintOrder } from '../../core/model';
import {
  bootRig, resetRig, state, setEditorMode, partByLabel, rootGEl, simulateDragDrop,
  pressKey,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

function outerBody() {
  const found = state.doc!.parts.find((p) => p.label === 'body' && !p.parentId);
  if (!found) throw new Error('no root-level "body" part');
  return found;
}
function innerBody() {
  const found = state.doc!.parts.find((p) => p.label === 'body' && !!p.parentId);
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

/** Every layer row's key (partId or pathId), panel top-to-bottom DOM order. */
function panelRowOrder(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('#layers .layer-row'))
    .map((el) => el.dataset.partId ?? el.dataset.pathId!)
    .filter(Boolean);
}

/** Canvas run order: `partId` per top-level run group, live DOM order (bottom→top). */
function canvasRunOrder(): string[] {
  return Array.from(rootGEl().children)
    .map((g) => (g as SVGElement).dataset?.partId)
    .filter((id): id is string => !!id);
}

/** Assert the canvas paints exactly what the model's own flatten says (rest order). */
function assertCanvasMatchesModel(): void {
  expect(canvasRunOrder()).toEqual(flattenPaintOrder(state.doc!, () => 0).map((r) => r.partId));
}

/** Client point in a row's TOP or BOTTOM edge zone (part rows: outer quarter). */
function edgeOf(el: Element, edge: 'top' | 'bottom'): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: edge === 'top' ? r.top + r.height * 0.1 : r.bottom - r.height * 0.1 };
}

describe('scenario — THE user complaint: the body shadow path moves below/above its sibling PART', () => {
  it('drag shadow BELOW the nested body row: slots, panel rows, and canvas all restack; one undo restores all three', () => {
    setEditorMode('setup');
    const body = outerBody();
    const inner = innerBody();
    ensureExpanded(body.id);
    const shadow = body.paths.find((p) => p.label === 'shadow')!;
    // Import sanity (the U4 importer): true document order = nested body BELOW shadow.
    expect(body.childOrder!.map((s) => s.kind)).toEqual(['part', 'path']);
    const panelBefore = panelRowOrder();
    expect(panelBefore.indexOf(shadow.id), 'shadow row starts ABOVE the nested body row')
      .toBeLessThan(panelBefore.indexOf(inner.id));
    assertCanvasMatchesModel();
    expect(canUndo()).toBe(false);

    // The REAL gesture: drag the shadow PATH row into the nested-body PART row's bottom
    // edge zone (= "insert just below it, as a sibling slot").
    simulateDragDrop(pathRow(shadow.id), partRow(inner.id), edgeOf(partRow(inner.id), 'bottom'));

    // Model: slots flipped to [path shadow, part body].
    expect(outerBody().childOrder!.map((s) => `${s.kind}:${s.id}`))
      .toEqual([`path:${shadow.id}`, `part:${inner.id}`]);
    // Panel: the shadow row now renders BELOW the nested body row.
    const panelAfter = panelRowOrder();
    expect(panelAfter.indexOf(shadow.id)).toBeGreaterThan(panelAfter.indexOf(inner.id));
    // Canvas: the outer body's shadow run paints BEFORE (under) the nested body.
    const canvas = canvasRunOrder();
    expect(canvas.indexOf(outerBody().id)).toBeLessThan(canvas.indexOf(inner.id));
    assertCanvasMatchesModel();
    expect(canUndo(), 'exactly one checkpoint covers the whole drop').toBe(true);

    undo();
    expect(outerBody().childOrder!.map((s) => s.kind), 'undo restores the model slots')
      .toEqual(['part', 'path']);
    const panelUndone = panelRowOrder();
    expect(panelUndone.indexOf(shadow.id), 'undo restores the panel rows')
      .toBeLessThan(panelUndone.indexOf(innerBody().id));
    const canvasUndone = canvasRunOrder();
    expect(canvasUndone.indexOf(outerBody().id), 'undo restores the canvas stacking')
      .toBeGreaterThan(canvasUndone.indexOf(innerBody().id));
    assertCanvasMatchesModel();
  });

  it('…and back UP: dragging the shadow row above the nested body restacks it on top again', () => {
    setEditorMode('setup');
    const body = outerBody();
    const inner = innerBody();
    ensureExpanded(body.id);
    const shadow = body.paths.find((p) => p.label === 'shadow')!;
    // First move it below (same gesture as above), then drag it back over the top edge.
    simulateDragDrop(pathRow(shadow.id), partRow(inner.id), edgeOf(partRow(inner.id), 'bottom'));
    expect(outerBody().childOrder!.map((s) => s.kind)).toEqual(['path', 'part']);

    simulateDragDrop(pathRow(shadow.id), partRow(inner.id), edgeOf(partRow(inner.id), 'top'));

    expect(outerBody().childOrder!.map((s) => s.kind)).toEqual(['part', 'path']);
    const canvas = canvasRunOrder();
    expect(canvas.indexOf(outerBody().id), 'shadow paints on top of the nested body again')
      .toBeGreaterThan(canvas.indexOf(inner.id));
    assertCanvasMatchesModel();
  });

  it('PageDown on the entered shadow path crosses the sibling PART row (slot stepping)', () => {
    setEditorMode('setup');
    const body = outerBody();
    ensureExpanded(body.id);
    const shadow = body.paths.find((p) => p.label === 'shadow')!;
    // Enter the path (like clicking its row) so the step targets its slot.
    pathRow(shadow.id).click();
    expect(state.selectedPathId).toBe(shadow.id);

    pressKey('PageDown');

    expect(outerBody().childOrder!.map((s) => s.kind), 'one step crossed the part slot')
      .toEqual(['path', 'part']);
    assertCanvasMatchesModel();

    pressKey('PageUp');
    expect(outerBody().childOrder!.map((s) => s.kind)).toEqual(['part', 'path']);
    assertCanvasMatchesModel();
  });
});

describe('scenario — a PART row dragged between two PATH rows becomes a slotted child', () => {
  it('eyes dropped between left_leg\'s two path rows reparents + slots it there; undo/redo round-trips', () => {
    setEditorMode('setup');
    const leg = partByLabel('left_leg');
    const eyes = partByLabel('eyes');
    const face = partByLabel('face');
    expect(eyes.parentId).toBe(face.id);
    ensureExpanded(face.id); // the eyes row lives inside face's folder
    ensureExpanded(leg.id);
    // left_leg's slots are [path leg, path shadow] — rows top→bottom: shadow, leg.
    const legPathIds = leg.paths.map((p) => p.id);
    const shadowPath = leg.paths.find((p) => p.label === 'shadow')!;

    // Drop the eyes PART row on the BOTTOM half of the shadow PATH row = between the
    // two path rows (slot 1 of left_leg).
    const r = pathRow(shadowPath.id).getBoundingClientRect();
    simulateDragDrop(partRow(eyes.id), pathRow(shadowPath.id), { x: r.left + r.width / 2, y: r.bottom - 2 });

    const legNow = partByLabel('left_leg');
    expect(partByLabel('eyes').parentId, 'eyes reparented into the leg').toBe(legNow.id);
    expect(legNow.childOrder!.map((s) => `${s.kind}:${s.id}`), 'slotted BETWEEN the two paths')
      .toEqual([`path:${legPathIds[0]}`, `part:${eyes.id}`, `path:${legPathIds[1]}`]);
    // Panel rows agree: shadow, eyes, leg (top→bottom within the leg's folder).
    const panel = panelRowOrder();
    expect(panel.indexOf(shadowPath.id)).toBeLessThan(panel.indexOf(eyes.id));
    expect(panel.indexOf(eyes.id)).toBeLessThan(panel.indexOf(legPathIds[0]));
    // Canvas: the leg splits into two runs bracketing the eyes subtree.
    assertCanvasMatchesModel();
    const canvas = canvasRunOrder();
    expect(canvas.filter((id) => id === legNow.id), 'two leg runs bracket the insert')
      .toHaveLength(2);
    expect(canUndo(), 'one checkpoint for reparent + slot placement').toBe(true);

    undo();
    expect(partByLabel('eyes').parentId, 'undo restores the parent').toBe(partByLabel('face').id);
    expect(partByLabel('left_leg').childOrder!.map((s) => s.kind)).toEqual(['path', 'path']);
    assertCanvasMatchesModel();

    redo();
    expect(partByLabel('eyes').parentId, 'redo replays the whole drop').toBe(partByLabel('left_leg').id);
    expect(partByLabel('left_leg').childOrder!.map((s) => s.kind)).toEqual(['path', 'part', 'path']);
    assertCanvasMatchesModel();
  });
});

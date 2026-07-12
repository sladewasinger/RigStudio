/**
 * Interaction tests for two Layers-panel path-row bugs, both scoped to `panels/layers.ts`.
 *
 * (1) Selection styling: clicking a PATH row selects it (`selectPart` + `selectedPathId` —
 * unchanged, load-bearing semantics for the inspector/node scoping) but used to ALSO fully
 * `.selected`-highlight the parent part row, reading as a confusing "both are selected."
 * `partNode` now only adds `.selected` to a part row when the part itself (no path within
 * it) is the selection target; a part that merely CONTAINS the selected path gets the same
 * muted `.in-selection` affordance multi-selected parts already use.
 *
 * (2) Path rows were not draggable. They now accept drops from SIBLING path rows of the
 * SAME part (reordering `part.paths`, which is that part's own paint order) and reject drops
 * from any other part's path list outright — paths are baked into their part's frame, so a
 * cross-part move would teleport geometry. The reorder reuses the exact adjacent-swap
 * mutation PageUp/PageDown already drives on an entered path (`moveSelectedInDrawOrder` in
 * core/model.ts), walked one step at a time to the drop target.
 *
 * Fixture note: PIP_MASTER.svg's outer "body" group directly contains a "shadow" path AND a
 * nested group also labeled "body" (its own part, containing white_pill_body/bottom_half_red/
 * outline) — this is the user's exact reported screenshot shape, and doubles as the natural
 * cross-part rejection case: dragging the outer body's own "shadow" onto the nested body
 * part's "white_pill_body" must be a no-op. The same-part reorder scenario instead uses
 * left_leg (paths: leg, shadow — no nesting), the simplest part with two own paths.
 *
 * Mutation guard (manually verified while writing this file, not left in the tree):
 * commenting out `movePathTo`'s call inside `wirePathRowDrop`'s drop handler makes the
 * same-part reorder scenario fail on the `part.paths` order assertion; commenting out the
 * `dragged.partId !== part.id` guard makes the cross-part rejection scenario fail on the
 * "paths unchanged" assertions.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { undo, canUndo } from '../../core/history';
import { selectPart as modelSelectPart } from '../../core/model';
import {
  bootRig, resetRig, state, setEditorMode, notify, partByLabel, partGroupEl, simulateDragDrop,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

// ---- Fixture lookups (label alone is ambiguous — "body" names both the outer part and its
// nested child) ----

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
function leftLeg() {
  return partByLabel('left_leg');
}

// ---- Layers DOM lookups by id (data-part-id/data-path-id — added alongside this fix
// specifically so duplicate labels like the two "body" parts stay unambiguous) ----

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
/** Open a part's folder (idempotent — `expanded` is module state that persists across the
 *  scenarios in this file, so a blind click would sometimes toggle it back closed). */
function ensureExpanded(partId: string): void {
  const chevron = partRow(partId).querySelector<HTMLElement>('.chevron')!;
  if (chevron.textContent === '▸') chevron.click(); // notify() inside rebuilds the tree
}

function domPathOrder(partLabel: string): (string | undefined)[] {
  return Array.from(partGroupEl(partLabel).querySelectorAll('[data-path-id]'))
    .map((e) => (e as SVGElement).dataset.pathId);
}

describe('scenario — clicking a path row selects it without fully highlighting its parent', () => {
  it('path row gets .selected; the containing part row gets only the muted affordance', () => {
    setEditorMode('setup');
    const body = outerBody();
    const shadow = body.paths.find((p) => p.label === 'shadow')!;
    ensureExpanded(body.id);

    // Baseline contrast: selecting the PART alone (no path) DOES fully highlight its row —
    // this is the behavior the path-selection case must NOT trigger.
    modelSelectPart(body.id);
    notify();
    expect(partRow(body.id).classList.contains('selected'), 'part-only selection is .selected').toBe(true);

    pathRow(shadow.id).click();

    // Selection semantics are unchanged (load-bearing for the inspector/node scoping): a
    // path click selects its part AND records the path.
    expect(state.selectedPartId).toBe(body.id);
    expect(state.selectedPathId).toBe(shadow.id);

    expect(pathRow(shadow.id).classList.contains('selected'), 'clicked path row is selected').toBe(true);
    const row = partRow(body.id);
    expect(row.classList.contains('selected'), 'parent part row is NOT fully selected').toBe(false);
    expect(row.classList.contains('in-selection'), 'parent part row shows the muted affordance instead').toBe(true);
  });
});

describe('scenario — dragging a path row reorders paint order within its own part', () => {
  it('drag shadow below leg: part.paths swaps, canvas DOM path order follows, one undo restores', () => {
    setEditorMode('setup');
    const leg = leftLeg();
    ensureExpanded(leg.id);
    const legPath = leg.paths.find((p) => p.label === 'leg')!;
    const shadowPath = leg.paths.find((p) => p.label === 'shadow')!;
    const before = leg.paths.map((p) => p.id);
    expect(before, 'authored order: leg drawn first (behind), shadow last (on top)').toEqual([legPath.id, shadowPath.id]);
    expect(domPathOrder('left_leg')).toEqual(before);
    expect(canUndo()).toBe(false);

    const srcRow = pathRow(shadowPath.id);
    const dstRow = pathRow(legPath.id);
    const r = dstRow.getBoundingClientRect();
    // Drop near the BOTTOM of the leg row -> 'below' zone -> shadow ends up under leg.
    simulateDragDrop(srcRow, dstRow, { x: r.left + r.width / 2, y: r.bottom - 2 });

    expect(leftLeg().paths.map((p) => p.id), 'model order swapped').toEqual([shadowPath.id, legPath.id]);
    expect(domPathOrder('left_leg'), 'canvas DOM path order follows immediately').toEqual([shadowPath.id, legPath.id]);
    expect(canUndo(), 'exactly one checkpoint covers the whole drag').toBe(true);

    undo();
    expect(leftLeg().paths.map((p) => p.id), 'undo restores model order').toEqual(before);
    expect(domPathOrder('left_leg'), 'undo restores canvas DOM order too').toEqual(before);
  });
});

describe('scenario — dropping a path onto a DIFFERENT part is rejected with zero mutation', () => {
  it('the user\'s exact case: outer body\'s shadow dragged onto the nested body\'s white_pill_body does nothing', () => {
    setEditorMode('setup');
    const body = outerBody();
    const inner = innerBody();
    ensureExpanded(body.id);
    ensureExpanded(inner.id);

    const shadow = body.paths.find((p) => p.label === 'shadow')!;
    const whitePill = inner.paths.find((p) => p.label === 'white_pill_body')!;
    const bodyPathsBefore = body.paths.map((p) => p.id);
    const innerPathsBefore = inner.paths.map((p) => p.id);
    expect(canUndo()).toBe(false);

    simulateDragDrop(pathRow(shadow.id), pathRow(whitePill.id));

    expect(outerBody().paths.map((p) => p.id), 'outer body paths unchanged').toEqual(bodyPathsBefore);
    expect(innerBody().paths.map((p) => p.id), 'nested body paths unchanged').toEqual(innerPathsBefore);
    expect(canUndo(), 'no checkpoint was pushed — the drop was a structural non-event').toBe(false);
  });

  it('dropping a path onto a PART row (not a path row) also does nothing', () => {
    setEditorMode('setup');
    const body = outerBody();
    const inner = innerBody();
    ensureExpanded(body.id);
    const shadow = body.paths.find((p) => p.label === 'shadow')!;
    const bodyPathsBefore = body.paths.map((p) => p.id);

    simulateDragDrop(pathRow(shadow.id), partRow(inner.id));

    expect(outerBody().paths.map((p) => p.id)).toEqual(bodyPathsBefore);
    expect(canUndo()).toBe(false);
  });
});

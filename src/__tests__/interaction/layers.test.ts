/**
 * Interaction tests for Layers-panel path-row behaviors: selection styling, SAME-part
 * paint-order reordering (drag), and inline path RENAME. The drag wiring itself lives in
 * `panels/layersDragAndDrop.ts` (split out of layers.ts); CROSS-part path moves — which
 * REPLACED the old reject-outright behavior once `view/rigOpsEdit.ts`'s render-neutral
 * `movePathToPart` existed — are pinned in `layersPathMove.test.ts`, not here.
 *
 * (1) Selection styling: clicking a PATH row selects it (`selectPart` + `selectedPathId` —
 * unchanged, load-bearing semantics for the inspector/node scoping) but used to ALSO fully
 * `.selected`-highlight the parent part row, reading as a confusing "both are selected."
 * `partNode` now only adds `.selected` to a part row when the part itself (no path within
 * it) is the selection target; a part that merely CONTAINS the selected path gets the same
 * muted `.in-selection` affordance multi-selected parts already use.
 *
 * (2) Same-part reordering: path rows accept drops from SIBLING path rows of the SAME part
 * (reordering `part.paths`, which is that part's own paint order). The reorder reuses the
 * exact adjacent-swap mutation PageUp/PageDown already drives on an entered path
 * (`moveSelectedInDrawOrder` in core/model.ts), walked one step at a time to the drop
 * target. This behavior is byte-identical before/after the layersDragAndDrop split AND
 * before/after cross-part moves were added.
 *
 * (3) Inline path rename (user report "I also can't rename paths?" — it works; this pins
 * it): a REAL double-click gesture on a path row swaps its name for an input, Enter
 * commits `path.label` under one checkpoint, the row text follows, one undo restores. The
 * clicks re-resolve the row via elementFromPoint between events because the first click's
 * notify() rebuilds the whole panel (the harness double-click convention).
 *
 * Fixture note: the same-part reorder scenario uses left_leg (paths: leg, shadow — no
 * nesting), the simplest part with two own paths; rename uses the outer body's shadow.
 *
 * Mutation guard (manually verified while writing this file, not left in the tree):
 * commenting out `movePathTo`'s call inside `wirePathRowDrop`'s drop handler makes the
 * same-part reorder scenario fail on the `part.paths` order assertion.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { undo, canUndo } from '../../core/history';
import { selectPart as modelSelectPart } from '../../core/model';
import {
  bootRig, resetRig, state, setEditorMode, notify, partByLabel, partGroupEl, simulateDragDrop,
  clientCenterOf,
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

describe('scenario — double-click renames a path inline (real gesture)', () => {
  it('dblclick opens the editor, Enter commits label + row text under one checkpoint, undo restores', () => {
    setEditorMode('setup');
    const body = outerBody();
    ensureExpanded(body.id);
    const shadow = body.paths.find((p) => p.label === 'shadow')!;
    expect(canUndo()).toBe(false);

    // Full double-click on the row's NAME, re-resolving the hit target between events —
    // each click's handler notify()s and rebuilds the panel, detaching the previous row.
    const pt = clientCenterOf(pathRow(shadow.id).querySelector('.layer-name')!);
    const fire = (type: string, detail: number) => {
      const target = document.elementFromPoint(pt.x, pt.y)!;
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y, detail,
      }));
    };
    fire('mousedown', 1); fire('mouseup', 1); fire('click', 1);
    fire('mousedown', 2); fire('mouseup', 2); fire('click', 2);
    fire('dblclick', 2);

    const input = pathRow(shadow.id).querySelector<HTMLInputElement>('input.layer-rename-input');
    expect(input, 'inline rename editor appeared in the row').toBeTruthy();
    expect(input!.value, 'pre-filled with the current label').toBe('shadow');

    input!.value = 'ground_shadow';
    input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    expect(outerBody().paths.find((p) => p.id === shadow.id)!.label, 'doc label committed').toBe('ground_shadow');
    expect(
      pathRow(shadow.id).querySelector('.layer-name')!.textContent,
      'row text follows after the rebuild',
    ).toBe('ground_shadow');
    expect(canUndo(), 'exactly one checkpoint').toBe(true);

    undo();
    expect(
      state.doc!.parts.find((p) => p.id === body.id)!.paths.find((p) => p.id === shadow.id)!.label,
      'undo restores the old label',
    ).toBe('shadow');
  });

  it('Escape cancels without a checkpoint or a label change', () => {
    setEditorMode('setup');
    const body = outerBody();
    ensureExpanded(body.id);
    const shadow = body.paths.find((p) => p.label === 'shadow')!;

    const pt = clientCenterOf(pathRow(shadow.id).querySelector('.layer-name')!);
    const fire = (type: string, detail: number) => {
      const target = document.elementFromPoint(pt.x, pt.y)!;
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y, detail,
      }));
    };
    fire('mousedown', 1); fire('mouseup', 1); fire('click', 1);
    fire('mousedown', 2); fire('mouseup', 2); fire('click', 2);
    fire('dblclick', 2);

    const input = pathRow(shadow.id).querySelector<HTMLInputElement>('input.layer-rename-input')!;
    input.value = 'discarded';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(outerBody().paths.find((p) => p.id === shadow.id)!.label).toBe('shadow');
    expect(pathRow(shadow.id).querySelector('.layer-name')!.textContent).toBe('shadow');
    expect(canUndo(), 'no checkpoint for a canceled rename').toBe(false);
  });
});

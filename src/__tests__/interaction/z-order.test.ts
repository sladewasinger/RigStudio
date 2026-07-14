/**
 * Interaction tests for keyframeable z-order (editor side).
 *
 * The keyable per-part `z` OFFSET restacks the canvas over time: renderPose sorts the part
 * groups by (effective z ascending, doc.parts index ascending) each frame and re-appends
 * them, so a keyed z flips paint order at the key (STEPPED — no blend between ranks). These
 * scenarios pin: (1) the DOM part-group order flips EXACTLY at the key when scrubbing (the
 * per-frame path playback drives), (2) one undo removes the z key and restores the authored
 * order, (3) the Edit-mode ▲/▼ stacking buttons move a part in doc.parts identically to
 * PageUp. Mutation guard: sabotaging applyDrawOrder (skip the re-append) fails scenarios 1–2;
 * sabotaging stepped sampling (interpolate z) breaks the "exactly at the key" assertions.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { checkpoint, undo } from '../../core/history';
import {
  setKeyframeAt, notify, selectPart as modelSelectPart, isCanonicalPartOrder,
  flattenPaintOrder,
} from '../../core/model';
import {
  bootRig, resetRig, state, setEditorMode, repaint, rootGEl, partByLabel, simulateDragDrop,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/** The live DOM paint order of the part groups (rootGroup's only children). */
function domPartOrder(): string[] {
  return Array.from(rootGEl().children)
    .map((c) => (c as SVGElement).dataset?.partId)
    .filter((id): id is string => !!id);
}

function domIndexOf(id: string): number {
  return domPartOrder().indexOf(id);
}

/** Scrub to a time and render exactly as a playback frame would. */
function scrubTo(ms: number): void {
  state.currentTime = ms;
  repaint();
}

describe('scenario — a keyed z flips DOM paint order exactly at the key', () => {
  it('a behind-part keyed z-forward at t=500 draws behind before the key and in front at/after it', () => {
    setEditorMode('animate');
    // parts[0] is painted first (bottom-most), parts[1] above it — so parts[0] starts BEHIND.
    const behind = state.doc!.parts[0];
    const front = state.doc!.parts[1];

    scrubTo(0);
    expect(domIndexOf(behind.id)).toBeLessThan(
      domIndexOf(front.id),
    ); // authored order: `behind` under `front`

    // Key z = 5 on the behind-part at t=500 (a single stepped key). Under one checkpoint so
    // scenario 2's undo can revert it.
    checkpoint();
    setKeyframeAt(behind.id, 'z', 500, 5);
    notify();

    // Stepped: before the key the offset is still 0 (authored order holds)…
    scrubTo(499);
    expect(domIndexOf(behind.id)).toBeLessThan(domIndexOf(front.id));

    // …and exactly at the key it jumps to z=5 → sorts after every z=0 part (drawn last/top).
    scrubTo(500);
    expect(domIndexOf(behind.id)).toBeGreaterThan(domIndexOf(front.id));
    expect(domIndexOf(behind.id)).toBe(domPartOrder().length - 1); // lifted fully to the front

    // Held after the last key (playback across the key keeps the restacked order every frame).
    scrubTo(1200);
    expect(domIndexOf(behind.id)).toBeGreaterThan(domIndexOf(front.id));
  });
});

describe('scenario — one undo removes the z key and restores authored order', () => {
  it('undo reverts the restack (the part is behind again at the same time)', () => {
    setEditorMode('animate');
    const behindId = state.doc!.parts[0].id;
    const frontId = state.doc!.parts[1].id;

    checkpoint();
    setKeyframeAt(behindId, 'z', 500, 5);
    notify();
    scrubTo(500);
    expect(domIndexOf(behindId)).toBeGreaterThan(domIndexOf(frontId)); // restacked in front

    undo(); // restore-handler rebuilds the canvas; state.doc is swapped
    // currentTime is still 500, but the z track is gone → authored order restored.
    expect(state.doc!.clips[state.activeClipIndex].tracks.some((t) => t.channel === 'z')).toBe(false);
    expect(domIndexOf(behindId)).toBeLessThan(domIndexOf(frontId));
  });
});

describe('scenario — Edit-mode stacking ▲/▼ mirror PageUp/PageDown', () => {
  function stackingButtons(): { up: HTMLButtonElement; down: HTMLButtonElement } {
    const btns = document.querySelectorAll<HTMLButtonElement>('#inspector .stacking-step');
    if (btns.length < 2) throw new Error('stacking ▲/▼ buttons not found in the inspector');
    return { up: btns[0], down: btns[1] };
  }

  it('clicking ▲ moves the selected part forward in doc.parts (and the DOM) like PageUp', () => {
    setEditorMode('setup');
    const target = state.doc!.parts[0];
    const startIdx = state.doc!.parts.indexOf(target);
    modelSelectPart(target.id);
    notify(); // build the inspector with the stacking row

    stackingButtons().up.click(); // ▲ = bring forward (PageUp)

    const afterBtn = state.doc!.parts.indexOf(target);
    expect(afterBtn).toBe(startIdx + 1); // stepped one forward in the authored order
    // DOM paint order followed the model (reorderCanvas ran).
    expect(domIndexOf(target.id)).toBe(afterBtn);

    // PageUp on the same fresh selection produces the identical move.
    resetRig();
    setEditorMode('setup');
    const t2 = state.doc!.parts[0];
    modelSelectPart(t2.id);
    notify();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }));
    expect(state.doc!.parts.indexOf(t2)).toBe(startIdx + 1);
  });

  it('▼ is disabled for the bottom-most part (cannot send further back)', () => {
    setEditorMode('setup');
    const bottom = state.doc!.parts[0]; // index 0 = bottom of the draw order
    modelSelectPart(bottom.id);
    notify();
    expect(stackingButtons().down.disabled).toBe(true);
    expect(stackingButtons().up.disabled).toBe(false);
  });
});

// ---- "Layer order IS z-order" wave: canonical order, subtree-block moves, panel-vs-canvas ----

/** The part ids of every currently-rendered row in the Layers panel, top-to-bottom DOM
 *  order (parts only, not path rows) — the panel's own display order, which must NEVER
 *  re-sort with z keys (only doc.parts/the canvas does). */
function layersPartOrder(): string[] {
  return Array.from(document.querySelectorAll('#layers .layer-row.part'))
    .map((el) => (el as HTMLElement).dataset.partId)
    .filter((id): id is string => !!id);
}

function partRow(label: string): HTMLElement {
  const id = partByLabel(label).id;
  const row = document.querySelector<HTMLElement>(`#layers .layer-row.part[data-part-id="${id}"]`);
  if (!row) throw new Error(`no layers row for "${label}"`);
  return row;
}

/** A client point near the TOP edge of `el`'s row (the 'above' drop zone — top quarter,
 *  see layersDragAndDrop.ts's dropZoneOf). */
function topOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height * 0.1 };
}

describe('scenario — panel drag reorder moves a SUBTREE\'s whole paint block', () => {
  it('dragging right_arm above body\'s row (the acceptance recipe) reorders doc.parts and the canvas', () => {
    setEditorMode('setup');
    notify(); // ensure the Layers panel is built
    const before = state.doc!.parts.map((p) => p.id);
    const rightArm = partByLabel('right_arm');
    const body = partByLabel('body');
    expect(before.indexOf(rightArm.id)).toBeLessThan(before.indexOf(body.id)); // arm currently BEHIND body

    simulateDragDrop(partRow('right_arm'), partRow('body'), topOf(partRow('body')));

    const after = state.doc!.parts.map((p) => p.id);
    expect(isCanonicalPartOrder(state.doc!.parts)).toBe(true);
    expect(after.indexOf(rightArm.id)).toBeGreaterThan(after.indexOf(body.id)); // now stacked ABOVE body
    // The canvas DOM paint order followed the model (last = topmost).
    expect(domPartOrder().indexOf(rightArm.id)).toBeGreaterThan(domPartOrder().indexOf(body.id));
  });

  it('dragging a part WITH CHILDREN (body) above another part WITH CHILDREN (face) moves both whole blocks intact', () => {
    setEditorMode('setup');
    notify();
    const body = partByLabel('body');
    const bodyChild = state.doc!.parts.find((p) => p.parentId === body.id)!; // Pip's nested body-in-body
    const face = partByLabel('face');
    const eyes = partByLabel('eyes');
    expect(eyes.parentId).toBe(face.id);

    simulateDragDrop(partRow('body'), partRow('face'), topOf(partRow('face')));

    expect(isCanonicalPartOrder(state.doc!.parts)).toBe(true);
    const ids = state.doc!.parts.map((p) => p.id);
    // body's own child traveled WITH it (never left behind, never split from body).
    expect(ids.indexOf(bodyChild.id)).toBe(ids.indexOf(body.id) + 1);
    // face's own child (eyes) was never split from face by the incoming drop either —
    // body's whole block landed entirely outside face's block.
    expect(ids.indexOf(eyes.id)).toBe(ids.indexOf(face.id) + 1);
    // body's block now sits above (higher index than) face's whole block.
    expect(ids.indexOf(bodyChild.id)).toBeGreaterThan(ids.indexOf(eyes.id));
    // Canvas DOM paint order matches the model's own paint algorithm exactly. (Since U4
    // the sample's recorded childOrder interleaves — body's own shadow run paints AFTER
    // its nested child — so the reference is the childOrder flatten, not raw doc.parts.)
    expect(domPartOrder()).toEqual(flattenPaintOrder(state.doc!, () => 0).map((r) => r.partId));
  });
});

describe('scenario — PageUp on a parent moves its whole subtree block, never splitting it', () => {
  it('stepping "body" (which has a nested child) forward carries the child along, contiguous', () => {
    setEditorMode('setup');
    const body = partByLabel('body');
    const bodyChild = state.doc!.parts.find((p) => p.parentId === body.id)!;
    modelSelectPart(body.id);
    notify();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true, cancelable: true }));

    expect(isCanonicalPartOrder(state.doc!.parts)).toBe(true);
    const ids = state.doc!.parts.map((p) => p.id);
    // body is still IMMEDIATELY followed by its own child — the block moved as one unit.
    expect(ids.indexOf(bodyChild.id)).toBe(ids.indexOf(body.id) + 1);
    // The DOM paint order (canvas) reflects the same move, per the childOrder flatten
    // (U4: body's own shadow run paints AFTER its nested child — recorded doc order).
    expect(domPartOrder()).toEqual(flattenPaintOrder(state.doc!, () => 0).map((r) => r.partId));
  });
});

describe('scenario — keyed z re-sorts the CANVAS only; the Layers panel never re-sorts', () => {
  it('the panel\'s row order stays fixed across a z-key scrub that visibly restacks the canvas', () => {
    setEditorMode('animate');
    notify();
    const behind = state.doc!.parts[0];
    const front = state.doc!.parts[1];
    const panelBefore = layersPartOrder();

    checkpoint();
    setKeyframeAt(behind.id, 'z', 500, 5);
    notify();
    scrubTo(500);

    // Canvas: restacked (pinned already above) — re-assert here for the paired contrast.
    expect(domIndexOf(behind.id)).toBeGreaterThan(domIndexOf(front.id));
    // Panel: completely unchanged DOM row order — it shows structure, never the animated
    // z-sorted result.
    expect(layersPartOrder()).toEqual(panelBefore);
  });

  it('Edit mode ignores keyed z entirely: canvas shows pure rest/authored order', () => {
    // Capture the Edit-mode rest paint order FIRST — since U4 that is the childOrder
    // flatten (body/face interleave), not raw doc.parts order, so the baseline is the
    // rendered truth itself rather than a doc.parts-derived approximation.
    setEditorMode('setup');
    repaint();
    const restOrder = domPartOrder();

    setEditorMode('animate');
    const behind = state.doc!.parts[0];
    const front = state.doc!.parts[1];

    checkpoint();
    setKeyframeAt(behind.id, 'z', 500, 5);
    notify();
    scrubTo(500);
    expect(domIndexOf(behind.id)).toBeGreaterThan(domIndexOf(front.id)); // Animate: restacked

    setEditorMode('setup'); // Edit mode: poseTime() is null, so effectiveZ ignores the key
    repaint();
    expect(domIndexOf(behind.id)).toBeLessThan(domIndexOf(front.id)); // back under `front`
    expect(domPartOrder()).toEqual(restOrder); // byte-identical rest order, key ignored
  });
});

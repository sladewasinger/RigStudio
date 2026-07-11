import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { parsePath } from '../../geometry/paths';
import { selectedNodeCount } from '../../view';
import { groupAction } from '../../panels';
import {
  bootRig, resetRig, state, partByLabel, clientPointOnPart, gestureDrag, click,
  fullDblClick, pressKey, enterNodeMode, partGroupEl, count, overlayCount,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

const legId = () => partByLabel('left_leg').paths.find((p) => p.nodeTypes === 'cssssscc')!.id;

describe('scenario 8 — node marquee across dimmed art', () => {
  it('dims non-edited parts and the marquee selects only the edited path’s nodes', () => {
    const id = legId();
    enterNodeMode('left_leg', id);

    // Everything outside the edited part fades; the edited part itself does not.
    expect(count('.dimmed')).toBeGreaterThanOrEqual(5);
    expect(partGroupEl('left_leg').classList.contains('dimmed')).toBe(false);
    // A dimmed part (e.g. body) is genuinely tagged.
    expect(partGroupEl('body').classList.contains('dimmed')).toBe(true);

    const legNodes = parsePath(partByLabel('left_leg').paths.find((p) => p.id === id)!.d)
      .filter((c) => c.cmd !== 'Z').length;

    // Rubber-band the whole canvas (starting top-left, far from the leg outline and over
    // dimmed artwork). Dimmed parts carry no node handles, so nothing of theirs selects.
    const r = document.getElementById('canvas')!.getBoundingClientRect();
    let marqueeSeen = 0;
    gestureDrag(
      { x: r.left + 6, y: r.top + 6 },
      { x: r.right - 6, y: r.bottom - 6 },
      { beforeUp: () => { marqueeSeen = count('.node-marquee'); } },
    );

    expect(marqueeSeen).toBe(1); // the rubber band was live mid-drag
    expect(count('.node-marquee')).toBe(0); // and removed on pointerup
    expect(selectedNodeCount()).toBe(legNodes); // exactly the leg's nodes, dimmed art excluded
  });
});

describe('scenario 9 — group dive-in and one-level Escape tiers (P3 rework)', () => {
  it('dives without selecting, a single click selects the child, then path scope', () => {
    // Build a group so the dive ladder exists (the sample has none).
    const laId = partByLabel('left_arm').id;
    const raId = partByLabel('right_arm').id;
    let p = clientPointOnPart('left_arm');
    click(p.x, p.y);
    p = clientPointOnPart('right_arm');
    click(p.x, p.y, { shiftKey: true });
    expect(new Set(state.selectedPartIds)).toEqual(new Set([laId, raId]));
    groupAction();
    const group = state.doc!.parts.find((pt) => pt.kind === 'group')!;
    expect(state.selectedPartId).toBe(group.id); // grouped + selected

    // Click the arm artwork → group-aware selection lands on the closed GROUP.
    p = clientPointOnPart('right_arm');
    click(p.x, p.y);
    expect(state.selectedPartId).toBe(group.id);

    // Double-click DIVES into the group, selecting NOTHING (temporary ungrouping): no
    // selection, hence no selection box on the canvas.
    p = clientPointOnPart('right_arm');
    fullDblClick(p.x, p.y);
    expect(state.selectedPartId).toBeNull();
    expect(overlayCount('.select-box')).toBe(0);

    // The next single click selects the child under the cursor — the group's children
    // are now directly clickable.
    p = clientPointOnPart('right_arm');
    click(p.x, p.y);
    expect(state.selectedPartId).toBe(raId);
    expect(state.selectedPathId).toBeNull();
    expect(overlayCount('.select-box')).toBeGreaterThanOrEqual(1); // box on the child only

    // Double-click on the (deepest-level) multi-path part enters PATH/node scope.
    p = clientPointOnPart('right_arm');
    fullDblClick(p.x, p.y);
    expect(state.selectedPartId).toBe(raId);
    const pathIds = partByLabel('right_arm').paths.map((pp) => pp.id);
    expect(pathIds).toContain(state.selectedPathId);

    // Escape tier 1: leave the entered path (part stays selected).
    pressKey('Escape');
    expect(state.selectedPathId).toBeNull();
    expect(state.selectedPartId).toBe(raId);

    // Escape tier 2: deselect, but stay inside the entered group (one level at a time).
    pressKey('Escape');
    expect(state.selectedPartId).toBeNull();

    // Escape tier 3: pop the entered group. Clicking the arm now lands on the GROUP
    // again (proving we are back outside it).
    pressKey('Escape');
    p = clientPointOnPart('right_arm');
    click(p.x, p.y);
    expect(state.selectedPartId).toBe(group.id);
  });
});

describe('scenario 10 — dive → click-selects-child → dive deeper (nested groups)', () => {
  it('each dive enters one level; a single click selects the nested group, not dives', () => {
    const raId = partByLabel('right_arm').id;
    // Inner group G2 = { left_arm, right_arm }.
    let p = clientPointOnPart('left_arm');
    click(p.x, p.y);
    p = clientPointOnPart('right_arm');
    click(p.x, p.y, { shiftKey: true });
    groupAction();
    const g2 = state.doc!.parts.find((pt) => pt.kind === 'group')!;

    // Outer group G1 = { body, G2 }. Shift+clicking the arm adds G2 (group-aware).
    p = clientPointOnPart('body');
    click(p.x, p.y);
    p = clientPointOnPart('right_arm');
    click(p.x, p.y, { shiftKey: true });
    expect(new Set(state.selectedPartIds)).toEqual(new Set([partByLabel('body').id, g2.id]));
    groupAction();
    const g1 = state.doc!.parts.find((pt) => pt.kind === 'group' && pt.id !== g2.id)!;
    // Now nested: G1 ⊃ G2 ⊃ right_arm.
    expect(partByLabel('right_arm').parentId).toBe(g2.id);
    expect(state.doc!.parts.find((pt) => pt.id === g2.id)!.parentId).toBe(g1.id);

    // Clicking the arm selects the OUTERMOST closed group, G1.
    p = clientPointOnPart('right_arm');
    click(p.x, p.y);
    expect(state.selectedPartId).toBe(g1.id);

    // Double-click DIVES into G1 (selects nothing).
    p = clientPointOnPart('right_arm');
    fullDblClick(p.x, p.y);
    expect(state.selectedPartId).toBeNull();

    // Single click now selects the nested group G2 (selecting it, NOT diving).
    p = clientPointOnPart('right_arm');
    click(p.x, p.y);
    expect(state.selectedPartId).toBe(g2.id);

    // Double-click DIVES one level deeper into G2 (selects nothing).
    p = clientPointOnPart('right_arm');
    fullDblClick(p.x, p.y);
    expect(state.selectedPartId).toBeNull();

    // Single click at the deepest group level selects the leaf part right_arm.
    p = clientPointOnPart('right_arm');
    click(p.x, p.y);
    expect(state.selectedPartId).toBe(raId);
  });
});

describe('scenario 11 — Layers panel range + toggle selection (P3)', () => {
  it('Shift+click selects the visible-row range; Ctrl+click toggles one', () => {
    // Part rows in DOM order == the visible (flattened, expanded-only) row order.
    const rows = [...document.querySelectorAll<HTMLElement>('#layers .layer-row.part')];
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const idOf = (row: HTMLElement) =>
      partByLabel(row.querySelector('.layer-name')!.textContent!).id;
    const id0 = idOf(rows[0]), id1 = idOf(rows[1]), id2 = idOf(rows[2]);
    const clickRow = (row: HTMLElement, mods: { shiftKey?: boolean; ctrlKey?: boolean } = {}) =>
      row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...mods }));

    // Anchor on row 0, then Shift+click row 2 → the whole visible range [0..2].
    clickRow(rows[0]);
    expect(state.selectedPartId).toBe(id0);
    clickRow(rows[2], { shiftKey: true });
    expect(new Set(state.selectedPartIds)).toEqual(new Set([id0, id1, id2]));

    // Re-query (notify() rebuilt the panel) and Ctrl+click the middle row to toggle it out.
    const rows2 = [...document.querySelectorAll<HTMLElement>('#layers .layer-row.part')];
    const mid = rows2.find((r) => idOf(r) === id1)!;
    clickRow(mid, { ctrlKey: true });
    expect(new Set(state.selectedPartIds)).toEqual(new Set([id0, id2]));
  });
});

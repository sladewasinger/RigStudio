import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { parsePath } from '../../paths';
import { selectedNodeCount } from '../../view';
import { groupAction } from '../../panels';
import {
  bootRig, resetRig, state, partByLabel, clientPointOnPart, gestureDrag, click,
  fullDblClick, pressKey, enterNodeMode, partGroupEl, count,
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

describe('scenario 9 — drill-down double-click and Escape tiers', () => {
  it('steps group → part → path and Escape steps back out', () => {
    // Build a group so the full group→part→path ladder exists (the sample has none).
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

    // Click the arm artwork → group-aware selection lands on the GROUP.
    p = clientPointOnPart('right_arm');
    click(p.x, p.y);
    expect(state.selectedPartId).toBe(group.id);

    // Double-click enters the group and selects the PART.
    p = clientPointOnPart('right_arm');
    fullDblClick(p.x, p.y);
    expect(state.selectedPartId).toBe(raId);
    expect(state.selectedPathId).toBeNull();

    // Double-click again enters the part and selects a PATH under the cursor.
    p = clientPointOnPart('right_arm');
    fullDblClick(p.x, p.y);
    expect(state.selectedPartId).toBe(raId);
    const pathIds = partByLabel('right_arm').paths.map((pp) => pp.id);
    expect(pathIds).toContain(state.selectedPathId);

    // Escape tier 1: leave the entered path (part stays selected).
    pressKey('Escape');
    expect(state.selectedPathId).toBeNull();
    expect(state.selectedPartId).toBe(raId);

    // Escape tier 2: clear the selection and step out of the entered group.
    pressKey('Escape');
    expect(state.selectedPartId).toBeNull();
  });
});

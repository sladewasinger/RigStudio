/**
 * Priority-table pin (gesture-pipeline redesign, ROADMAP.md "Pattern-driven redesign
 * pass"): `view/interactions/priority.ts`'s `GESTURE_PIPELINES` is a STATIC ordered
 * Chain of Responsibility — the table itself IS the spec for which pipeline wins an
 * overlapping press. This file pins the one genuine same-ELEMENT dual match the DOM
 * structure produces (a freeze joint marker carries BOTH `data-role="pivot"` AND
 * `data-part-id`, so `pivot`'s and `artwork`'s claim conditions are simultaneously true
 * for the identical press) — `pivot` sits above `artwork` in the table and must win.
 *
 * The distinguishing signature between the two outcomes: `pivot` reshapes the PARENT
 * bone (`aimBoneAtTip` moves ITS `boneTip`/`rest.rotate`, since a child joint IS the
 * parent's tip) and never touches the CHILD's own `rest` at all; `artwork` would instead
 * start a body 'rotate' drag ON THE CHILD itself (bones force `action = 'rotate'`),
 * changing the child's OWN `rest.rotate` and leaving the parent's `boneTip` untouched.
 *
 * MUTATION-CHECK (performed manually, not embedded as a permanent assertion — matches
 * this codebase's existing mutation-check convention, e.g. freeze.test.ts's header
 * comment): moved `PIVOT_PIPELINE` to AFTER `ARTWORK_PIPELINE` in `GESTURE_PIPELINES`
 * (`priority.ts`) and re-ran `npm run test:interaction`. Every DOM-driven joint/pivot
 * press turned out to have the exact same dual-match property this scenario pins (the
 * marker elements — freeze markers AND the plain art-pivot crosshair alike — all carry
 * `data-part-id` alongside their `data-role="pivot"`), so the swap broke every scenario
 * that presses one, not just this file's: 9 FAILED / 160 passed (of 169), across FOUR
 * files — bones.test.ts (B9 "the shared joint moves as one"), freeze.test.ts (F1, F2 x2,
 * F6, F7 x2), rig-drags.test.ts (scenario 4 "pivot drag compensation" — an even simpler
 * case: a plain Setup ART pivot crosshair press, no freeze/bones involved at all,
 * confirming the dual-match isn't bone-specific), and this file's own scenario below.
 * Restoring `pivot` above `artwork` brought all four files straight back to 169/169.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { selectPart as modelSelectPart } from '../../core/model';
import { renderPose } from '../../view';
import {
  bootRig, resetRig, state, notify, partByLabel, clientCenterOf, overlayEl,
  gestureDrag, expectClose, pressKey, repaint, medialPoints, placeBoneChain,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/** Place an n-bone chain down a limb's medial axis, nothing selected beforehand. */
function placeChain(label: string, n: number): ReturnType<typeof partByLabel>[] {
  modelSelectPart(null);
  notify();
  renderPose();
  return placeBoneChain(medialPoints(label, n));
}

/** The connected-chain invariant (CLAUDE.md "Bones system") — re-checked here since this
 *  file drives a real joint drag. SCOPED to chain-internal links: an `attachedRoot`
 *  cross-chain attach is deliberately loose (Unified Skeleton Phase 1). */
function assertNoGap(): void {
  const parts = state.doc?.parts ?? [];
  for (const child of parts) {
    if (child.kind !== 'bone' || !child.parentId || child.attachedRoot) continue;
    const parent = parts.find((p) => p.id === child.parentId && p.kind === 'bone');
    if (!parent || !parent.boneTip) continue;
    expectClose(child.pivot.x + child.rest.tx, parent.boneTip.x, 0.3, 'no gap: child origin x == parent tip x');
    expectClose(child.pivot.y + child.rest.ty, parent.boneTip.y, 0.3, 'no gap: child origin y == parent tip y');
  }
}
afterEach(assertNoGap);

describe('gesture priority — pivot beats artwork on a genuinely dual-matching element', () => {
  it('a freeze joint marker carries BOTH data-role="pivot" AND data-part-id — the same press two rows both claim', () => {
    const [b1, b2] = placeChain('left_leg', 2);
    pressKey('y'); // freeze mode: every bone gets an origin marker, incl. shared joints
    modelSelectPart(null);
    notify();
    repaint();
    expect(state.freezeMode).toBe(true);
    expect(state.selectedPartId, 'nothing selected before the press').toBeNull();

    const marker = overlayEl().querySelector(`[data-role="pivot"][data-part-id="${b2.id}"]`);
    expect(marker, 'a freeze-mode origin marker exists for the shared joint').toBeTruthy();
    // The dual-match this scenario pins: ONE element satisfies both `pivot`'s hit test
    // (closest [data-role="pivot"]) and `artwork`'s (closest [data-part-id]) simultaneously
    // — table ORDER, not DOM occlusion, decides the winner for this exact press.
    expect(marker!.getAttribute('data-role'), 'satisfies the pivot row\'s condition').toBe('pivot');
    expect(marker!.getAttribute('data-part-id'), 'ALSO satisfies the artwork row\'s condition').toBe(b2.id);

    const from = clientCenterOf(marker!);
    const tip0 = { ...b1.boneTip! };
    const childRot0 = b2.rest.rotate;

    gestureDrag(from, { x: from.x + 30, y: from.y + 24 }, { steps: 10 });

    const cur1 = state.doc!.parts.find((p) => p.id === b1.id)!;
    const cur2 = state.doc!.parts.find((p) => p.id === b2.id)!;
    // PIVOT semantics won: the press selected the child bone and reshaped the PARENT
    // (aimBoneAtTip moves b1's boneTip — the shared joint) while the CHILD's own rest is
    // completely untouched. Had `artwork` won instead, this press would have started a
    // body 'rotate' drag ON THE CHILD (bones force action='rotate'), changing b2's OWN
    // rest.rotate and leaving b1's boneTip exactly where it started — the opposite
    // signature, which is exactly what the swap-and-verify mutation check above produces.
    expect(state.selectedPartId, 'the press selected the child bone').toBe(b2.id);
    const moved = Math.hypot(cur1.boneTip!.x - tip0.x, cur1.boneTip!.y - tip0.y);
    expect(moved, 'the shared joint (parent tip) actually moved').toBeGreaterThan(0.3);
    expect(cur2.rest.rotate, "the CHILD's own rest.rotate is untouched (not a body rotate)").toBe(childRot0);
    expectClose(cur2.pivot.x, cur1.boneTip!.x, 0.3, 'child origin tracks the new joint');
    expectClose(cur2.pivot.y, cur1.boneTip!.y, 0.3, 'child origin tracks the new joint');
  });
});

/**
 * Interaction tests for Bones 2.0 (P4): auto-bind on placement, child bones anchoring
 * at the parent tip, per-node overrides, and IK through a bound chain. Full realistic
 * gestures via the harness (elementFromPoint hit targets, intermediate pointermoves).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { canUndo, undo } from '../../core/history';
import {
  selectPart as modelSelectPart, setKeyframe, notify,
  serializeDoc, deserializeDoc,
} from '../../core/model';
import { startBonePlacement, renderPose, setNodeBinding } from '../../view';
import {
  bootRig, resetRig, state, partByLabel, partGroupEl, gestureDrag, click,
  clientCenterOf, overlayEl, expectClose, setEditorMode, repaint, enterNodeMode,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/** Client points spread lo→hi along a part's longer screen axis (the bone chain path). */
function axisPoints(label: string, n: number, lo = 0.18, hi = 0.82): { x: number; y: number }[] {
  const r = partGroupEl(label).getBoundingClientRect();
  const vertical = r.height >= r.width;
  const pts: { x: number; y: number }[] = [];
  for (let k = 0; k <= n; k++) {
    const f = lo + (hi - lo) * (k / n);
    pts.push(vertical
      ? { x: r.left + r.width / 2, y: r.top + r.height * f }
      : { x: r.left + r.width * f, y: r.top + r.height / 2 });
  }
  return pts;
}

/** Place an n-bone chain along a part: bone 1 free-form, the rest as child bones. */
function placeChain(label: string, n: number): ReturnType<typeof partByLabel>[] {
  const pts = axisPoints(label, n);
  modelSelectPart(null); // bone 1 is free-form (no bone selected)
  notify();
  renderPose();
  const bones: ReturnType<typeof partByLabel>[] = [];
  for (let k = 1; k <= n; k++) {
    startBonePlacement();
    // Bone 1 is free-form (origin = press). CHILD bones press at an OFFSET from the
    // parent tip so the test can tell "origin anchored at parent tip" apart from "origin
    // at the press point" — only the drag END (the tip) is meant to matter for them.
    const press = k === 1 ? pts[0] : { x: pts[k - 1].x + 28, y: pts[k - 1].y + 18 };
    gestureDrag(press, pts[k]);
    bones.push(state.doc!.parts[state.doc!.parts.length - 1]);
  }
  return bones;
}

/** Concatenated rendered `d` of a part's path elements (the LBS-deformed geometry). */
function renderedD(label: string): string {
  return Array.from(partGroupEl(label).querySelectorAll('path'))
    .map((p) => p.getAttribute('d') ?? '').join('|');
}

/** The model rest `d` of a part's paths (must stay byte-identical under LBS). */
function modelD(label: string): string {
  return partByLabel(label).paths.map((p) => p.d).join('|');
}

const LIMB = 'left_leg';

describe('scenario B1 — auto-bind on placement + LBS bend', () => {
  it('a placed 3-bone chain skins the limb; the middle bone bends the render, rest d byte-identical', () => {
    expect(partByLabel(LIMB).skin ?? null).toBeNull();

    const [, mid] = placeChain(LIMB, 3);

    // The overlapping art became skinned to the whole chain with ZERO manual steps.
    const skin = partByLabel(LIMB).skin;
    expect(skin, 'limb auto-bound').toBeTruthy();
    expect(skin!.bones.length, 'bound to all 3 chain bones').toBe(3);

    const restD = modelD(LIMB);
    const before = renderedD(LIMB);

    // Rotate the MIDDLE bone in Animate (drives the model API a rotate drag calls) and
    // confirm the rendered geometry deforms while the stored rest path data is untouched.
    setEditorMode('animate');
    state.currentTime = 0;
    setKeyframe(mid.id, 'rotate', 40);
    repaint();

    expect(renderedD(LIMB), 'rendered path bends').not.toBe(before);
    expect(modelD(LIMB), 'rest path.d stays byte-identical (LBS never mutates it)').toBe(restD);
  });
});

describe('scenario B2 — placement + binding is ONE undo', () => {
  it('one undo reverts a freshly placed bone AND the binding it created', () => {
    const before = state.doc!.parts.length;
    expect(partByLabel(LIMB).skin ?? null).toBeNull();

    placeChain(LIMB, 1); // one placement gesture = one checkpoint

    expect(state.doc!.parts.length).toBe(before + 1);
    expect(partByLabel(LIMB).skin, 'bound by the placement').toBeTruthy();

    expect(canUndo()).toBe(true);
    undo();

    // Re-read after undo (the doc object is swapped).
    expect(state.doc!.parts.length, 'bone removed').toBe(before);
    expect(partByLabel(LIMB).skin ?? null, 'binding reverted in the same step').toBeNull();
  });
});

describe('scenario B3 — child bone anchors at the parent tip', () => {
  it('a child bone origin lands exactly on the selected bone tip', () => {
    const [b1, b2] = placeChain(LIMB, 2);
    // b1 is free-form (parentId null → its local frame is root), so b1.boneTip is already
    // in root coords, and b2.pivot (stored in b1's frame) must equal it.
    expect(b2.parentId, 'child parented to the bone').toBe(b1.id);
    expectClose(b2.pivot.x, b1.boneTip!.x, 0.3, 'child origin x == parent tip x');
    expectClose(b2.pivot.y, b1.boneTip!.y, 0.3, 'child origin y == parent tip y');
  });
});

describe('scenario B4 — IK through the bound chain', () => {
  it('IK-dragging the chain end rotates both ancestor joints and deforms the art', () => {
    const [b1, b2, b3] = placeChain(LIMB, 3);
    expect(partByLabel(LIMB).skin!.bones.length).toBe(3);

    // Grab the END bone with the IK tool; deselect first so its glyph (not a pivot/tip
    // handle) is the hit target, and the IK press both selects it and starts the solve.
    state.tool = 'ik';
    modelSelectPart(null);
    repaint();

    const glyph = overlayEl().querySelector(`[data-part-id="${b3.id}"]`);
    expect(glyph, 'end-bone glyph present').toBeTruthy();
    const from = clientCenterOf(glyph!);

    const rot1Before = b1.rest.rotate;
    const rot2Before = b2.rest.rotate;
    const artBefore = renderedD(LIMB);

    // Drag the effector well back toward the chain root (shortening reach ~65%) with a
    // perpendicular nudge, so the ELBOW must fold — both ancestor joints rotate, not just
    // the shoulder swinging on a fixed reach.
    const root = clientCenterOf(overlayEl().querySelector(`[data-part-id="${b1.id}"]`)!);
    const dxr = root.x - from.x, dyr = root.y - from.y;
    const len = Math.hypot(dxr, dyr) || 1;
    const toward = {
      x: from.x + dxr * 0.65 + (-dyr / len) * 35,
      y: from.y + dyr * 0.65 + (dxr / len) * 35,
    };
    gestureDrag(from, toward, { steps: 12 });

    const b1After = state.doc!.parts.find((p) => p.id === b1.id)!;
    const b2After = state.doc!.parts.find((p) => p.id === b2.id)!;
    expect(Math.abs(b1After.rest.rotate - rot1Before), 'root joint rotated').toBeGreaterThan(0.5);
    expect(Math.abs(b2After.rest.rotate - rot2Before), 'mid joint rotated').toBeGreaterThan(0.5);
    expect(renderedD(LIMB), 'skinned art deformed under IK').not.toBe(artBefore);
  });
});

describe('scenario B5 — per-node weight overrides', () => {
  it('pinning selected nodes to a bone changes the deformation and survives a round-trip', () => {
    const bones = placeChain(LIMB, 3);
    const end = bones[bones.length - 1];

    // Enter node editing on the skinned limb and select a couple of nodes via real clicks
    // on their handles (the inspector binding editor operates on exactly this selection).
    enterNodeMode(LIMB);
    const handles = Array.from(
      overlayEl().querySelectorAll('.node-handle[data-field="x"]'),
    ) as SVGElement[];
    expect(handles.length, 'node handles present on the skinned part').toBeGreaterThan(2);
    // Two well-separated nodes (first + middle) so neither handle occludes the other.
    const a = clientCenterOf(handles[0]);
    const b = clientCenterOf(handles[Math.floor(handles.length / 2)]);
    click(a.x, a.y);
    click(b.x, b.y, { shiftKey: true });

    // Rotate the end bone so the deformation is visible, capture the AUTO-weight render.
    const endBone = state.doc!.parts.find((p) => p.id === end.id)!;
    endBone.rest.rotate = 55;
    repaint();
    const autoD = renderedD(LIMB);

    // Pin the selected nodes to 100% of the end bone — the exact call the inspector's
    // "apply to selected nodes" button makes.
    expect(setNodeBinding(end.id, null, 1)).toBe(true);
    repaint();

    const skin = partByLabel(LIMB).skin!;
    expect(skin.overrides, 'override recorded on the part').toBeTruthy();
    const total = Object.values(skin.overrides!).reduce((s, rec) => s + Object.keys(rec).length, 0);
    expect(total, 'both selected nodes pinned').toBeGreaterThanOrEqual(2);
    expect(renderedD(LIMB), 'override changes the deformation').not.toBe(autoD);

    // The override survives a serialize → deserialize round-trip byte-for-byte.
    const round = deserializeDoc(serializeDoc(state.doc!));
    const limbBack = round.parts.find((p) => p.label === LIMB)!;
    expect(limbBack.skin!.overrides).toEqual(skin.overrides);
  });
});

/**
 * Interaction tests for Unified Skeleton Phase 1 (cross-chain bone attachment via the
 * Layers panel — ROADMAP.md "Unified skeleton: cross-chain bone attachment", CLAUDE.md's
 * `RigPart.attachedRoot` doc comment). The user's own words: "the entire pip could be
 * rigged so that his body (spine) can affect the arm bones… like they're moving relative
 * to one another depending on the hierarchy." Today each limb chain is a disconnected
 * skeleton; this wave makes cross-chain attachment first-class: drag one chain's root
 * bone onto another chain's bone in the Layers panel and it parents WORLD-PRESERVING (no
 * jump), then rides that bone's pose exactly like any other child.
 *
 * Full realistic gestures per the harness conventions: pen-tool chain placement for both
 * chains, a REAL HTML5 drag-and-drop for the attach itself (the actual dragover/drop
 * handlers in panels/layersDragAndDrop.ts), the real undo stack. Phase 2 (IK solving
 * ACROSS attachments) is explicitly deferred — scenario US3 pins that IK on the arm's own
 * tip stays scoped to the arm (never touches the spine), which is what "stop at attached
 * roots this wave" means operationally.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { undo, canUndo } from '../../core/history';
import { selectPart as modelSelectPart, notify, RigPart } from '../../core/model';
import { renderPose, zoomBy } from '../../view';
import {
  bootRig, resetRig, state, partByLabel, partGroupEl, svgEl, medialPoints, placeBoneChain,
  simulateDragDrop, clientCenterOf, expectClose, repaint, overlayEl, gestureDrag,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

const SPINE = 'body';
const LIMB = 'right_arm';

/** Place an n-bone chain ANCHORED on `label` (hierarchy-as-assignment: bone1 parents to
 *  it, and — for an art part — the chain auto-binds it). Mirrors skinnedPose.test.ts's
 *  `skinLimb()`. */
function placeChainOn(label: string, n: number): RigPart[] {
  modelSelectPart(partByLabel(label).id);
  notify();
  renderPose();
  const bones = placeBoneChain(medialPoints(label, n));
  // placeBoneChain's underlying gesture never calls notify() itself (it's a click, not a
  // drag with a gesture-end hook) — force it so #layers grows a row for the freshly
  // created bones before this file's Layers-drag scenarios try to find them.
  notify();
  return bones;
}

/** The connected-chain invariant, SCOPED to chain-internal links (Unified Skeleton
 *  Phase 1) — mirrors bones.test.ts/freeze.test.ts/ikDrag.test.ts/skinnedPose.test.ts. */
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

/** Every path point of a part sampled along its length, in CLIENT px — the RENDERED
 *  result (independent of local<->root baking). Mirrors bones.test.ts's helper. */
function renderScreenSamples(label: string): number[] {
  const g = partGroupEl(label);
  const svg = svgEl();
  const out: number[] = [];
  for (const pe of Array.from(g.querySelectorAll('path')) as SVGPathElement[]) {
    const len = pe.getTotalLength();
    if (!(len > 0)) continue;
    const m = pe.getScreenCTM()!;
    for (let f = 0; f <= 1.0001; f += 0.1) {
      const q = pe.getPointAtLength(len * f);
      const pt = svg.createSVGPoint(); pt.x = q.x; pt.y = q.y;
      const s = pt.matrixTransform(m);
      out.push(s.x, s.y);
    }
  }
  return out;
}
function maxDrift(a: number[], b: number[]): number {
  let mx = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) mx = Math.max(mx, Math.abs(a[i] - b[i]));
  return mx;
}

function partRow(partId: string): HTMLElement {
  const row = document.querySelector<HTMLElement>(`#layers .layer-row.part[data-part-id="${partId}"]`);
  if (!row) throw new Error(`no part row for ${partId}`);
  return row;
}
function ensureExpanded(partId: string): void {
  const chevron = partRow(partId).querySelector<HTMLElement>('.chevron')!;
  if (chevron.textContent === '▸') chevron.click();
}

/** The exact origin point of the PRIMARY-selected part (the pivot-handle crosshair
 *  renders at `effectivePivot`, dead center — precise to the render, unlike a glyph's
 *  bounding box). Caller must have selected `partId` in Setup mode. */
function pivotHandleCenter(partId: string): { x: number; y: number } {
  const el = overlayEl().querySelector(`.pivot-handle[data-part-id="${partId}"]`);
  if (!el) throw new Error(`no pivot handle for ${partId} (must be the primary selection, Setup mode)`);
  return clientCenterOf(el);
}
/** The exact tip point of the PRIMARY-selected bone (only one renders at a time). */
function tipHandleCenter(): { x: number; y: number } {
  const el = overlayEl().querySelector('.bone-tip-handle');
  if (!el) throw new Error('no tip handle (must be a bone, primary selection, Setup mode)');
  return clientCenterOf(el);
}

/**
 * Give the spine and the limb a nonzero pre-existing pose BEFORE the arm chain is placed
 * on it. Without this, every part in a freshly-imported, never-posed doc has an IDENTITY
 * chain matrix (rotate(0, px, py) is the identity transform regardless of where the
 * pivot sits) — so a RAW reparent (no fold at all) would coincidentally be render-neutral
 * too, making the render-neutrality checks below (and the US2 mutation check) pass
 * vacuously. A real chain-frame delta on both sides of the eventual attach is what
 * actually exercises `reattachRootBone`'s fold.
 */
function poseNonTrivially(spine1: RigPart): void {
  spine1.rest.rotate = 18;
  partByLabel(LIMB).rest.rotate = -9;
  repaint();
}

/** Place a spine (SPINE anchored) + arm (LIMB anchored, auto-binds) chain, attach the
 *  arm's root onto the spine's second bone, and return every part involved. */
function setupAttachedRig(): {
  spine1: RigPart; spine2: RigPart; armRoot: RigPart; armTip: RigPart; limb: RigPart;
} {
  const [spine1, spine2] = placeChainOn(SPINE, 2);
  poseNonTrivially(spine1);
  const [armRoot, armTip] = placeChainOn(LIMB, 2);
  modelSelectPart(armRoot.id);
  notify();
  repaint();
  ensureExpanded(spine1.id);
  ensureExpanded(partByLabel(LIMB).id);
  ensureExpanded(armRoot.parentId!); // reveal armRoot's row under its (pre-attach) parent
  simulateDragDrop(partRow(armRoot.id), partRow(spine2.id));
  return { spine1, spine2, armRoot, armTip, limb: partByLabel(LIMB) };
}

describe('scenario US1 — the Pip acceptance scenario: attach + undo', () => {
  it('dragging the arm chain root onto the spine\'s bone2 attaches world-preserving, and undo restores the pre-attach state exactly', () => {
    const [spine1, spine2] = placeChainOn(SPINE, 2);
    poseNonTrivially(spine1);
    const [armRoot, armTip] = placeChainOn(LIMB, 2);
    const limb = partByLabel(LIMB);
    expect(limb.skin, 'the arm chain auto-bound right_arm').toBeTruthy();
    expect(armRoot.parentId, 'precondition: still parented under the arm (hierarchy-as-assignment)')
      .toBe(limb.id);
    expect(armRoot.attachedRoot).toBeUndefined();

    modelSelectPart(armRoot.id);
    notify();
    repaint();
    ensureExpanded(limb.id);
    const originBefore = pivotHandleCenter(armRoot.id);
    const tipBefore = tipHandleCenter();
    const artBefore = renderScreenSamples(LIMB);
    const preAttachDoc = JSON.stringify(state.doc);
    expect(canUndo(), 'placing both chains already checkpointed').toBe(true);

    ensureExpanded(spine1.id);
    simulateDragDrop(partRow(armRoot.id), partRow(spine2.id));

    // --- attached, world-preserving ---
    expect(armRoot.parentId, 'reparented onto the spine bone').toBe(spine2.id);
    expect(armRoot.attachedRoot, 'flagged as a cross-chain attach').toBe(true);
    expect(canUndo(), 'the drop is one checkpoint').toBe(true);

    const originAfter = pivotHandleCenter(armRoot.id);
    const tipAfter = tipHandleCenter();
    expectClose(originAfter.x, originBefore.x, 0.01, 'arm root origin x unchanged at attach');
    expectClose(originAfter.y, originBefore.y, 0.01, 'arm root origin y unchanged at attach');
    expectClose(tipAfter.x, tipBefore.x, 0.01, 'arm root tip x unchanged at attach');
    expectClose(tipAfter.y, tipBefore.y, 0.01, 'arm root tip y unchanged at attach');
    const artAfter = renderScreenSamples(LIMB);
    expect(maxDrift(artBefore, artAfter), 'deformed arm art render-neutral at attach (< 0.01px)')
      .toBeLessThan(0.01);
    // Bind data untouched: still the same two bones, same restWorldInv/bindSeg objects.
    expect(limb.skin!.bones.map((b) => b.id)).toEqual([armRoot.id, armTip.id]);

    // --- undo restores the pre-attach state exactly ---
    undo();
    expect(JSON.stringify(state.doc), 'doc byte-identical to pre-attach').toBe(preAttachDoc);
    repaint();
    modelSelectPart(armRoot.id);
    notify();
    repaint();
    const originUndone = pivotHandleCenter(armRoot.id);
    expectClose(originUndone.x, originBefore.x, 0.01, 'undo restores the on-canvas origin too');
    expectClose(originUndone.y, originBefore.y, 0.01, 'undo restores the on-canvas origin too');
  });
});

describe('scenario US2 — attach is render-neutral (isolated, for the mutation check)', () => {
  it('the deformed arm art does not move at the instant of attach', () => {
    const [spine1, spine2] = placeChainOn(SPINE, 2);
    poseNonTrivially(spine1);
    const [armRoot] = placeChainOn(LIMB, 2);
    const before = renderScreenSamples(LIMB);

    ensureExpanded(armRoot.parentId!);
    ensureExpanded(spine2.id);
    simulateDragDrop(partRow(armRoot.id), partRow(spine2.id));

    const after = renderScreenSamples(LIMB);
    // MUTATION CHECK (performed while writing this file, not left in the tree): commenting
    // out the `foldWorldIntoBoneRest` call in view/rigOpsAttach.ts's `reattachRootBone`
    // (reparenting raw, like plain `setParent`) turns this into a real multi-pixel jump —
    // see the task report for the measured delta.
    expect(maxDrift(before, after)).toBeLessThan(0.01);
  });
});

describe('scenario US3 — spine rotation carries the attached arm; the arm\'s own IK stays local', () => {
  it('rotating the spine bone moves the arm bones and deforms the arm art; IK-dragging the arm tip never touches the spine', () => {
    const { spine1, spine2, armRoot, armTip, limb } = setupAttachedRig();
    expect(armRoot.attachedRoot).toBe(true); // precondition

    modelSelectPart(armTip.id);
    notify();
    repaint();
    const armTipOriginBefore = pivotHandleCenter(armTip.id);
    const artBeforeRotate = renderScreenSamples(LIMB);

    // "Rotate the spine bone (inspector)" — a direct rest.rotate edit + repaint, the same
    // effective mutation an inspector field or a body-drag rotate gizmo would make.
    spine2.rest.rotate += 25;
    repaint();

    modelSelectPart(armTip.id);
    notify();
    repaint();
    const armTipOriginAfter = pivotHandleCenter(armTip.id);
    const artAfterRotate = renderScreenSamples(LIMB);
    const moved = Math.hypot(armTipOriginAfter.x - armTipOriginBefore.x, armTipOriginAfter.y - armTipOriginBefore.y);
    expect(moved, 'the attached arm chain rides the spine bone\'s rotation').toBeGreaterThan(2);
    expect(maxDrift(artBeforeRotate, artAfterRotate), 'the deformed arm art rides along too')
      .toBeGreaterThan(2);
    // Chain-internal connectivity survives the parent's rotation (armTip.pivot == armRoot.boneTip).
    expectClose(armTip.pivot.x + armTip.rest.tx, armRoot.boneTip!.x, 0.3, 'arm chain stays connected');
    expectClose(armTip.pivot.y + armTip.rest.ty, armRoot.boneTip!.y, 0.3, 'arm chain stays connected');

    // --- the arm's own IK/tip reshaping still works LOCALLY (Phase 2 deferred: IK never
    // crosses the attachment boundary into the spine) ---
    const spine1RotBefore = spine1.rest.rotate;
    const spine2RotBefore = spine2.rest.rotate;
    const armRootRotBefore = armRoot.rest.rotate;
    const spineBoneIdsBefore = (partByLabel(SPINE).skin?.bones ?? []).map((b) => b.id).sort();

    state.tool = 'ik';
    // Pre-select armTip (rather than clearing selection, B4's pattern): armTip's
    // ancestor chain now runs THROUGH the spine's own anchor art part (post-attach), and
    // that part may be "group-like" (other non-bone children) — the artwork pipeline's
    // group-substitution would otherwise redirect this press up to it. A part already in
    // `selectedPartIds` is manipulated directly, never hijacked (artwork.ts's own rule).
    modelSelectPart(armTip.id);
    notify();
    repaint();
    // Mirrors bones.test.ts scenario B4's proven drag geometry: grab the chain-end glyph
    // and aim 65% of the way toward the chain root plus a 35px perpendicular offset, so
    // the FABRIK solve produces an unambiguous, generous bend rather than a near-zero one.
    const from = clientCenterOf(overlayEl().querySelector(`[data-part-id="${armTip.id}"]`)!);
    const root = clientCenterOf(overlayEl().querySelector(`[data-part-id="${armRoot.id}"]`)!);
    const dxr = root.x - from.x, dyr = root.y - from.y;
    const len = Math.hypot(dxr, dyr) || 1;
    const toward = {
      x: from.x + dxr * 0.65 + (-dyr / len) * 35,
      y: from.y + dyr * 0.65 + (dxr / len) * 35,
    };
    gestureDrag(from, toward, { steps: 12 });

    expect(Math.abs(armRoot.rest.rotate - armRootRotBefore), 'the grabbed local chain reshaped')
      .toBeGreaterThan(0.5);
    expect(spine1.rest.rotate, 'IK on the arm never touches the spine (Phase 2 deferred)')
      .toBe(spine1RotBefore);
    expect(spine2.rest.rotate, 'IK on the arm never touches the spine (Phase 2 deferred)')
      .toBe(spine2RotBefore);
    // The spine's own bind set (from its own chain placement) is untouched by an IK
    // gesture grabbed on the arm — it neither loses nor gains a bone.
    expect((partByLabel(SPINE).skin?.bones ?? []).map((b) => b.id).sort()).toEqual(spineBoneIdsBefore);
    expect(limb.skin, 'the arm stays bound').toBeTruthy();
  });
});

describe('scenario US4 — auto-bind stays chain-scoped after attachment (mutation-checked)', () => {
  it('extending the attached arm chain by one bone re-binds only the arm — the spine/body never gets skinned', () => {
    const { spine1, spine2, armTip, limb } = setupAttachedRig();
    // Precondition: the SPINE chain's OWN placement legitimately auto-bound `body` to
    // spine1+spine2 (hierarchy-as-assignment, same as the arm binding right_arm) — that's
    // correct and expected. What must NOT happen is the arm's later extension leaking a
    // NEW bone into that bind set.
    const spineBoneIdsBefore = (partByLabel(SPINE).skin?.bones ?? []).map((b) => b.id).sort();
    expect(spineBoneIdsBefore, 'precondition: spine/body bound to its own chain only')
      .toEqual([spine1.id, spine2.id].sort());

    // Continue the chain from armTip (child anchoring: origin auto-anchors at its tip).
    modelSelectPart(armTip.id);
    notify();
    repaint();
    const before = state.doc!.parts.length;
    const extra = placeBoneChain([clientPointNear(armTip), clientPointFarFrom(armTip)]);
    expect(state.doc!.parts.length, 'one bone committed').toBe(before + 1);
    const armTip2 = extra[0];
    expect(armTip2.parentId).toBe(armTip.id);
    expect(armTip2.attachedRoot).toBeUndefined(); // a normal chain-internal child, not an attach

    expect(limb.skin!.bones.map((b) => b.id), 'the arm\'s bind set grows to include it')
      .toContain(armTip2.id);
    // MUTATION CHECK (performed while writing this file, not left in the tree): reverting
    // `boneChain`'s `rootOf` in core/boneOps.ts to walk straight past `attachedRoot` (the
    // pre-Phase-1 code) makes this chain resolve all the way to the spine's own anchor
    // (`body`), and `chainAnchorPart`/`expandBindTarget` then bind `body`'s auto-bind
    // target list to include the new arm bone — see the task report for the observed
    // failure.
    const spineBoneIdsAfter = (partByLabel(SPINE).skin?.bones ?? []).map((b) => b.id).sort();
    expect(spineBoneIdsAfter, 'spine/body bind set unchanged by the arm\'s extension')
      .toEqual(spineBoneIdsBefore);
    expect(spineBoneIdsAfter, 'the new arm bone never leaks into the spine\'s bind set')
      .not.toContain(armTip2.id);

    function clientPointNear(bone: RigPart): { x: number; y: number } {
      // Any point works — with a bone selected the FIRST click only seeds the origin
      // (anchored at the bone's own tip, ignoring the click position).
      return clientCenterOf(overlayEl().querySelector(`[data-part-id="${bone.id}"]`)!);
    }
    function clientPointFarFrom(bone: RigPart): { x: number; y: number } {
      const c = clientCenterOf(overlayEl().querySelector(`[data-part-id="${bone.id}"]`)!);
      return { x: c.x + 25, y: c.y + 25 };
    }
  });
});

describe('scenario US5 — the no-gap invariant is scoped: enforced within a chain, relaxed across an attach', () => {
  it('spine and arm stay internally connected while the cross-chain link keeps its real, nonzero offset', () => {
    const { spine1, spine2, armRoot, armTip } = setupAttachedRig();

    // Chain-internal links: zero gap (asserted by afterEach too — spelled out here as the
    // scenario's own explicit pin).
    expectClose(spine2.pivot.x + spine2.rest.tx, spine1.boneTip!.x, 0.3, 'spine chain-internal: no gap');
    expectClose(spine2.pivot.y + spine2.rest.ty, spine1.boneTip!.y, 0.3, 'spine chain-internal: no gap');
    expectClose(armTip.pivot.x + armTip.rest.tx, armRoot.boneTip!.x, 0.3, 'arm chain-internal: no gap');
    expectClose(armTip.pivot.y + armTip.rest.ty, armRoot.boneTip!.y, 0.3, 'arm chain-internal: no gap');

    // The cross-chain link is deliberately LOOSE: the attached root's origin is a REAL,
    // nonzero distance from the spine bone's tip (in the spine bone's own local frame) —
    // proof the attach fold did not (and must not) glue it the way a normal child is glued.
    const gapX = armRoot.pivot.x + armRoot.rest.tx - spine2.boneTip!.x;
    const gapY = armRoot.pivot.y + armRoot.rest.ty - spine2.boneTip!.y;
    expect(Math.hypot(gapX, gapY), 'the attach link has a real offset, not a glued joint')
      .toBeGreaterThan(0.5);
  });
});

describe('scenario — the dashed attachment link is visible and its stroke stays screen-constant', () => {
  it('draws from the spine bone\'s TIP to the attached root\'s origin, non-scaling-stroke, surviving a zoom rebuild', () => {
    // A plain (unrotated) attach, deliberately NOT using setupAttachedRig's
    // poseNonTrivially: with every rest.rotate/tx/ty at 0, every chain matrix is the
    // identity, so the raw model boneTip/pivot values equal the RENDERED root-space
    // coordinates directly — letting this test assert the link's endpoints without
    // needing the pose-composition machinery the render-neutrality scenarios exercise.
    const [, spine2] = placeChainOn(SPINE, 2);
    const [armRoot] = placeChainOn(LIMB, 2);
    modelSelectPart(armRoot.id);
    notify();
    repaint();
    ensureExpanded(spine2.parentId!);
    ensureExpanded(armRoot.parentId!);
    simulateDragDrop(partRow(armRoot.id), partRow(spine2.id));

    const link = overlayEl().querySelector('.attachment-link');
    if (!link) throw new Error('no .attachment-link rendered after attach');
    expectClose(Number(link.getAttribute('x1')), spine2.boneTip!.x, 0.05, 'link starts at the spine bone\'s TIP');
    expectClose(Number(link.getAttribute('y1')), spine2.boneTip!.y, 0.05, 'link starts at the spine bone\'s TIP');
    expectClose(Number(link.getAttribute('x2')), armRoot.pivot.x + armRoot.rest.tx, 0.05, 'link ends at the attached root\'s origin');
    expectClose(Number(link.getAttribute('y2')), armRoot.pivot.y + armRoot.rest.ty, 0.05, 'link ends at the attached root\'s origin');

    // A NORMAL chain-internal bone-line (spine1->spine2) still renders too, distinctly.
    expect(overlayEl().querySelectorAll('.bone-line').length, 'ordinary chain-internal bone-lines still render')
      .toBeGreaterThan(0);

    // GOTCHA (CLAUDE.md "ALL canvas chrome must be screen-constant under zoom"): unlike a
    // glyph's radius, this line's ENDPOINTS are real doc-space positions and its length
    // legitimately changes with zoom (assertScreenConstant's own bbox measurement doesn't
    // apply here — see its doc comment) — what must NOT change is the STROKE-WIDTH
    // MECHANISM. Assert it's present before AND after an 8x zoom + overlay rebuild (a
    // renderOverlay() call is implicit in the zoom pipeline), so a future edit that starts
    // computing the stroke from a zoom-dependent value (breaking the invariant) is caught.
    const before = {
      vectorEffect: link.getAttribute('vector-effect'),
      strokeWidth: link.getAttribute('stroke-width'),
    };
    expect(before.vectorEffect, 'non-scaling-stroke keeps the line screen-constant').toBe('non-scaling-stroke');
    expect(before.strokeWidth, 'a fixed literal width, not zoom-derived').toBe('1');

    zoomBy(8);
    repaint();
    const linkAfter = overlayEl().querySelector('.attachment-link');
    if (!linkAfter) throw new Error('no .attachment-link after the zoom rebuild');
    expect(linkAfter.getAttribute('vector-effect')).toBe(before.vectorEffect);
    expect(linkAfter.getAttribute('stroke-width')).toBe(before.strokeWidth);
  });
});

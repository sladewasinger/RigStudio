/**
 * Interaction tests for "Group-like selection for art-with-children" (ROADMAP.md live
 * bug queue, user-reported 2026-07-12): every group behavior (click-selects-ancestor,
 * dblclick drill-down, entered-group tracking, union selection box, group handle sets
 * w/ descendant scale distribution) used to key on `kind === 'group'` alone. An ART part
 * carrying child parts — Pip's `face` (its own mouth path PLUS a nested `eyes` part,
 * the recursive importer's normal shape) — got none of it: clicking the eyes selected
 * `eyes` instead of `face`, and `face`'s selection box only ever covered its own mouth
 * path. `isGroupLike` (core/partHierarchy.ts) fixes this at every site; these scenarios
 * mirror selection-focus.test.ts's scenario 9 (dive-in) and groupHandles.test.ts's group
 * scale/rotate scenarios, now driven through `face`/`eyes` instead of a Ctrl+G null.
 *
 * Real gestures throughout (elementFromPoint hit targets, full pointer sequences,
 * numeric assertions) per the harness conventions.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { canUndo, undo } from '../../core/history';
import { isGroupLike, selectPart } from '../../core/model';
import { groupAction } from '../../panels';
import { partRootBoxes, unbindSelectedSkin, enterGroupsFor } from '../../view';
import {
  bootRig, resetRig, state, partByLabel, clientPointOnPart, gestureDrag, click,
  fullDblClick, pressKey, overlayEl, overlayCount, expectClose, docToClient,
  clientCenterOf, selectByLabel, repaint, screenScale, pathElById, rawToClient,
  placeBoneChain, notify, setEditorMode,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/**
 * A click point deep INSIDE one of `label`'s own paths (its local bbox center, mapped
 * through that path's own live screen CTM) — unlike `clientPointOnPart` (which samples
 * along the path's OUTLINE, right at the fill edge), this survives the ~1px integer
 * truncation `MouseEvent`'s `clientX`/`clientY` apply at construction time. That
 * truncation matters here specifically: Pip's `eyes` are two small ellipses, and once
 * `eyes` is selected its own selection-box/handle chrome can occlude an outline sample
 * point, pushing `clientPointOnPart` to a LATER, edge-hugging fraction where a single
 * pixel of rounding can land just outside the fill (a real, reproducible interaction —
 * not test flakiness — the harness's `clientPointOnPart` was written for larger limbs
 * where this never bites).
 */
function centerPointOnPath(label: string): { x: number; y: number } {
  const pathId = partByLabel(label).paths[0].id;
  const el = pathElById(pathId);
  const box = el.getBBox();
  return rawToClient(pathId, box.x + box.width / 2, box.y + box.height / 2);
}

/** The primary `.select-box`'s ON-SCREEN (client px) bounding rect — real browser
 *  geometry, so it's automatically correct regardless of which coordinate space the
 *  rect's raw x/y/width/height attributes are expressed in (root-space for a group-like
 *  union box, part-LOCAL space for a plain single part's own bbox — comparing THOSE
 *  raw attributes directly against `partRootBoxes`' root-space numbers would silently
 *  mismatch whenever a part's own transform includes rotation/scale). */
function selectBoxClientRect(): DOMRect {
  return (overlayEl().querySelector('.select-box') as SVGRectElement).getBoundingClientRect();
}

/** `partRootBoxes` (root/doc-space) → client-space bounding rect, via the live root CTM
 *  (`docToClient`) — same coordinate system `selectBoxClientRect` reads, so the two are
 *  directly comparable regardless of zoom/pan. */
function unionClientRect(ids: string[]): { left: number; top: number; right: number; bottom: number } {
  const boxes = ids.map((id) => partRootBoxes([id]).get(id)!);
  const ux0 = Math.min(...boxes.map((b) => b.x));
  const uy0 = Math.min(...boxes.map((b) => b.y));
  const ux1 = Math.max(...boxes.map((b) => b.x + b.w));
  const uy1 = Math.max(...boxes.map((b) => b.y + b.h));
  const c0 = docToClient({ x: ux0, y: uy0 });
  const c1 = docToClient({ x: ux1, y: uy1 });
  return {
    left: Math.min(c0.x, c1.x), top: Math.min(c0.y, c1.y),
    right: Math.max(c0.x, c1.x), bottom: Math.max(c0.y, c1.y),
  };
}

/** Asserts the primary select box tightly covers the union of the given parts' own
 *  rendered boxes (inclusion both ways, with a little slack for the handle padding). */
function assertBoxIsUnionOf(ids: string[]): void {
  const u = unionClientRect(ids);
  const r = selectBoxClientRect();
  expect(r.left, 'box left edge covers the union (padding only, never clipped)').toBeLessThanOrEqual(u.left + 1);
  expect(r.top, 'box top edge covers the union').toBeLessThanOrEqual(u.top + 1);
  expect(r.right, 'box right edge covers the union').toBeGreaterThanOrEqual(u.right - 1);
  expect(r.bottom, 'box bottom edge covers the union').toBeGreaterThanOrEqual(u.bottom - 1);
  // And it isn't wildly larger than the union either (padding-only slack, not "the box
  // just happens to contain everything because it covers the whole canvas").
  const pad = 20 * screenScale(); // generous — actual handle padding is a few doc units
  expect(r.right - r.left).toBeLessThanOrEqual((u.right - u.left) + pad);
  expect(r.bottom - r.top).toBeLessThanOrEqual((u.bottom - u.top) + pad);
}

describe('scenario GL1 — clicking into art-with-children selects the whole composite, with a union box', () => {
  it('face has a child part eyes (the recursive importer\'s normal shape, not kind "group")', () => {
    const face = partByLabel('face');
    const eyes = partByLabel('eyes');
    expect(face.kind).toBe('art');
    expect(face.paths.length, 'face draws its own geometry (the mouth)').toBeGreaterThan(0);
    expect(eyes.parentId).toBe(face.id);
    expect(isGroupLike(face, state.doc!.parts)).toBe(true);
    expect(isGroupLike(eyes, state.doc!.parts), 'a leaf child is not itself group-like').toBe(false);
  });

  it('clicking the eyes artwork on canvas selects face, boxed as the mouth+eyes union', () => {
    const face = partByLabel('face');
    const p = centerPointOnPath('eyes');
    click(p.x, p.y);
    expect(state.selectedPartId, 'click substitutes up to the group-like ancestor').toBe(face.id);
    assertBoxIsUnionOf([face.id, partByLabel('eyes').id]);
  });

  it('clicking the mouth artwork (face\'s own path) selects face unchanged, same union box', () => {
    const face = partByLabel('face');
    const p = clientPointOnPart('face'); // resolves to face's own path (eyes is a nested group)
    click(p.x, p.y);
    expect(state.selectedPartId, 'no substitution needed — face is already what was hit').toBe(face.id);
    assertBoxIsUnionOf([face.id, partByLabel('eyes').id]);
  });

  it('selecting face the way a Layers click does (selectPart + notify) gets the same union box', () => {
    const face = partByLabel('face');
    selectByLabel('face'); // exactly what a Layers row click drives (per the harness helper)
    expect(state.selectedPartId).toBe(face.id);
    assertBoxIsUnionOf([face.id, partByLabel('eyes').id]);
  });

  it('picking eyes directly via Layers (selectPart + enterGroupsFor) opens face as context, so eyes stays directly clickable', () => {
    // enterGroupsFor is the OTHER site the fix touches (focus.ts) — the Layers-panel
    // click driver (layers.ts, owned by another agent) calls selectPart + this. Drive
    // it exactly the way that panel does, per this task's instruction to verify Layers
    // behavior through selection state rather than editing the panel.
    const eyes = partByLabel('eyes');
    selectPart(eyes.id);
    enterGroupsFor(eyes.id);
    // Deselect (but keep the entered context — mirrors the "dive in, select nothing"
    // state repairEnteredGroups is careful never to disturb): the artwork pipeline's
    // "already selected, manipulate directly" exception would otherwise mask whether
    // enterGroupsFor actually opened face, since a re-click on an ALREADY-selected part
    // skips group substitution regardless of entered state.
    selectPart(null);
    notify();
    expect(state.selectedPartId).toBeNull();

    // Without face entered, a canvas click on eyes would substitute up to face (GL1).
    // With it entered (this test's whole point), the SAME click lands on eyes directly.
    const p = centerPointOnPath('eyes');
    click(p.x, p.y);
    expect(state.selectedPartId, 'face was opened as context by enterGroupsFor').toBe(eyes.id);
  });
});

describe('scenario GL2 — dblclick drills into face, a click selects eyes, Escape steps back out', () => {
  it('mirrors the established group dive-in ladder (selection-focus.test.ts scenario 9) for art-with-children', () => {
    const face = partByLabel('face');
    const eyes = partByLabel('eyes');

    // Click the eyes → lands on the closed group-like ancestor, face.
    let p = centerPointOnPath('eyes');
    click(p.x, p.y);
    expect(state.selectedPartId).toBe(face.id);

    // Double-click DIVES into face, selecting NOTHING (temporary ungrouping).
    p = centerPointOnPath('eyes');
    fullDblClick(p.x, p.y);
    expect(state.selectedPartId).toBeNull();
    expect(overlayCount('.select-box')).toBe(0);

    // The next single click selects the child under the cursor directly.
    p = centerPointOnPath('eyes');
    click(p.x, p.y);
    expect(state.selectedPartId).toBe(eyes.id);
    expect(state.selectedPathId).toBeNull();
    expect(overlayCount('.select-box')).toBeGreaterThanOrEqual(1);

    // Its box is eyes' OWN box now (deepest level, not the face+eyes union anymore) —
    // meaningfully smaller than the face+eyes union checked in scenario GL1.
    const soleBox = selectBoxClientRect();
    const union = unionClientRect([face.id, eyes.id]);
    expect(
      (soleBox.right - soleBox.left) * (soleBox.bottom - soleBox.top),
      'eyes-alone box area is well under the face+eyes union area',
    ).toBeLessThan(((union.right - union.left) * (union.bottom - union.top)) * 0.8);

    // Double-click on the (deepest-level) part enters PATH/node scope.
    p = centerPointOnPath('eyes');
    fullDblClick(p.x, p.y);
    expect(state.selectedPartId).toBe(eyes.id);
    const pathIds = partByLabel('eyes').paths.map((pp) => pp.id);
    expect(pathIds).toContain(state.selectedPathId);

    // Escape tier 1: leave the entered path (part stays selected).
    pressKey('Escape');
    expect(state.selectedPathId).toBeNull();
    expect(state.selectedPartId).toBe(eyes.id);

    // Escape tier 2: deselect, but stay inside face (one level at a time).
    pressKey('Escape');
    expect(state.selectedPartId).toBeNull();

    // Escape tier 3: pop face. Clicking the eyes now lands on face again.
    pressKey('Escape');
    p = centerPointOnPath('eyes');
    click(p.x, p.y);
    expect(state.selectedPartId).toBe(face.id);
  });
});

describe('scenario GL3 — face (art-with-children) gets the group handle sets', () => {
  it('first click shows 8 scale handles; an SE-corner drag scales BOTH face\'s own geometry and eyes, about face\'s own pivot', () => {
    const face = partByLabel('face');
    const eyes = partByLabel('eyes');
    selectByLabel('face');
    repaint();
    expect(overlayCount('.scale-handle')).toBe(8);
    expect(overlayCount('.rotate-handle')).toBe(0);
    expect(face.rest.sx).toBe(1);
    expect(eyes.rest.sx).toBe(1);

    const pivot0 = { ...face.pivot };
    const faceBoxBefore = partRootBoxes([face.id]).get(face.id)!;
    const eyesBoxBefore = partRootBoxes([eyes.id]).get(eyes.id)!;

    const seC = clientCenterOf(overlayEl().querySelector('[data-handle="se"]')!);
    const pivotC = docToClient(face.pivot);
    const k = 1.3;
    const target = {
      x: pivotC.x + k * (seC.x - pivotC.x),
      y: pivotC.y + k * (seC.y - pivotC.y),
    };
    gestureDrag(seC, target);

    const face2 = state.doc!.parts.find((p) => p.id === face.id)!;
    const eyes2 = state.doc!.parts.find((p) => p.id === eyes.id)!;
    expectClose(face2.rest.sx, k, 0.08, "face's OWN geometry scales too, not just its descendants");
    expectClose(face2.rest.sy, k, 0.08, "face's OWN rest.sy scales too");
    expectClose(eyes2.rest.sx, k, 0.08, 'eyes (the descendant) scales the same amount');

    // The anchor invariant: face's OWN effective pivot never moves (same rule a partless
    // group's pivot follows — applyGroupScale's point-scale formula pins it exactly).
    expectClose(face2.pivot.x, pivot0.x, 1e-9, "face's own pivot is untouched");
    expectClose(face2.pivot.y, pivot0.y, 1e-9, "face's own pivot is untouched");

    const faceBoxAfter = partRootBoxes([face.id]).get(face.id)!;
    const eyesBoxAfter = partRootBoxes([eyes.id]).get(eyes.id)!;
    expectClose(faceBoxAfter.w, faceBoxBefore.w * k, Math.max(0.5, faceBoxBefore.w * 0.08), "face's own rendered box grew ~k");
    expectClose(eyesBoxAfter.w, eyesBoxBefore.w * k, Math.max(0.5, eyesBoxBefore.w * 0.08), "eyes' rendered box grew ~k too");

    expect(canUndo()).toBe(true);
    undo();
    const faceR = state.doc!.parts.find((p) => p.id === face.id)!;
    const eyesR = state.doc!.parts.find((p) => p.id === eyes.id)!;
    expectClose(faceR.rest.sx, 1, 1e-9, 'undo restores face rest.sx');
    expectClose(eyesR.rest.sx, 1, 1e-9, 'undo restores eyes rest.sx');
  });

  it('second click toggles to 4 rotate corners, no skew sides — matching a pure group\'s set exactly', () => {
    selectByLabel('face');
    repaint();
    const p = clientPointOnPart('face'); // click again on the (already-primary) mouth toggles the set
    click(p.x, p.y);
    expect(overlayCount('.scale-handle'), 'scale set gone').toBe(0);
    expect(overlayCount('.skew-handle'), 'group-like art gets no skew — a distributed edit has no shear field').toBe(0);
    expect(overlayCount('.rotate-handle'), '4 rotate corners visible').toBe(4);
  });

  it('a rotate-corner drag writes face\'s OWN rest.rotate, and eyes rides it through the normal pose chain', () => {
    const face = partByLabel('face');
    const eyes = partByLabel('eyes');
    selectByLabel('face');
    repaint();
    const p = clientPointOnPart('face');
    click(p.x, p.y); // toggle to rotate corners
    expect(overlayCount('.rotate-handle')).toBe(4);

    const rot0 = face.rest.rotate;
    const pivotC = docToClient(face.pivot);
    const handles = Array.from(overlayEl().querySelectorAll('[data-role="rotate-handle"]'));
    const withDist = handles.map((h) => {
      const c = clientCenterOf(h);
      return { c, d: Math.hypot(c.x - pivotC.x, c.y - pivotC.y) };
    }).sort((a, b) => b.d - a.d);
    const start = withDist[0].c;
    const th = (20 * Math.PI) / 180;
    const rx = start.x - pivotC.x, ry = start.y - pivotC.y;
    const target = {
      x: pivotC.x + rx * Math.cos(th) - ry * Math.sin(th),
      y: pivotC.y + rx * Math.sin(th) + ry * Math.cos(th),
    };

    const eyesBoxBefore = partRootBoxes([eyes.id]).get(eyes.id)!;
    gestureDrag(start, target);

    const face2 = state.doc!.parts.find((pp) => pp.id === face.id)!;
    const rotDelta = face2.rest.rotate - rot0;
    expectClose(Math.cos(((rotDelta - 20) * Math.PI) / 180), 1, 1e-2, "face's rest.rotate advances ~20°");
    expect(eyes.rest.rotate, "eyes' OWN rotate channel is untouched — it rides face's pose").toBe(0);

    const eyesBoxAfter = partRootBoxes([eyes.id]).get(eyes.id)!;
    expect(
      Math.hypot(eyesBoxAfter.x - eyesBoxBefore.x, eyesBoxAfter.y - eyesBoxBefore.y),
      'eyes visibly moved — it rides the rotation through the ordinary parent-chain pose',
    ).toBeGreaterThan(1);
  });
});

describe('scenario GL4 — a bone chain under an art part does NOT make it group-like (critical exclusion)', () => {
  it('right_arm stays a normal single-part selection with a bone parented under it', () => {
    // Place a real pen-tool chain (proper root→parent-local pivot conversion, exactly
    // what a user gesture produces — `commitBone`), then strip the auto-bind side
    // effect (Bones 2.0 skins art anchored under a placed chain, which would ALSO
    // suppress handles via the skinned-part path and confound this test), leaving
    // exactly the hierarchy relationship the predicate must exclude: a bone CHILD
    // parented under an ordinary art part, per "hierarchy-as-assignment".
    const rightArm = partByLabel('right_arm');
    selectByLabel('right_arm');
    const start = clientPointOnPart('right_arm');
    const bones = placeBoneChain([start, { x: start.x + 40, y: start.y - 10 }]);
    expect(bones.length, 'a bone was committed').toBeGreaterThan(0);
    const bone = bones[0];
    expect(bone.parentId).toBe(rightArm.id);

    selectByLabel('right_arm');
    unbindSelectedSkin();
    expect(partByLabel('right_arm').skin, 'auto-bind side effect removed').toBeFalsy();

    // The critical assertion: a bone child must NOT flip the predicate.
    expect(isGroupLike(rightArm, state.doc!.parts)).toBe(false);

    // right_arm is already the fresh primary selection (handleMode reset to 'scale' by
    // the reselect above) — a normal single-part box and the plain 8-square scale set,
    // no group substitution, no group handle set.
    expect(state.selectedPartId).toBe(rightArm.id);
    expect(overlayCount('.select-box')).toBe(1);
    expect(overlayCount('.scale-handle'), 'still the plain 8-square single-part scale set').toBe(8);

    // And clicking the BONE's own glyph selects the bone directly too — right_arm never
    // acts as a "closed container" a bone click would get substituted up through. The
    // glyph lives in the OVERLAY (bones are partless — no artwork group of their own);
    // querying unscoped `document` would find the Layers row instead (it ALSO carries
    // `data-part-id`, panels/layers.ts, and sits earlier in the DOM).
    const boneGlyph = overlayEl().querySelector(`[data-part-id="${bone.id}"]`) as SVGGElement;
    expect(boneGlyph, 'the bone has its own clickable glyph').toBeTruthy();
    const r = boneGlyph.getBoundingClientRect();
    click(r.x + r.width / 2, r.y + r.height / 2);
    expect(state.selectedPartId).toBe(bone.id);
  });
});

/** `#inspector`'s section headings, same probe `keySelection.test.ts` uses. */
function inspectorHeadings(): string[] {
  return Array.from(document.querySelectorAll('#inspector h3')).map((h) => h.textContent ?? '');
}

/**
 * scenario GL5 — user-reported regression (2026-07-13): "I double click on an eye, and
 * everything fades except for the face. Good. Then I double click on an eye again to
 * drilldown into the eyes group, but nothing happens." Root cause: the dblclick ladder's
 * deepest-level branch (enter the part + select the path under the cursor) carried a
 * `state.editorMode !== 'setup'` early return — a leftover from before drill-down was
 * generalized to art-with-children, back when "enters a part" implicitly meant "enters
 * node-editing". PRE-FIX in Animate: the second dblclick on the eye silently no-ops —
 * `state.selectedPathId` stays `null` and `state.selectedPartId` stays `null` (still
 * inside the dived `face`, nothing selected) — confirmed by reverting the dblclick.ts
 * fix and re-running this scenario (recorded in the wave's commit message).
 *
 * Design ruling (2026-07-13, "parts/groups should act the same, Inkscape-like"): drill-
 * down and path SELECTION are IDENTICAL in Edit and Animate — it is navigation/
 * inspection (Layers row highlight, canvas dashed outline, inspector object section),
 * never a new keyable surface. Only node EDITING itself (state.mode 'nodes', Setup-only)
 * stays gated. This scenario duplicates GL2's ladder verbatim per mode via
 * `describe.each` (mode is the only variable) so Edit's already-passing behavior and
 * Animate's fixed behavior are pinned by the exact same assertions.
 */
describe.each(['setup', 'animate'] as const)(
  'scenario GL5 — %s: dblclick drills face -> eyes -> eyes\' path scope, Escape walks back out',
  (mode) => {
    it(`the user's exact recipe: dblclick eye, dblclick eye again enters path scope (${mode})`, () => {
      setEditorMode(mode);
      const face = partByLabel('face');
      const eyes = partByLabel('eyes');

      // Click the eyes → lands on the closed group-like ancestor, face (unaffected by
      // editorMode — the artwork pipeline's group substitution never gated on it).
      let p = centerPointOnPath('eyes');
      click(p.x, p.y);
      expect(state.selectedPartId).toBe(face.id);

      // Double-click DIVES into face, selecting NOTHING — "everything fades except the
      // face. Good" from the report.
      p = centerPointOnPath('eyes');
      fullDblClick(p.x, p.y);
      expect(state.selectedPartId).toBeNull();
      expect(overlayCount('.select-box')).toBe(0);

      // The next single click selects eyes directly (face is now entered).
      p = centerPointOnPath('eyes');
      click(p.x, p.y);
      expect(state.selectedPartId).toBe(eyes.id);
      expect(state.selectedPathId).toBeNull();

      // THE REPORTED DEAD SPOT: double-click on eyes again must enter PATH scope —
      // eyes has no child parts of its own, so the next drill level is the classic
      // "enter the part, select the path under the cursor" behavior.
      p = centerPointOnPath('eyes');
      fullDblClick(p.x, p.y);
      expect(state.selectedPartId, 'still on eyes, now path-scoped').toBe(eyes.id);
      const pathIds = eyes.paths.map((pp) => pp.id);
      expect(pathIds, 'a real path id was selected').toContain(state.selectedPathId);
      expect(
        eyes.paths.find((pp) => pp.id === state.selectedPathId)?.label,
        'the clicked path is one of the two eye ellipses',
      ).toMatch(/eye/);

      // Sane, mode-agnostic feedback for the entered path: Layers row highlight (already
      // mode-agnostic pre-fix), the canvas dashed outline, and the inspector's object
      // section — all three now render regardless of editorMode.
      expect(overlayCount('.path-highlight'), 'canvas dashed path outline').toBe(1);
      expect(
        inspectorHeadings().some((h) => h.startsWith('object:')),
        'inspector grows an "object:" section for the entered path',
      ).toBe(true);

      // Escape tier 1: leave the entered path (part stays selected).
      pressKey('Escape');
      expect(state.selectedPathId).toBeNull();
      expect(state.selectedPartId).toBe(eyes.id);

      // Escape tier 2: deselect, but stay inside face (one level at a time).
      pressKey('Escape');
      expect(state.selectedPartId).toBeNull();

      // Escape tier 3: pop face. Clicking the eyes now lands on face again — proving the
      // whole dive is symmetric, in either mode.
      pressKey('Escape');
      p = centerPointOnPath('eyes');
      click(p.x, p.y);
      expect(state.selectedPartId).toBe(face.id);
    });
  },
);

/**
 * scenario GL6 — a THREE-deep group-like ladder: a genuine `kind: 'group'` null wrapping
 * `face` (itself group-like: art-with-children, per GL1) which in turn parents the plain
 * leaf art `eyes`. Verifies the ladder generalizes past one group-like level — EACH
 * dblclick steps exactly one level toward the clicked leaf, whatever mix of `kind:
 * 'group'` and art-with-children ancestors sits in between — and that Escape unwinds the
 * same three levels symmetrically. Fabricated (mirrors selection-focus.test.ts scenario
 * 10's nested-group technique) since no bundled fixture nests a real group around an
 * art-with-children part.
 */
describe.each(['setup', 'animate'] as const)(
  'scenario GL6 — %s: a 3-deep ladder (group -> art-with-children -> plain art)',
  (mode) => {
    it(`each dblclick dives exactly one level; a final dblclick enters eyes' path scope (${mode})`, () => {
      // Build the fixture in Setup — grouping is a structural rig edit (groupAction is
      // itself Setup-gated, unrelated to this ladder fix) — THEN switch to the mode
      // under test for the actual drill-down gestures below.
      selectByLabel('face');
      const p2 = clientPointOnPart('right_leg');
      click(p2.x, p2.y, { shiftKey: true });
      groupAction();
      const group = state.doc!.parts.find((pt) => pt.kind === 'group')!;
      const face = partByLabel('face');
      const eyes = partByLabel('eyes');
      expect(face.parentId, 'face now hangs under the new group').toBe(group.id);
      expect(eyes.parentId, "face's own child link is untouched by the grouping").toBe(face.id);

      setEditorMode(mode);
      selectPart(null);

      // Level 1: click eyes → substitutes to the OUTERMOST closed group-like ancestor
      // (the new group), same rule scenario 10 pins for nested plain groups.
      let p = centerPointOnPath('eyes');
      click(p.x, p.y);
      expect(state.selectedPartId).toBe(group.id);

      // Dive 1: enters the group only — face is NOT yet entered.
      p = centerPointOnPath('eyes');
      fullDblClick(p.x, p.y);
      expect(state.selectedPartId).toBeNull();

      // Level 2: click now substitutes to face (the next un-entered group-like ancestor).
      p = centerPointOnPath('eyes');
      click(p.x, p.y);
      expect(state.selectedPartId).toBe(face.id);

      // Dive 2: enters face. Both group-like ancestors are now entered.
      p = centerPointOnPath('eyes');
      fullDblClick(p.x, p.y);
      expect(state.selectedPartId).toBeNull();

      // Level 3 (deepest — no un-entered group-like ancestor left): click selects the
      // leaf eyes directly.
      p = centerPointOnPath('eyes');
      click(p.x, p.y);
      expect(state.selectedPartId).toBe(eyes.id);

      // Dive 3: the final dblclick has nowhere left to descend as a GROUP, so it enters
      // PATH scope on eyes instead — exactly GL5's assertion, now reached through two
      // group-like levels instead of one.
      p = centerPointOnPath('eyes');
      fullDblClick(p.x, p.y);
      expect(state.selectedPartId).toBe(eyes.id);
      expect(eyes.paths.map((pp) => pp.id)).toContain(state.selectedPathId);

      // Escape unwinds the same three levels one at a time: path -> deselect -> pop
      // face -> deselect -> pop group. Every step is a real gesture (Escape/click, no
      // state.* backdoors) — a click on eyes after each pop proves which level is
      // active, mirroring GL2/scenario 9's round-trip check.
      pressKey('Escape'); // leave the path
      expect(state.selectedPathId).toBeNull();
      expect(state.selectedPartId).toBe(eyes.id);

      pressKey('Escape'); // deselect eyes, stay inside face+group
      expect(state.selectedPartId).toBeNull();

      pressKey('Escape'); // pop face — group stays entered
      p = centerPointOnPath('eyes');
      click(p.x, p.y);
      expect(state.selectedPartId, 'face is no longer entered — click substitutes to it again').toBe(face.id);

      pressKey('Escape'); // deselect face
      expect(state.selectedPartId).toBeNull();

      pressKey('Escape'); // pop the group — nothing entered anymore
      p = centerPointOnPath('eyes');
      click(p.x, p.y);
      expect(state.selectedPartId, 'group is no longer entered — click substitutes all the way back to it').toBe(group.id);
    });
  },
);

/**
 * CLAUDE.md "Node editor revamp" items 1-4 (2026-07-13):
 *  1. Alt+click ON A SEGMENT inserts a node at the exact point clicked (retiring the old
 *     Alt+click-a-NODE-inserts-at-midpoint gesture).
 *  2. smooth/symmetric always synthesize BOTH handles, growing a straight-line neighbor.
 *  3. The closing-seam coincident pair (bend pipeline's implicit-Z split) renders/selects/
 *     drags as ONE node.
 *  4. The inspector's smooth/symmetric/corner buttons subtly highlight the selection's
 *     current type (`.node-type-active` — a lighter treatment than the loud toggle-style
 *     `button.active` used for mode/tool switches elsewhere, per "subtly highlight").
 *
 * Helpers below take the path id as an explicit parameter (captured ONCE per test) rather
 * than re-deriving it by matching the fixture's ORIGINAL nodeTypes string every call —
 * several scenarios here deliberately mutate nodeTypes, which would break a re-derive.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { parsePath, serializePath, PathCmd } from '../../geometry/paths';
import { IDENTITY } from '../../geometry/transforms';
import { selectedNodeCount } from '../../view';
import {
  bootRig, resetRig, partByLabel, gestureDrag, expectClose, overlayEl, count,
  clientCenterOf, enterNodeMode, rawToClient, click, repaint,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

const mouthId = () => partByLabel('face').paths.find((p) => p.nodeTypes === 'zzzzz')!.id;
const legId = () => partByLabel('left_leg').paths.find((p) => p.nodeTypes === 'cssssscc')!.id;

function nodeHandle(pathId: string, cmdIndex: number, field: 'x' | 'x1' | 'x2'): SVGElement {
  const sel = `[data-role="node"][data-path-id="${pathId}"][data-cmd-index="${cmdIndex}"][data-field="${field}"]`;
  const el = overlayEl().querySelector(sel);
  if (!el) throw new Error(`no ${field} handle at cmd ${cmdIndex}`);
  return el as SVGElement;
}

function facePath(id: string) {
  return partByLabel('face').paths.find((p) => p.id === id)!;
}
function faceCmds(id: string): PathCmd[] {
  return parsePath(facePath(id).d);
}
function leftLegPath(id: string) {
  return partByLabel('left_leg').paths.find((p) => p.id === id)!;
}
function leftLegCmds(id: string): PathCmd[] {
  return parsePath(leftLegPath(id).d);
}

/** The real inspector node-ops button matching this exact label. */
function opButton(text: string): HTMLButtonElement {
  const btn = [...document.querySelectorAll('#inspector button')]
    .find((b) => b.textContent === text) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`no inspector button "${text}"`);
  return btn;
}

describe('CLAUDE.md item 1 — Alt+click ON A SEGMENT inserts a node there', () => {
  it('lands the new node within 0.5px of the exact click point (not the segment midpoint)', () => {
    const id = mouthId();
    enterNodeMode('face', id);
    const cmds0 = faceCmds(id);
    const p0 = cmds0[1] as { x: number; y: number };
    const seg = cmds0[2] as { x1: number; y1: number; x2: number; y2: number; x: number; y: number };
    // t=0.2: off-center (so a midpoint-insert would clearly miss) and, at this fixture's
    // zoom, clear of the segment's own control-handle glyphs (verified: 0.28-0.78 along
    // this exact segment resolves to a handle circle, not the path, under elementFromPoint).
    const t = 0.2;
    const u = 1 - t;
    const raw = {
      x: u * u * u * p0.x + 3 * u * u * t * seg.x1 + 3 * u * t * t * seg.x2 + t * t * t * seg.x,
      y: u * u * u * p0.y + 3 * u * u * t * seg.y1 + 3 * u * t * t * seg.y2 + t * t * t * seg.y,
    };
    const press = rawToClient(id, raw.x, raw.y);
    const nodesBefore = cmds0.filter((c) => c.cmd !== 'Z').length;

    click(press.x, press.y, { altKey: true });

    const cmds1 = faceCmds(id);
    expect(cmds1.filter((c) => c.cmd !== 'Z').length).toBe(nodesBefore + 1);
    const newNode = cmds1[2] as { x: number; y: number }; // spliced in before the old cmds0[2]
    const landed = rawToClient(id, newNode.x, newNode.y);
    expectClose(Math.hypot(landed.x - press.x, landed.y - press.y), 0, 0.5, 'inserted node lands at the click point');

    // New node marked smooth ('s'), matching insertNodeAfter's existing convention.
    expect(facePath(id).nodeTypes).toBe('zz' + 's' + 'zzz');
  });

  it('inserts on the implicit CLOSING segment too (the Z wrap)', () => {
    const id = legId();
    enterNodeMode('left_leg', id);
    const cmds0 = leftLegCmds(id);
    const zIdx = cmds0.findIndex((c) => c.cmd === 'Z');
    const lastNode = cmds0[zIdx - 1] as { x: number; y: number };
    const mStart = cmds0.find((c) => c.cmd === 'M') as { x: number; y: number };
    const raw = { x: lastNode.x + (mStart.x - lastNode.x) * 0.4, y: lastNode.y + (mStart.y - lastNode.y) * 0.4 };
    const press = rawToClient(id, raw.x, raw.y);
    const nodesBefore = cmds0.filter((c) => c.cmd !== 'Z').length;

    click(press.x, press.y, { altKey: true });

    const cmds1 = leftLegCmds(id);
    expect(cmds1.filter((c) => c.cmd !== 'Z').length).toBe(nodesBefore + 1);
    expect(cmds1[cmds1.length - 1].cmd).toBe('Z'); // still closed, Z untouched
    const newNode = cmds1[cmds1.length - 2] as { x: number; y: number };
    const landed = rawToClient(id, newNode.x, newNode.y);
    expectClose(Math.hypot(landed.x - press.x, landed.y - press.y), 0, 0.5, 'inserted node lands at the click point');
  });

  it('RETIRED: Alt+click directly on a NODE no longer inserts (old midpoint-insert gesture)', () => {
    const id = mouthId();
    enterNodeMode('face', id);
    const before = faceCmds(id);
    const countBefore = before.filter((c) => c.cmd !== 'Z').length;
    const n1Before = before[1] as { x: number; y: number };

    const h = clientCenterOf(nodeHandle(id, 1, 'x'));
    click(h.x, h.y, { altKey: true });

    const after = faceCmds(id);
    expect(after.filter((c) => c.cmd !== 'Z').length).toBe(countBefore); // no node added
    const n1After = after[1] as { x: number; y: number };
    expectClose(n1After.x, n1Before.x, 1e-6, 'node1 untouched by the retired gesture');
    expectClose(n1After.y, n1Before.y, 1e-6, 'node1 untouched by the retired gesture');
  });
});

describe('CLAUDE.md item 2 — symmetric/smooth always synthesize BOTH handles', () => {
  /** Force node1's LEAVING segment (cmds[2]) from 'C' to 'L' — the reported bug shape:
   *  a real ARRIVING handle (cmds[1]) but no LEAVING one. Returns node1/node2 points. */
  function forceLeavingLine(id: string): { node1: { x: number; y: number }; node2: { x: number; y: number } } {
    const path = facePath(id);
    const cmds = parsePath(path.d);
    const node1 = cmds[1] as { x: number; y: number };
    const seg = cmds[2] as { x: number; y: number };
    const node2 = { x: seg.x, y: seg.y };
    cmds[2] = { cmd: 'L', x: seg.x, y: seg.y };
    path.d = serializePath(cmds);
    repaint();
    return { node1, node2 };
  }

  it('symmetric: the grown handle mirrors the real one exactly (equal length, opposed)', () => {
    const id = mouthId();
    enterNodeMode('face', id);
    forceLeavingLine(id);

    const h = clientCenterOf(nodeHandle(id, 1, 'x'));
    click(h.x, h.y);
    opButton('symmetric').click();

    const cmds1 = faceCmds(id);
    const node1 = cmds1[1] as { x: number; y: number; x2: number; y2: number };
    const leaving = cmds1[2];
    expect(leaving.cmd).toBe('C'); // grown from the forced 'L'
    const c2 = leaving as { x1: number; y1: number };
    const a = { x: node1.x2 - node1.x, y: node1.y2 - node1.y };
    const b = { x: c2.x1 - node1.x, y: c2.y1 - node1.y };
    const la = Math.hypot(a.x, a.y), lb = Math.hypot(b.x, b.y);
    const cos = (a.x * b.x + a.y * b.y) / (la * lb);
    expectClose(cos, -1, 1e-2, 'handles opposed');
    expectClose(la, lb, 0.05, 'equal length handles even beside a former straight edge');
    expect(facePath(id).nodeTypes?.[1]).toBe('z');
  });

  it("smooth: mirrors direction but keeps the grown side's own 1/3-chord length", () => {
    const id = mouthId();
    enterNodeMode('face', id);
    const { node1, node2 } = forceLeavingLine(id);
    const laBefore = Math.hypot(
      (faceCmds(id)[1] as { x2: number }).x2 - node1.x,
      (faceCmds(id)[1] as { y2: number }).y2 - node1.y,
    );
    const expectedLb = Math.hypot(node2.x - node1.x, node2.y - node1.y) / 3;

    const h = clientCenterOf(nodeHandle(id, 1, 'x'));
    click(h.x, h.y);
    opButton('smooth').click();

    const cmds1 = faceCmds(id);
    const n1 = cmds1[1] as { x: number; y: number; x2: number; y2: number };
    const leaving = cmds1[2] as { cmd: string; x1: number; y1: number };
    expect(leaving.cmd).toBe('C');
    const a = { x: n1.x2 - n1.x, y: n1.y2 - n1.y };
    const b = { x: leaving.x1 - n1.x, y: leaving.y1 - n1.y };
    const la = Math.hypot(a.x, a.y), lb = Math.hypot(b.x, b.y);
    const cos = (a.x * b.x + a.y * b.y) / (la * lb);
    expectClose(cos, -1, 1e-2, 'handles opposed (smooth)');
    expectClose(la, laBefore, 0.05, "arriving side's own length preserved (smooth never rescales)");
    expectClose(lb, expectedLb, 0.05, "grown side lands at its own natural 1/3-chord length");
    expect(facePath(id).nodeTypes?.[1]).toBe('s');
  });

  it('preserves skin overrides across the L→C growth (same command count)', () => {
    const id = mouthId();
    enterNodeMode('face', id);
    forceLeavingLine(id);
    const part = partByLabel('face');
    const countBefore = faceCmds(id).length;
    part.skin = {
      bones: [{ id: 'fakeBone', restWorldInv: IDENTITY, bindSeg: { p: { x: 0, y: 0 }, q: { x: 1, y: 1 } } }],
      overrides: { [id]: { 1: { a: 'fakeBone', b: null, t: 1 } } },
    };
    repaint();

    const h = clientCenterOf(nodeHandle(id, 1, 'x'));
    click(h.x, h.y);
    opButton('symmetric').click();

    expect(part.skin.overrides?.[id]?.[1]).toEqual({ a: 'fakeBone', b: null, t: 1 });
    expect(faceCmds(id).length).toBe(countBefore);
  });
});

describe('CLAUDE.md item 3 — closing-seam glyph unification', () => {
  it('renders as ONE glyph; selecting/dragging/marqueeing moves both coincident points as one', () => {
    const id = legId();
    enterNodeMode('left_leg', id);

    const cmds0 = leftLegCmds(id);
    const zIdx0 = cmds0.findIndex((c) => c.cmd === 'Z');
    const lastNode = cmds0[zIdx0 - 1] as { x: number; y: number };
    const mStart = cmds0.find((c) => c.cmd === 'M') as { x: number; y: number };
    const nodesBefore = cmds0.filter((c) => c.cmd !== 'Z').length;
    const glyphSel = `[data-role="node"][data-path-id="${id}"][data-field="x"]`;
    const glyphsBefore = overlayEl().querySelectorAll(glyphSel).length;

    // Bend the implicit closing segment (same setup as the pre-existing scenario 7 in
    // node-editing.test.ts) — splices an explicit closing cubic whose endpoint coincides
    // with the M: the seam pattern item 3 unifies.
    const midRaw = { x: (lastNode.x + mStart.x) / 2, y: (lastNode.y + mStart.y) / 2 };
    const press = rawToClient(id, midRaw.x, midRaw.y);
    gestureDrag(press, { x: press.x + 26, y: press.y + 22 });

    const cmds1 = leftLegCmds(id);
    const nodesAfter = cmds1.filter((c) => c.cmd !== 'Z').length;
    expect(nodesAfter).toBe(nodesBefore + 1); // sanity: the split really happened
    const mIdx = cmds1.findIndex((c) => c.cmd === 'M');
    const zIdx1 = cmds1.findIndex((c) => c.cmd === 'Z');
    const shadowIdx = zIdx1 - 1;
    const mNode0 = cmds1[mIdx] as { x: number; y: number };
    const shadowNode0 = cmds1[shadowIdx] as { x: number; y: number };
    expectClose(mNode0.x, shadowNode0.x, 1e-6, 'seam coincident (sanity)');
    expectClose(mNode0.y, shadowNode0.y, 1e-6, 'seam coincident (sanity)');

    // ONE glyph renders for the coincident pair — count unchanged despite +1 real node —
    // and the shadow's own endpoint glyph never renders at all.
    expect(overlayEl().querySelectorAll(glyphSel).length).toBe(glyphsBefore);
    expect(overlayEl().querySelector(
      `[data-role="node"][data-path-id="${id}"][data-cmd-index="${shadowIdx}"][data-field="x"]`,
    )).toBeFalsy();

    // Clicking the merged glyph selects BOTH coincident indexes as one.
    const seamPoint = rawToClient(id, mNode0.x, mNode0.y);
    click(seamPoint.x, seamPoint.y);
    expect(selectedNodeCount()).toBe(2);

    // Dragging it moves both points together — no tear, still coincident, and it lands
    // on the pointer.
    const target = { x: seamPoint.x + 30, y: seamPoint.y - 24 };
    gestureDrag(seamPoint, target);
    const cmds2 = leftLegCmds(id);
    const mNode1 = cmds2[mIdx] as { x: number; y: number };
    const shadowNode1 = cmds2[shadowIdx] as { x: number; y: number };
    expectClose(mNode1.x, shadowNode1.x, 0.01, 'M and closing endpoint stay coincident after the drag');
    expectClose(mNode1.y, shadowNode1.y, 0.01, 'M and closing endpoint stay coincident after the drag');
    const landed = rawToClient(id, mNode1.x, mNode1.y);
    expectClose(Math.hypot(landed.x - target.x, landed.y - target.y), 0, 0.5, 'seam lands on the pointer');
    expect(cmds2[cmds2.length - 1].cmd).toBe('Z'); // still closed

    // A whole-canvas marquee also picks up BOTH coincident indexes (not just the one
    // visible glyph) — selectedNodeCount reaches the full real node count.
    const r = document.getElementById('canvas')!.getBoundingClientRect();
    gestureDrag({ x: r.left + 6, y: r.top + 6 }, { x: r.right - 6, y: r.bottom - 6 });
    expect(selectedNodeCount()).toBe(nodesAfter);

    // The pair splits ONLY via the explicit "del seg" op: deselect (a blank click, since a
    // click on an ALREADY-selected node — the marquee just selected everything — is a
    // deliberate no-op that preserves group-drag ability), then solo-select exactly the
    // seam pair and use the button — the path opens (Z gone).
    const blank = document.getElementById('canvas')!.getBoundingClientRect();
    click(blank.left + 4, blank.top + 4);
    expect(selectedNodeCount()).toBe(0);
    const seamPoint2 = rawToClient(id, mNode1.x, mNode1.y);
    click(seamPoint2.x, seamPoint2.y);
    expect(selectedNodeCount()).toBe(2);
    const delBtn = opButton('del seg');
    expect(delBtn.disabled).toBe(false);
    delBtn.click();
    const cmds3 = leftLegCmds(id);
    expect(cmds3.some((c) => c.cmd === 'Z')).toBe(false); // path is now open
  });
});

describe('CLAUDE.md item 4 — node-ops type-button highlight', () => {
  it('highlights the matching type button per selection; mixed selection highlights none', () => {
    const id = legId(); // nodeTypes 'cssssscc': node0='c', node1..5='s', node6/7='c'
    enterNodeMode('left_leg', id);

    click(clientCenterOf(nodeHandle(id, 1, 'x')).x, clientCenterOf(nodeHandle(id, 1, 'x')).y);
    expect(opButton('smooth').classList.contains('node-type-active')).toBe(true);
    expect(opButton('symmetric').classList.contains('node-type-active')).toBe(false);
    expect(opButton('corner').classList.contains('node-type-active')).toBe(false);

    click(clientCenterOf(nodeHandle(id, 0, 'x')).x, clientCenterOf(nodeHandle(id, 0, 'x')).y);
    expect(opButton('corner').classList.contains('node-type-active')).toBe(true);
    expect(opButton('smooth').classList.contains('node-type-active')).toBe(false);

    // Mixed selection (node0 'c' + node1 's'): nothing highlights.
    click(
      clientCenterOf(nodeHandle(id, 1, 'x')).x, clientCenterOf(nodeHandle(id, 1, 'x')).y,
      { shiftKey: true },
    );
    expect(selectedNodeCount()).toBe(2);
    expect(opButton('smooth').classList.contains('node-type-active')).toBe(false);
    expect(opButton('symmetric').classList.contains('node-type-active')).toBe(false);
    expect(opButton('corner').classList.contains('node-type-active')).toBe(false);
  });
});

// Sanity: neither new gesture leaks a stray marquee div.
describe('node editor revamp — no stray DOM', () => {
  it('leaves no .node-marquee behind after any of the above', () => {
    expect(count('.node-marquee')).toBe(0);
  });
});

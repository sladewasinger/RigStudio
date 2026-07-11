import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { parsePath, PathCmd } from '../../geometry/paths';
import {
  bootRig, resetRig, partByLabel, gestureDrag, expectClose, overlayEl,
  clientCenterOf, enterNodeMode, rawToClient, wheelAt, viewBox,
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

function legCmds(): PathCmd[] {
  return parsePath(partByLabel('left_leg').paths.find((p) => p.id === legId())!.d);
}
function mouthCmds(): PathCmd[] {
  return parsePath(partByLabel('face').paths.find((p) => p.id === mouthId())!.d);
}

describe('scenario 6 — node drag under zoom + pan', () => {
  it('an endpoint drag lands on the pointer within 0.1px at ~4x zoom + pan', () => {
    const id = mouthId();
    enterNodeMode('face', id);

    // Wheel-zoom ~4x anchored ON the node (cursor-anchored, so it stays on-screen),
    // then pan with a middle-drag so the frame is both scaled and offset.
    let h = clientCenterOf(nodeHandle(id, 1, 'x'));
    const w0 = viewBox().w;
    wheelAt(h.x, h.y, -925); // 1.0015^925 ≈ 4.0×
    expectClose(w0 / viewBox().w, 4, 0.35, 'reached ~4× zoom');
    h = clientCenterOf(nodeHandle(id, 1, 'x'));
    gestureDrag({ x: h.x, y: h.y }, { x: h.x + 50, y: h.y + 34 }, { button: 1 });

    h = clientCenterOf(nodeHandle(id, 1, 'x'));
    const target = { x: h.x + 45, y: h.y - 32 };
    gestureDrag(h, target);

    const node = mouthCmds()[1] as { x: number; y: number };
    const landed = rawToClient(id, node.x, node.y);
    expectClose(Math.hypot(landed.x - target.x, landed.y - target.y), 0, 0.1, 'endpoint lands on pointer');
  });

  it("dragging a 'z' node's control handle mirrors its partner (cos == -1, equal length)", () => {
    const id = mouthId();
    enterNodeMode('face', id);

    const start = clientCenterOf(nodeHandle(id, 1, 'x2'));
    gestureDrag(start, { x: start.x + 28, y: start.y + 16 });

    const cmds = mouthCmds();
    const c1 = cmds[1] as { x: number; y: number; x2: number; y2: number };
    const c2 = cmds[2] as { x1: number; y1: number };
    const node = { x: c1.x, y: c1.y };
    const own = { x: c1.x2 - node.x, y: c1.y2 - node.y };
    const partner = { x: c2.x1 - node.x, y: c2.y1 - node.y };
    const la = Math.hypot(own.x, own.y), lb = Math.hypot(partner.x, partner.y);
    const cos = (own.x * partner.x + own.y * partner.y) / (la * lb);
    expectClose(cos, -1, 1e-3, 'handles opposed');
    expectClose(la, lb, 0.05, 'symmetric: equal handle lengths');
  });
});

describe('scenario 7 — segment bend including the closing Z', () => {
  it('bends the implicit closing line into a cubic; nodeTypes stay in lockstep', () => {
    const id = legId();
    enterNodeMode('left_leg', id);

    const cmds0 = legCmds();
    const zIdx = cmds0.findIndex((c) => c.cmd === 'Z');
    expect(zIdx).toBeGreaterThan(0);
    const lastNode = cmds0[zIdx - 1] as { x: number; y: number };
    const mStart = cmds0.find((c) => c.cmd === 'M') as { x: number; y: number };
    const nodesBefore = cmds0.filter((c) => c.cmd !== 'Z').length;

    // Press the middle of the closing chord (last node → M) and bend it outward.
    const midRaw = { x: (lastNode.x + mStart.x) / 2, y: (lastNode.y + mStart.y) / 2 };
    const press = rawToClient(id, midRaw.x, midRaw.y);
    const target = { x: press.x + 26, y: press.y + 22 };
    gestureDrag(press, target);

    const legPath = partByLabel('left_leg').paths.find((p) => p.id === id)!;
    const cmds1 = parsePath(legPath.d);
    const nodesAfter = cmds1.filter((c) => c.cmd !== 'Z').length;
    // Still closed, and a real cubic now sits where the implicit line was: the closing
    // edge "grew handles" (the L→C-style conversion) and gained one node.
    expect(cmds1[cmds1.length - 1].cmd).toBe('Z');
    expect(nodesAfter).toBe(nodesBefore + 1);
    const spliced = cmds1[cmds1.length - 2];
    expect(spliced.cmd).toBe('C');

    // nodeTypes stay in lockstep with the node count (the sample leg carries an extra
    // Inkscape closing char that normalizes away as the new 'c' is appended), and the
    // new closing node is a corner.
    expect(legPath.nodeTypes!.length).toBe(nodesAfter);
    expect(legPath.nodeTypes!.endsWith('c')).toBe(true);

    // The bent cubic passes through the pointer (min client distance < 0.5px).
    const c = spliced as { x1: number; y1: number; x2: number; y2: number; x: number; y: number };
    const p0 = cmds1[cmds1.length - 3] as { x: number; y: number };
    let best = Infinity;
    for (let s = 0; s <= 200; s++) {
      const t = s / 200, u = 1 - t;
      const rx = u * u * u * p0.x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x;
      const ry = u * u * u * p0.y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y;
      const cl = rawToClient(id, rx, ry);
      best = Math.min(best, Math.hypot(cl.x - target.x, cl.y - target.y));
    }
    expectClose(best, 0, 0.5, 'curve passes through the pointer');
  });
});

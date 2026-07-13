/**
 * Pointer interaction for the graph canvas: box drag-to-move, drag-to-connect (the primary
 * transition-creation gesture), the click-click "arm" fallback's armed/from state, and
 * transition/state creation+deletion. Sits below `./graph` (which wires these handlers
 * onto the SVG it draws) and above `./graphCamera` (coordinate math) / `./state` (shared
 * ctx); neither of those is imported back by this module, and this module never imports
 * `./graph` back either.
 */

import { StateMachine, SMState, SMTransition, freshId, notify } from '../../core/model';
import { checkpoint } from '../../core/history';
import { ctx, rerender } from './state';
import { stateBox, elNS, svgPoint } from './graphCamera';

// Graph-space band around a box's RIGHT edge (its connection port) where a pointerdown
// starts a drag-to-connect instead of a box move. Center drags still move the box.
const CONNECT_BAND = 10;

// "Add transition" armed mode: arm → click a source box → click a target box → transition.
let arming = false;
let armFrom: string | null = null;

export function isArming(): boolean { return arming; }
export function hasArmFrom(): boolean { return armFrom !== null; }

/** The "+ transition" button's click handler: toggles armed mode. */
export function toggleArm(): void {
  arming = !arming;
  armFrom = null;
  if (arming) ctx.selTransitionId = null;
  rerender();
}

/** Escape / background-click cancel — a no-op if not currently arming. */
export function cancelArm(): void { arming = false; armFrom = null; }

export function onStatePointerDown(
  ev: PointerEvent, svg: SVGSVGElement, sm: StateMachine, st: SMState, redraw: () => void,
): void {
  if (ev.button !== 0) return; // middle click bubbles up to the svg's pan handler
  ev.stopPropagation();
  ev.preventDefault();

  if (arming) {
    if (!armFrom) { armFrom = st.id; rerender(); }
    else { createTransition(sm, armFrom, st.id); }
    return;
  }

  const start = svgPoint(svg, ev);
  // A grab in the right-edge port band starts a drag-to-connect; anywhere else moves.
  const box = stateBox(st);
  const nearPort =
    start.x >= box.x + box.w - CONNECT_BAND && start.x <= box.x + box.w + CONNECT_BAND &&
    start.y >= box.y - CONNECT_BAND && start.y <= box.y + box.h + CONNECT_BAND;
  if (nearPort) { startConnectDrag(ev, svg, sm, st, redraw); return; }

  const orig = { x: st.x ?? 0, y: st.y ?? 0 };
  let moved = false;
  let pendingCheckpoint = true;
  try { svg.setPointerCapture(ev.pointerId); } catch { /* synthetic/pen events */ }

  const move = (e: PointerEvent) => {
    const p = svgPoint(svg, e);
    if (!moved && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
    if (pendingCheckpoint) { checkpoint(); pendingCheckpoint = false; }
    moved = true;
    st.x = round1(orig.x + (p.x - start.x));
    st.y = round1(orig.y + (p.y - start.y));
    redraw();
  };
  const up = () => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
    if (moved) {
      notify(); // persist the new position
    } else {
      ctx.selStateId = st.id;
      ctx.selTransitionId = null;
      rerender();
    }
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
}

/**
 * Drag-to-connect: from the source box's port, draw a live preview arrow to the pointer
 * and, if released over ANOTHER box, create the transition (checkpointed via
 * createTransition). Released over empty space or back on the source cancels. Runs on the
 * svg (pointer-captured) so it survives the pointer leaving the source box.
 */
function startConnectDrag(
  ev: PointerEvent, svg: SVGSVGElement, sm: StateMachine, st: SMState, redraw: () => void,
): void {
  const box = stateBox(st);
  const from = { x: box.x + box.w, y: box.y + box.h / 2 }; // the source port
  try { svg.setPointerCapture(ev.pointerId); } catch { /* synthetic/pen events */ }

  const preview = elNS('path', 'sm-arrow sm-arrow-preview');
  preview.setAttribute('marker-end', 'url(#sm-arrowhead)');
  svg.appendChild(preview);

  const highlight = (id: string | null) => {
    for (const r of Array.from(svg.querySelectorAll<SVGRectElement>('.sm-state'))) {
      const rid = r.getAttribute('data-state-id');
      r.classList.toggle('sm-connect-target', !!id && rid === id && id !== st.id);
    }
  };

  const move = (e: PointerEvent) => {
    const p = svgPoint(svg, e);
    preview.setAttribute('d', `M ${from.x} ${from.y} L ${p.x} ${p.y}`);
    highlight(stateAtPoint(sm, p));
  };
  const up = (e: PointerEvent) => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
    preview.remove();
    const target = stateAtPoint(sm, svgPoint(svg, e));
    if (target && target !== st.id) {
      createTransition(sm, st.id, target); // checkpoints + full rerender (clears highlight)
    } else {
      redraw(); // no target — repaint to drop the highlight/preview
    }
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
}

/** The id of the topmost state box under a graph-space point, or null. */
function stateAtPoint(sm: StateMachine, p: { x: number; y: number }): string | null {
  for (let i = sm.states.length - 1; i >= 0; i--) {
    const b = stateBox(sm.states[i]);
    if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return sm.states[i].id;
  }
  return null;
}

function createTransition(sm: StateMachine, fromId: string, toId: string): void {
  arming = false;
  armFrom = null;
  checkpoint();
  const tr: SMTransition = { id: freshId('tr'), fromId, toId, durationMs: 0, conditions: [] };
  sm.transitions.push(tr);
  ctx.selTransitionId = tr.id;
  ctx.selStateId = null;
  notify();
}

export function deleteState(sm: StateMachine, st: SMState): void {
  // Only animation states are deletable — entry/any/exit are mandatory (Rive rejects a
  // layer missing any of the three as corrupt).
  if (st.kind !== 'animation') return;
  checkpoint();
  sm.states = sm.states.filter((s) => s !== st);
  sm.transitions = sm.transitions.filter((t) => t.fromId !== st.id && t.toId !== st.id);
  if (ctx.selStateId === st.id) ctx.selStateId = null;
  notify();
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * The draggable state graph canvas: builds the graph bar (new-state/transition/fit
 * controls) and draws node boxes + transition arrows. Pointer gestures (drag-to-move,
 * drag-to-connect, click-click arming) live in `./graphInteract`; viewport math in
 * `./graphCamera`. Sits above both plus `./preview` (drawState reads live-preview
 * highlighting) and `./state` (shared ctx + DOM helpers); none of them are imported back
 * by this module.
 */

import { StateMachine, SMState, SMTransition, freshId, notify } from '../../core/model';
import { checkpoint } from '../../core/history';
import { ctx, rerender, div, button, hintBlock, option, span } from './state';
import { isPreviewing, liveStateId } from './preview';
import {
  SVG_NS, stateBox, getGraphViewRect, applyGraphViewRect, fitGraph, wireGraphCamera,
  elNS, svgText,
} from './graphCamera';
import {
  isArming, hasArmFrom, toggleArm, cancelArm, onStatePointerDown, deleteState,
} from './graphInteract';

export { deleteState } from './graphInteract';

/**
 * Seed positions for any state that lacks them (cosmetic; persisted silently via
 * autosave). Entry/any/exit are mandatory (model.ts's normalizeDoc guarantees them) but
 * an exit synthesized onto an OLD project on load arrives with no x/y — this seeds it to
 * the right of the animation column, mirroring the default `newStateMachine` gives a
 * freshly-minted exit.
 */
export function ensureLayout(sm: StateMachine): void {
  const entry = sm.states.find((s) => s.kind === 'entry');
  const any = sm.states.find((s) => s.kind === 'any');
  const exit = sm.states.find((s) => s.kind === 'exit');
  if (entry && !hasPos(entry)) { entry.x = 40; entry.y = 44; }
  if (any && !hasPos(any)) { any.x = 40; any.y = 128; }
  if (exit && !hasPos(exit)) { exit.x = 520; exit.y = 44; }
  const others = sm.states.filter((s) => s.kind !== 'entry' && s.kind !== 'any' && s.kind !== 'exit');
  let maxY = 20;
  for (const s of others) if (hasPos(s)) maxY = Math.max(maxY, s.y ?? 0);
  for (const s of others) {
    if (!hasPos(s)) {
      s.x = 300;
      maxY += 78;
      s.y = maxY;
    }
  }
}

const hasPos = (s: SMState): boolean => typeof s.x === 'number' && typeof s.y === 'number';

export function buildGraph(doc: { clips: { name: string }[] }, sm: StateMachine): HTMLElement {
  const wrap = div('sm-graph');
  let svgEl: SVGSVGElement | null = null; // assigned below; captured by the ⌂ button's closure

  const bar = div('sm-graph-bar');

  // Cluster: new-state creation — the clip dropdown and [+ state] on one row.
  const stateCluster = div('sm-cluster');
  const clipSel = document.createElement('select');
  clipSel.className = 'sm-clip-sel';
  clipSel.title = 'Clip for a new animation state';
  if (!doc.clips.length) {
    clipSel.appendChild(option('', '(no clips)'));
    clipSel.disabled = true;
  } else {
    for (const c of doc.clips) clipSel.appendChild(option(c.name, c.name));
  }
  const addState = button('+ state', () => {
    if (!doc.clips.length) return;
    checkpoint();
    const clipName = clipSel.value || doc.clips[0].name;
    const st: SMState = {
      id: freshId('state'), name: clipName, kind: 'animation', clipName,
    };
    sm.states.push(st);
    ctx.selStateId = st.id;
    ctx.selTransitionId = null;
    notify();
  });
  if (!doc.clips.length) { addState.disabled = true; addState.title = 'Create a clip first'; }
  stateCluster.appendChild(clipSel);
  stateCluster.appendChild(addState);
  bar.appendChild(stateCluster);

  // Cluster: transition creation. Two paths — drag from a state box's EDGE to another
  // box (the primary, discoverable gesture), or this armed click-click fallback.
  const transCluster = div('sm-cluster');
  const arming = isArming();
  const armBtn = button(
    arming ? (hasArmFrom() ? 'pick target…' : 'pick source…') : '+ transition',
    () => toggleArm(),
  );
  if (arming) armBtn.classList.add('active');
  armBtn.title = 'Connect two states: drag from a box edge to another box, or click the source then the target (Esc cancels)';
  transCluster.appendChild(armBtn);
  if (arming) transCluster.appendChild(span('sm-hint', 'Esc cancels'));
  bar.appendChild(transCluster);

  // Fit control, pushed to the end of the bar.
  const fitCluster = div('sm-cluster sm-cluster-end');
  const fitBtn = button('⌂', () => { if (svgEl) fitGraph(svgEl, sm); });
  fitBtn.title = 'Fit view to all states';
  fitCluster.appendChild(fitBtn);
  bar.appendChild(fitCluster);
  wrap.appendChild(bar);

  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('class', 'sm-svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svgEl = svg;
  wrap.appendChild(svg);

  applyGraphViewRect(svg, getGraphViewRect(sm)); // persisted rect, or a first-show fit
  wireGraphCamera(svg, sm);
  // Background pointerdown on empty canvas (left button only — middle is pan, handled by
  // wireGraphCamera and must never arm/select/deselect): cancel arming, else clear selection.
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.target !== svg || ev.button !== 0) return;
    if (isArming()) { cancelArm(); rerender(); return; }
    if (ctx.selStateId || ctx.selTransitionId) { ctx.selStateId = null; ctx.selTransitionId = null; rerender(); }
  });
  drawGraph(svg, sm);

  if (!sm.states.some((s) => s.kind === 'animation')) {
    wrap.appendChild(hintBlock('Add an animation state (+ state) and connect it from Entry.'));
  }
  return wrap;
}

/** Repaint graph CONTENT only — never touches the viewBox (pan/zoom survive redraws
 * triggered by box drags, arming clicks, or any other state/transition edit). */
function drawGraph(svg: SVGSVGElement, sm: StateMachine): void {
  const redraw = () => {
    svg.replaceChildren();
    svg.appendChild(arrowDefs());
    for (const tr of sm.transitions) drawTransition(svg, sm, tr);
    for (const st of sm.states) drawState(svg, sm, st, redraw);
  };
  redraw();
}

function arrowDefs(): SVGElement {
  const defs = elNS('defs');
  const mk = (id: string, cls: string) => {
    const m = elNS('marker');
    m.setAttribute('id', id);
    m.setAttribute('viewBox', '0 0 10 10');
    m.setAttribute('refX', '9');
    m.setAttribute('refY', '5');
    m.setAttribute('markerWidth', '7');
    m.setAttribute('markerHeight', '7');
    m.setAttribute('orient', 'auto-start-reverse');
    const p = elNS('path', cls);
    p.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    m.appendChild(p);
    return m;
  };
  defs.appendChild(mk('sm-arrowhead', 'sm-arrowhead'));
  defs.appendChild(mk('sm-arrowhead-sel', 'sm-arrowhead-sel'));
  return defs;
}

function drawState(svg: SVGSVGElement, sm: StateMachine, st: SMState, redraw: () => void): void {
  const box = stateBox(st);
  const g = elNS('g', 'sm-node');

  const rect = elNS('rect', `sm-state sm-state-${st.kind}`);
  rect.setAttribute('data-state-id', st.id);
  rect.setAttribute('x', String(box.x));
  rect.setAttribute('y', String(box.y));
  rect.setAttribute('width', String(box.w));
  rect.setAttribute('height', String(box.h));
  rect.setAttribute('rx', '9');
  if (st.id === ctx.selStateId) rect.classList.add('selected');
  if (isPreviewing(sm) && liveStateId() === st.id) rect.classList.add('sm-live');
  g.appendChild(rect);

  const cx = box.x + box.w / 2;
  if (st.kind === 'animation') {
    g.appendChild(svgText(cx, box.y + 21, st.name, 'sm-state-name'));
    g.appendChild(svgText(cx, box.y + 38, `▶ ${st.clipName ?? '—'}`, 'sm-state-clip'));
  } else {
    g.appendChild(svgText(cx, box.y + box.h / 2 - 3, glyphFor(st.kind), 'sm-state-glyph'));
    g.appendChild(svgText(cx, box.y + box.h / 2 + 13, st.name, 'sm-state-kindlabel'));
  }

  // Connection port on the right edge — a hover-revealed affordance hinting that you can
  // drag from here to another box to create a transition. Purely cosmetic (pointer-events
  // off); the real connect hit region is the right-edge band in onStatePointerDown.
  const port = elNS('circle', 'sm-port');
  port.setAttribute('cx', String(box.x + box.w));
  port.setAttribute('cy', String(box.y + box.h / 2));
  port.setAttribute('r', '5');
  g.appendChild(port);

  // ✕ delete affordance for removable states (entry/any/exit are mandatory — Rive
  // rejects a layer missing any of the three as corrupt).
  if (st.kind === 'animation') {
    const close = svgText(box.x + box.w - 10, box.y + 14, '✕', 'sm-node-close');
    close.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return; // middle click here must bubble to pan
      ev.stopPropagation();
      ev.preventDefault();
      deleteState(sm, st);
    });
    g.appendChild(close);
  }

  g.addEventListener('pointerdown', (ev) => onStatePointerDown(ev as PointerEvent, svg, sm, st, redraw));
  svg.appendChild(g);
}

function glyphFor(kind: string): string {
  return kind === 'entry' ? '⏻' : kind === 'any' ? '✳' : '⏹';
}

function drawTransition(svg: SVGSVGElement, sm: StateMachine, tr: SMTransition): void {
  const from = sm.states.find((s) => s.id === tr.fromId);
  const to = sm.states.find((s) => s.id === tr.toId);
  if (!from || !to) return;
  const fb = stateBox(from);
  const tb = stateBox(to);
  const c1 = { x: fb.x + fb.w / 2, y: fb.y + fb.h / 2 };
  const c2 = { x: tb.x + tb.w / 2, y: tb.y + tb.h / 2 };
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const len = Math.hypot(dx, dy) || 1;
  // A lone transition is drawn STRAIGHT. When its reverse (toId→fromId) also exists, each is
  // bowed perpendicular to ITS OWN from→to direction: the reverse arrow's direction is
  // flipped, so its perpendicular flips too and the pair automatically bows to OPPOSITE sides
  // (never overlapping). Crucially NO id-order sign is applied — that would re-flip the
  // reverse arrow and drop both onto the same side. `mid` at the midpoint ⇒ a straight line.
  const hasReverse = sm.transitions.some(
    (o) => o !== tr && o.fromId === tr.toId && o.toId === tr.fromId,
  );
  const bow = hasReverse ? 24 : 0;
  const nx = (-dy / len) * bow;
  const ny = (dx / len) * bow;
  const mid = { x: (c1.x + c2.x) / 2 + nx, y: (c1.y + c2.y) / 2 + ny };
  const p1 = edgePoint(fb, mid);
  const p2 = edgePoint(tb, mid);
  const d = `M ${p1.x} ${p1.y} Q ${mid.x} ${mid.y} ${p2.x} ${p2.y}`;
  const selected = tr.id === ctx.selTransitionId;

  const hit = elNS('path', 'sm-arrow-hit');
  hit.setAttribute('d', d);
  hit.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return; // middle click bubbles up to pan
    ev.stopPropagation();
    ctx.selTransitionId = tr.id;
    ctx.selStateId = null;
    rerender();
  });
  svg.appendChild(hit);

  const vis = elNS('path', 'sm-arrow' + (selected ? ' selected' : ''));
  vis.setAttribute('d', d);
  vis.setAttribute('marker-end', selected ? 'url(#sm-arrowhead-sel)' : 'url(#sm-arrowhead)');
  svg.appendChild(vis);

  if (tr.durationMs > 0) {
    svg.appendChild(svgText(mid.x, mid.y - 4, `${tr.durationMs}ms`, 'sm-arrow-label'));
  }
}

/** Where the segment from a box's center toward `to` crosses the box boundary. */
function edgePoint(
  box: { x: number; y: number; w: number; h: number }, to: { x: number; y: number },
): { x: number; y: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = to.x - cx;
  const dy = to.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = box.w / 2 + 2;
  const hh = box.h / 2 + 2;
  const scale = 1 / Math.max(Math.abs(dx) / hw, Math.abs(dy) / hh);
  return { x: cx + dx * scale, y: cy + dy * scale };
}

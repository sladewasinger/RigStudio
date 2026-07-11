/**
 * State-machine editor + live preview. Swaps into the timeline's lanes area exactly like
 * the curves editor does (a mutually-exclusive "logic" toggle), and owns everything the
 * feature needs so the view.ts monolith stays untouched save one hook (`setPoseSampler`).
 *
 * Layout: a header row (machine selector / +machine / rename / delete / ▶ preview + live
 * status) over a two-column body — LEFT a draggable graph canvas of states & transitions,
 * RIGHT a stack of Inputs, the selected transition/state Properties, and Listeners.
 *
 * PREVIEW builds a pure SMInstance (stateMachine.ts), ticks it with real rAF frame deltas,
 * and drives the rendered pose through view.setPoseSampler. While it runs the inputs list
 * becomes LIVE controls and canvas pointer events over artwork are consumed (selection/drag
 * suppressed) and routed to the machine's listeners. Preview is APP state — never serialized.
 */

import {
  state, notify, freshId, ancestorChain, partById,
  StateMachine, SMState, SMTransition, SMInput, SMCondition, SMListener, SMListenerAction,
  SMInputType, SMConditionOp,
  newStateMachine,
} from '../core/model';
import { checkpoint } from '../core/history';
import { renderPose, setPoseSampler } from '../view';
import { createSMInstance, SMInstance, SM_REST_STATE_ID } from '../core/stateMachine';

const SVG_NS = 'http://www.w3.org/2000/svg';

// ---- Editor selection & interaction state (module-level so it survives re-renders) ----

let host: HTMLElement | null = null;
let selMachineId: string | null = null;
let selStateId: string | null = null;
let selTransitionId: string | null = null;

// "Add transition" armed mode: arm → click a source box → click a target box → transition.
let arming = false;
let armFrom: string | null = null;

// Whether the logic view is the one currently on screen (gates the main.ts Delete/Escape hooks).
let logicVisible = false;

// ---- Preview (app state; never serialized) ----

interface Preview {
  machineId: string;
  instance: SMInstance;
  rafId: number;
  last: number;
  /** Live input values shown by the LIVE controls, so a rebuild mid-preview keeps them. */
  liveInputs: Map<string, boolean | number>;
}
let preview: Preview | null = null;
let previewCanvas: HTMLElement | null = null;

// =====================================================================================
// Entry point (called by the timeline when the logic view is shown)
// =====================================================================================

export function buildSMPanel(container: HTMLElement): void {
  host = container;
  logicVisible = true;
  container.innerHTML = '';
  container.classList.add('sm-editor');
  const doc = state.doc;
  if (!doc) {
    container.appendChild(hintBlock('Import an SVG to build a state machine.'));
    return;
  }
  if (!Array.isArray(doc.stateMachines)) doc.stateMachines = [];
  const machines = doc.stateMachines;

  let sm = machines.find((m) => m.id === selMachineId) ?? null;
  if (!sm && machines.length) {
    sm = machines[0];
    selMachineId = sm.id;
  }

  container.appendChild(buildHeader(machines, sm));

  if (!sm) {
    const empty = div('sm-empty');
    empty.appendChild(hintBlock('No state machines yet. Wire your clips into an interactive graph.'));
    empty.appendChild(button('+ machine', () => addMachine()));
    container.appendChild(empty);
    return;
  }

  ensureLayout(sm);

  const body = div('sm-body');
  body.appendChild(buildGraph(doc, sm));
  body.appendChild(buildSide(doc, sm));
  container.appendChild(body);
}

/** Timeline tells us when the logic view is NOT on screen (setup mode / toggled off / no doc). */
export function setLogicVisible(v: boolean): void {
  logicVisible = v;
}

// =====================================================================================
// Header
// =====================================================================================

function buildHeader(machines: StateMachine[], sm: StateMachine | null): HTMLElement {
  const header = div('sm-header');

  const sel = document.createElement('select');
  sel.title = 'Active state machine';
  if (!machines.length) {
    const o = option('', 'No machines');
    o.selected = true;
    sel.appendChild(o);
    sel.disabled = true;
  } else {
    for (const m of machines) {
      const o = option(m.id, m.name);
      if (m.id === sm?.id) o.selected = true;
      sel.appendChild(o);
    }
  }
  sel.onchange = () => {
    stopPreview();
    selMachineId = sel.value;
    selStateId = null;
    selTransitionId = null;
    arming = false;
    armFrom = null;
    rerender();
  };
  header.appendChild(sel);

  header.appendChild(button('+ machine', () => addMachine()));

  if (sm) {
    const nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.className = 'sm-name';
    nameIn.value = sm.name;
    nameIn.title = 'Machine name (edit to rename)';
    nameIn.onchange = () => {
      const v = nameIn.value.trim();
      if (!v || v === sm.name) return;
      checkpoint();
      sm.name = v;
      notify();
    };
    header.appendChild(nameIn);

    header.appendChild(button('delete machine', () => {
      stopPreview();
      checkpoint();
      const arr = state.doc!.stateMachines!;
      const i = arr.findIndex((m) => m.id === sm.id);
      if (i >= 0) arr.splice(i, 1);
      graphViewRects.delete(sm.id); // drop the now-dangling view state
      selMachineId = arr[0]?.id ?? null;
      selStateId = null;
      selTransitionId = null;
      notify();
    }));

    const active = isPreviewing(sm);
    const pv = button(active ? '■ stop' : '▶ preview', () => {
      if (isPreviewing(sm)) stopPreview();
      else startPreview(sm);
      rerender();
    });
    pv.className = 'sm-preview-btn';
    if (active) pv.classList.add('active');
    pv.title = 'Run the machine live and drive the canvas pose';
    header.appendChild(pv);

    if (active) {
      const status = div('sm-status');
      status.textContent = previewStatusText(sm);
      header.appendChild(status);
    }
  }

  return header;
}

function addMachine(): void {
  stopPreview();
  const doc = state.doc;
  if (!doc) return;
  if (!Array.isArray(doc.stateMachines)) doc.stateMachines = [];
  checkpoint();
  const m = newStateMachine(`machine_${doc.stateMachines.length + 1}`);
  doc.stateMachines.push(m);
  selMachineId = m.id;
  selStateId = null;
  selTransitionId = null;
  notify();
}

// =====================================================================================
// Graph canvas
// =====================================================================================

const ANIM_W = 128;
const ANIM_H = 52;
const NODE_W = 76;
const NODE_H = 44;

function stateBox(st: SMState): { x: number; y: number; w: number; h: number } {
  const w = st.kind === 'animation' ? ANIM_W : NODE_W;
  const h = st.kind === 'animation' ? ANIM_H : NODE_H;
  return { x: st.x ?? 0, y: st.y ?? 0, w, h };
}

/**
 * Seed positions for any state that lacks them (cosmetic; persisted silently via
 * autosave). Entry/any/exit are mandatory (model.ts's normalizeDoc guarantees them) but
 * an exit synthesized onto an OLD project on load arrives with no x/y — this seeds it to
 * the right of the animation column, mirroring the default `newStateMachine` gives a
 * freshly-minted exit.
 */
function ensureLayout(sm: StateMachine): void {
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

// ---- Graph pan & zoom (session view state — NOT persisted, NOT reset by rebuilds) ----
//
// Mirrors view.ts's canvas viewBox pattern (wheel = zoom at cursor, middle-drag = pan,
// clamped multiplicative zoom, no undo checkpoints) but keyed per machine id in a
// module-level map, since the panel rebuilds on every notify() and each machine should
// remember its own scroll position across machine switches and logic-view toggles.

interface GraphViewRect { x: number; y: number; w: number; h: number }

const graphViewRects = new Map<string, GraphViewRect>();
const GRAPH_FIT_PAD = 48;
const GRAPH_ZOOM_MIN = 0.2; // matches CLAUDE.md's 0.2x-5x range, relative to the fit view
const GRAPH_ZOOM_MAX = 5;

/** Bounding box of every state's box, in graph space. */
function graphContentBounds(sm: StateMachine): { minX: number; minY: number; maxX: number; maxY: number } {
  if (!sm.states.length) return { minX: 0, minY: 0, maxX: 480, maxY: 260 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of sm.states) {
    const b = stateBox(s);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { minX, minY, maxX, maxY };
}

/** The viewBox rect that frames every state box with padding — what the ⌂ button
 * restores and what a machine gets the first time it's ever shown. */
function fitGraphRect(sm: StateMachine): GraphViewRect {
  const b = graphContentBounds(sm);
  return {
    x: b.minX - GRAPH_FIT_PAD,
    y: b.minY - GRAPH_FIT_PAD,
    w: Math.max(1, b.maxX - b.minX) + GRAPH_FIT_PAD * 2,
    h: Math.max(1, b.maxY - b.minY) + GRAPH_FIT_PAD * 2,
  };
}

/** This machine's current view rect, fitting it once the first time it's shown. */
function getGraphViewRect(sm: StateMachine): GraphViewRect {
  let vr = graphViewRects.get(sm.id);
  if (!vr) {
    vr = fitGraphRect(sm);
    graphViewRects.set(sm.id, vr);
  }
  return vr;
}

function applyGraphViewRect(svg: SVGSVGElement, vr: GraphViewRect): void {
  svg.setAttribute('viewBox', `${vr.x} ${vr.y} ${vr.w} ${vr.h}`);
}

/** ⌂ button + first-show: recenter/refit on every current state box. */
function fitGraph(svg: SVGSVGElement, sm: StateMachine): void {
  const vr = fitGraphRect(sm);
  graphViewRects.set(sm.id, vr);
  applyGraphViewRect(svg, vr);
}

/**
 * Core viewBox zoom: scale around the graph-space point (px,py) by `factor` (>1 zooms
 * in), clamped to 0.2x-5x of the content-fit width — the same shape as view.ts's
 * zoomAround, but relative to this graph's own content bbox instead of doc.viewBox.
 */
function zoomGraphAround(svg: SVGSVGElement, sm: StateMachine, px: number, py: number, factor: number): void {
  const vr = getGraphViewRect(sm);
  const fitW = fitGraphRect(sm).w;
  const minW = fitW / GRAPH_ZOOM_MAX;
  const maxW = fitW / GRAPH_ZOOM_MIN;
  const newW = Math.min(maxW, Math.max(minW, vr.w / factor));
  const applied = vr.w / newW;
  vr.x = px - (px - vr.x) / applied;
  vr.y = py - (py - vr.y) / applied;
  vr.w = newW;
  vr.h = vr.h / applied;
  applyGraphViewRect(svg, vr);
}

/** Middle-button drag pan (navigation, not editing — no checkpoints). */
function startGraphPan(svg: SVGSVGElement, sm: StateMachine, ev: PointerEvent): void {
  const vr = getGraphViewRect(sm);
  const startClient = { x: ev.clientX, y: ev.clientY };
  const startRect = { ...vr };
  svg.style.cursor = 'grabbing';
  try { svg.setPointerCapture(ev.pointerId); } catch { /* synthetic/pen events */ }

  const move = (e: PointerEvent) => {
    const ctm = svg.getScreenCTM();
    const scale = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
    vr.x = startRect.x - (e.clientX - startClient.x) / scale;
    vr.y = startRect.y - (e.clientY - startClient.y) / scale;
    applyGraphViewRect(svg, vr);
  };
  const up = () => {
    svg.removeEventListener('pointermove', move);
    svg.removeEventListener('pointerup', up);
    svg.style.cursor = '';
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
}

/** Wired exactly once per svg element (buildGraph creates a fresh one on every rebuild). */
function wireGraphInteractions(svg: SVGSVGElement, sm: StateMachine): void {
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault(); // never scroll the timeline panel the graph sits in
    const p = svgPoint(svg, ev);
    const factor = Math.pow(1.0015, -ev.deltaY);
    zoomGraphAround(svg, sm, p.x, p.y, factor);
  }, { passive: false });

  svg.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 1) return;
    ev.preventDefault(); // no middle-click autoscroll
    startGraphPan(svg, sm, ev);
  });

  // Background pointerdown on empty canvas (left button only — middle is pan, handled
  // above and must never arm/select/deselect): cancel arming, else clear selection.
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.target !== svg || ev.button !== 0) return;
    if (arming) { arming = false; armFrom = null; rerender(); return; }
    if (selStateId || selTransitionId) { selStateId = null; selTransitionId = null; rerender(); }
  });
}

function buildGraph(doc: { clips: { name: string }[] }, sm: StateMachine): HTMLElement {
  const wrap = div('sm-graph');
  let svgEl: SVGSVGElement | null = null; // assigned below; captured by the ⌂ button's closure

  const bar = div('sm-graph-bar');
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
      id: freshId('state'), name: clipName, kind: 'animation', clipName, loop: true,
    };
    sm.states.push(st);
    selStateId = st.id;
    selTransitionId = null;
    notify();
  });
  if (!doc.clips.length) { addState.disabled = true; addState.title = 'Create a clip first'; }
  bar.appendChild(addState);
  bar.appendChild(clipSel);

  const armBtn = button(
    arming ? (armFrom ? 'pick target…' : 'pick source…') : '+ transition',
    () => {
      arming = !arming;
      armFrom = null;
      if (arming) selTransitionId = null;
      rerender();
    },
  );
  if (arming) armBtn.classList.add('active');
  armBtn.title = 'Connect two states: click the source box, then the target (Esc cancels)';
  bar.appendChild(armBtn);
  if (arming) bar.appendChild(span('sm-hint', 'Esc cancels'));

  const fitBtn = button('⌂', () => { if (svgEl) fitGraph(svgEl, sm); });
  fitBtn.title = 'Fit view to all states';
  bar.appendChild(fitBtn);
  wrap.appendChild(bar);

  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('class', 'sm-svg');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svgEl = svg;
  wrap.appendChild(svg);

  applyGraphViewRect(svg, getGraphViewRect(sm)); // persisted rect, or a first-show fit
  wireGraphInteractions(svg, sm);
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
  if (st.id === selStateId) rect.classList.add('selected');
  if (preview && preview.machineId === sm.id && liveStateId() === st.id) rect.classList.add('sm-live');
  g.appendChild(rect);

  const cx = box.x + box.w / 2;
  if (st.kind === 'animation') {
    g.appendChild(svgText(cx, box.y + 21, st.name, 'sm-state-name'));
    g.appendChild(svgText(cx, box.y + 38, `▶ ${st.clipName ?? '—'}`, 'sm-state-clip'));
  } else {
    g.appendChild(svgText(cx, box.y + box.h / 2 - 3, glyphFor(st.kind), 'sm-state-glyph'));
    g.appendChild(svgText(cx, box.y + box.h / 2 + 13, st.name, 'sm-state-kindlabel'));
  }

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

function onStatePointerDown(
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
      selStateId = st.id;
      selTransitionId = null;
      rerender();
    }
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', up);
}

function createTransition(sm: StateMachine, fromId: string, toId: string): void {
  arming = false;
  armFrom = null;
  checkpoint();
  const tr: SMTransition = { id: freshId('tr'), fromId, toId, durationMs: 0, conditions: [] };
  sm.transitions.push(tr);
  selTransitionId = tr.id;
  selStateId = null;
  notify();
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
  // Perpendicular bow, sign keyed on id order so A→B and B→A arc to opposite sides.
  const side = tr.fromId < tr.toId ? 1 : -1;
  const nx = (-dy / len) * 26 * side;
  const ny = (dx / len) * 26 * side;
  const mid = { x: (c1.x + c2.x) / 2 + nx, y: (c1.y + c2.y) / 2 + ny };
  const p1 = edgePoint(fb, mid);
  const p2 = edgePoint(tb, mid);
  const d = `M ${p1.x} ${p1.y} Q ${mid.x} ${mid.y} ${p2.x} ${p2.y}`;
  const selected = tr.id === selTransitionId;

  const hit = elNS('path', 'sm-arrow-hit');
  hit.setAttribute('d', d);
  hit.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return; // middle click bubbles up to pan
    ev.stopPropagation();
    selTransitionId = tr.id;
    selStateId = null;
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

function deleteState(sm: StateMachine, st: SMState): void {
  // Only animation states are deletable — entry/any/exit are mandatory (Rive rejects a
  // layer missing any of the three as corrupt).
  if (st.kind !== 'animation') return;
  checkpoint();
  sm.states = sm.states.filter((s) => s !== st);
  sm.transitions = sm.transitions.filter((t) => t.fromId !== st.id && t.toId !== st.id);
  if (selStateId === st.id) selStateId = null;
  notify();
}

// =====================================================================================
// Right column: inputs / properties / listeners
// =====================================================================================

function buildSide(doc: { parts: { id: string; label: string }[]; clips: { name: string }[] }, sm: StateMachine): HTMLElement {
  const side = div('sm-side');
  side.appendChild(buildInputs(sm));
  side.appendChild(buildProps(doc, sm));
  side.appendChild(buildListeners(doc, sm));
  return side;
}

// ---- Inputs ----

function buildInputs(sm: StateMachine): HTMLElement {
  const sec = section('Inputs');
  for (const inp of sm.inputs) sec.appendChild(inputRow(sm, inp));
  if (!sm.inputs.length) sec.appendChild(hintBlock('No inputs. Add bool / number / trigger controls.'));
  const add = div('sm-add-row');
  add.appendChild(button('+ bool', () => addInput(sm, 'bool')));
  add.appendChild(button('+ number', () => addInput(sm, 'number')));
  add.appendChild(button('+ trigger', () => addInput(sm, 'trigger')));
  sec.appendChild(add);
  return sec;
}

function inputRow(sm: StateMachine, inp: SMInput): HTMLElement {
  const row = div('sm-row');
  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'sm-inp-name';
  name.value = inp.name;
  name.title = 'Input name';
  name.onchange = () => {
    const v = name.value.trim();
    if (!v || v === inp.name) return;
    checkpoint();
    inp.name = v;
    notify();
  };
  row.appendChild(name);
  row.appendChild(span('sm-badge', inp.type));
  row.appendChild(defaultOrLiveControl(sm, inp));
  row.appendChild(iconBtn('✕', 'Remove input', () => removeInput(sm, inp)));
  return row;
}

/** Editing the input default, unless preview is live — then it drives the running instance. */
function defaultOrLiveControl(sm: StateMachine, inp: SMInput): HTMLElement {
  const live = isPreviewing(sm);
  if (inp.type === 'bool') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    if (live) {
      cb.checked = boolLive(inp);
      cb.title = 'Live: toggle the input';
      cb.onchange = () => setLive(inp, cb.checked);
    } else {
      cb.checked = inp.default === true;
      cb.onchange = () => { checkpoint(); inp.default = cb.checked; notify(); };
    }
    return cb;
  }
  if (inp.type === 'number') {
    const n = document.createElement('input');
    n.type = 'number';
    n.step = 'any';
    n.className = 'sm-num';
    if (live) {
      n.value = String(numLive(inp));
      n.title = 'Live: drive the input';
      n.oninput = () => setLive(inp, Number(n.value) || 0);
    } else {
      n.value = String(typeof inp.default === 'number' ? inp.default : 0);
      n.onchange = () => { checkpoint(); inp.default = Number(n.value) || 0; notify(); };
    }
    return n;
  }
  // trigger
  if (live) return button('fire', () => preview!.instance.fireTrigger(inp.name));
  return span('sm-trigger-note', '(fires)');
}

function addInput(sm: StateMachine, type: SMInputType): void {
  checkpoint();
  const inp: SMInput = {
    id: freshId('input'),
    name: uniqueInputName(sm, type),
    type,
    default: type === 'bool' ? false : type === 'number' ? 0 : undefined,
  };
  sm.inputs.push(inp);
  notify();
}

function removeInput(sm: StateMachine, inp: SMInput): void {
  checkpoint();
  sm.inputs = sm.inputs.filter((i) => i !== inp);
  for (const tr of sm.transitions) tr.conditions = tr.conditions.filter((c) => c.inputId !== inp.id);
  for (const ls of sm.listeners) ls.actions = ls.actions.filter((a) => a.inputId !== inp.id);
  notify();
}

// ---- Properties (selected transition OR state) ----

function buildProps(doc: { clips: { name: string }[] }, sm: StateMachine): HTMLElement {
  const sec = section('Properties');
  const tr = sm.transitions.find((t) => t.id === selTransitionId);
  const st = sm.states.find((s) => s.id === selStateId);
  if (tr) buildTransitionProps(sec, sm, tr);
  else if (st) buildStateProps(sec, doc, sm, st);
  else sec.appendChild(hintBlock('Select a state or transition to edit it.'));
  return sec;
}

function buildTransitionProps(sec: HTMLElement, sm: StateMachine, tr: SMTransition): void {
  const head = div('sm-prop-head');
  head.appendChild(span('sm-prop-title', `${stateName(sm, tr.fromId)} → ${stateName(sm, tr.toId)}`));
  head.appendChild(button('delete', () => {
    checkpoint();
    sm.transitions = sm.transitions.filter((t) => t !== tr);
    selTransitionId = null;
    notify();
  }));
  sec.appendChild(head);

  const durRow = labeledRow('blend (ms)');
  durRow.appendChild(numberInput(tr.durationMs, (v) => {
    checkpoint();
    tr.durationMs = Math.max(0, v);
    notify();
  }));
  sec.appendChild(durRow);

  sec.appendChild(span('sm-subhead', 'Conditions (all must pass)'));
  if (!tr.conditions.length) sec.appendChild(hintBlock('Unconditional — fires as soon as it is reached.'));
  tr.conditions.forEach((c, i) => sec.appendChild(conditionRow(sm, tr, c, i)));

  const addC = button('+ condition', () => {
    if (!sm.inputs.length) return;
    checkpoint();
    tr.conditions.push(defaultCondition(sm.inputs[0]));
    notify();
  });
  if (!sm.inputs.length) { addC.disabled = true; addC.title = 'Add an input first'; }
  sec.appendChild(addC);
}

function conditionRow(sm: StateMachine, tr: SMTransition, c: SMCondition, i: number): HTMLElement {
  const row = div('sm-row');
  const inSel = document.createElement('select');
  for (const inp of sm.inputs) {
    const o = option(inp.id, inp.name);
    if (inp.id === c.inputId) o.selected = true;
    inSel.appendChild(o);
  }
  inSel.onchange = () => {
    const inp = sm.inputs.find((x) => x.id === inSel.value);
    if (!inp) return;
    checkpoint();
    // Reset stale op/value when the input type changes (e.g. bool → trigger).
    delete c.op;
    delete c.value;
    Object.assign(c, defaultCondition(inp));
    notify();
  };
  row.appendChild(inSel);

  const type = sm.inputs.find((x) => x.id === c.inputId)?.type ?? 'bool';
  if (type === 'trigger') {
    row.appendChild(span('sm-trigger-note', 'when fired'));
  } else {
    const opSel = document.createElement('select');
    const ops: SMConditionOp[] = type === 'bool' ? ['==', '!='] : ['==', '!=', '<', '<=', '>', '>='];
    for (const op of ops) {
      const o = option(op, op);
      if ((c.op ?? '==') === op) o.selected = true;
      opSel.appendChild(o);
    }
    opSel.onchange = () => { checkpoint(); c.op = opSel.value as SMConditionOp; notify(); };
    row.appendChild(opSel);

    if (type === 'bool') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = c.value === true;
      cb.onchange = () => { checkpoint(); c.value = cb.checked; notify(); };
      row.appendChild(cb);
    } else {
      row.appendChild(numberInput(typeof c.value === 'number' ? c.value : 0, (v) => {
        checkpoint();
        c.value = v;
        notify();
      }));
    }
  }
  row.appendChild(iconBtn('✕', 'Remove condition', () => {
    checkpoint();
    tr.conditions.splice(i, 1);
    notify();
  }));
  return row;
}

function defaultCondition(inp: SMInput): SMCondition {
  if (inp.type === 'trigger') return { inputId: inp.id };
  if (inp.type === 'bool') return { inputId: inp.id, op: '==', value: true };
  return { inputId: inp.id, op: '>', value: 0 };
}

function buildStateProps(
  sec: HTMLElement, doc: { clips: { name: string }[] }, sm: StateMachine, st: SMState,
): void {
  const head = div('sm-prop-head');
  head.appendChild(span('sm-prop-title', `${cap(st.kind)} state`));
  if (st.kind === 'animation') {
    head.appendChild(button('delete', () => deleteState(sm, st)));
  }
  sec.appendChild(head);

  if (st.kind !== 'animation') {
    sec.appendChild(hintBlock(kindHint(st.kind)));
    return;
  }

  const nameRow = labeledRow('name');
  nameRow.appendChild(textInput(st.name, (v) => { checkpoint(); st.name = v || st.name; notify(); }));
  sec.appendChild(nameRow);

  const clipRow = labeledRow('clip');
  const clipSel = document.createElement('select');
  if (!doc.clips.length) clipSel.appendChild(option('', '(no clips)'));
  for (const cl of doc.clips) {
    const o = option(cl.name, cl.name);
    if (cl.name === st.clipName) o.selected = true;
    clipSel.appendChild(o);
  }
  clipSel.onchange = () => { checkpoint(); st.clipName = clipSel.value; notify(); };
  clipRow.appendChild(clipSel);
  sec.appendChild(clipRow);

  const loopRow = labeledRow('loop');
  const loop = document.createElement('input');
  loop.type = 'checkbox';
  loop.checked = st.loop !== false;
  loop.onchange = () => { checkpoint(); st.loop = loop.checked; notify(); };
  loopRow.appendChild(loop);
  sec.appendChild(loopRow);
}

function kindHint(kind: string): string {
  if (kind === 'entry') return 'Start node — its outgoing transition picks the first state.';
  if (kind === 'any') return 'Transitions from here may fire from any state.';
  return 'Exit ends the machine and freezes the last pose.';
}

// ---- Listeners ----

function buildListeners(
  doc: { parts: { id: string; label: string }[] }, sm: StateMachine,
): HTMLElement {
  const sec = section('Listeners');
  for (const ls of sm.listeners) sec.appendChild(listenerRow(doc, sm, ls));
  if (!sm.listeners.length) sec.appendChild(hintBlock('No listeners. Map a click/hover on a part to an input.'));
  const add = div('sm-add-row');
  const addBtn = button('+ listener', () => addListener(doc, sm, null));
  if (!doc.parts.length) { addBtn.disabled = true; addBtn.title = 'Import a rig first'; }
  add.appendChild(addBtn);
  const useSel = button('use selected part', () => {
    if (state.selectedPartId) addListener(doc, sm, state.selectedPartId);
  });
  useSel.title = 'Add a listener on the part selected on the canvas';
  add.appendChild(useSel);
  sec.appendChild(add);
  return sec;
}

function listenerRow(
  doc: { parts: { id: string; label: string }[] }, sm: StateMachine, ls: SMListener,
): HTMLElement {
  const wrap = div('sm-listener');
  const top = div('sm-row');

  const partSel = document.createElement('select');
  for (const p of doc.parts) {
    const o = option(p.id, p.label);
    if (p.id === ls.targetPartId) o.selected = true;
    partSel.appendChild(o);
  }
  partSel.onchange = () => { checkpoint(); ls.targetPartId = partSel.value; notify(); };
  top.appendChild(partSel);

  const evSel = document.createElement('select');
  for (const e of ['down', 'up', 'enter', 'exit'] as const) {
    const o = option(e, e);
    if (e === ls.event) o.selected = true;
    evSel.appendChild(o);
  }
  evSel.onchange = () => { checkpoint(); ls.event = evSel.value as SMListener['event']; notify(); };
  top.appendChild(evSel);

  top.appendChild(iconBtn('✕', 'Remove listener', () => {
    checkpoint();
    sm.listeners = sm.listeners.filter((l) => l !== ls);
    notify();
  }));
  wrap.appendChild(top);

  ls.actions.forEach((a, i) => wrap.appendChild(actionRow(sm, ls, a, i)));
  const addA = button('+ action', () => {
    if (!sm.inputs.length) return;
    checkpoint();
    ls.actions.push(defaultAction(sm.inputs[0]));
    notify();
  });
  addA.className = 'sm-add-action';
  if (!sm.inputs.length) { addA.disabled = true; addA.title = 'Add an input first'; }
  wrap.appendChild(addA);
  return wrap;
}

function actionRow(sm: StateMachine, ls: SMListener, a: SMListenerAction, i: number): HTMLElement {
  const row = div('sm-row sm-action');
  const inSel = document.createElement('select');
  for (const inp of sm.inputs) {
    const o = option(inp.id, inp.name);
    if (inp.id === a.inputId) o.selected = true;
    inSel.appendChild(o);
  }
  inSel.onchange = () => {
    const inp = sm.inputs.find((x) => x.id === inSel.value);
    if (!inp) return;
    checkpoint();
    // Reset stale value when the input type changes (e.g. setBool → fireTrigger).
    delete a.value;
    Object.assign(a, defaultAction(inp));
    notify();
  };
  row.appendChild(inSel);
  row.appendChild(span('sm-badge', actionLabel(a.type)));

  const type = sm.inputs.find((x) => x.id === a.inputId)?.type ?? 'bool';
  if (type === 'bool') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = a.value === true;
    cb.onchange = () => { checkpoint(); a.value = cb.checked; notify(); };
    row.appendChild(cb);
  } else if (type === 'number') {
    row.appendChild(numberInput(typeof a.value === 'number' ? a.value : 0, (v) => {
      checkpoint();
      a.value = v;
      notify();
    }));
  }
  row.appendChild(iconBtn('✕', 'Remove action', () => {
    checkpoint();
    ls.actions.splice(i, 1);
    notify();
  }));
  return row;
}

function addListener(
  doc: { parts: { id: string; label: string }[] }, sm: StateMachine, partId: string | null,
): void {
  const target = partId ?? doc.parts[0]?.id;
  if (!target) return;
  checkpoint();
  sm.listeners.push({ id: freshId('listener'), targetPartId: target, event: 'down', actions: [] });
  notify();
}

function defaultAction(inp: SMInput): SMListenerAction {
  if (inp.type === 'bool') return { inputId: inp.id, type: 'setBool', value: true };
  if (inp.type === 'number') return { inputId: inp.id, type: 'setNumber', value: 0 };
  return { inputId: inp.id, type: 'fireTrigger' };
}

const actionLabel = (t: SMListenerAction['type']): string =>
  t === 'setBool' ? 'set' : t === 'setNumber' ? 'set' : 'fire';

// =====================================================================================
// Preview: instance + rAF loop + canvas listener dispatch
// =====================================================================================

function isPreviewing(sm: StateMachine): boolean {
  return !!preview && preview.machineId === sm.id;
}

function startPreview(sm: StateMachine): void {
  stopPreview();
  const doc = state.doc;
  if (!doc) return;
  const instance = createSMInstance(doc, sm);
  preview = { machineId: sm.id, instance, rafId: 0, last: performance.now(), liveInputs: new Map() };
  setPoseSampler((target, channel) => instance.channelValue(target, channel));
  installCanvasHooks();

  const tick = (now: number) => {
    if (!preview || preview.instance !== instance) return;
    const dt = now - preview.last;
    preview.last = now;
    instance.advance(dt);
    renderPose();
    updateStatusReadout();
    preview.rafId = requestAnimationFrame(tick);
  };
  // Draw immediately (headless environments may never produce frames), then loop.
  instance.advance(0);
  renderPose();
  updateStatusReadout();
  preview.rafId = requestAnimationFrame(tick);
}

export function stopPreview(): void {
  if (!preview) return;
  cancelAnimationFrame(preview.rafId);
  preview = null;
  removeCanvasHooks();
  setPoseSampler(null); // restores normal sampling and repaints
}

function boolLive(inp: SMInput): boolean {
  const v = preview?.liveInputs.get(inp.id);
  return v === undefined ? inp.default === true : v === true;
}

function numLive(inp: SMInput): number {
  const v = preview?.liveInputs.get(inp.id);
  if (typeof v === 'number') return v;
  return typeof inp.default === 'number' ? inp.default : 0;
}

function setLive(inp: SMInput, value: boolean | number): void {
  if (!preview) return;
  preview.liveInputs.set(inp.id, value);
  preview.instance.setInput(inp.name, value);
}

function liveStateId(): string {
  return preview ? preview.instance.status().stateId : '';
}

function previewStatusText(sm: StateMachine): string {
  if (!preview) return '';
  const s = preview.instance.status();
  let txt = `▶ ${stateName(sm, s.stateId)}`;
  if (s.blend) txt += ` ⇢ ${Math.round(s.blend.progress * 100)}%`;
  if (s.done) txt += ' · done';
  return txt;
}

function updateStatusReadout(): void {
  if (!preview || !host) return;
  const sm = state.doc?.stateMachines?.find((m) => m.id === preview!.machineId);
  const el = host.querySelector<HTMLElement>('.sm-status');
  if (el && sm) el.textContent = previewStatusText(sm);
  // Keep the live state-box highlight in sync each frame without a full rebuild.
  const svg = host.querySelector<SVGSVGElement>('.sm-svg');
  if (!svg) return;
  const liveId = liveStateId();
  for (const rect of Array.from(svg.querySelectorAll<SVGRectElement>('.sm-state'))) {
    rect.classList.toggle('sm-live', rect.getAttribute('data-state-id') === liveId);
  }
}

// ---- Canvas pointer capture during preview ----

const EVENT_MAP: Record<string, SMListener['event']> = {
  pointerdown: 'down',
  pointerup: 'up',
  pointerover: 'enter',
  pointerout: 'exit',
};

function installCanvasHooks(): void {
  previewCanvas = document.getElementById('canvas');
  if (!previewCanvas) return;
  for (const type of Object.keys(EVENT_MAP)) {
    previewCanvas.addEventListener(type, onPreviewPointer, true);
  }
}

function removeCanvasHooks(): void {
  if (!previewCanvas) return;
  for (const type of Object.keys(EVENT_MAP)) {
    previewCanvas.removeEventListener(type, onPreviewPointer, true);
  }
  previewCanvas = null;
}

function onPreviewPointer(ev: Event): void {
  if (!preview) return;
  const pe = ev as PointerEvent;
  // Capture-phase on #canvas (an ancestor of the svg): stop here so view.ts's selection/
  // drag handlers on the svg never see it — the canvas is inert while previewing.
  ev.stopPropagation();
  const mapped = EVENT_MAP[ev.type];
  if (!mapped) return;
  dispatchToListeners(pe.clientX, pe.clientY, mapped);
}

function dispatchToListeners(clientX: number, clientY: number, event: SMListener['event']): void {
  if (!preview) return;
  const doc = state.doc;
  const sm = doc?.stateMachines?.find((m) => m.id === preview!.machineId);
  if (!doc || !sm) return;
  const partId = hitPartId(clientX, clientY);
  if (!partId) return;
  const part = partById(partId);
  if (!part) return;
  // A listener on a group/ancestor also fires for events on its children.
  const chain = new Set<string>([partId, ...ancestorChain(part).map((a) => a.id)]);
  for (const ls of sm.listeners) {
    if (ls.event !== event) continue;
    if (!chain.has(ls.targetPartId)) continue;
    for (const a of ls.actions) {
      const inp = sm.inputs.find((x) => x.id === a.inputId);
      if (!inp) continue;
      if (a.type === 'fireTrigger') preview.instance.fireTrigger(inp.name);
      else if (a.type === 'setBool') preview.instance.setInput(inp.name, a.value === true);
      else preview.instance.setInput(inp.name, typeof a.value === 'number' ? a.value : 0);
    }
  }
}

function hitPartId(clientX: number, clientY: number): string | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const partEl = (el as Element).closest?.('[data-part-id]') as HTMLElement | null;
    if (partEl?.dataset.partId) return partEl.dataset.partId;
  }
  return null;
}

// =====================================================================================
// main.ts key hooks (Delete / Escape) — only act while the logic view is on screen
// =====================================================================================

export function smHandleEscape(): boolean {
  if (arming) { arming = false; armFrom = null; rerender(); return true; }
  if (preview) { stopPreview(); rerender(); return true; }
  return false;
}

export function smHandleDelete(): boolean {
  if (!logicVisible) return false;
  const sm = state.doc?.stateMachines?.find((m) => m.id === selMachineId);
  if (!sm) return false;
  if (selTransitionId) {
    const tr = sm.transitions.find((t) => t.id === selTransitionId);
    if (tr) {
      checkpoint();
      sm.transitions = sm.transitions.filter((t) => t !== tr);
      selTransitionId = null;
      notify();
      return true;
    }
  }
  if (selStateId) {
    const st = sm.states.find((s) => s.id === selStateId);
    if (st && st.kind === 'animation') {
      deleteState(sm, st);
      return true;
    }
  }
  return false;
}

// =====================================================================================
// Small DOM/util helpers
// =====================================================================================

/** Re-render just the panel (preview keeps running — the rAF loop holds its own state). */
function rerender(): void {
  if (host) buildSMPanel(host);
}

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function span(className: string, text: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

function iconBtn(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = button(glyph, onClick);
  b.className = 'sm-icon-btn';
  b.title = title;
  return b;
}

function section(title: string): HTMLElement {
  const sec = div('sm-section');
  sec.appendChild(span('sm-section-title', title));
  return sec;
}

function labeledRow(label: string): HTMLElement {
  const row = div('sm-labeled');
  row.appendChild(span('sm-label', label));
  return row;
}

function hintBlock(text: string): HTMLElement {
  return span('sm-hint', text);
}

function numberInput(value: number, onChange: (v: number) => void): HTMLInputElement {
  const n = document.createElement('input');
  n.type = 'number';
  n.step = 'any';
  n.className = 'sm-num';
  n.value = String(value);
  n.onchange = () => onChange(Number(n.value) || 0);
  return n;
}

function textInput(value: string, onChange: (v: string) => void): HTMLInputElement {
  const t = document.createElement('input');
  t.type = 'text';
  t.value = value;
  t.onchange = () => onChange(t.value.trim());
  return t;
}

function option(value: string, label: string): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

function elNS(tag: string, className = ''): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  if (className) node.setAttribute('class', className);
  return node;
}

function svgText(x: number, y: number, content: string, className: string): SVGElement {
  const t = elNS('text', className);
  t.setAttribute('x', String(x));
  t.setAttribute('y', String(y));
  t.setAttribute('text-anchor', 'middle');
  t.textContent = content;
  return t;
}

/** Accepts any event carrying client coordinates (pointer, wheel) — not just PointerEvent. */
function svgPoint(svg: SVGSVGElement, ev: { clientX: number; clientY: number }): { x: number; y: number } {
  const ctm = svg.getScreenCTM();
  if (!ctm) {
    const r = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return {
      x: r.width ? ((ev.clientX - r.left) / r.width) * vb.width : 0,
      y: r.height ? ((ev.clientY - r.top) / r.height) * vb.height : 0,
    };
  }
  const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

function stateName(sm: StateMachine, id: string): string {
  if (id === SM_REST_STATE_ID) return 'rest';
  return sm.states.find((s) => s.id === id)?.name ?? '?';
}

function uniqueInputName(sm: StateMachine, type: SMInputType): string {
  const base = type === 'bool' ? 'flag' : type === 'number' ? 'value' : 'trigger';
  const used = new Set(sm.inputs.map((i) => i.name));
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base}${i}`)) i++;
  return `${base}${i}`;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// ---- Debug hook for verification (not serialized) ----
if (typeof window !== 'undefined') {
  (window as unknown as { __smPanel: unknown }).__smPanel = {
    previewStatus: () => (preview ? preview.instance.status() : null),
    isPreviewActive: () => !!preview,
    // Deterministic tick for headless verification (mirrors the rAF loop's per-frame work,
    // since requestAnimationFrame is throttled/paused in an unfocused automation tab).
    tick: (dtMs: number) => {
      if (!preview) return null;
      preview.instance.advance(dtMs);
      renderPose();
      updateStatusReadout();
      return preview.instance.status();
    },
    setPreviewInput: (name: string, v: boolean | number) => preview?.instance.setInput(name, v),
    firePreviewTrigger: (name: string) => preview?.instance.fireTrigger(name),
    selectState: (id: string | null) => { selStateId = id; selTransitionId = null; rerender(); },
    selectTransition: (id: string | null) => { selTransitionId = id; selStateId = null; rerender(); },
    selectMachine: (id: string | null) => { selMachineId = id; selStateId = null; selTransitionId = null; rerender(); },
    channelValue: (target: string, channel: 'rotate' | 'tx' | 'ty' | 'sx' | 'sy') =>
      preview ? preview.instance.channelValue(target, channel) : null,
  };
}

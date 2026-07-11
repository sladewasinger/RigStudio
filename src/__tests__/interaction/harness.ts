/// <reference types="vite/client" />
/**
 * Headless interaction-test harness (Vitest Browser Mode / headless Chromium).
 *
 * Boots the REAL app the way index.html does — injects the toolbar/layout body shell,
 * loads style.css, imports main.ts, loads the bundled sample — then exposes
 * realistic-gesture helpers built on the "Testing conventions" in ROADMAP.md:
 *
 *   - gestures target document.elementFromPoint(x,y), the TRUE hit target, so overlay
 *     occlusion bugs (pivot grabs, handles, gizmos) are caught;
 *   - a double-click is pointerdown/up x2 then dblclick, re-resolving the hit target
 *     between clicks (overlays appear!);
 *   - a drag includes intermediate pointermoves and emulates pointer capture by routing
 *     moves/up at the svg (the app's listeners live there; synthetic events don't honor
 *     real setPointerCapture retargeting);
 *   - probes re-query getScreenCTM every call and read geometry from the transform
 *     STRINGS — never a captured DOM ref (overlay rebuilds detach elements, whose CTM is
 *     garbage). Re-read state.doc after undo.
 *
 * Coordinates: helper inputs/outputs in CLIENT (viewport) pixels unless named *Doc.
 */

import '../../style.css';
import { expect } from 'vitest';
import { state, notify, selectPart as modelSelectPart } from '../../core/model';
import { renderPose } from '../../view';
import { Mat, matrixOfTransform } from '../../geometry/transforms';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The app body markup, copied verbatim from index.html (today's toolbar: no Compose
 * button, sample says "Load sample") minus the <script> — main.ts is imported below.
 * Kept in ONE place so a divergence from the real shell is a single edit.
 */
export const INDEX_BODY = `
  <header id="toolbar">
    <strong class="brand">Rig Studio</strong>
    <div class="tb-group" role="group" aria-label="File">
      <button id="btn-open" title="SVG artwork or a saved .rig.json project">Open…</button>
      <button id="btn-sample" title="Load the bundled sample character">Load sample</button>
      <button id="btn-save" title="Download the project as JSON">Save project</button>
    </div>
    <div class="tb-group" role="group" aria-label="History">
      <button id="btn-undo" title="Ctrl+Z" disabled>&#x21B6; Undo</button>
      <button id="btn-redo" title="Ctrl+Y" disabled>&#x21B7; Redo</button>
    </div>
    <span class="spacer"></span>
    <div class="tb-group" role="group" aria-label="Export">
      <button id="btn-export-lottie" title="Export the rig + clips as Lottie JSON">Export Lottie</button>
      <button id="btn-export-riv" title="Export the rig + all clips as a Rive .riv binary">Export Rive (.riv)</button>
    </div>
    <div id="mode-toggle" title="Tab toggles. Edit mode edits the character; Animate records keyframes.">
      <button id="btn-mode-setup">Edit</button>
      <button id="btn-mode-animate">Animate</button>
    </div>
    <button id="btn-help" class="icon-btn" title="Keyboard shortcuts (?)">?</button>
    <input id="file-input" type="file" accept=".svg,.json" hidden />
  </header>
  <main id="layout">
    <aside id="layers" aria-label="Layers"></aside>
    <div id="canvas-col">
      <div id="canvas-tools"></div>
      <section id="canvas" aria-label="Canvas"></section>
    </div>
    <aside id="inspector" aria-label="Inspector"></aside>
  </main>
  <div
    id="timeline-splitter"
    role="separator"
    aria-orientation="horizontal"
    aria-label="Resize timeline panel"
  ></div>
  <footer id="timeline" aria-label="Timeline"></footer>
`;

interface RigStudioHook {
  state: typeof state;
  loadProjectText: (text: string) => boolean;
  serializeDoc: (doc: NonNullable<typeof state.doc>) => string;
  setEditorMode: (mode: 'setup' | 'animate') => void;
}
function hook(): RigStudioHook {
  return (window as unknown as { __rigStudio: RigStudioHook }).__rigStudio;
}

let pristine = '';
let bootPromise: Promise<void> | null = null;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll `fn` until it returns truthy or the deadline passes (no arbitrary sleeps). */
export async function waitFor<T>(
  fn: () => T | null | undefined | false,
  { timeout = 8000, interval = 15, message = 'condition' } = {},
): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (performance.now() > deadline) throw new Error(`waitFor timed out: ${message}`);
    await sleep(interval);
  }
}

/**
 * Boot once per test file (browser-mode isolates each file in its own iframe, so this
 * runs fresh per file). localStorage.clear() BEFORE importing main so no autosave loads;
 * inject the shell; import main; click "Load sample"; wait for the doc + canvas; snapshot
 * the pristine project for beforeEach restores.
 */
export function bootRig(): Promise<void> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    localStorage.clear();
    document.body.innerHTML = INDEX_BODY;
    await import('../../main');
    (document.getElementById('btn-sample') as HTMLButtonElement).click();
    await waitFor(
      () => state.doc && document.getElementById('rig-svg') && partGroupCount() > 0,
      { message: 'sample loaded + canvas built' },
    );
    pristine = hook().serializeDoc(state.doc!);
  })();
  return bootPromise;
}

/** Restore the pristine sample + reset editor state. Call in beforeEach. */
export function resetRig(): void {
  state.editorMode = 'setup';
  state.mode = 'rig';
  state.tool = 'select';
  state.snapEnabled = false; // deterministic drags; the snapping scenario opts back in
  state.onionSkin = false;
  state.currentTime = 0;
  state.activeClipIndex = 0;
  state.playing = false;
  hook().loadProjectText(pristine); // rebuilds canvas, resets view + history, notifies
}

// ---- DOM accessors ----

export function svgEl(): SVGSVGElement {
  const el = document.getElementById('rig-svg');
  if (!el) throw new Error('#rig-svg not present');
  return el as unknown as SVGSVGElement;
}

/** The root artwork <g> (between #onion and #overlay) — carries the root pose transform. */
export function rootGEl(): SVGGElement {
  const svg = svgEl();
  for (const child of Array.from(svg.children)) {
    if (child.tagName === 'g' && child.id !== 'onion' && child.id !== 'overlay') {
      return child as SVGGElement;
    }
  }
  throw new Error('root <g> not found');
}

export function overlayEl(): SVGGElement {
  return document.getElementById('overlay') as unknown as SVGGElement;
}

function partGroupCount(): number {
  const svg = document.getElementById('rig-svg');
  return svg ? svg.querySelectorAll('[data-part-id]').length : 0;
}

export function partByLabel(label: string) {
  const part = state.doc?.parts.find((p) => p.label === label);
  if (!part) throw new Error(`no part labeled "${label}"`);
  return part;
}

export function partGroupEl(label: string): SVGGElement {
  const id = partByLabel(label).id;
  const g = svgEl().querySelector(`[data-part-id="${id}"]`);
  if (!g) throw new Error(`no canvas group for "${label}"`);
  return g as SVGGElement;
}

// ---- Coordinate probes (re-query the live CTM every call) ----

export function screenScale(): number {
  const m = svgEl().getScreenCTM();
  return m ? Math.hypot(m.a, m.b) : 1;
}

/** Root/document point → client (viewport) pixels, through the LIVE root-group CTM. */
export function docToClient(p: { x: number; y: number }): { x: number; y: number } {
  const m = rootGEl().getScreenCTM()!;
  const pt = svgEl().createSVGPoint();
  pt.x = p.x; pt.y = p.y;
  const s = pt.matrixTransform(m);
  return { x: s.x, y: s.y };
}

/** Client pixels → root/document point, through the LIVE root-group CTM. */
export function clientToDoc(x: number, y: number): { x: number; y: number } {
  const m = rootGEl().getScreenCTM()!;
  const pt = svgEl().createSVGPoint();
  pt.x = x; pt.y = y;
  const s = pt.matrixTransform(m.inverse());
  return { x: s.x, y: s.y };
}

/** The rendered transform of a part's group, parsed from the ATTRIBUTE string. */
export function partMatrix(label: string): Mat {
  return matrixOfTransform(partGroupEl(label).getAttribute('transform') ?? '');
}

/** Current viewBox as {x,y,w,h} (camera state). */
export function viewBox(): { x: number; y: number; w: number; h: number } {
  const [x, y, w, h] = (svgEl().getAttribute('viewBox') ?? '0 0 0 0').split(/\s+/).map(Number);
  return { x, y, w, h };
}

/** Count DOM matches (whole document — the marquee div lives outside #overlay). */
export function count(sel: string): number {
  return document.querySelectorAll(sel).length;
}

/** Count matches inside the overlay group only. */
export function overlayCount(sel: string): number {
  return overlayEl().querySelectorAll(sel).length;
}

export function expectClose(actual: number, expected: number, eps: number, msg = ''): void {
  expect(
    Math.abs(actual - expected),
    `${msg} expected ${actual} ≈ ${expected} (±${eps})`,
  ).toBeLessThanOrEqual(eps);
}

/** Client center of a DOM element's bounding rect. */
export function clientCenterOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/**
 * A CLIENT point that actually lands on a part's artwork (verified through
 * elementFromPoint), so drags press the true hit target. Samples points along the
 * part's own path outlines; falls back to the rendered bbox center.
 */
export function clientPointOnPart(label: string): { x: number; y: number } {
  const g = partGroupEl(label);
  const svg = svgEl();
  const paths = Array.from(g.querySelectorAll('path')) as SVGPathElement[];
  const fracs = [0.5, 0.25, 0.75, 0.1, 0.4, 0.6, 0.9, 0.15, 0.35, 0.65, 0.85];
  for (const pe of paths) {
    const len = pe.getTotalLength();
    if (!(len > 0)) continue;
    const m = pe.getScreenCTM();
    if (!m) continue;
    for (const f of fracs) {
      const lp = pe.getPointAtLength(len * f);
      const pt = svg.createSVGPoint();
      pt.x = lp.x; pt.y = lp.y;
      const s = pt.matrixTransform(m);
      const hit = document.elementFromPoint(s.x, s.y);
      if (hit?.closest('[data-part-id]') === g) return { x: s.x, y: s.y };
    }
  }
  const box = g.getBBox();
  return docToClient({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
}

// ---- Synthetic input ----

interface Mods { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean; }

function pointer(type: string, x: number, y: number, button: number, buttons: number, mods: Mods): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    clientX: x, clientY: y,
    button, buttons,
    pointerId: 1, pointerType: 'mouse', isPrimary: true,
    ctrlKey: !!mods.ctrlKey, shiftKey: !!mods.shiftKey,
    altKey: !!mods.altKey, metaKey: !!mods.metaKey,
  });
}

/** The element under a client point, or the svg as a floor (matches the app's listeners). */
export function hitAt(x: number, y: number): Element {
  return document.elementFromPoint(x, y) ?? (svgEl() as unknown as Element);
}

export interface DragOptions extends Mods {
  steps?: number;
  /** 0 = left (default), 1 = middle (pan). */
  button?: number;
  /** Runs after the final pointermove, before pointerup — inspect live-drag DOM here. */
  beforeUp?: () => void;
}

/**
 * A full drag: pointerdown on the true hit target at `from`, >=4 intermediate moves, then
 * pointerup. Moves/up dispatch at the svg (pointer-capture emulation). All in CLIENT px.
 */
export function gestureDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  opts: DragOptions = {},
): void {
  const steps = Math.max(4, opts.steps ?? 6);
  const button = opts.button ?? 0;
  const buttonsDown = button === 1 ? 4 : 1;
  const mods: Mods = {
    ctrlKey: opts.ctrlKey, shiftKey: opts.shiftKey, altKey: opts.altKey, metaKey: opts.metaKey,
  };
  const svg = svgEl();
  hitAt(from.x, from.y).dispatchEvent(pointer('pointerdown', from.x, from.y, button, buttonsDown, mods));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    svg.dispatchEvent(pointer('pointermove', x, y, 0, buttonsDown, mods));
  }
  opts.beforeUp?.();
  svg.dispatchEvent(pointer('pointerup', to.x, to.y, button, 0, mods));
}

/**
 * A drag confined to ONE element (e.g. the timeline splitter): down/move×/up all
 * dispatch at `el` itself, relying on setPointerCapture in REAL headless Chromium
 * (unlike gestureDrag, which routes move/up through the svg because the canvas's own
 * pipelines are wired there — non-canvas elements that call setPointerCapture on
 * themselves, like timeline diamonds or the splitter, retarget correctly here since
 * Vitest Browser Mode is a genuine browser engine, not jsdom).
 */
export function dragOnElement(
  el: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 6,
): void {
  el.dispatchEvent(pointer('pointerdown', from.x, from.y, 0, 1, {}));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    el.dispatchEvent(pointer('pointermove', x, y, 0, 1, {}));
  }
  el.dispatchEvent(pointer('pointerup', to.x, to.y, 0, 0, {}));
}

/** A single down/up click at a client point (no movement → no drag, no checkpoint). */
export function click(x: number, y: number, mods: Mods = {}): void {
  hitAt(x, y).dispatchEvent(pointer('pointerdown', x, y, 0, 1, mods));
  svgEl().dispatchEvent(pointer('pointerup', x, y, 0, 0, mods));
}

/**
 * A realistic double-click: click, click (re-resolving the hit target between them —
 * overlays appear after the first selects), then a dblclick. The app's dblclick handler
 * re-resolves artwork via elementsFromPoint, so the dblclick dispatches at the svg.
 */
export function fullDblClick(x: number, y: number): void {
  click(x, y);
  click(x, y);
  svgEl().dispatchEvent(new MouseEvent('dblclick', {
    bubbles: true, cancelable: true, clientX: x, clientY: y,
  }));
}

export function pressKey(key: string, mods: Mods = {}): void {
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true,
    ctrlKey: !!mods.ctrlKey, shiftKey: !!mods.shiftKey,
    altKey: !!mods.altKey, metaKey: !!mods.metaKey,
  }));
}

/** A wheel tick at a client point (deltaY < 0 zooms in). */
export function wheelAt(x: number, y: number, deltaY: number): void {
  svgEl().dispatchEvent(new WheelEvent('wheel', {
    bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY,
  }));
}

/** Select a part programmatically (for setups where selection itself isn't under test). */
export function selectByLabel(label: string): void {
  modelSelectPart(partByLabel(label).id);
  notify();
  renderPose();
}

/** Re-render after a direct state/doc mutation so the DOM reflects it before measuring. */
export function repaint(): void {
  renderPose();
}

/** Switch editor mode through main's real handler (notify + renderPose). */
export function setEditorMode(mode: 'setup' | 'animate'): void {
  hook().setEditorMode(mode);
}

/** The active clip's track for a target/channel, or undefined. */
export function clipTrack(target: string, channel: string) {
  const clip = state.doc?.clips[state.activeClipIndex];
  return clip?.tracks.find((t) => t.target === target && t.channel === channel);
}

/** Put the app into path-node editing on a part (optionally scoped to one path). */
export function enterNodeMode(partLabel: string, pathId?: string): void {
  modelSelectPart(partByLabel(partLabel).id);
  state.selectedPathId = pathId ?? null;
  state.mode = 'nodes';
  notify();
  renderPose();
}

export function pathElById(pathId: string): SVGPathElement {
  const el = svgEl().querySelector(`[data-path-id="${pathId}"]`);
  if (!el) throw new Error(`no path element ${pathId}`);
  return el as SVGPathElement;
}

/** Map a path's raw (pre-transform) coordinate to CLIENT px through its LIVE screen CTM. */
export function rawToClient(pathId: string, x: number, y: number): { x: number; y: number } {
  const m = pathElById(pathId).getScreenCTM()!;
  const pt = svgEl().createSVGPoint();
  pt.x = x; pt.y = y;
  const s = pt.matrixTransform(m);
  return { x: s.x, y: s.y };
}

export { state, notify, renderPose, SVG_NS };

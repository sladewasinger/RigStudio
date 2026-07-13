/**
 * Shared timeline-panel session state — the timeline "context".
 *
 * `timeline.ts` began as one large module; it is split into `src/timeline/*` layers
 * (this file, transport, lanes, keyProps, panel) that all read/write the same mutable
 * state through the `tlCtx` object here, mirroring `view/context.ts`'s pattern. Lower
 * layers that need to trigger a full panel re-render call `tlCtx.rerender()` — a hook
 * `panel.ts` installs once its `render()` exists — rather than importing the facade's
 * top layer back (which would cycle). Generic DOM helpers and the fixed-height shell
 * (splitter, `applyPanelHeight`) live here too since every layer needs them.
 *
 * Panel shell: #timeline has a FIXED height (splitter-adjustable, localStorage-
 * persisted) set via inline style in applyPanelHeight — never CSS min/max-content
 * sizing. This is a P3 bug fix: a lane appearing mid-drag used to grow #timeline's
 * intrinsic height, shrinking #layout/#canvas in the same flex column and shifting
 * the canvas's screen CTM under an in-flight gesture (a 30° rotate recorded ~12°).
 * render() only ever touches `tlCtx.bodyEl` (an internally-scrolling child) — the chip
 * header and splitter live outside it, built once in setupShell().
 */

import { state, Keyframe, Track } from '../core/model';
import { renderPose } from '../view';

// Which content replaces the lanes area — mutually exclusive by construction (a
// single field, not two booleans that could disagree). Onion is a separate toggle.
export type PanelMode = 'keys' | 'curves' | 'logic';

/** Mutable state shared across the timeline layers (formerly timeline.ts's module-level lets). */
export interface TimelineContext {
  container: HTMLElement;
  // The scrolling content region inside the fixed-height shell — render() rebuilds
  // only this, never `container` itself, so panel height never depends on content.
  bodyEl: HTMLElement;
  rafId: number;
  lastTick: number;
  fpsFrames: number;
  fpsWindowStart: number;
  fpsValue: number;
  // Selected keyframes (live object references into the active clip). Pruned on render;
  // cleared wholesale when undo/redo swaps the document out from under us.
  selectedKeys: Set<Keyframe>;
  trackOfKey: WeakMap<Keyframe, Track>;
  // Diamond elements of the current render, for box-select hit testing.
  diamondEls: { el: HTMLElement; key: Keyframe }[];
  panelMode: PanelMode;
  /** Installed by panel.ts once its render() exists; lower layers call this instead of
   *  importing the facade's top layer back (would cycle). No-op until buildTimeline()
   *  has run. */
  rerender: () => void;
}

export const tlCtx: TimelineContext = {
  container: undefined as unknown as HTMLElement,
  bodyEl: undefined as unknown as HTMLElement,
  rafId: 0,
  lastTick: 0,
  fpsFrames: 0,
  fpsWindowStart: 0,
  fpsValue: 0,
  selectedKeys: new Set<Keyframe>(),
  trackOfKey: new WeakMap<Keyframe, Track>(),
  diamondEls: [],
  panelMode: 'keys',
  rerender: () => {},
};

// ---- Generic DOM helpers (used by every layer) ----

export function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

export function divider(): HTMLElement {
  return div('tl-divider');
}

export function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.onclick = onClick;
  return b;
}

// ---- Panel height (splitter) ----

export const TIMELINE_HEIGHT_KEY = 'rig-studio-timeline-height';
const MIN_HEIGHT = 120;
const MAX_HEIGHT_VH = 0.7;
// "...the current typical height" (the spec's fallback phrasing): the OLD min-height
// floor. Setup mode's auto-sized content (just a note) always hit that floor, and
// Setup is the default/reset state, so this is the footprint most of the app's screen
// real estate was already tuned around. A 30vh default (~240px at a typical 800px
// viewport) was tried first and rejected: it shrank #canvas to roughly half its old
// boot-time height, silently invalidating pixel-based interaction-test gestures
// (including ones outside this file's ownership) that assumed the old geometry.
const DEFAULT_HEIGHT = MIN_HEIGHT;

function maxHeightPx(): number {
  return Math.max(MIN_HEIGHT, window.innerHeight * MAX_HEIGHT_VH);
}

function clampHeight(px: number): number {
  return Math.min(maxHeightPx(), Math.max(MIN_HEIGHT, px));
}

/** Sets every box-model property that could let content dictate the panel's height,
 *  overriding style.css's #timeline min/max-height block via inline style (which wins
 *  over any external stylesheet rule regardless of load order — the one thing this
 *  fix cannot afford to lose to a cascade-order accident). */
function applyPanelHeight(px: number): void {
  const h = clampHeight(px);
  tlCtx.container.style.flex = '0 0 auto';
  tlCtx.container.style.height = `${h}px`;
  tlCtx.container.style.minHeight = '0';
  tlCtx.container.style.maxHeight = 'none';
  tlCtx.container.style.display = 'flex';
  tlCtx.container.style.flexDirection = 'column';
  tlCtx.container.style.overflow = 'hidden'; // .tl-body scrolls internally instead
}

function loadStoredHeight(): number {
  const raw = Number(localStorage.getItem(TIMELINE_HEIGHT_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HEIGHT;
}

function saveHeight(px: number): void {
  localStorage.setItem(TIMELINE_HEIGHT_KEY, String(Math.round(px)));
}

function wireSplitter(): void {
  const splitter = document.getElementById('timeline-splitter');
  if (!splitter) return;
  splitter.addEventListener('pointerdown', (ev) => {
    const pev = ev as PointerEvent;
    pev.preventDefault();
    const startY = pev.clientY;
    const startHeight = tlCtx.container.getBoundingClientRect().height;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    try { splitter.setPointerCapture(pev.pointerId); } catch { /* synthetic/pen events */ }
    const move = (e: PointerEvent) => {
      // The panel sits at the bottom: dragging UP (negative dy) must GROW it.
      applyPanelHeight(startHeight - (e.clientY - startY));
    };
    const up = () => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.classList.remove('dragging');
      document.body.style.cursor = '';
      saveHeight(tlCtx.container.getBoundingClientRect().height);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });
}

/** Built once (not by render()): the fixed-height shell, the "Timeline" chip, the
 *  scrolling body, and the splitter. */
export function setupShell(): void {
  applyPanelHeight(loadStoredHeight());
  wireSplitter();
  window.addEventListener('resize', () => {
    const current = tlCtx.container.getBoundingClientRect().height;
    const clamped = clampHeight(current);
    if (Math.abs(clamped - current) > 0.5) applyPanelHeight(clamped);
  });

  const chip = div('tl-chip');
  chip.textContent = 'Timeline';
  tlCtx.container.appendChild(chip);

  tlCtx.bodyEl = div('tl-body');
  tlCtx.container.appendChild(tlCtx.bodyEl);
}

// ---- Time readout: ms <-> frames toggle (Category B item 2) ----

/** Editor preference (like the panel-height splitter above), never doc state. */
const TIME_DISPLAY_KEY = 'rig-studio-time-display-frames';

function loadShowFrames(): boolean {
  try {
    return localStorage.getItem(TIME_DISPLAY_KEY) === 'true';
  } catch {
    return false; // no localStorage (tests/node) — default to ms
  }
}

let showFrames = loadShowFrames();

export function isFrameDisplay(): boolean {
  return showFrames;
}

/** Flip the ms/frames readout mode and persist the choice. Callers re-render. */
export function toggleTimeDisplay(): void {
  showFrames = !showFrames;
  try {
    localStorage.setItem(TIME_DISPLAY_KEY, String(showFrames));
  } catch {
    /* persistence unavailable — keep the in-memory flag */
  }
}

/** ms -> the readout string for the CURRENT mode: "123 ms" or "7f" (round(ms*fps/1000)
 *  at doc.fps, falling back to 60 for a doc that predates the field / has none loaded). */
export function formatTime(ms: number): string {
  if (!showFrames) return `${Math.round(ms)} ms`;
  const fps = state.doc?.fps ?? 60;
  return `${Math.round((ms * fps) / 1000)}f`;
}

// ---- Playhead scrub utility (shared by the transport bar and keyframe lanes) ----

/** Scrub to a time and refresh the playhead/readout without a full rebuild. */
export function movePlayheadTo(time: number, duration: number): void {
  state.currentTime = time;
  const playhead = tlCtx.container.querySelector<HTMLElement>('.tl-playhead');
  if (playhead) playhead.style.left = `${(time / duration) * 100}%`;
  const timeLabel = tlCtx.container.querySelector<HTMLElement>('.tl-time');
  if (timeLabel) timeLabel.textContent = formatTime(time);
  renderPose();
}

// ---- Keyframe selection -> part selection (editing ergonomics wave) ----

/**
 * Syncs `state.selectedPartIds` to the UNION of the currently-selected keys' target
 * parts, so the layers tree highlights + auto-expands to them and the inspector shows
 * one ("extremely hard to see what I'm editing" with unnamed bones otherwise — user
 * report). Root-targeted tracks are skipped (`root` is the synthetic whole-figure
 * target, never a real part); if the union ends up empty — no keys selected, or every
 * selected key targets root — the existing part selection is left untouched. This is a
 * ONE-WAY key->part coupling: deselecting keys never clears a part selection the user
 * may be mid-editing. Callers own calling `notify()` afterward (this only mutates
 * state) and must call this once per key-selection CHANGE — the initial press of a
 * click/shift-click/retime drag, or a marquee's pointerup — never per pointermove, so a
 * retime drag doesn't churn part selection every frame.
 */
export function syncPartSelectionFromKeys(): void {
  const ids = new Set<string>();
  for (const key of tlCtx.selectedKeys) {
    const target = tlCtx.trackOfKey.get(key)?.target;
    if (target && target !== 'root') ids.add(target);
  }
  if (ids.size === 0) return;
  state.selectedPartIds = [...ids];
  state.selectedPartId = state.selectedPartIds[state.selectedPartIds.length - 1];
  state.selectedPathId = null;
}

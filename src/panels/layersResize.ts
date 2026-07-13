/**
 * Layers panel WIDTH splitter — the horizontal-resize sibling of timeline/tlState.ts's
 * height splitter (CLAUDE.md "Editing ergonomics wave": same pattern, same persistence
 * discipline — an editor pref, never doc state, no checkpoints). `#layout`'s
 * grid-template-columns (style.css) reads a `--layers-width` CSS custom property; this
 * module owns setting it and the draggable handle between `#layers` and the canvas
 * column. The splitter element is created here at runtime (a sibling `layersEl` gets
 * inserted next to) rather than declared in index.html, so main.ts/index.html — owned
 * by another agent this wave — stay untouched.
 */
import { renderPose } from '../view';

export const LAYERS_WIDTH_KEY = 'rig-studio-layers-width';
const MIN_WIDTH = 160;
const MAX_WIDTH_RATIO = 0.5;
const DEFAULT_WIDTH = 200; // matches style.css's previous static first-column width

function maxWidthPx(): number {
  return Math.max(MIN_WIDTH, window.innerWidth * MAX_WIDTH_RATIO);
}

function clampWidth(px: number): number {
  return Math.min(maxWidthPx(), Math.max(MIN_WIDTH, px));
}

function loadStoredWidth(): number {
  const raw = Number(localStorage.getItem(LAYERS_WIDTH_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WIDTH;
}

function saveWidth(px: number): void {
  localStorage.setItem(LAYERS_WIDTH_KEY, String(Math.round(px)));
}

/** Inline style on `#layout` wins over style.css's fallback regardless of load order —
 *  same rationale as tlState.ts's applyPanelHeight. */
function applyWidth(layout: HTMLElement, px: number): void {
  layout.style.setProperty('--layers-width', `${clampWidth(px)}px`);
}

/**
 * Sets up the splitter once (the first `buildLayersPanel` call, i.e. app boot) and
 * is a no-op on every rebuild after that — `layers.ts` calls this on EVERY render, so
 * bail immediately if the element already exists rather than re-creating/re-wiring it.
 */
export function ensureLayersSplitter(layersEl: HTMLElement): void {
  if (document.getElementById('layers-splitter')) return;
  const layout = layersEl.parentElement;
  if (!layout) return;

  applyWidth(layout, loadStoredWidth());

  const splitter = document.createElement('div');
  splitter.id = 'layers-splitter';
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-orientation', 'vertical');
  splitter.setAttribute('aria-label', 'Resize layers panel');
  layout.insertBefore(splitter, layersEl.nextSibling);

  splitter.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = layersEl.getBoundingClientRect().width;
    splitter.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    try { splitter.setPointerCapture(ev.pointerId); } catch { /* synthetic/pen events */ }
    const move = (e: PointerEvent) => {
      applyWidth(layout, startWidth + (e.clientX - startX));
      // Re-fit chrome to the canvas's new pixel width: overlay handle radii are baked
      // doc-unit numbers computed from the CTM at the last renderPose() call, so a
      // layout-driven CTM change goes stale exactly like the zoom GOTCHA in CLAUDE.md
      // ("ALL canvas chrome must be screen-constant under zoom") without a live kick.
      renderPose();
    };
    const up = () => {
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.classList.remove('dragging');
      document.body.style.cursor = '';
      saveWidth(layersEl.getBoundingClientRect().width);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
  });

  window.addEventListener('resize', () => {
    const current = layersEl.getBoundingClientRect().width;
    const clamped = clampWidth(current);
    if (Math.abs(clamped - current) > 0.5) applyWidth(layout, clamped);
  });
}

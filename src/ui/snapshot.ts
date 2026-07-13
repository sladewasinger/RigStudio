/**
 * Shared SVG-clone rasterizer for the canvas's live artwork — used by the AI
 * assistant's pose-snapshot attachment (panels/ai.ts's snapshotPose) and the
 * toolbar's still-image export (ui/imageExport.ts). Clones the live `#rig-svg`
 * (never touches the original — callers get a disposable detached element), strips
 * overlay/onion chrome always, and the artboard highlight rect optionally, then
 * either serializes the clone to SVG text or rasterizes it to a PNG data URL via an
 * off-screen `<canvas>`.
 *
 * AI Animate System v2 A3 ("filmstrip vision") also lives here: rendering N frames of a
 * clip across its duration, downscaled, for the assistant to see motion instead of a
 * single pose. Frame-time SELECTION (`selectFilmstripTimes`, pure, keyframe-cluster-
 * aware) moved to `core/filmstripTimes.ts` in H1b so the headless `rig render-frames`
 * CLI can share it (re-exported below, unchanged for every existing caller);
 * `renderClipFilmstrip` (DOC path — scrubs `state.currentTime`) and
 * `captureFilmstripFrame` (the single-frame capture primitive, shared with A2's
 * CANDIDATE path in panels/ai.ts, which scrubs its own preview clock instead — see that
 * file's `renderCandidateFilmstrip`) do the actual rendering and stay here (DOM-bound).
 */
import { state, Clip } from '../core/model';
import { renderPose } from '../view';
import { selectFilmstripTimes } from '../core/filmstripTimes';

export { FILMSTRIP_MAX_FRAMES, selectFilmstripTimes } from '../core/filmstripTimes';
export type { FilmstripTimingInput } from '../core/filmstripTimes';

export interface CloneOptions {
  /** Also strip #rig-artboard-rect (the faint page-bounds highlight). The AI
   *  snapshot's pre-existing behavior keeps it — omit this option to preserve that
   *  exactly; still-image export passes true. */
  stripArtboard?: boolean;
  /** ViewBox to frame the clone with, in doc space. Defaults to the whole
   *  document's viewBox — full-document framing regardless of the user's current
   *  pan/zoom (the live SVG's own viewBox reflects the current viewport, not the
   *  document). */
  box?: { x: number; y: number; w: number; h: number };
}

/** Clone the live canvas SVG with overlay/onion (and optionally artboard) chrome
 *  stripped and the viewBox reframed. Returns null if there's no live canvas/doc. */
export function cloneArtworkSvg(opts: CloneOptions = {}): SVGSVGElement | null {
  const live = document.getElementById('rig-svg') as SVGSVGElement | null;
  const doc = state.doc;
  if (!live || !doc) return null;
  const clone = live.cloneNode(true) as SVGSVGElement;
  clone.querySelector('#overlay')?.remove();
  clone.querySelector('#onion')?.remove();
  if (opts.stripArtboard) clone.querySelector('#rig-artboard-rect')?.remove();
  const box = opts.box ?? doc.viewBox;
  clone.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
  return clone;
}

/** Serialize a (typically cloned, detached) SVG element to a standalone XML string. */
export function serializeArtworkSvg(svg: SVGSVGElement): string {
  return new XMLSerializer().serializeToString(svg);
}

/**
 * Rasterize an SVG element to a PNG data URL at exactly outW x outH pixels. Mutates
 * the passed element's width/height attributes — pass a disposable clone, not a live
 * DOM node. `background` fills the canvas first when given; omit it for a
 * transparent PNG.
 */
export async function rasterizeSvg(
  svg: SVGSVGElement, outW: number, outH: number, background?: string,
): Promise<string> {
  svg.setAttribute('width', String(outW));
  svg.setAttribute('height', String(outH));
  const svgText = serializeArtworkSvg(svg);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('rasterize failed'));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const c = canvas.getContext('2d')!;
  if (background) {
    c.fillStyle = background;
    c.fillRect(0, 0, outW, outH);
  }
  c.drawImage(img, 0, 0, outW, outH);
  return canvas.toDataURL('image/png');
}

// =====================================================================================
// AI Animate System v2 A3: filmstrip vision — render N frames of a clip across its
// duration instead of a single playhead snapshot, so the assistant sees motion arcs,
// held poses, and clipping instead of one instant.
// =====================================================================================

/** Long-edge cap for a filmstrip frame, in px — small enough that 6 of them cost little
 *  bandwidth/latency, large enough to read a pose. */
const FILMSTRIP_MAX_DIM = 320;

export interface FilmstripFrame {
  timeMs: number;
  dataUrl: string;
}

/**
 * Rasterize the canvas's CURRENTLY RENDERED pose (whatever the caller already set + drew
 * via `renderPose()` — this function paints nothing itself) to a filmstrip-sized PNG
 * frame, downscaled to at most FILMSTRIP_MAX_DIM px on the long edge. Shares
 * `cloneArtworkSvg`/`rasterizeSvg` above, so overlay/onion chrome is already stripped
 * (and the artboard rect kept, matching the existing single-snapshot look). White
 * background, matching `panels/ai.ts`'s `snapshotPose`. Returns null (never throws) when
 * there's no live canvas/doc or a zero-size viewBox — callers treat that as "no frame".
 */
export async function captureFilmstripFrame(timeMs: number): Promise<FilmstripFrame | null> {
  const doc = state.doc;
  const clone = cloneArtworkSvg();
  if (!clone || !doc) return null;
  const { w, h } = doc.viewBox;
  if (!(w > 0) || !(h > 0)) return null;
  const scale = FILMSTRIP_MAX_DIM / Math.max(w, h);
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  const dataUrl = await rasterizeSvg(clone, outW, outH, '#ffffff');
  return { timeMs, dataUrl };
}

/**
 * Render a filmstrip of the DOC's ACTIVE CLIP: temporarily scrubs `state.currentTime`
 * across the clip's selected frame times (`selectFilmstripTimes`), capturing each via
 * `renderPose()` + `captureFilmstripFrame`, then restores the EXACT original
 * `currentTime` and repaints — byte-exact, even if a frame's rasterization throws
 * partway through (try/finally covers it). Never calls `notify()`: this is DOM-only
 * scrubbing, not a state change the rest of the app should react to (no
 * timeline/inspector rebuild mid-capture, no notify storm).
 *
 * Poses only actually change across frames in Animate mode (`view/pose.ts`'s `poseTime`
 * reads `state.currentTime` only when `state.editorMode === 'animate'`) — the only mode
 * the AI panel that calls this exists in, so this is never exercised from Setup in
 * practice. A rasterization failure on one frame is swallowed by the caller (see
 * `panels/ai.ts`'s `runAnimate`), never by this function — it always finishes its
 * restore.
 */
export async function renderClipFilmstrip(clip: Clip): Promise<FilmstripFrame[]> {
  const times = selectFilmstripTimes(clip);
  const savedTime = state.currentTime;
  const frames: FilmstripFrame[] = [];
  try {
    for (const t of times) {
      state.currentTime = t;
      renderPose();
      const frame = await captureFilmstripFrame(t);
      if (frame) frames.push(frame);
    }
  } finally {
    state.currentTime = savedTime;
    renderPose();
  }
  return frames;
}

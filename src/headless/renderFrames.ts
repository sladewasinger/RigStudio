/**
 * `rig render-frames`: rasterize N frames of a clip to PNGs, headlessly — the visual-
 * feedback loop an agent editing a `.rig.json` in a shell has no other way to get
 * (ROADMAP H1b). Two pure(ish) steps, both directly unit-testable without touching the
 * filesystem:
 *   1. `resolveFrameTimes` — WHEN to sample (explicit `--times`, evenly-spaced `--count`,
 *      or the default: `core/filmstripTimes.ts`'s `selectFilmstripTimes`, the exact
 *      keyframe-cluster algorithm the in-app AI assistant's filmstrip vision uses).
 *   2. `renderFrames` — compose each frame (`./composePose`) and rasterize it to a PNG
 *      buffer via `@resvg/resvg-js` (a CLI-only native dependency — see that module's
 *      header for why it must never reach the Vite bundle).
 * `cliCommands.ts`'s `runRenderFrames` is the thin fs/argv wrapper over this.
 */
import { Resvg } from '@resvg/resvg-js';

import { Clip, RigDoc } from '../core/model';
import { selectFilmstripTimes } from '../core/filmstripTimes';
import { composePose } from './composePose';

/** PNG background — opaque white, matching `ui/snapshot.ts`'s filmstrip capture
 *  convention (`captureFilmstripFrame`'s `rasterizeSvg(clone, outW, outH, '#ffffff')`). */
const BACKGROUND = '#ffffff';

export interface RenderFramesOptions {
  /** Explicit frame times (ms) — takes precedence over `count`. */
  times?: number[];
  /** Evenly-spaced frame count across [0, clip.duration] (including both ends). */
  count?: number;
  /** Output width in px of each rendered PNG; height follows the doc's aspect ratio
   *  (artboard/viewBox) via resvg's `fitTo: { mode: 'width' }`. Default 640. */
  width?: number;
}

export interface RenderedFrame {
  timeMs: number;
  /** Suggested filename (caller decides the directory) — sortable, self-describing. */
  fileName: string;
  png: Buffer;
  width: number;
  height: number;
}

export interface RenderFramesResult {
  clip: Clip;
  frames: RenderedFrame[];
  /** True when `doc` has any skinned part — callers surface `composePose`'s rigid-
   *  skin limitation to the user (the CLI prints a one-line note; see cliCommands.ts). */
  hasSkinnedParts: boolean;
}

function evenlySpacedTimes(duration: number, count: number): number[] {
  if (count <= 1) return [0];
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Math.round((i * duration) / (count - 1)));
  return out;
}

/** WHEN to sample `clip` — explicit override, evenly-spaced override, or the A3
 *  keyframe-cluster default. Exported standalone so tests can pin selection separately
 *  from rasterization (which needs the native resvg binding). */
export function resolveFrameTimes(clip: Clip, opts: Pick<RenderFramesOptions, 'times' | 'count'>): number[] {
  if (opts.times && opts.times.length > 0) return [...opts.times].sort((a, b) => a - b);
  if (opts.count && opts.count > 0) return evenlySpacedTimes(clip.duration, opts.count);
  return selectFilmstripTimes(clip);
}

function padTime(t: number): string {
  return t < 0 ? `n${Math.abs(t)}` : String(t);
}

/**
 * Render every selected frame of `doc`'s clip named `clipName` to a PNG buffer.
 * Throws with the available clip names when `clipName` doesn't match one exactly (the
 * CLI turns that into a `code: 1` failure — see cliCommands.ts's `runRenderFrames`).
 */
export function renderFrames(
  doc: RigDoc, clipName: string, opts: RenderFramesOptions = {},
): RenderFramesResult {
  const clip = doc.clips.find((c) => c.name === clipName);
  if (!clip) {
    const available = doc.clips.map((c) => c.name).join(', ') || '(none)';
    throw new Error(`Clip not found: "${clipName}" (available: ${available})`);
  }
  const width = opts.width && opts.width > 0 ? Math.round(opts.width) : 640;
  const times = resolveFrameTimes(clip, opts);

  const frames: RenderedFrame[] = times.map((t, idx) => {
    const svg = composePose(doc, clip, t);
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width }, background: BACKGROUND });
    const rendered = resvg.render();
    const fileName = `frame-${String(idx).padStart(4, '0')}-${padTime(t)}ms.png`;
    return { timeMs: t, fileName, png: rendered.asPng(), width: rendered.width, height: rendered.height };
  });

  return { clip, frames, hasSkinnedParts: doc.parts.some((p) => !!p.skin) };
}

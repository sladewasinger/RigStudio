/**
 * Headless pose composition: a `RigDoc` + one `Clip` at a time (ms) → a complete, ready-
 * to-view SVG string. The DOM-free counterpart to what `view/render.ts`'s `renderPose()`
 * paints onto the live canvas — same math (`geometry/pose.ts`, the pure kernel both
 * share, see its header), same z-sorted paint order (`core/model`'s `drawOrder`), same
 * hidden-part exclusion rule the exporters use. `headless/renderFrames.ts` (the `rig
 * render-frames` CLI command) calls this once per selected frame time before
 * rasterizing; any headless script can call it directly for the SVG text alone.
 *
 * LIMITATION (documented here AND surfaced by `renderFrames.ts`'s CLI output — do not
 * silently drop it in a future refactor): skinned parts (`part.skin`) render RIGID —
 * their bind-time REST geometry (already baked to root space by the bind step) with an
 * identity transform, like the Lottie exporter and `view/render.ts`'s
 * `renderPartRigid` fallback. (The .riv exporter is the exception since the
 * skinned-part export wave, 2026-07-13: it emits real Rive Skin/Tendon deformation —
 * `io/riv/skin.ts` — so exported playback articulates even though headless FRAME
 * RENDERS of the same doc stay rigid.) Headless linear-blend skinning is out of scope
 * for H1b.
 */
import {
  RigDoc, Clip, RigPart, RigPath, state, artboardFrame, isEffectivelyHidden,
  flattenPaintOrder, PaintRun,
} from '../core/model';
import { effectiveOpacity, effectiveZ, groupTransformOf, rootPoseTransform } from '../geometry/pose';

const SVG_NS = 'http://www.w3.org/2000/svg';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One `<path>` element exactly as `view/partDom.ts`'s `applyPathAttrs` would set it up
 *  on the live DOM (same attribute set, same conditional stroke/transform). */
function pathTag(p: RigPath): string {
  const attrs = [
    `d="${esc(p.d)}"`,
    `fill="${p.fill ? esc(p.fill) : 'none'}"`,
    `fill-opacity="${p.fillOpacity}"`,
  ];
  if (p.stroke) {
    attrs.push(
      `stroke="${esc(p.stroke)}"`,
      `stroke-width="${p.strokeWidth}"`,
      `stroke-opacity="${p.strokeOpacity}"`,
      'stroke-linecap="round"',
      'stroke-linejoin="round"',
    );
  }
  if (p.transform) attrs.push(`transform="${esc(p.transform)}"`);
  return `<path ${attrs.join(' ')}/>`;
}

/**
 * One paint RUN's `<g>`: transform + opacity + this run's own path ids (in slot order,
 * last on top — the same SVG-nesting convention the live canvas uses). U2: a part whose
 * own paths interleave with children in its childOrder emits MORE than one of these
 * (`run.totalRuns > 1`, carrying `data-run` — see `core/paintOrder.ts`); every doc that
 * predates U2 or was never hand-edited into an interleaved shape degenerates to exactly
 * one run holding ALL of a part's paths — byte-identical to the pre-U2 output.
 */
function paintRunTag(part: RigPart, run: PaintRun, t: number): string {
  // Skinned parts render RIGID here — see the module doc comment's LIMITATION.
  const transform = part.skin ? '' : groupTransformOf(part, t);
  const attrs = [`data-part-id="${esc(part.id)}"`];
  if (run.totalRuns > 1) attrs.push(`data-run="${run.runIndex}"`);
  if (transform) attrs.push(`transform="${esc(transform)}"`);
  const opacity = Math.min(1, Math.max(0, effectiveOpacity(part, t)));
  if (opacity < 1) attrs.push(`opacity="${opacity}"`);
  const pathById = new Map(part.paths.map((p) => [p.id, p]));
  const paths = run.pathIds.map((pid) => pathById.get(pid)).filter((p): p is RigPath => !!p).map(pathTag).join('');
  return `<g ${attrs.join(' ')}>${paths}</g>`;
}

/**
 * Compose one frame of `clip` at `timeMs` into a standalone SVG string. `clip` must be
 * the actual element of `doc.clips` the caller wants sampled (by reference, not just by
 * matching name) — callers resolve it by name first (`renderFrames.ts`'s pattern).
 *
 * Temporarily installs `doc`/`clip` as the shared `state` singleton's active doc/clip —
 * the same convention every headless script already follows (see `headless/index.ts`'s
 * header: "a script sets `state.doc = doc` before calling it") — so `geometry/pose.ts`'s
 * channel sampling resolves against the right tracks, then restores whatever was there
 * before, even if composition throws (try/finally, mirroring `ui/snapshot.ts`'s
 * `renderClipFilmstrip` scrub-and-restore pattern).
 *
 * Reference frame is the artboard when the doc has one enabled, else the viewBox
 * (`artboardFrame`, shared with both exporters) — used directly as the SVG's own
 * viewBox, so unlike the exporters no origin-offset math is needed: an SVG viewBox can
 * start at any (x, y), exactly like the live canvas's own `#rig-svg`.
 */
export function composePose(doc: RigDoc, clip: Clip, timeMs: number): string {
  const clipIndex = doc.clips.indexOf(clip);
  if (clipIndex === -1) {
    throw new Error(`composePose: clip "${clip.name}" is not an element of doc.clips`);
  }
  const savedDoc = state.doc;
  const savedClipIndex = state.activeClipIndex;
  state.doc = doc;
  state.activeClipIndex = clipIndex;
  try {
    const frame = artboardFrame(doc);
    const root = rootPoseTransform(timeMs);
    // U2: paint order is the childOrder slot flatten (core/paintOrder.ts) — the SAME
    // algorithm the live canvas uses (view/render.ts/canvas.ts) — sibling-scoped keyed-z
    // resort included, not the old GLOBAL drawOrder sort. Hidden-part exclusion stays a
    // caller concern (flattenPaintOrder is agnostic to RigPart.hidden): headless exports
    // drop a hidden subtree entirely, unlike the live canvas which keeps it in the DOM.
    const partsById = new Map(doc.parts.map((p) => [p.id, p]));
    const runs = flattenPaintOrder(doc, (part) => effectiveZ(part, timeMs))
      .filter((run) => !isEffectivelyHidden(partsById.get(run.partId)!));
    const groups = runs.map((run) => paintRunTag(partsById.get(run.partId)!, run, timeMs)).join('');
    return (
      `<svg xmlns="${SVG_NS}" viewBox="${frame.x} ${frame.y} ${frame.w} ${frame.h}" ` +
      `width="${frame.w}" height="${frame.h}">` +
      `<g transform="${esc(root)}">${groups}</g>` +
      '</svg>'
    );
  } finally {
    state.doc = savedDoc;
    state.activeClipIndex = savedClipIndex;
  }
}

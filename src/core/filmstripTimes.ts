/**
 * AI Animate System v2 A3 ("filmstrip vision") frame-time selection: keyframe-cluster-
 * aware picking of WHEN to sample a clip for a multi-frame preview. Extracted from
 * `ui/snapshot.ts` (H1b, the headless render-frames wave) so the headless `rig
 * render-frames` CLI command (`headless/renderFrames.ts`) can share the exact same
 * default frame selection the AI assistant panel uses — `ui/` is forbidden territory for
 * headless code (`src/__tests__/headlessBoundary.test.ts`), this module is core/, so it
 * isn't. `ui/snapshot.ts` imports this back for its own callers (`renderClipFilmstrip`),
 * unchanged.
 */

/** Max frames a filmstrip ever returns. Payload budget (documented in full at
 *  ai/claude.ts's frame-attachment code, which mirrors this as a defensive cap since
 *  ai/ doesn't import ui/): 6 frames at FILMSTRIP_MAX_DIM px each stays well under any
 *  request-size concern. */
export const FILMSTRIP_MAX_FRAMES = 6;
/** Keyframe times within this many ms of their neighbor merge into one cluster (one
 *  "moment" the pose changes) — collapses e.g. an arrival + its overshoot settle into a
 *  single representative frame instead of two near-duplicates. */
const FILMSTRIP_CLUSTER_MS = 150;
/** Below this many distinct clusters the clip reads as too sparse for cluster-driven
 *  sampling to mean anything (e.g. a bare in/out pair, or an unkeyed clip with zero
 *  clusters) — fall back to a plain evenly-spaced strip across the whole duration. */
const FILMSTRIP_MIN_CLUSTERS = 4;

/** Minimal shape `selectFilmstripTimes` needs — satisfied structurally by both a real
 *  `Clip` and the A2 preview's candidate `{duration, tracks}` (panels/ai.ts's
 *  `AiPreviewState`), so one function serves the doc path and the candidate path. */
export interface FilmstripTimingInput {
  duration: number;
  tracks: { keyframes: { time: number }[] }[];
}

/**
 * Pick the frame times for a clip's filmstrip: keyframe-cluster-aware when the clip has
 * enough distinct motion, evenly-spaced otherwise. Pure (no DOM/state) — exported for
 * direct unit testing; the rendering step (`renderClipFilmstrip` in `ui/snapshot.ts`) is
 * what actually samples the doc/candidate at these times in the live editor;
 * `headless/renderFrames.ts` uses it as `rig render-frames`'s default frame selection.
 *
 * Algorithm: collect every distinct keyframe time across all tracks, sort ascending,
 * then single-linkage cluster consecutive times within FILMSTRIP_CLUSTER_MS of their
 * immediate neighbor (a cluster's representative = the mean of its members, rounded to
 * the nearest ms). Fewer than FILMSTRIP_MIN_CLUSTERS clusters (including zero, an
 * unkeyed clip) is too sparse to be meaningful — fall back to 0/25/50/75/100% of the
 * duration instead (which trivially always includes both 0 and the duration, deduped
 * down to one frame when duration is 0). Otherwise, more than FILMSTRIP_MAX_FRAMES
 * clusters are downsampled to exactly that many by picking evenly spaced INDICES into
 * the sorted cluster list — index 0 and the last index always survive, so the strip
 * still spans the full first→last cluster range.
 */
export function selectFilmstripTimes(clip: FilmstripTimingInput): number[] {
  const duration = Math.max(0, clip.duration);
  const keyTimes = [...new Set(clip.tracks.flatMap((t) => t.keyframes.map((k) => k.time)))]
    .sort((a, b) => a - b);

  const clusters: number[] = [];
  let bucket: number[] = [];
  const flushBucket = () => {
    if (bucket.length === 0) return;
    clusters.push(Math.round(bucket.reduce((a, b) => a + b, 0) / bucket.length));
    bucket = [];
  };
  for (const time of keyTimes) {
    if (bucket.length > 0 && time - bucket[bucket.length - 1] > FILMSTRIP_CLUSTER_MS) flushBucket();
    bucket.push(time);
  }
  flushBucket();

  if (clusters.length < FILMSTRIP_MIN_CLUSTERS) {
    const fractions = [0, 0.25, 0.5, 0.75, 1];
    return [...new Set(fractions.map((f) => Math.round(duration * f)))];
  }

  if (clusters.length <= FILMSTRIP_MAX_FRAMES) return clusters;

  const lastIdx = clusters.length - 1;
  const picked = new Set<number>();
  for (let i = 0; i < FILMSTRIP_MAX_FRAMES; i++) {
    picked.add(Math.round((i * lastIdx) / (FILMSTRIP_MAX_FRAMES - 1)));
  }
  return [...picked].sort((a, b) => a - b).map((idx) => clusters[idx]);
}

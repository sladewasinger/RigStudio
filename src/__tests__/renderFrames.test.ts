/**
 * H1b `headless/renderFrames.ts`: frame-time resolution (`resolveFrameTimes` — explicit
 * override / evenly-spaced override / the A3 default) plus a raster smoke test that
 * actually decodes the PNG bytes `@resvg/resvg-js` produced and checks the artwork moved
 * the right way, not just that bytes came back. `headlessCliRenderFrames.test.ts` covers
 * the `rig render-frames` CLI surface on top of this.
 */
import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { renderFrames, resolveFrameTimes } from '../headless/renderFrames';
import { makeClip, makeDoc, makePart, makePath, makeTrack } from './helpers';

describe('resolveFrameTimes', () => {
  const clip = makeClip({
    name: 'c',
    duration: 1000,
    tracks: [makeTrack('a', 'rotate', [[0, 0, 'linear'], [1000, 90, 'linear']])],
  });

  it('explicit --times wins and is returned sorted', () => {
    expect(resolveFrameTimes(clip, { times: [500, 0, 250] })).toEqual([0, 250, 500]);
  });

  it('--count evenly spaces N frames across [0, duration], including both ends', () => {
    expect(resolveFrameTimes(clip, { count: 5 })).toEqual([0, 250, 500, 750, 1000]);
    expect(resolveFrameTimes(clip, { count: 1 })).toEqual([0]);
  });

  it('falls back to the A3 filmstrip default when neither is given', () => {
    // Only 2 distinct keyframe times -> too sparse for clustering -> evenly-spaced fallback.
    expect(resolveFrameTimes(clip, {})).toEqual([0, 250, 500, 750, 1000]);
  });
});

/** Weighted centroid of every pixel that isn't essentially white (the composePose
 *  background), weighting by distance from white so anti-aliased edges contribute
 *  proportionally instead of needing a hard threshold. */
function nonBackgroundCentroid(png: InstanceType<typeof PNG>): { x: number; y: number } {
  let sumX = 0, sumY = 0, sumW = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      const w = (255 - r) + (255 - g) + (255 - b);
      if (w <= 0) continue;
      sumX += x * w;
      sumY += y * w;
      sumW += w;
    }
  }
  if (sumW === 0) throw new Error('frame is entirely background — nothing to centroid');
  return { x: sumX / sumW, y: sumY / sumW };
}

describe('renderFrames: raster smoke test', () => {
  it('rasterizes real PNGs whose non-background centroid moves with a large keyed tx', () => {
    const block = makePart('block', {
      paths: [makePath('block-path', {
        d: 'M 10,10 L 40,10 L 40,40 L 10,40 Z',
        fill: '#ff0000',
        stroke: null,
      })],
    });
    const clip = makeClip({
      name: 'move',
      duration: 1000,
      tracks: [makeTrack('block', 'tx', [[0, 0, 'linear'], [1000, 120, 'linear']])],
    });
    const doc = makeDoc([block], [clip]);
    doc.viewBox = { x: 0, y: 0, w: 200, h: 200 };

    const result = renderFrames(doc, 'move', { times: [0, 1000], width: 200 });
    expect(result.frames).toHaveLength(2);
    expect(result.hasSkinnedParts).toBe(false);

    const [frame0, frame1] = result.frames;
    // Square viewBox + width == viewBox width -> ~1:1 pixel mapping, square output.
    expect(frame0.width).toBe(200);
    expect(Math.abs(frame0.height - frame0.width)).toBeLessThanOrEqual(1);
    expect(frame1.width).toBe(frame0.width);
    expect(frame1.height).toBe(frame0.height);

    const png0 = PNG.sync.read(frame0.png);
    const png1 = PNG.sync.read(frame1.png);
    const c0 = nonBackgroundCentroid(png0);
    const c1 = nonBackgroundCentroid(png1);

    // tx moved +120 doc units in x, 1:1 pixel scale -> centroid shifts right by ~120px;
    // y is untouched.
    expect(c1.x - c0.x).toBeGreaterThan(80);
    expect(Math.abs(c1.y - c0.y)).toBeLessThan(5);
  });

  it('throws with the available clip names when the requested clip is missing', () => {
    const doc = makeDoc([], [makeClip({ name: 'idle' })]);
    expect(() => renderFrames(doc, 'nope')).toThrow(/Clip not found: "nope"/);
    expect(() => renderFrames(doc, 'nope')).toThrow(/idle/);
  });

  it('reports hasSkinnedParts so callers can surface the rigid-render limitation', () => {
    const skinned = makePart('s', { paths: [makePath('s-path')], skin: { bones: [] } });
    const doc = makeDoc([skinned], [makeClip({ name: 'c' })]);
    const result = renderFrames(doc, 'c', { times: [0] });
    expect(result.hasSkinnedParts).toBe(true);
  });
});

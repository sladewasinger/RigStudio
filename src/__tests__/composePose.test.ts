/**
 * H1b `headless/composePose.ts` correctness: a `RigDoc` + `Clip` + time → a posed SVG
 * string. Covers the behaviors the module header promises — keyed translation reflected
 * in the part's transform, keyed `z` reordering paint order, hidden-part exclusion,
 * keyed opacity, and the skinned-rigid-render fallback — plus that `state.doc`/
 * `state.activeClipIndex` are restored afterward (composePose must be safely callable
 * repeatedly without leaking global state between frames or tests).
 */
import { describe, expect, it } from 'vitest';
import { state } from '../core/model';
import { composePose } from '../headless/composePose';
import { makeClip, makeDoc, makePart, makePath, makeTrack, resetState } from './helpers';

describe('composePose', () => {
  it('reflects a keyed ty at the sampled time in the part transform', () => {
    const a = makePart('a', { paths: [makePath('a-path')] });
    const clip = makeClip({
      name: 'move',
      duration: 1000,
      tracks: [makeTrack('a', 'ty', [[0, 0, 'linear'], [500, 100, 'linear']])],
    });
    const doc = makeDoc([a], [clip]);

    const svgAt0 = composePose(doc, clip, 0);
    const svgAt500 = composePose(doc, clip, 500);

    expect(svgAt0).toMatch(/data-part-id="a"[^>]*transform="translate\(0,0\)/);
    expect(svgAt500).toMatch(/data-part-id="a"[^>]*transform="translate\(0,100\)/);
  });

  it('restores state.doc/activeClipIndex after composing, even across repeated calls', () => {
    const sentinelDoc = makeDoc();
    resetState(sentinelDoc);
    state.activeClipIndex = 7;

    const a = makePart('a', { paths: [makePath('a-path')] });
    const clip = makeClip({ name: 'c', tracks: [] });
    const doc = makeDoc([a], [clip]);
    composePose(doc, clip, 0);

    expect(state.doc).toBe(sentinelDoc);
    expect(state.activeClipIndex).toBe(7);
  });

  it('throws when the clip is not an element of doc.clips (by reference)', () => {
    const doc = makeDoc([], []);
    const foreignClip = makeClip({ name: 'not-in-doc' });
    expect(() => composePose(doc, foreignClip, 0)).toThrow(/not an element of doc\.clips/);
  });

  it('a keyed z swaps paint order between two parts across frames', () => {
    const a = makePart('a', { paths: [makePath('a-path')] });
    const b = makePart('b', { paths: [makePath('b-path')] });
    const clip = makeClip({
      name: 'reorder',
      duration: 1000,
      tracks: [makeTrack('a', 'z', [[0, 0, 'linear'], [500, 2, 'linear']])],
    });
    // doc.parts order is [a, b] -> unkeyed paint order is a-then-b (b topmost).
    const doc = makeDoc([a, b], [clip]);

    const svgAt0 = composePose(doc, clip, 0);
    const idxA0 = svgAt0.indexOf('data-part-id="a"');
    const idxB0 = svgAt0.indexOf('data-part-id="b"');
    expect(idxA0).toBeGreaterThanOrEqual(0);
    expect(idxB0).toBeGreaterThan(idxA0); // b drawn after a -> b on top, matching doc order

    const svgAt500 = composePose(doc, clip, 500);
    const idxA500 = svgAt500.indexOf('data-part-id="a"');
    const idxB500 = svgAt500.indexOf('data-part-id="b"');
    expect(idxA500).toBeGreaterThan(idxB500); // a's z=2 lifts it above b -> a drawn last
  });

  it('excludes a hidden part entirely, like the exporters', () => {
    const visible = makePart('visible', { paths: [makePath('v-path')] });
    const hidden = makePart('hidden', { paths: [makePath('h-path')], hidden: true });
    const clip = makeClip({ name: 'c' });
    const doc = makeDoc([visible, hidden], [clip]);

    const svg = composePose(doc, clip, 0);
    expect(svg).toContain('data-part-id="visible"');
    expect(svg).not.toContain('data-part-id="hidden"');
  });

  it('a part riding a hidden ancestor is also excluded (isEffectivelyHidden cascades)', () => {
    const parent = makePart('parent', { hidden: true });
    const child = makePart('child', { parentId: 'parent', paths: [makePath('c-path')] });
    const clip = makeClip({ name: 'c' });
    const doc = makeDoc([parent, child], [clip]);

    const svg = composePose(doc, clip, 0);
    expect(svg).not.toContain('data-part-id="child"');
  });

  it('samples keyed opacity onto the group, clamped, and omits the attribute at full opacity', () => {
    const a = makePart('a', { paths: [makePath('a-path')] });
    const clip = makeClip({
      name: 'fade',
      duration: 1000,
      tracks: [makeTrack('a', 'opacity', [[0, 1, 'linear'], [500, 0.4, 'linear']])],
    });
    const doc = makeDoc([a], [clip]);

    const svgAt0 = composePose(doc, clip, 0);
    expect(svgAt0).toMatch(/data-part-id="a"(?![^>]*opacity=)[^>]*>/);

    const svgAt500 = composePose(doc, clip, 500);
    expect(svgAt500).toMatch(/data-part-id="a"[^>]*opacity="0\.4"/);
  });

  it('renders a skinned part rigid: empty transform regardless of its rest pose', () => {
    const skinned = makePart('skinned', {
      paths: [makePath('s-path')],
      rest: { rotate: 45, tx: 999, ty: -999, sx: 2, sy: 2, kx: 0, ky: 0, opacity: 1 },
      skin: { bones: [] },
    });
    const clip = makeClip({ name: 'c' });
    const doc = makeDoc([skinned], [clip]);

    const svg = composePose(doc, clip, 0);
    const match = /<g data-part-id="skinned"([^>]*)>/.exec(svg);
    expect(match).not.toBeNull();
    expect(match![1]).not.toContain('transform=');
  });

  it('uses the enabled artboard as the viewBox reference frame instead of the doc viewBox', () => {
    const a = makePart('a', { paths: [makePath('a-path')] });
    const clip = makeClip({ name: 'c' });
    const doc = makeDoc([a], [clip]);
    doc.artboard = { enabled: true, x: 10, y: 20, w: 300, h: 400 };

    const svg = composePose(doc, clip, 0);
    expect(svg).toContain('viewBox="10 20 300 400"');
    expect(svg).toContain('width="300" height="400"');
  });
});

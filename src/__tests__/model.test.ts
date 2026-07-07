/**
 * Unit tests for the document model: channel sampling and easing curves, keyframe
 * writes, the keyframe clipboard, selection, parenting rules, and normalizeDoc's
 * back-compat fills. All state-dependent functions run against the app-state
 * singleton, pointed at a fresh document per test via resetState().
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  Easing,
  RigDoc,
  ancestorChain,
  canMoveSelectedInDrawOrder,
  channelValue,
  copyKeys,
  copyPoseAt,
  deleteKeyframe,
  movePartRelativeTo,
  moveSelectedInDrawOrder,
  normalizeDoc,
  pasteKeysAt,
  sampleChannel,
  selectPart,
  selectedParts,
  setKeyframeAt,
  setParent,
  state,
} from '../model';
import { makeClip, makeDoc, makePart, makePath, makeTrack, resetState } from './helpers';

describe('sampleChannel', () => {
  it('clamps to the first key before it and the last key after it', () => {
    const track = makeTrack('p1', 'rotate', [
      [200, 10, 'linear'],
      [800, 30, 'linear'],
    ]);
    resetState(makeDoc([makePart('p1')], [makeClip({ tracks: [track] })]));
    expect(sampleChannel('p1', 'rotate', 0)).toBe(10);
    expect(sampleChannel('p1', 'rotate', 200)).toBe(10);
    expect(sampleChannel('p1', 'rotate', 800)).toBe(30);
    expect(sampleChannel('p1', 'rotate', 5000)).toBe(30);
  });

  it.each<[Easing, number]>([
    ['linear', 0.5],
    ['easeIn', 0.25],
    ['easeOut', 0.75],
    ['easeInOut', 0.5],
  ])('interpolates the midpoint with %s easing on the arriving key → %d', (easing, expected) => {
    const track = makeTrack('p1', 'rotate', [
      [0, 0, 'linear'],
      [1000, 1, easing], // easing lives on the ARRIVING keyframe
    ]);
    resetState(makeDoc([makePart('p1')], [makeClip({ tracks: [track] })]));
    expect(sampleChannel('p1', 'rotate', 500)).toBeCloseTo(expected, 9);
  });

  it('falls back to CHANNEL_DEFAULTS when there is no track (or no clip)', () => {
    resetState(makeDoc([makePart('p1')]));
    expect(sampleChannel('p1', 'rotate', 100)).toBe(0);
    expect(sampleChannel('p1', 'sx', 100)).toBe(1);
    expect(sampleChannel('p1', 'sy', 100)).toBe(1);
    resetState(null);
    expect(sampleChannel('p1', 'tx', 100)).toBe(0);
    expect(sampleChannel('p1', 'sx', 100)).toBe(1);
  });
});

describe('channelValue', () => {
  function docWithKeyedRotate(): RigDoc {
    const part = makePart('p1', {
      rest: { rotate: 45, tx: 7, ty: 0, sx: 1, sy: 1 },
    });
    const track = makeTrack('p1', 'rotate', [
      [0, 10, 'linear'],
      [1000, 20, 'linear'],
    ]);
    return makeDoc([part], [makeClip({ tracks: [track] })]);
  }

  it('returns the ABSOLUTE sampled value for a keyed channel (rest is not added)', () => {
    const doc = docWithKeyedRotate();
    resetState(doc);
    expect(channelValue(doc.parts[0], 'rotate', 500)).toBeCloseTo(15, 9); // not 45 + 15
    expect(channelValue(doc.parts[0], 'rotate', 0)).toBe(10);
  });

  it('returns the rest value for an unkeyed channel at any time', () => {
    const doc = docWithKeyedRotate();
    resetState(doc);
    expect(channelValue(doc.parts[0], 'tx', 500)).toBe(7);
    expect(channelValue(doc.parts[0], 'sx', 500)).toBe(1);
  });

  it('returns the rest value for time = null even when the channel is keyed', () => {
    const doc = docWithKeyedRotate();
    resetState(doc);
    expect(channelValue(doc.parts[0], 'rotate', null)).toBe(45);
  });

  it('returns the rest value when the track exists but has no keyframes', () => {
    const part = makePart('p1', { rest: { rotate: 30, tx: 0, ty: 0, sx: 1, sy: 1 } });
    const empty = makeTrack('p1', 'rotate', []);
    resetState(makeDoc([part], [makeClip({ tracks: [empty] })]));
    expect(channelValue(part, 'rotate', 500)).toBe(30);
  });
});

describe('setKeyframeAt', () => {
  beforeEach(() => {
    resetState(makeDoc([makePart('p1')]));
  });

  it('creates the track on first use', () => {
    const clip = state.doc!.clips[0];
    expect(clip.tracks).toHaveLength(0);
    setKeyframeAt('p1', 'rotate', 100, 10);
    expect(clip.tracks).toHaveLength(1);
    expect(clip.tracks[0]).toMatchObject({ target: 'p1', channel: 'rotate' });
    expect(clip.tracks[0].keyframes).toEqual([{ time: 100, value: 10, easing: 'easeInOut' }]);
  });

  it('replaces an existing keyframe within 5ms instead of adding one', () => {
    const first = setKeyframeAt('p1', 'rotate', 100, 10);
    const second = setKeyframeAt('p1', 'rotate', 103, 99);
    expect(second).toBe(first); // same object, updated in place
    const track = state.doc!.clips[0].tracks[0];
    expect(track.keyframes).toHaveLength(1);
    expect(track.keyframes[0].time).toBe(100);
    expect(track.keyframes[0].value).toBe(99);
  });

  it('keeps keyframes sorted by time regardless of insertion order', () => {
    setKeyframeAt('p1', 'rotate', 500, 5);
    setKeyframeAt('p1', 'rotate', 50, 1);
    setKeyframeAt('p1', 'rotate', 250, 3);
    const track = state.doc!.clips[0].tracks[0];
    expect(track.keyframes.map((k) => k.time)).toEqual([50, 250, 500]);
  });
});

describe('deleteKeyframe', () => {
  it('removes a keyframe, and removes the track from the clip once empty', () => {
    resetState(makeDoc([makePart('p1')]));
    setKeyframeAt('p1', 'rotate', 0, 1);
    setKeyframeAt('p1', 'rotate', 500, 2);
    const clip = state.doc!.clips[0];
    const track = clip.tracks[0];

    deleteKeyframe(track, track.keyframes[0]);
    expect(track.keyframes.map((k) => k.time)).toEqual([500]);
    expect(clip.tracks).toHaveLength(1); // still has a key → track stays

    deleteKeyframe(track, track.keyframes[0]);
    expect(track.keyframes).toHaveLength(0);
    expect(clip.tracks).toHaveLength(0); // empty track pruned from the clip
  });

  it('only removes the exact keyframe object passed', () => {
    resetState(makeDoc([makePart('p1')]));
    setKeyframeAt('p1', 'rotate', 0, 1);
    setKeyframeAt('p1', 'rotate', 500, 2);
    const clip = state.doc!.clips[0];
    const track = clip.tracks[0];
    // A value-equal clone is not the same keyframe.
    deleteKeyframe(track, { time: 0, value: 1, easing: 'easeInOut' });
    expect(track.keyframes).toHaveLength(2);
  });
});

describe('keyframe clipboard (copyKeys / pasteKeysAt)', () => {
  it('preserves relative dt, pastes at a new time, and returns the pasted keys', () => {
    const track = makeTrack('p1', 'rotate', [
      [200, 1, 'easeIn'],
      [500, 2, 'easeOut'],
    ]);
    resetState(makeDoc([makePart('p1')], [makeClip({ tracks: [track] })]));

    const copied = copyKeys(track.keyframes.map((key) => ({ track, key })));
    expect(copied).toBe(2);

    const pasted = pasteKeysAt(1000);
    expect(pasted).toHaveLength(2);
    expect(pasted.map((k) => k.time)).toEqual([1000, 1300]); // dt 0 and 300 preserved
    expect(pasted.map((k) => k.value)).toEqual([1, 2]);
    expect(pasted.map((k) => k.easing)).toEqual(['easeIn', 'easeOut']);
    // Paste adds; the originals are still there.
    expect(track.keyframes.map((k) => k.time)).toEqual([200, 500, 1000, 1300]);
  });

  it('snaps pasted times to 10ms and clamps at zero', () => {
    const track = makeTrack('p1', 'rotate', [[200, 1, 'linear']]);
    resetState(makeDoc([makePart('p1')], [makeClip({ tracks: [track] })]));
    copyKeys([{ track, key: track.keyframes[0] }]);

    expect(pasteKeysAt(1004)[0].time).toBe(1000);
    expect(pasteKeysAt(-50)[0].time).toBe(0);
  });

  it('pastes nothing without an active clip', () => {
    const track = makeTrack('p1', 'rotate', [[0, 1, 'linear']]);
    resetState(makeDoc([makePart('p1')], [makeClip({ tracks: [track] })]));
    copyKeys([{ track, key: track.keyframes[0] }]);
    resetState(null);
    expect(pasteKeysAt(100)).toEqual([]);
  });
});

describe('copyPoseAt', () => {
  it('snapshots sampled values from every non-empty track', () => {
    const rotate = makeTrack('p1', 'rotate', [
      [0, 0, 'linear'],
      [1000, 10, 'linear'],
    ]);
    const tx = makeTrack('p1', 'tx', [[0, 7, 'linear']]);
    const empty = makeTrack('p1', 'ty', []);
    resetState(makeDoc([makePart('p1')], [makeClip({ tracks: [rotate, tx, empty] })]));

    expect(copyPoseAt(500)).toBe(2); // the empty ty track is skipped

    // Pasting the pose writes the sampled values, all at the paste time (dt = 0).
    const pasted = pasteKeysAt(2000);
    expect(pasted).toHaveLength(2);
    expect(pasted.map((k) => k.time)).toEqual([2000, 2000]);
    expect(pasted[0].value).toBeCloseTo(5, 9); // rotate midpoint of 0 → 10
    expect(pasted[1].value).toBe(7); // tx clamped to its only key
  });
});

describe('selectPart / selectedParts', () => {
  beforeEach(() => {
    resetState(makeDoc([makePart('a'), makePart('b'), makePart('c')]));
  });

  it('replaces the selection by default', () => {
    selectPart('a');
    selectPart('b');
    expect(state.selectedPartId).toBe('b');
    expect(state.selectedPartIds).toEqual(['b']);
    expect(selectedParts().map((p) => p.id)).toEqual(['b']);
  });

  it('extends the selection when additive, without duplicating', () => {
    selectPart('a');
    selectPart('b', true);
    selectPart('b', true);
    expect(state.selectedPartId).toBe('b');
    expect(state.selectedPartIds).toEqual(['a', 'b']);
    expect(selectedParts().map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('clears everything when selecting null', () => {
    selectPart('a');
    state.selectedPathId = 'path_1';
    selectPart(null);
    expect(state.selectedPartId).toBeNull();
    expect(state.selectedPartIds).toEqual([]);
    expect(state.selectedPathId).toBeNull();
    expect(selectedParts()).toEqual([]);
  });

  it('clears selectedPathId when selecting a DIFFERENT part, keeps it on re-select', () => {
    selectPart('a');
    state.selectedPathId = 'path_1';
    selectPart('a');
    expect(state.selectedPathId).toBe('path_1'); // same part → stays "entered"
    selectPart('b');
    expect(state.selectedPathId).toBeNull();
  });

  it('drops selected ids that no longer resolve to parts', () => {
    selectPart('a');
    state.selectedPartIds = ['a', 'ghost'];
    expect(selectedParts().map((p) => p.id)).toEqual(['a']);
  });
});

describe('setParent / ancestorChain', () => {
  beforeEach(() => {
    resetState(makeDoc([makePart('a'), makePart('b'), makePart('c')]));
  });

  it('allows a valid reparent and detaching via null', () => {
    expect(setParent('b', 'a')).toBe(true);
    expect(state.doc!.parts[1].parentId).toBe('a');
    expect(setParent('b', 'c')).toBe(true); // move to a different parent
    expect(state.doc!.parts[1].parentId).toBe('c');
    expect(setParent('b', null)).toBe(true);
    expect(state.doc!.parts[1].parentId).toBeNull();
  });

  it('refuses self-parenting and cycles', () => {
    expect(setParent('a', 'a')).toBe(false);
    setParent('b', 'a');
    setParent('c', 'b');
    expect(setParent('a', 'c')).toBe(false); // a → c → b → a would cycle
    expect(setParent('a', 'b')).toBe(false);
    expect(state.doc!.parts[0].parentId).toBeNull(); // untouched
  });

  it('refuses unknown child or parent ids', () => {
    expect(setParent('ghost', 'a')).toBe(false);
    expect(setParent('a', 'ghost')).toBe(false);
    expect(state.doc!.parts[0].parentId).toBeNull();
  });

  it('ancestorChain lists ancestors outermost first', () => {
    setParent('b', 'a');
    setParent('c', 'b');
    const [a, b, c] = state.doc!.parts;
    expect(ancestorChain(c).map((p) => p.id)).toEqual(['a', 'b']);
    expect(ancestorChain(b).map((p) => p.id)).toEqual(['a']);
    expect(ancestorChain(a)).toEqual([]);
  });

  it('ancestorChain terminates on a hand-made cycle', () => {
    const [a, b] = state.doc!.parts;
    a.parentId = 'b'; // bypass setParent to force a corrupt doc
    b.parentId = 'a';
    expect(ancestorChain(a).map((p) => p.id)).toEqual(['b']);
    expect(ancestorChain(b).map((p) => p.id)).toEqual(['a']);
  });
});

describe('normalizeDoc', () => {
  it('fills missing rest fields, including sx/sy on older docs', () => {
    const doc = {
      name: 'old',
      viewBox: { x: 0, y: 0, w: 10, h: 10 },
      rootPivot: { x: 5, y: 8 },
      parts: [
        { id: 'p_1', label: 'no_rest', transform: '', pivot: { x: 0, y: 0 }, paths: [] },
        {
          id: 'p_2', label: 'v1_rest', transform: '', pivot: { x: 0, y: 0 }, paths: [],
          rest: { rotate: 5, tx: 1, ty: 2 }, // written before sx/sy existed
        },
      ],
      clips: [{ name: 'idle', duration: 2000, tracks: [] }],
    } as unknown as RigDoc;

    const out = normalizeDoc(doc);
    expect(out.parts[0].rest).toEqual({ rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1 });
    expect(out.parts[1].rest).toEqual({ rotate: 5, tx: 1, ty: 2, sx: 1, sy: 1 });
    expect(out.parts[0].parentId).toBeNull();
    expect(out.parts[0].pivotHint).toBeNull();
  });

  it('fills missing path labels as path_N', () => {
    const doc = {
      name: 'old',
      viewBox: { x: 0, y: 0, w: 10, h: 10 },
      rootPivot: { x: 5, y: 8 },
      parts: [
        {
          id: 'p_1', label: 'arm', transform: '', pivot: { x: 0, y: 0 },
          rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1 }, parentId: null,
          paths: [
            { id: 'path_1', d: 'M 0,0', fill: null, fillOpacity: 1, stroke: null, strokeWidth: 1, strokeOpacity: 1, transform: '' },
            { id: 'path_2', label: 'named', d: 'M 0,0', fill: null, fillOpacity: 1, stroke: null, strokeWidth: 1, strokeOpacity: 1, transform: '' },
          ],
        },
      ],
      clips: [{ name: 'idle', duration: 2000, tracks: [] }],
    } as unknown as RigDoc;

    const out = normalizeDoc(doc);
    expect(out.parts[0].paths[0].label).toBe('path_1');
    expect(out.parts[0].paths[1].label).toBe('named'); // existing labels untouched
  });

  it('drops dangling parentIds but keeps valid ones', () => {
    const doc = makeDoc([
      makePart('a'),
      makePart('b', { parentId: 'a' }),
      makePart('c', { parentId: 'ghost' }),
    ]);
    const out = normalizeDoc(doc);
    expect(out.parts[1].parentId).toBe('a');
    expect(out.parts[2].parentId).toBeNull();
  });

  it('coerces unknown easing strings to easeInOut and keeps valid ones', () => {
    const doc = makeDoc(
      [makePart('a')],
      [makeClip({
        tracks: [{
          target: 'a',
          channel: 'rotate',
          keyframes: [
            { time: 0, value: 1, easing: 'bounce' as Easing },
            { time: 500, value: 2, easing: 'linear' },
          ],
        }],
      })],
    );
    const out = normalizeDoc(doc);
    expect(out.clips[0].tracks[0].keyframes[0].easing).toBe('easeInOut');
    expect(out.clips[0].tracks[0].keyframes[1].easing).toBe('linear');
  });

  it('supplies a default idle clip when clips are missing or empty', () => {
    const bare = {
      name: 'old',
      viewBox: { x: 0, y: 0, w: 10, h: 10 },
      rootPivot: { x: 5, y: 8 },
      parts: [],
    } as unknown as RigDoc;
    expect(normalizeDoc(bare).clips).toEqual([{ name: 'idle', duration: 2000, tracks: [] }]);
    const empty = makeDoc([], []);
    expect(normalizeDoc(empty).clips).toEqual([{ name: 'idle', duration: 2000, tracks: [] }]);
  });
});

describe('draw order (z-order)', () => {
  const threeParts = () => makeDoc([makePart('p1'), makePart('p2'), makePart('p3')]);

  beforeEach(() => resetState(threeParts()));

  it('moveSelectedInDrawOrder steps the selected part up (+1 = drawn later/on top)', () => {
    selectPart('p1');
    expect(canMoveSelectedInDrawOrder(1)).toBe(true);
    expect(moveSelectedInDrawOrder(1)).toBe(true);
    expect(state.doc!.parts.map((p) => p.id)).toEqual(['p2', 'p1', 'p3']);
  });

  it('refuses to step past either end without mutating', () => {
    selectPart('p3');
    expect(canMoveSelectedInDrawOrder(1)).toBe(false);
    expect(moveSelectedInDrawOrder(1)).toBe(false);
    selectPart('p1');
    expect(canMoveSelectedInDrawOrder(-1)).toBe(false);
    expect(moveSelectedInDrawOrder(-1)).toBe(false);
    expect(state.doc!.parts.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('steps an entered path within its part instead of the part', () => {
    const part = makePart('p1', { paths: [makePath('a'), makePath('b')] });
    resetState(makeDoc([part, makePart('p2')]));
    selectPart('p1');
    state.selectedPathId = 'a';
    expect(moveSelectedInDrawOrder(1)).toBe(true);
    expect(part.paths.map((p) => p.id)).toEqual(['b', 'a']);
    // the part array is untouched
    expect(state.doc!.parts.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(moveSelectedInDrawOrder(1)).toBe(false); // already on top
  });

  it('movePartRelativeTo places above/below the reference (above = later in parts)', () => {
    expect(movePartRelativeTo('p1', 'p3', 'above')).toBe(true);
    expect(state.doc!.parts.map((p) => p.id)).toEqual(['p2', 'p3', 'p1']);
    expect(movePartRelativeTo('p1', 'p2', 'below')).toBe(true);
    expect(state.doc!.parts.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('movePartRelativeTo adopts the reference part\'s parent (sibling insertion)', () => {
    const doc = threeParts();
    doc.parts[1].parentId = 'p3'; // p2 is a child of p3
    resetState(doc);
    expect(movePartRelativeTo('p1', 'p2', 'above')).toBe(true);
    expect(state.doc!.parts.find((p) => p.id === 'p1')!.parentId).toBe('p3');
    // dropping between root-level parts detaches
    expect(movePartRelativeTo('p1', 'p3', 'below')).toBe(true);
    expect(state.doc!.parts.find((p) => p.id === 'p1')!.parentId).toBeNull();
  });

  it('movePartRelativeTo refuses drops whose adopted parent would create a cycle', () => {
    const doc = threeParts();
    doc.parts[1].parentId = 'p1'; // p2 is a child of p1
    resetState(doc);
    // dropping p1 next to p2 would make p1 a sibling under itself
    expect(movePartRelativeTo('p1', 'p2', 'above')).toBe(false);
    expect(state.doc!.parts.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(movePartRelativeTo('p1', 'p1', 'above')).toBe(false);
  });
});

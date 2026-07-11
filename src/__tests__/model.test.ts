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
  applyRigChanges,
  canMoveSelectedInDrawOrder,
  channelValue,
  copyKeys,
  copyPoseAt,
  deleteKeyframe,
  deserializeDoc,
  duplicateParts,
  groupParts,
  keyAt,
  movePartRelativeTo,
  moveSelectedInDrawOrder,
  newStateMachine,
  normalizeDoc,
  pasteKeysAt,
  removeKeyAt,
  sampleChannel,
  selectAllParts,
  selectPart,
  selectedParts,
  serializeDoc,
  setKeyframe,
  setKeyframeAt,
  setParent,
  state,
  ungroupPart,
} from '../core/model';
import { multiply, rotationMat, translationMat } from '../geometry/transforms';
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
      rest: { rotate: 45, tx: 7, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 },
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
    const part = makePart('p1', { rest: { rotate: 30, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 } });
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

describe('keyAt / removeKeyAt (inspector keyframe-toggle circles)', () => {
  beforeEach(() => {
    resetState(makeDoc([makePart('p1')]));
  });

  it('keyAt finds a keyframe within the 5ms tolerance, and misses outside it', () => {
    setKeyframeAt('p1', 'rotate', 500, 30);
    expect(keyAt('p1', 'rotate', 500)).toMatchObject({ time: 500, value: 30 });
    expect(keyAt('p1', 'rotate', 503)).toMatchObject({ time: 500, value: 30 }); // within 5ms
    expect(keyAt('p1', 'rotate', 497)).toMatchObject({ time: 500, value: 30 }); // within 5ms
    expect(keyAt('p1', 'rotate', 506)).toBeNull(); // just outside
    expect(keyAt('p1', 'rotate', 494)).toBeNull();
  });

  it('keyAt returns null for an untracked channel or an unkeyed one', () => {
    expect(keyAt('p1', 'rotate', 0)).toBeNull(); // no track at all
    setKeyframeAt('p1', 'tx', 0, 1);
    expect(keyAt('p1', 'rotate', 0)).toBeNull(); // track exists on a different channel
  });

  it('keyAt matches setKeyframe\'s 10ms grid snap (playhead time need not be exact)', () => {
    state.currentTime = 237;
    setKeyframe('p1', 'rotate', 12); // snaps to 240
    expect(keyAt('p1', 'rotate', 237)).toMatchObject({ time: 240, value: 12 });
  });

  it('removeKeyAt removes just that key and keeps the track when other keys remain', () => {
    setKeyframeAt('p1', 'rotate', 0, 1);
    setKeyframeAt('p1', 'rotate', 500, 2);
    expect(removeKeyAt('p1', 'rotate', 500)).toBe(true);
    const track = state.doc!.clips[0].tracks[0];
    expect(track.keyframes.map((k) => k.time)).toEqual([0]);
    expect(state.doc!.clips[0].tracks).toHaveLength(1);
  });

  it('removeKeyAt drops the track once its last key is removed (matches timeline delete semantics)', () => {
    setKeyframeAt('p1', 'rotate', 0, 1);
    expect(removeKeyAt('p1', 'rotate', 0)).toBe(true);
    expect(state.doc!.clips[0].tracks).toHaveLength(0);
  });

  it('removeKeyAt returns false and is a no-op when nothing matches', () => {
    setKeyframeAt('p1', 'rotate', 0, 1);
    expect(removeKeyAt('p1', 'rotate', 900)).toBe(false);
    expect(removeKeyAt('p1', 'sx', 0)).toBe(false);
    expect(state.doc!.clips[0].tracks[0].keyframes).toHaveLength(1);
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

describe('selectAllParts', () => {
  it('selects every part in the document, with the last one primary', () => {
    resetState(makeDoc([makePart('a'), makePart('b'), makePart('c')]));
    selectAllParts();
    expect(state.selectedPartIds).toEqual(['a', 'b', 'c']);
    expect(state.selectedPartId).toBe('c');
  });

  it('clears the entered path', () => {
    resetState(makeDoc([makePart('a')]));
    selectPart('a');
    state.selectedPathId = 'path_1';
    selectAllParts();
    expect(state.selectedPathId).toBeNull();
  });

  it('no-ops without a document', () => {
    resetState(null);
    expect(() => selectAllParts()).not.toThrow();
    expect(state.selectedPartIds).toEqual([]);
  });
});

describe('duplicateParts', () => {
  it('clones fresh ids for the part and every path, without sharing path objects', () => {
    const part = makePart('p1', {
      paths: [makePath('a'), makePath('b')],
      rest: { rotate: 0, tx: 5, ty: 5, sx: 1, sy: 1, kx: 0, ky: 0 },
    });
    resetState(makeDoc([part, makePart('p2')]));
    const [newId] = duplicateParts(['p1']);
    expect(newId).toBeDefined();
    expect(newId).not.toBe('p1');
    const clone = state.doc!.parts.find((p) => p.id === newId)!;
    expect(clone.paths).toHaveLength(2);
    expect(clone.paths.map((p) => p.id)).not.toEqual(['a', 'b']);
    expect(new Set(clone.paths.map((p) => p.id)).size).toBe(2); // both fresh, distinct

    // Mutating the clone's path must not touch the source's.
    clone.paths[0].d = 'M 9,9';
    expect(part.paths[0].d).toBe('M 0,0 L 1,1');
  });

  it('labels the copy, offsets rest tx/ty by +12,+12, and preserves the parent', () => {
    const parent = makePart('parent');
    const part = makePart('p1', {
      label: 'arm', parentId: 'parent',
      rest: { rotate: 3, tx: 1, ty: 2, sx: 1, sy: 1, kx: 0, ky: 0 },
    });
    resetState(makeDoc([parent, part]));
    const [newId] = duplicateParts(['p1']);
    const clone = state.doc!.parts.find((p) => p.id === newId)!;
    expect(clone.label).toBe('arm copy');
    expect(clone.parentId).toBe('parent');
    expect(clone.rest.tx).toBe(13);
    expect(clone.rest.ty).toBe(14);
    expect(clone.rest.rotate).toBe(3); // untouched
  });

  it('inserts the copy immediately after the source, and copies no animation tracks', () => {
    const doc = makeDoc(
      [makePart('p1'), makePart('p2')],
      [makeClip({ tracks: [makeTrack('p1', 'rotate', [[0, 5, 'linear']])] })],
    );
    resetState(doc);
    const [newId] = duplicateParts(['p1']);
    expect(state.doc!.parts.map((p) => p.id)).toEqual(['p1', newId, 'p2']);
    const clip = state.doc!.clips[0];
    expect(clip.tracks.some((t) => t.target === newId)).toBe(false);
    expect(clip.tracks).toHaveLength(1); // the source's track is untouched
  });

  it('skips skinned parts and unknown ids, returning only the ids actually duplicated', () => {
    const skinned = makePart('skin1', { skin: { bones: [] } });
    const plain = makePart('p1');
    resetState(makeDoc([skinned, plain]));
    const newIds = duplicateParts(['skin1', 'ghost', 'p1']);
    expect(newIds).toHaveLength(1);
    expect(state.doc!.parts).toHaveLength(3); // skin1, p1, and one clone
  });

  it('returns [] without a document', () => {
    resetState(null);
    expect(duplicateParts(['p1'])).toEqual([]);
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
    expect(out.parts[0].rest).toEqual({ rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 });
    expect(out.parts[1].rest).toEqual({ rotate: 5, tx: 1, ty: 2, sx: 1, sy: 1, kx: 0, ky: 0 });
    expect(out.parts[0].parentId).toBeNull();
    expect(out.parts[0].pivotHint).toBeNull();
    expect(out.parts[0].kind).toBe('art'); // defaulted — field didn't exist pre-bones/groups
  });

  it('defaults boneTip and skin to null on parts written before those fields existed', () => {
    const doc = {
      name: 'old',
      viewBox: { x: 0, y: 0, w: 10, h: 10 },
      rootPivot: { x: 5, y: 8 },
      parts: [
        { id: 'p_1', label: 'bare', transform: '', pivot: { x: 0, y: 0 }, paths: [] },
      ],
      clips: [{ name: 'idle', duration: 2000, tracks: [] }],
    } as unknown as RigDoc;
    const out = normalizeDoc(doc);
    expect(out.parts[0].boneTip).toBeNull();
    expect(out.parts[0].skin).toBeNull();
  });

  it('leaves an absent path nodeTypes as undefined, and coerces a non-string value to null', () => {
    const doc = {
      name: 'old',
      viewBox: { x: 0, y: 0, w: 10, h: 10 },
      rootPivot: { x: 5, y: 8 },
      parts: [{
        id: 'p_1', label: 'arm', kind: 'art', transform: '', pivot: { x: 0, y: 0 },
        rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 }, parentId: null,
        paths: [
          { id: 'path_1', d: 'M 0,0', fill: null, fillOpacity: 1, stroke: null, strokeWidth: 1, strokeOpacity: 1, transform: '' },
          { id: 'path_2', d: 'M 0,0', fill: null, fillOpacity: 1, stroke: null, strokeWidth: 1, strokeOpacity: 1, transform: '', nodeTypes: 42 },
        ],
      }],
      clips: [{ name: 'idle', duration: 2000, tracks: [] }],
    } as unknown as RigDoc;
    const out = normalizeDoc(doc);
    expect(out.parts[0].paths[0].nodeTypes).toBeUndefined(); // never written — stays absent
    expect(out.parts[0].paths[1].nodeTypes).toBeNull(); // malformed — coerced
  });

  it('drops skin bones referencing missing part ids, clearing skin entirely once none remain', () => {
    const doc = makeDoc([
      makePart('bone1'),
      makePart('skinned', {
        skin: {
          bones: [
            { id: 'bone1', restWorldInv: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, bindSeg: { p: { x: 0, y: 0 }, q: { x: 1, y: 0 } } },
            { id: 'ghost', restWorldInv: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, bindSeg: { p: { x: 0, y: 0 }, q: { x: 1, y: 0 } } },
          ],
        },
      }),
      makePart('skinned_all_dangling', {
        skin: { bones: [{ id: 'ghost2', restWorldInv: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, bindSeg: { p: { x: 0, y: 0 }, q: { x: 1, y: 0 } } }] },
      }),
    ]);
    const out = normalizeDoc(doc);
    const skinned = out.parts.find((p) => p.id === 'skinned')!;
    expect(skinned.skin?.bones.map((b) => b.id)).toEqual(['bone1']);
    const allDangling = out.parts.find((p) => p.id === 'skinned_all_dangling')!;
    expect(allDangling.skin).toBeNull();
  });

  it("coerces an invalid keyframe bezier to null, clamps a valid one's x components, and tolerates an absent bezier", () => {
    const doc = makeDoc(
      [makePart('a')],
      [makeClip({
        tracks: [{
          target: 'a',
          channel: 'rotate',
          keyframes: [
            { time: 0, value: 0, easing: 'linear' }, // no bezier at all — pre-curve-editor doc
            {
              time: 500, value: 1, easing: 'easeIn',
              bezier: [0.1, 0.2, 0.3] as unknown as [number, number, number, number], // wrong length
            },
            { time: 1000, value: 2, easing: 'easeOut', bezier: [-0.5, 0.2, 1.5, 0.8] }, // x out of 0..1
          ],
        }],
      })],
    );
    const out = normalizeDoc(doc);
    const keys = out.clips[0].tracks[0].keyframes;
    expect(keys[0].bezier).toBeUndefined();
    expect(keys[1].bezier).toBeNull();
    expect(keys[2].bezier).toEqual([0, 0.2, 1, 0.8]); // x clamped, y (overshoot) untouched
  });

  it('fills missing path labels as path_N', () => {
    const doc = {
      name: 'old',
      viewBox: { x: 0, y: 0, w: 10, h: 10 },
      rootPivot: { x: 5, y: 8 },
      parts: [
        {
          id: 'p_1', label: 'arm', transform: '', pivot: { x: 0, y: 0 },
          rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 }, parentId: null,
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

  it('defaults stateMachines to [] on a document written before they existed', () => {
    const doc = makeDoc([makePart('p1')]);
    delete (doc as { stateMachines?: unknown }).stateMachines; // pre-state-machine doc
    const out = normalizeDoc(doc);
    expect(out.stateMachines).toEqual([]);
  });

  it('re-establishes the entry/any/exit invariant on a machine missing them', () => {
    const doc = makeDoc([makePart('p1')]);
    doc.stateMachines = [
      { id: 'sm_1', name: 'm', inputs: [], states: [], transitions: [], listeners: [] },
    ];
    const out = normalizeDoc(doc);
    const kinds = out.stateMachines![0].states.map((s) => s.kind);
    expect(kinds).toContain('entry');
    expect(kinds).toContain('any');
    expect(kinds).toContain('exit');
  });

  it('prunes dangling-toId transitions, listeners, and actions, and clamps durationMs', () => {
    const doc = makeDoc([makePart('p1')]);
    doc.stateMachines = [
      {
        id: 'sm_1',
        name: 'm',
        inputs: [{ id: 'in_a', name: 'a', type: 'bool', default: false }],
        states: [
          { id: 'st_entry', name: 'Entry', kind: 'entry' },
          { id: 'st_any', name: 'Any', kind: 'any' },
          { id: 'st_a', name: 'A', kind: 'animation', clipName: 'idle', loop: true },
        ],
        transitions: [
          // its only condition resolves cleanly; durationMs is negative (clamped)
          {
            id: 'tr_ok', fromId: 'st_entry', toId: 'st_a', durationMs: -50,
            conditions: [{ inputId: 'in_a', op: '==', value: true }],
          },
          { id: 'tr_bad', fromId: 'st_a', toId: 'st_ghost', durationMs: 100, conditions: [] }, // dangling toId
        ],
        listeners: [
          {
            id: 'ls_ok', targetPartId: 'p1', event: 'down',
            actions: [
              { inputId: 'in_a', type: 'setBool', value: true }, // kept
              { inputId: 'ghost_input', type: 'fireTrigger' }, // dropped
            ],
          },
          { id: 'ls_bad', targetPartId: 'ghost_part', event: 'up', actions: [] }, // dropped
        ],
      },
    ];
    const out = normalizeDoc(doc);
    const sm = out.stateMachines![0];
    expect(sm.transitions.map((t) => t.id)).toEqual(['tr_ok']); // dangling toId dropped
    expect(sm.transitions[0].durationMs).toBe(0); // negative clamped
    expect(sm.transitions[0].conditions.map((c) => c.inputId)).toEqual(['in_a']);
    expect(sm.listeners.map((l) => l.id)).toEqual(['ls_ok']); // dangling targetPart dropped
    expect(sm.listeners[0].actions.map((a) => a.inputId)).toEqual(['in_a']);
  });

  it('drops the WHOLE transition (not just the offending condition) when any condition references a missing input', () => {
    // Pins the semantic fix: a condition whose inputId no longer resolves makes
    // conditionPasses() return false forever (stateMachine.ts), so the transition can
    // never fire. Silently stripping just that condition used to resurrect the
    // transition as unconditional (or partially-conditioned) after save/reload — the
    // opposite of what was authored. normalizeDoc now drops the whole transition instead.
    const doc = makeDoc([makePart('p1')]);
    doc.stateMachines = [
      {
        id: 'sm_1',
        name: 'm',
        inputs: [{ id: 'in_a', name: 'a', type: 'bool', default: false }],
        states: [
          { id: 'st_entry', name: 'Entry', kind: 'entry' },
          { id: 'st_any', name: 'Any', kind: 'any' },
          { id: 'st_a', name: 'A', kind: 'animation', clipName: 'idle', loop: true },
        ],
        transitions: [
          // one condition resolves, one dangles — the WHOLE transition must go.
          {
            id: 'tr_partial', fromId: 'st_entry', toId: 'st_a', durationMs: 0,
            conditions: [
              { inputId: 'in_a', op: '==', value: true },
              { inputId: 'ghost_input', op: '==', value: true },
            ],
          },
          // every condition dangles — also dropped.
          {
            id: 'tr_all_bad', fromId: 'st_any', toId: 'st_a', durationMs: 0,
            conditions: [{ inputId: 'ghost_input_2', op: '==', value: true }],
          },
        ],
        listeners: [],
      },
    ];
    const out = normalizeDoc(doc);
    expect(out.stateMachines![0].transitions).toEqual([]);
  });

  it('KEEPS a state whose clipName no longer resolves (evaluator treats it as rest)', () => {
    const doc = makeDoc([makePart('p1')]); // clips: only the default 'idle'
    doc.stateMachines = [
      {
        id: 'sm_1',
        name: 'm',
        inputs: [],
        states: [
          { id: 'st_entry', name: 'Entry', kind: 'entry' },
          { id: 'st_any', name: 'Any', kind: 'any' },
          { id: 'st_gone', name: 'Gone', kind: 'animation', clipName: 'deleted_clip', loop: true },
        ],
        transitions: [],
        listeners: [],
      },
    ];
    const out = normalizeDoc(doc);
    const gone = out.stateMachines![0].states.find((s) => s.id === 'st_gone');
    expect(gone).toBeDefined();
    expect(gone!.clipName).toBe('deleted_clip'); // dangling clipName preserved
  });

  it('newStateMachine mints exactly one entry, one any, and one exit node and survives normalize', () => {
    const sm = newStateMachine('walk');
    expect(sm.states.filter((s) => s.kind === 'entry')).toHaveLength(1);
    expect(sm.states.filter((s) => s.kind === 'any')).toHaveLength(1);
    expect(sm.states.filter((s) => s.kind === 'exit')).toHaveLength(1);
    const doc = makeDoc([makePart('p1')]);
    doc.stateMachines = [sm];
    const out = normalizeDoc(doc);
    expect(out.stateMachines![0].states.map((s) => s.kind)).toEqual(['entry', 'any', 'exit']);
  });

  it('clamps a present exitFraction into [0,1], strips it from non-animation fromIds, leaves absent alone', () => {
    const doc = makeDoc([makePart('p1')]);
    doc.stateMachines = [
      {
        id: 'sm_1', name: 'm', inputs: [],
        states: [
          { id: 'st_entry', name: 'Entry', kind: 'entry' },
          { id: 'st_any', name: 'Any', kind: 'any' },
          { id: 'st_a', name: 'A', kind: 'animation', clipName: 'idle', loop: false },
          { id: 'st_exit', name: 'Exit', kind: 'exit' },
        ],
        transitions: [
          { id: 't_over', fromId: 'st_a', toId: 'st_exit', durationMs: 0, conditions: [], exitFraction: 1.7 },
          { id: 't_neg', fromId: 'st_a', toId: 'st_exit', durationMs: 0, conditions: [], exitFraction: -0.4 },
          // exit time leaving a non-animation state (entry) must be stripped.
          { id: 't_entry', fromId: 'st_entry', toId: 'st_a', durationMs: 0, conditions: [], exitFraction: 0.5 },
          // a transition that never set exit time keeps no exitFraction field at all.
          { id: 't_plain', fromId: 'st_a', toId: 'st_exit', durationMs: 0, conditions: [] },
        ],
        listeners: [],
      },
    ];
    const out = normalizeDoc(doc);
    const trs = out.stateMachines![0].transitions;
    const byId = (id: string) => trs.find((t) => t.id === id)!;
    expect(byId('t_over').exitFraction).toBe(1); // clamped down
    expect(byId('t_neg').exitFraction).toBe(0); // clamped up
    expect(byId('t_entry').exitFraction).toBeNull(); // stripped (from a non-animation state)
    expect('exitFraction' in byId('t_plain')).toBe(false); // absent stays absent (no null added)
  });

  it('seeds an absent artboard as disabled, matching the current viewBox (back-compat: pre-P2c docs and fresh SVG imports)', () => {
    const doc = makeDoc([makePart('p1')]);
    delete (doc as { artboard?: unknown }).artboard;
    const out = normalizeDoc(doc);
    expect(out.artboard).toEqual({ enabled: false, x: 0, y: 0, w: 100, h: 100 });
  });

  it('leaves a well-formed enabled artboard untouched', () => {
    const doc = makeDoc([makePart('p1')]);
    doc.artboard = { enabled: true, x: -10, y: 5, w: 200, h: 150 };
    const out = normalizeDoc(doc);
    expect(out.artboard).toEqual({ enabled: true, x: -10, y: 5, w: 200, h: 150 });
  });

  it('falls back to the viewBox per axis for a non-finite x/y or a non-positive w/h (hand-edited file)', () => {
    const doc = makeDoc([makePart('p1')]);
    doc.artboard = {
      enabled: true,
      x: Number.NaN, y: 12,
      w: -5, h: 0,
    } as unknown as RigDoc['artboard'];
    const out = normalizeDoc(doc);
    // x/w/h were invalid -> viewBox (0,_,100,100); y (12) was valid -> kept.
    expect(out.artboard).toEqual({ enabled: true, x: 0, y: 12, w: 100, h: 100 });
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

describe('bones, groups, structural edits', () => {
  it('groupParts wraps only the outermost selected parts and adopts their common parent', () => {
    const doc = makeDoc([makePart('p1'), makePart('p2'), makePart('p3')]);
    doc.parts[1].parentId = 'p1'; // p2 under p1
    resetState(doc);
    const group = groupParts(['p1', 'p2', 'p3'], { x: 5, y: 5 })!;
    expect(group.kind).toBe('group');
    expect(group.paths).toEqual([]);
    // p2's ancestor p1 is also selected, so p2 stays under p1.
    expect(state.doc!.parts.find((p) => p.id === 'p2')!.parentId).toBe('p1');
    expect(state.doc!.parts.find((p) => p.id === 'p1')!.parentId).toBe(group.id);
    expect(state.doc!.parts.find((p) => p.id === 'p3')!.parentId).toBe(group.id);
    expect(group.parentId).toBeNull();
  });

  it('ungroupPart absorbs the group rest pose exactly (child renders identically)', () => {
    const doc = makeDoc([makePart('g'), makePart('c')]);
    resetState(doc);
    const g = state.doc!.parts[0];
    const c = state.doc!.parts[1];
    g.kind = 'group';
    g.pivot = { x: 10, y: 10 };
    g.rest.rotate = 30;
    g.rest.tx = 7;
    g.rest.ty = -3;
    c.parentId = 'g';
    c.pivot = { x: 25, y: 5 };
    c.rest.rotate = 10;
    c.rest.tx = 2;
    c.rest.ty = 4;
    // Composed rendering matrix before dissolving: group pose · child pose.
    const before = multiply(
      multiply(translationMat(7, -3), rotationMat(30, 10, 10)),
      multiply(translationMat(2, 4), rotationMat(10, 25, 5)),
    );
    expect(ungroupPart('g')).toBe(true);
    expect(state.doc!.parts.map((p) => p.id)).toEqual(['c']);
    expect(c.parentId).toBeNull();
    expect(c.rest.rotate).toBeCloseTo(40, 9);
    const after = multiply(
      translationMat(c.rest.tx, c.rest.ty),
      rotationMat(c.rest.rotate, 25, 5),
    );
    for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
      expect(after[k]).toBeCloseTo(before[k], 6);
    }
  });

  it('ungroupPart shifts keyed child rotations and remaps translations through the group pose', () => {
    const doc = makeDoc(
      [makePart('g'), makePart('c')],
      [makeClip({
        tracks: [
          makeTrack('c', 'rotate', [[0, 0, 'linear'], [1000, 90, 'linear']]),
          makeTrack('c', 'tx', [[0, 0, 'linear'], [1000, 10, 'linear']]),
        ],
      })],
    );
    resetState(doc);
    const g = state.doc!.parts[0];
    const c = state.doc!.parts[1];
    g.kind = 'group';
    g.pivot = { x: 0, y: 0 };
    g.rest.rotate = 90; // A rotates (x,y) → (-y, x)
    c.parentId = 'g';
    c.pivot = { x: 0, y: 0 }; // cp == gp → k = 0
    expect(ungroupPart('g')).toBe(true);
    const clip = state.doc!.clips[0];
    const rot = clip.tracks.find((t) => t.channel === 'rotate')!;
    expect(rot.keyframes.map((k) => k.value)).toEqual([90, 180]);
    // gr ≠ 0 mixes axes: both tx and ty tracks exist, remapped t' = A·t (gt=0, k=0).
    const tx = clip.tracks.find((t) => t.channel === 'tx')!;
    const ty = clip.tracks.find((t) => t.channel === 'ty')!;
    expect(tx.keyframes.map((k) => Math.round(k.value))).toEqual([0, 0]); // -y = 0
    expect(ty.keyframes.map((k) => Math.round(k.value))).toEqual([0, 10]); // x
  });

  it('ungroupPart refuses animated nulls and parts with artwork', () => {
    const doc = makeDoc(
      [makePart('g'), makePart('art', { paths: [makePath('a')] })],
      [makeClip({ tracks: [makeTrack('g', 'rotate', [[0, 5, 'linear']])] })],
    );
    resetState(doc);
    state.doc!.parts[0].kind = 'group';
    expect(ungroupPart('g')).toBe(false); // animated
    expect(ungroupPart('art')).toBe(false); // has artwork
  });

  it('applyRigChanges creates bones, reparents with cycle guards, and moves pivots', () => {
    resetState(makeDoc([makePart('p1', { label: 'arm' })]));
    const map = applyRigChanges({
      addBones: [
        { label: 'shoulder', pivot: { x: 1, y: 2 }, parent: null },
        { label: 'elbow', pivot: { x: 3, y: 4 }, parent: 'shoulder' },
      ],
      reparent: [
        { part: 'arm', parent: 'elbow' },
        { part: 'shoulder', parent: 'nonexistent' }, // silently detaches to null
      ],
      movePivots: [{ part: 'arm', x: 9, y: 9 }],
    });
    const doc = state.doc!;
    const shoulder = doc.parts.find((p) => p.label === 'shoulder')!;
    const elbow = doc.parts.find((p) => p.label === 'elbow')!;
    const arm = doc.parts.find((p) => p.label === 'arm')!;
    expect(shoulder.kind).toBe('bone');
    expect(elbow.parentId).toBe(shoulder.id);
    expect(arm.parentId).toBe(elbow.id);
    expect(arm.pivot).toEqual({ x: 9, y: 9 });
    expect(map.get('elbow')).toBe(elbow.id);
    // duplicate label is skipped
    const before = doc.parts.length;
    applyRigChanges({ addBones: [{ label: 'arm', pivot: { x: 0, y: 0 }, parent: null }], reparent: [], movePivots: [] });
    expect(doc.parts.length).toBe(before);
  });

  it('applyRigChanges sets boneTip when a new bone carries an optional tip, and leaves it null otherwise', () => {
    resetState(makeDoc([makePart('p1')]));
    applyRigChanges({
      addBones: [
        { label: 'shoulder', pivot: { x: 1, y: 2 }, parent: null, tip: { x: 10, y: 2 } },
        { label: 'wrist', pivot: { x: 20, y: 2 }, parent: 'shoulder' }, // no tip
      ],
      reparent: [],
      movePivots: [],
    });
    const doc = state.doc!;
    const shoulder = doc.parts.find((p) => p.label === 'shoulder')!;
    const wrist = doc.parts.find((p) => p.label === 'wrist')!;
    expect(shoulder.boneTip).toEqual({ x: 10, y: 2 });
    expect(wrist.boneTip).toBeUndefined(); // addNullPart defaults boneTip unset; no tip given
  });

  it('applyRigChanges carries bindParts through the label→id map (binding itself is applied by the caller)', () => {
    resetState(makeDoc([makePart('p1', { label: 'forearm' })]));
    const changes = {
      addBones: [
        { label: 'elbow', pivot: { x: 5, y: 5 }, parent: null, tip: { x: 15, y: 5 }, bindParts: ['forearm'] },
      ],
      reparent: [],
      movePivots: [],
    };
    const map = applyRigChanges(changes);
    // applyRigChanges itself never touches part.skin — bindParts is carried in the
    // RigChanges value only, resolved by the caller (panels/ai.ts) against this map.
    const elbowId = map.get('elbow')!;
    expect(elbowId).toBeDefined();
    const forearm = state.doc!.parts.find((p) => p.label === 'forearm')!;
    expect(forearm.skin).toBeUndefined(); // makePart's default — never touched by applyRigChanges
    expect(changes.addBones[0].bindParts).toEqual(['forearm']);
  });
});

// ---- Project save/load round trip ----
//
// serializeDoc is a blind JSON.stringify of the live RigDoc, so nothing on the object
// is lost by construction UNLESS a field is left `undefined` (JSON drops the key) or
// some code path attaches a value the type doesn't declare. The tests below build one
// document that sets EVERY field on every type at once — including the ones easy to
// forget (boneTip, skin, pivotHint, nodeTypes, rest skew, a negative rest scale flip,
// a custom bezier alongside a preset easing, an enabled artboard distinct from the
// viewBox) — with no field left `undefined`, so a second serialize of the
// round-tripped doc must be byte-identical to the first.

const TORSO = 'torso';
const SHOULDER = 'shoulder_bone';
const ELBOW = 'elbow_bone';
const GROUP1 = 'group1';
const LEFT_ARM = 'left_arm';
const SKINNED_HAND = 'skinned_hand';

function maximalDoc(): RigDoc {
  return {
    name: 'maximal_test_rig',
    viewBox: { x: 0, y: 0, w: 120, h: 120 },
    // Enabled and deliberately offset/sized differently from the viewBox, so the round
    // trip proves the two rects are independent (not one derived from the other).
    artboard: { enabled: true, x: -10, y: -5, w: 140, h: 130 },
    rootPivot: { x: 50, y: 90 },
    // Draw order deliberately does NOT match the parent hierarchy or creation order —
    // doc.parts array order IS paint order and must round-trip independently of it.
    parts: [
      {
        id: SKINNED_HAND, label: 'hand', kind: 'art', transform: '',
        pivot: { x: 100, y: 55 }, pivotHint: null, boneTip: null,
        rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 },
        parentId: null, // skinning zeroes the parent chain per convention
        skin: {
          bones: [
            {
              id: SHOULDER,
              restWorldInv: { a: 1, b: 0, c: 0, d: 1, e: -50, f: -55 },
              bindSeg: { p: { x: 50, y: 55 }, q: { x: 70, y: 55 } },
            },
            {
              id: ELBOW,
              restWorldInv: { a: 0.966, b: 0.259, c: -0.259, d: 0.966, e: -67.6, f: -38.8 },
              bindSeg: { p: { x: 70, y: 55 }, q: { x: 90, y: 55 } },
            },
          ],
        },
        paths: [makePath2('hand_path_1', 'palm', 'M 100,50 L 110,50 L 110,60 L 100,60 Z', 'zzzz', {
          fill: '#ffddaa', fillOpacity: 1, stroke: '#552200', strokeWidth: 1, strokeOpacity: 1, transform: '',
        })],
      },
      {
        id: ELBOW, label: 'elbow', kind: 'bone', transform: '',
        pivot: { x: 70, y: 55 }, pivotHint: null, boneTip: { x: 90, y: 55 },
        rest: { rotate: 15, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 },
        parentId: SHOULDER, skin: null, paths: [],
      },
      {
        id: GROUP1, label: 'body_group', kind: 'group', transform: '',
        pivot: { x: 50, y: 40 }, pivotHint: null, boneTip: null,
        rest: { rotate: 5, tx: 1, ty: -1, sx: 1, sy: 1, kx: 0, ky: 0 },
        parentId: null, skin: null, paths: [],
      },
      {
        id: LEFT_ARM, label: 'left_arm', kind: 'art', transform: '',
        pivot: { x: 90, y: 55 }, pivotHint: null, boneTip: null,
        rest: { rotate: -8, tx: 2, ty: 3, sx: 1, sy: 1, kx: 0, ky: 0 },
        parentId: ELBOW, skin: null,
        paths: [makePath2('arm_path_1', 'forearm', 'M 90,50 C 95,50 100,52 100,55 S 95,60 90,60 Z', 'css', {
          fill: '#ffcc99', fillOpacity: 1, stroke: null, strokeWidth: 0, strokeOpacity: 1, transform: '',
        })],
      },
      {
        id: TORSO, label: 'torso', kind: 'art', transform: 'translate(10,10)',
        pivot: { x: 50, y: 50 }, pivotHint: { kind: 'centerOffset', dx: 2.5, dy: -1.5 }, boneTip: null,
        // Negative sx = a flip, kx/ky = rest skew — both innermost-local-transform features.
        rest: { rotate: 12, tx: 4, ty: -6, sx: -1.2, sy: 1.1, kx: 7.5, ky: -3.25 },
        parentId: GROUP1, skin: null,
        paths: [
          makePath2('torso_path_1', 'body_fill', 'M 0,0 L 10,0 L 10,10 L 0,10 Z', 'cccc', {
            fill: '#ff6600', fillOpacity: 0.9, stroke: '#000000', strokeWidth: 1.5, strokeOpacity: 1,
            transform: 'translate(1,1)',
          }),
          makePath2('torso_path_2', 'body_shadow', 'M 2,2 L 8,2 L 8,8 Z', null, {
            fill: null, fillOpacity: 1, stroke: '#333333', strokeWidth: 0.5, strokeOpacity: 0.5, transform: '',
          }),
        ],
      },
      {
        id: SHOULDER, label: 'shoulder', kind: 'bone', transform: '',
        pivot: { x: 50, y: 55 }, pivotHint: null, boneTip: { x: 70, y: 55 },
        rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 },
        parentId: TORSO, skin: null, paths: [],
      },
    ],
    clips: [
      {
        name: 'idle',
        duration: 2000,
        tracks: [
          {
            target: TORSO, channel: 'rotate',
            keyframes: [
              { time: 0, value: 0, easing: 'linear', bezier: null },
              { time: 500, value: 10, easing: 'easeIn', bezier: null },
              { time: 1000, value: -5, easing: 'easeOut', bezier: null },
              // Custom bezier alongside a preset easing fallback (bezier wins per convention).
              { time: 2000, value: 0, easing: 'easeInOut', bezier: [0.17, 0.67, 0.83, 0.32] },
            ],
          },
          {
            target: LEFT_ARM, channel: 'tx',
            keyframes: [
              { time: 0, value: 0, easing: 'linear', bezier: null },
              { time: 2000, value: 15, easing: 'linear', bezier: null },
            ],
          },
          {
            target: 'root', channel: 'sy', // whole-figure squash/stretch target
            keyframes: [
              { time: 0, value: 1, easing: 'easeOut', bezier: null },
              { time: 300, value: 1.2, easing: 'easeIn', bezier: null },
              { time: 600, value: 1, easing: 'linear', bezier: null },
            ],
          },
          {
            target: SHOULDER, channel: 'rotate',
            keyframes: [
              { time: 0, value: 0, easing: 'linear', bezier: null },
              { time: 2000, value: 20, easing: 'easeInOut', bezier: null },
            ],
          },
        ],
      },
      {
        name: 'wave',
        duration: 3500, // a second clip with a DIFFERENT duration
        tracks: [
          {
            target: ELBOW, channel: 'rotate',
            keyframes: [
              { time: 0, value: 0, easing: 'linear', bezier: null },
              { time: 1750, value: 45, easing: 'easeInOut', bezier: [0.25, 0.1, 0.25, 1] },
              { time: 3500, value: 0, easing: 'easeIn', bezier: null },
            ],
          },
          {
            target: LEFT_ARM, channel: 'rotate',
            keyframes: [
              { time: 0, value: 0, easing: 'linear', bezier: null },
              { time: 3500, value: -30, easing: 'easeOut', bezier: null },
            ],
          },
        ],
      },
    ],
    // A fully-populated state machine: all 3 input types, entry/any/exit + 2 animation
    // states, unconditional + conditional (bool/number/trigger) transitions with blend
    // durations, and a listener with 2 actions. Every reference resolves, so normalizeDoc
    // leaves it byte-identical on the round trip.
    stateMachines: [
      {
        id: 'sm_main',
        name: 'main',
        inputs: [
          { id: 'in_speed', name: 'speed', type: 'number', default: 0 },
          { id: 'in_waving', name: 'waving', type: 'bool', default: false },
          { id: 'in_jump', name: 'jump', type: 'trigger' },
        ],
        states: [
          { id: 'st_entry', name: 'Entry', kind: 'entry' },
          { id: 'st_any', name: 'Any', kind: 'any' },
          { id: 'st_exit', name: 'Exit', kind: 'exit' },
          { id: 'st_idle', name: 'Idle', kind: 'animation', clipName: 'idle', loop: true },
          { id: 'st_wave', name: 'Wave', kind: 'animation', clipName: 'wave', loop: false },
        ],
        transitions: [
          { id: 'tr_enter', fromId: 'st_entry', toId: 'st_idle', durationMs: 0, conditions: [] },
          {
            id: 'tr_wave', fromId: 'st_idle', toId: 'st_wave', durationMs: 200,
            conditions: [{ inputId: 'in_waving', op: '==', value: true }],
          },
          {
            id: 'tr_back', fromId: 'st_wave', toId: 'st_idle', durationMs: 300,
            conditions: [{ inputId: 'in_jump' }], // trigger condition: just an inputId
          },
          {
            id: 'tr_exit', fromId: 'st_any', toId: 'st_exit', durationMs: 0,
            conditions: [{ inputId: 'in_speed', op: '>', value: 5 }],
          },
        ],
        listeners: [
          {
            id: 'ls_torso', targetPartId: TORSO, event: 'down',
            actions: [
              { inputId: 'in_waving', type: 'setBool', value: true },
              { inputId: 'in_jump', type: 'fireTrigger' },
            ],
          },
        ],
      },
    ],
  };
}

function makePath2(
  id: string, label: string, d: string, nodeTypes: string | null,
  paint: { fill: string | null; fillOpacity: number; stroke: string | null; strokeWidth: number; strokeOpacity: number; transform: string },
) {
  return { id, label, d, nodeTypes, ...paint };
}

describe('serializeDoc / deserializeDoc round trip', () => {
  it('round-trips every field of a maximal document exactly, and stably (second serialize is byte-identical)', () => {
    const doc = maximalDoc();
    const json1 = serializeDoc(doc);
    const restored = deserializeDoc(json1);

    expect(restored).toEqual(doc); // whole-tree deep equality

    const json2 = serializeDoc(restored);
    expect(json2).toBe(json1); // stable round trip — no drift, no reordering, no new defaults
  });

  it('preserves draw order (doc.parts array order) independently of the parent hierarchy', () => {
    const doc = maximalDoc();
    const restored = deserializeDoc(serializeDoc(doc));
    expect(restored.parts.map((p) => p.id)).toEqual(doc.parts.map((p) => p.id));
    expect(restored.parts.map((p) => p.id)).toEqual([
      SKINNED_HAND, ELBOW, GROUP1, LEFT_ARM, TORSO, SHOULDER,
    ]);
  });

  it('preserves part kind, rest skew/negative-scale, pivotHint, and boneTip per part', () => {
    const doc = maximalDoc();
    const restored = deserializeDoc(serializeDoc(doc));
    const torso = restored.parts.find((p) => p.id === TORSO)!;
    const shoulder = restored.parts.find((p) => p.id === SHOULDER)!;
    const group = restored.parts.find((p) => p.id === GROUP1)!;

    expect(torso.rest).toEqual({ rotate: 12, tx: 4, ty: -6, sx: -1.2, sy: 1.1, kx: 7.5, ky: -3.25 });
    expect(torso.pivotHint).toEqual({ kind: 'centerOffset', dx: 2.5, dy: -1.5 });
    expect(shoulder.kind).toBe('bone');
    expect(shoulder.boneTip).toEqual({ x: 70, y: 55 });
    expect(group.kind).toBe('group');
    expect(group.paths).toEqual([]);
  });

  it('preserves skin bindings — bone refs, restWorldInv, and bindSeg', () => {
    const doc = maximalDoc();
    const restored = deserializeDoc(serializeDoc(doc));
    const hand = restored.parts.find((p) => p.id === SKINNED_HAND)!;
    expect(hand.skin?.bones.map((b) => b.id)).toEqual([SHOULDER, ELBOW]);
    expect(hand.skin?.bones[1].restWorldInv).toEqual(
      { a: 0.966, b: 0.259, c: -0.259, d: 0.966, e: -67.6, f: -38.8 },
    );
    expect(hand.skin?.bones[0].bindSeg).toEqual({ p: { x: 50, y: 55 }, q: { x: 70, y: 55 } });
  });

  it('preserves per-path node types and distinct paint properties across multiple paths', () => {
    const doc = maximalDoc();
    const restored = deserializeDoc(serializeDoc(doc));
    const torso = restored.parts.find((p) => p.id === TORSO)!;
    expect(torso.paths).toHaveLength(2);
    expect(torso.paths[0]).toMatchObject({
      nodeTypes: 'cccc', fill: '#ff6600', fillOpacity: 0.9, stroke: '#000000', strokeWidth: 1.5,
    });
    expect(torso.paths[1]).toMatchObject({
      nodeTypes: null, fill: null, stroke: '#333333', strokeOpacity: 0.5,
    });
  });

  it('preserves 2+ clips with distinct names/durations, and per-keyframe easing + bezier precedence', () => {
    const doc = maximalDoc();
    const restored = deserializeDoc(serializeDoc(doc));
    expect(restored.clips.map((c) => [c.name, c.duration])).toEqual([['idle', 2000], ['wave', 3500]]);

    const rot = restored.clips[0].tracks.find((t) => t.target === TORSO && t.channel === 'rotate')!;
    expect(rot.keyframes.map((k) => k.easing)).toEqual(['linear', 'easeIn', 'easeOut', 'easeInOut']);
    expect(rot.keyframes[3].bezier).toEqual([0.17, 0.67, 0.83, 0.32]); // overrides easeInOut when sampled

    const waveElbow = restored.clips[1].tracks.find((t) => t.target === ELBOW)!;
    expect(waveElbow.keyframes[1].bezier).toEqual([0.25, 0.1, 0.25, 1]);

    const rootTrack = restored.clips[0].tracks.find((t) => t.target === 'root' && t.channel === 'sy')!;
    expect(rootTrack.keyframes).toHaveLength(3);
  });

  it('samples identically before and after the round trip (functional, not just structural, equivalence)', () => {
    const doc = maximalDoc();
    resetState(doc);
    const before = [0, 250, 500, 750, 1000, 1500, 2000].map((t) => sampleChannel(TORSO, 'rotate', t));

    const restored = deserializeDoc(serializeDoc(doc));
    resetState(restored);
    const after = [0, 250, 500, 750, 1000, 1500, 2000].map((t) => sampleChannel(TORSO, 'rotate', t));

    expect(after).toEqual(before);
  });

  it('round-trips a state machine — inputs (all 3 kinds), states, transitions, listeners', () => {
    const doc = maximalDoc();
    const restored = deserializeDoc(serializeDoc(doc));
    const sm = restored.stateMachines![0];
    expect(sm.inputs.map((i) => i.type)).toEqual(['number', 'bool', 'trigger']);
    expect(sm.states.map((s) => s.kind)).toEqual(['entry', 'any', 'exit', 'animation', 'animation']);
    const wave = sm.states.find((s) => s.id === 'st_wave')!;
    expect(wave).toMatchObject({ clipName: 'wave', loop: false });
    // Unconditional entry transition, conditional bool/trigger/number transitions, blends.
    expect(sm.transitions.map((t) => t.durationMs)).toEqual([0, 200, 300, 0]);
    expect(sm.transitions[0].conditions).toEqual([]); // unconditional
    expect(sm.transitions[2].conditions).toEqual([{ inputId: 'in_jump' }]); // bare trigger
    expect(sm.transitions[3].conditions).toEqual([{ inputId: 'in_speed', op: '>', value: 5 }]);
    expect(sm.listeners[0].actions).toHaveLength(2);
    expect(sm.listeners[0].targetPartId).toBe(TORSO);
  });
});

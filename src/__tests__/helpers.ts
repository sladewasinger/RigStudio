/**
 * Shared fixtures for the unit-test suite. Builds minimal RigDoc structures and resets
 * the module-level app-state singleton between tests.
 */

import {
  Channel,
  Clip,
  Easing,
  RigDoc,
  RigPart,
  RigPath,
  Track,
  state,
} from '../core/model';

export function makePath(id: string, overrides: Partial<RigPath> = {}): RigPath {
  return {
    id,
    label: id,
    d: 'M 0,0 L 1,1',
    fill: '#000000',
    fillOpacity: 1,
    stroke: null,
    strokeWidth: 1,
    strokeOpacity: 1,
    transform: '',
    ...overrides,
  };
}

export function makePart(id: string, overrides: Partial<RigPart> = {}): RigPart {
  return {
    id,
    label: id,
    kind: 'art',
    transform: '',
    pivot: { x: 0, y: 0 },
    pivotHint: null,
    rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 },
    parentId: null,
    paths: [],
    ...overrides,
  };
}

export function makeClip(overrides: Partial<Clip> = {}): Clip {
  return { name: 'idle', duration: 2000, tracks: [], ...overrides };
}

/** [time, value, easing] triples → a Track. */
export function makeTrack(
  target: string,
  channel: Channel,
  keys: [number, number, Easing][],
): Track {
  return {
    target,
    channel,
    keyframes: keys.map(([time, value, easing]) => ({ time, value, easing })),
  };
}

export function makeDoc(parts: RigPart[] = [], clips: Clip[] = [makeClip()]): RigDoc {
  return {
    name: 'test',
    viewBox: { x: 0, y: 0, w: 100, h: 100 },
    parts,
    rootPivot: { x: 50, y: 80 },
    clips,
  };
}

/** Point the app-state singleton at a fresh document (or nothing). */
export function resetState(doc: RigDoc | null = null): void {
  state.doc = doc;
  state.activeClipIndex = 0;
  state.currentTime = 0;
  state.selectedPartId = null;
  state.selectedPartIds = [];
  state.selectedPathId = null;
  state.playing = false;
}

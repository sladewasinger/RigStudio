/**
 * Document model and application state for Rig Studio.
 *
 * A RigDoc is an imported SVG reorganized for rigging: each named top-level group
 * becomes a RigPart with a pivot point (the joint), verbatim baked transforms, and its
 * drawable paths. Animation lives in Clips: named timelines of per-channel keyframes.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface RigPath {
  id: string;
  /** Normalized absolute path data (all shapes are converted to paths on import). */
  d: string;
  fill: string | null;
  fillOpacity: number;
  stroke: string | null;
  strokeWidth: number;
  strokeOpacity: number;
  /** Verbatim SVG transform accumulated from ancestors between the part group and this path. */
  transform: string;
}

export interface RigPart {
  id: string;
  label: string;
  /** Verbatim SVG transform of the part's group — the authored rest placement. */
  transform: string;
  /** Joint location in root (document) coordinates. Animated rotation spins around it. */
  pivot: Vec2;
  paths: RigPath[];
}

/** Animatable channels. Parts support all three; the root figure also supports scale. */
export type Channel = 'rotate' | 'tx' | 'ty' | 'sx' | 'sy';

export type Easing = 'linear' | 'easeInOut';

export interface Keyframe {
  time: number; // ms
  value: number;
  easing: Easing; // easing of the segment arriving at this keyframe
}

export interface Track {
  /** A part id, or 'root' for the whole-figure group. */
  target: string;
  channel: Channel;
  keyframes: Keyframe[];
}

export interface Clip {
  name: string;
  duration: number; // ms
  tracks: Track[];
}

export interface RigDoc {
  name: string;
  viewBox: { x: number; y: number; w: number; h: number };
  parts: RigPart[];
  /** Pivot for root-level scale (e.g. squash-and-stretch around the ground). */
  rootPivot: Vec2;
  clips: Clip[];
}

export const CHANNEL_DEFAULTS: Record<Channel, number> = {
  rotate: 0,
  tx: 0,
  ty: 0,
  sx: 1,
  sy: 1,
};

// ---- Application state ----

export type Mode = 'rig' | 'nodes';

export interface AppState {
  doc: RigDoc | null;
  selectedPartId: string | null;
  activeClipIndex: number;
  currentTime: number;
  playing: boolean;
  mode: Mode;
}

export const state: AppState = {
  doc: null,
  selectedPartId: null,
  activeClipIndex: 0,
  currentTime: 0,
  playing: false,
  mode: 'rig',
};

type Listener = () => void;
const listeners: Listener[] = [];

/** Subscribe to any state/document change. Panels re-render on notify(). */
export function subscribe(fn: Listener): void {
  listeners.push(fn);
}

export function notify(): void {
  for (const fn of listeners) fn();
}

export function activeClip(): Clip | null {
  if (!state.doc) return null;
  return state.doc.clips[state.activeClipIndex] ?? null;
}

export function selectedPart(): RigPart | null {
  if (!state.doc || !state.selectedPartId) return null;
  return state.doc.parts.find((p) => p.id === state.selectedPartId) ?? null;
}

// ---- Pose evaluation ----

function ease(t: number, easing: Easing): number {
  if (easing === 'easeInOut') return t * t * (3 - 2 * t); // smoothstep
  return t;
}

/** Sample a channel value from the active clip at the given time. */
export function sampleChannel(target: string, channel: Channel, time: number): number {
  const clip = activeClip();
  const fallback = CHANNEL_DEFAULTS[channel];
  if (!clip) return fallback;
  const track = clip.tracks.find((t) => t.target === target && t.channel === channel);
  if (!track || track.keyframes.length === 0) return fallback;

  const keys = track.keyframes;
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;

  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i];
    const k1 = keys[i + 1];
    if (time >= k0.time && time <= k1.time) {
      const span = k1.time - k0.time;
      const t = span === 0 ? 1 : (time - k0.time) / span;
      return k0.value + (k1.value - k0.value) * ease(t, k1.easing);
    }
  }
  return fallback;
}

/**
 * Write a keyframe for the channel at the current time (auto-key). Creates the track on
 * first use; replaces an existing keyframe at (almost) the same time.
 */
export function setKeyframe(target: string, channel: Channel, value: number): void {
  const clip = activeClip();
  if (!clip) return;
  const time = Math.round(state.currentTime / 10) * 10;

  let track = clip.tracks.find((t) => t.target === target && t.channel === channel);
  if (!track) {
    track = { target, channel, keyframes: [] };
    clip.tracks.push(track);
  }
  const existing = track.keyframes.find((k) => Math.abs(k.time - time) < 5);
  if (existing) {
    existing.value = value;
  } else {
    track.keyframes.push({ time, value, easing: 'easeInOut' });
    track.keyframes.sort((a, b) => a.time - b.time);
  }
}

export function deleteKeyframe(track: Track, keyframe: Keyframe): void {
  const clip = activeClip();
  if (!clip) return;
  track.keyframes = track.keyframes.filter((k) => k !== keyframe);
  if (track.keyframes.length === 0) {
    clip.tracks = clip.tracks.filter((t) => t !== track);
  }
}

let idCounter = 0;
export function freshId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

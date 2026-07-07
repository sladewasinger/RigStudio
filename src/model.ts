/**
 * Document model and application state for Rig Studio.
 *
 * A RigDoc is an imported SVG reorganized for rigging: each named top-level group
 * becomes a RigPart with a pivot point (the joint), verbatim baked transforms, and its
 * drawable paths. Parts may be parented to one another (parentId) so limbs chain.
 * Animation lives in Clips: named timelines of per-channel keyframes. Each part also
 * carries a rest pose — offsets edited in Setup mode that keyframes add on top of.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface RigPath {
  id: string;
  /** Display name from the SVG leaf's inkscape:label (or id) — shown in the layers tree. */
  label: string;
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

/** Where a part's pivot should land once geometry is measurable (resolved by the canvas). */
export type PivotHint =
  /** Offset from the part's rendered bbox center, in document units (+y down). */
  { kind: 'centerOffset'; dx: number; dy: number };

/**
 * The character's rest pose, edited in Setup mode. A channel with keyframes ignores
 * these (keyed values are ABSOLUTE); a channel without keyframes displays its rest
 * value. Scale is Setup-only (no scale keyframes on parts) and is applied along the
 * artwork's own axes around the joint, so resizing never moves the pivot.
 */
export interface RestPose {
  rotate: number;
  tx: number;
  ty: number;
  sx: number;
  sy: number;
}

export interface RigPart {
  id: string;
  label: string;
  /** Verbatim SVG transform of the part's group — the authored rest placement. */
  transform: string;
  /** Joint location in root (document) coordinates. Animated rotation spins around it. */
  pivot: Vec2;
  /** Pending pivot placement that needs layout to resolve; cleared once applied. */
  pivotHint?: PivotHint | null;
  rest: RestPose;
  /** Another part's id to inherit motion from (bone hierarchy), or null. */
  parentId: string | null;
  paths: RigPath[];
}

/** Animatable channels. Parts support all three; the root figure also supports scale. */
export type Channel = 'rotate' | 'tx' | 'ty' | 'sx' | 'sy';

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export const EASINGS: Easing[] = ['linear', 'easeIn', 'easeOut', 'easeInOut'];

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

/** The canvas tool within Setup mode: pose the rig or edit path nodes. */
export type Mode = 'rig' | 'nodes';

/**
 * The global editing mode. Setup edits the character itself (rest pose, pivots, nodes)
 * and never touches keyframes; Animate records keyframes at the playhead.
 */
export type EditorMode = 'setup' | 'animate';

export interface AppState {
  doc: RigDoc | null;
  /** Primary selection (inspector target). */
  selectedPartId: string | null;
  /** Full selection set for multi-part posing; always contains selectedPartId when set. */
  selectedPartIds: string[];
  /** A single path within the selected part ("entered" like an SVG editor group), or null. */
  selectedPathId: string | null;
  activeClipIndex: number;
  currentTime: number;
  playing: boolean;
  mode: Mode;
  editorMode: EditorMode;
  playbackSpeed: number;
  pingPong: boolean;
  /** Playback direction, flipped by ping-pong looping. */
  playDirection: 1 | -1;
  onionSkin: boolean;
}

export const state: AppState = {
  doc: null,
  selectedPartId: null,
  selectedPartIds: [],
  selectedPathId: null,
  activeClipIndex: 0,
  currentTime: 0,
  playing: false,
  mode: 'rig',
  editorMode: 'setup',
  playbackSpeed: 1,
  pingPong: false,
  playDirection: 1,
  onionSkin: false,
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

export function selectedParts(): RigPart[] {
  if (!state.doc) return [];
  return state.selectedPartIds
    .map((id) => state.doc!.parts.find((p) => p.id === id))
    .filter((p): p is RigPart => !!p);
}

/** Set or extend the selection. Additive keeps existing parts (shift-click). */
export function selectPart(id: string | null, additive = false): void {
  if (id !== state.selectedPartId) state.selectedPathId = null;
  if (id === null) {
    state.selectedPartId = null;
    state.selectedPartIds = [];
    return;
  }
  if (additive) {
    if (!state.selectedPartIds.includes(id)) state.selectedPartIds.push(id);
    state.selectedPartId = id;
  } else {
    state.selectedPartId = id;
    state.selectedPartIds = [id];
  }
}

export function selectedPath(): { part: RigPart; path: RigPath } | null {
  const part = selectedPart();
  if (!part || !state.selectedPathId) return null;
  const path = part.paths.find((p) => p.id === state.selectedPathId);
  return path ? { part, path } : null;
}

// ---- Part hierarchy ----

export function partById(id: string): RigPart | null {
  return state.doc?.parts.find((p) => p.id === id) ?? null;
}

/** Ancestors of a part, outermost first. Cycle-safe (stops on repeat). */
export function ancestorChain(part: RigPart): RigPart[] {
  const chain: RigPart[] = [];
  const seen = new Set<string>([part.id]);
  let cur = part.parentId ? partById(part.parentId) : null;
  while (cur && !seen.has(cur.id)) {
    chain.unshift(cur);
    seen.add(cur.id);
    cur = cur.parentId ? partById(cur.parentId) : null;
  }
  return chain;
}

export function isAncestorOf(maybeAncestor: RigPart, part: RigPart): boolean {
  return ancestorChain(part).some((p) => p.id === maybeAncestor.id);
}

/** Reparent a part; refuses cycles. Returns whether the change was applied. */
export function setParent(childId: string, parentId: string | null): boolean {
  const child = partById(childId);
  if (!child) return false;
  if (parentId === null) {
    child.parentId = null;
    return true;
  }
  if (parentId === childId) return false;
  const parent = partById(parentId);
  if (!parent) return false;
  if (isAncestorOf(child, parent)) return false; // would create a cycle
  child.parentId = parentId;
  return true;
}

// ---- Draw order (z-order) ----
// doc.parts array order IS the paint order: last = drawn on top. The layers panel
// lists topmost first, so "up the layer list" means "later in doc.parts".

/** Whether the current selection (entered path, else part) can move a step in z. */
export function canMoveSelectedInDrawOrder(delta: 1 | -1): boolean {
  const doc = state.doc;
  const part = selectedPart();
  if (!doc || !part) return false;
  if (state.selectedPathId) {
    const i = part.paths.findIndex((p) => p.id === state.selectedPathId);
    return i >= 0 && i + delta >= 0 && i + delta < part.paths.length;
  }
  const i = doc.parts.indexOf(part);
  return i + delta >= 0 && i + delta < doc.parts.length;
}

/** Move the entered path (within its part) or the selected part one z step (+1 = up). */
export function moveSelectedInDrawOrder(delta: 1 | -1): boolean {
  if (!canMoveSelectedInDrawOrder(delta)) return false;
  const doc = state.doc!;
  const part = selectedPart()!;
  if (state.selectedPathId) {
    const i = part.paths.findIndex((p) => p.id === state.selectedPathId);
    [part.paths[i], part.paths[i + delta]] = [part.paths[i + delta], part.paths[i]];
  } else {
    const i = doc.parts.indexOf(part);
    [doc.parts[i], doc.parts[i + delta]] = [doc.parts[i + delta], doc.parts[i]];
  }
  return true;
}

/**
 * Drop a part just above/below another in the layers tree: it draws immediately on
 * top of ('above') or beneath ('below') `refId` and becomes its sibling — adopting
 * ref's parent, like dropping between rows in any layer tree. Refuses when adopting
 * that parent would create a cycle.
 */
export function movePartRelativeTo(
  partId: string, refId: string, place: 'above' | 'below',
): boolean {
  const doc = state.doc;
  if (!doc || partId === refId) return false;
  const part = partById(partId);
  const ref = partById(refId);
  if (!part || !ref) return false;
  if (ref.parentId !== part.parentId && !setParent(partId, ref.parentId)) return false;
  doc.parts.splice(doc.parts.indexOf(part), 1);
  const refIdx = doc.parts.indexOf(ref);
  doc.parts.splice(place === 'above' ? refIdx + 1 : refIdx, 0, part);
  return true;
}

// ---- Pose evaluation ----

function ease(t: number, easing: Easing): number {
  switch (easing) {
    case 'easeIn': return t * t;
    case 'easeOut': return 1 - (1 - t) * (1 - t);
    case 'easeInOut': return t * t * (3 - 2 * t); // smoothstep
    default: return t;
  }
}

/**
 * The value a part's channel displays at a time: the ABSOLUTE keyframed value when the
 * channel is keyed in the active clip, otherwise the part's rest value. This is what
 * makes editing the rest pose in Setup mode safe — it never shifts keyed animation.
 * Pass time = null to read the bare rest pose (Setup mode).
 */
export function channelValue(part: RigPart, channel: Channel, time: number | null): number {
  const rest =
    channel === 'rotate' ? part.rest.rotate
    : channel === 'tx' ? part.rest.tx
    : channel === 'ty' ? part.rest.ty
    : channel === 'sx' ? part.rest.sx
    : part.rest.sy;
  if (time === null) return rest;
  const clip = activeClip();
  const track = clip?.tracks.find((t) => t.target === part.id && t.channel === channel);
  if (!track || track.keyframes.length === 0) return rest;
  return sampleChannel(part.id, channel, time);
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
 * Write a keyframe for the channel at an explicit time. Creates the track on first
 * use; replaces an existing keyframe at (almost) the same time. An explicit `easing`
 * overwrites the existing key's easing (paste); omitting it keeps a hand-set easing
 * intact when auto-key drags re-value the key.
 */
export function setKeyframeAt(
  target: string, channel: Channel, time: number, value: number, easing?: Easing,
): Keyframe {
  const clip = activeClip()!;
  let track = clip.tracks.find((t) => t.target === target && t.channel === channel);
  if (!track) {
    track = { target, channel, keyframes: [] };
    clip.tracks.push(track);
  }
  const existing = track.keyframes.find((k) => Math.abs(k.time - time) < 5);
  if (existing) {
    existing.value = value;
    if (easing !== undefined) existing.easing = easing;
    return existing;
  }
  const key: Keyframe = { time, value, easing: easing ?? 'easeInOut' };
  track.keyframes.push(key);
  track.keyframes.sort((a, b) => a.time - b.time);
  return key;
}

/** Auto-key at the playhead (canvas drags, inspector edits in Animate mode). */
export function setKeyframe(target: string, channel: Channel, value: number): void {
  if (!activeClip()) return;
  const time = Math.round(state.currentTime / 10) * 10;
  setKeyframeAt(target, channel, time, value);
}

export function deleteKeyframe(track: Track, keyframe: Keyframe): void {
  const clip = activeClip();
  if (!clip) return;
  track.keyframes = track.keyframes.filter((k) => k !== keyframe);
  if (track.keyframes.length === 0) {
    clip.tracks = clip.tracks.filter((t) => t !== track);
  }
}

// ---- Keyframe clipboard ----

export interface CopiedKey {
  target: string;
  channel: Channel;
  /** Offset from the earliest copied keyframe. */
  dt: number;
  value: number;
  easing: Easing;
}

let keyClipboard: CopiedKey[] = [];

export function copyKeys(entries: { track: Track; key: Keyframe }[]): number {
  if (entries.length === 0) return 0;
  const t0 = Math.min(...entries.map((e) => e.key.time));
  keyClipboard = entries.map(({ track, key }) => ({
    target: track.target,
    channel: track.channel,
    dt: key.time - t0,
    value: key.value,
    easing: key.easing,
  }));
  return keyClipboard.length;
}

export function clipboardSize(): number {
  return keyClipboard.length;
}

/** Paste the clipboard with its earliest key landing at `time`. Returns pasted keys. */
export function pasteKeysAt(time: number): Keyframe[] {
  const clip = activeClip();
  if (!clip || keyClipboard.length === 0) return [];
  const out: Keyframe[] = [];
  for (const ck of keyClipboard) {
    const t = Math.max(0, Math.round((time + ck.dt) / 10) * 10);
    out.push(setKeyframeAt(ck.target, ck.channel, t, ck.value, ck.easing));
  }
  return out;
}

/** Snapshot every animated channel's value at `time` into the clipboard (copy pose). */
export function copyPoseAt(time: number): number {
  const clip = activeClip();
  if (!clip) return 0;
  keyClipboard = clip.tracks
    .filter((t) => t.keyframes.length > 0)
    .map((t) => ({
      target: t.target,
      channel: t.channel,
      dt: 0,
      value: sampleChannel(t.target, t.channel, time),
      easing: 'easeInOut' as Easing,
    }));
  return keyClipboard.length;
}

// ---- Serialization (project save/load) ----

const DOC_FORMAT = 'rig-studio';
const DOC_VERSION = 2;

export function serializeDoc(doc: RigDoc): string {
  return JSON.stringify({ format: DOC_FORMAT, version: DOC_VERSION, doc }, null, 1);
}

/**
 * Parse a saved project (current or older format) into a usable RigDoc, filling in
 * fields that did not exist when the file was written.
 */
export function deserializeDoc(json: string): RigDoc {
  const raw = JSON.parse(json) as { format?: string; version?: number; doc?: unknown };
  const doc = (raw && typeof raw === 'object' && 'doc' in raw ? raw.doc : raw) as RigDoc;
  if (!doc || !Array.isArray(doc.parts) || !doc.viewBox) {
    throw new Error('Not a Rig Studio project file');
  }
  return normalizeDoc(doc);
}

/** Fill defaults for fields added after a document was serialized. */
export function normalizeDoc(doc: RigDoc): RigDoc {
  let maxId = 0;
  const trackId = (id: string) => {
    const m = /_(\d+)$/.exec(id);
    if (m) maxId = Math.max(maxId, Number(m[1]));
  };
  for (const part of doc.parts) {
    trackId(part.id);
    part.rest = part.rest ?? { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1 };
    part.rest.sx = part.rest.sx ?? 1;
    part.rest.sy = part.rest.sy ?? 1;
    part.parentId = part.parentId ?? null;
    part.pivotHint = part.pivotHint ?? null;
    part.paths.forEach((p, i) => {
      trackId(p.id);
      p.label = p.label ?? `path_${i + 1}`;
    });
  }
  // Drop dangling parent references (e.g. hand-edited files).
  const ids = new Set(doc.parts.map((p) => p.id));
  for (const part of doc.parts) {
    if (part.parentId && !ids.has(part.parentId)) part.parentId = null;
  }
  doc.clips = doc.clips?.length ? doc.clips : [{ name: 'idle', duration: 2000, tracks: [] }];
  for (const clip of doc.clips) {
    for (const track of clip.tracks) {
      for (const k of track.keyframes) {
        if (!EASINGS.includes(k.easing)) k.easing = 'easeInOut';
      }
    }
  }
  bumpIdCounter(maxId);
  return doc;
}

let idCounter = 0;
export function freshId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

/** Keep freshId ahead of ids present in a loaded document. */
export function bumpIdCounter(min: number): void {
  if (min > idCounter) idCounter = min;
}

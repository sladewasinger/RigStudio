// ---- Channels: keyframe sampling, writing, and the AI/timeline clipboards ----

import { Channel, CHANNEL_DEFAULTS, Clip, Easing, Keyframe, RigPart, Track } from './docTypes';
import { activeClip, state } from './appState';

function ease(t: number, easing: Easing): number {
  switch (easing) {
    case 'easeIn': return t * t;
    case 'easeOut': return 1 - (1 - t) * (1 - t);
    case 'easeInOut': return t * t * (3 - 2 * t); // smoothstep
    default: return t;
  }
}

/**
 * CSS-style cubic-bezier easing: solve x(u) = t for u (Newton with bisection
 * fallback), then evaluate y(u). Control x's are assumed clamped to 0..1.
 */
export function cubicBezierEase(
  x1: number, y1: number, x2: number, y2: number, t: number,
): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const bx = (u: number) => 3 * u * (1 - u) * (1 - u) * x1 + 3 * u * u * (1 - u) * x2 + u ** 3;
  const by = (u: number) => 3 * u * (1 - u) * (1 - u) * y1 + 3 * u * u * (1 - u) * y2 + u ** 3;
  const dbx = (u: number) =>
    3 * (1 - u) * (1 - u) * x1 + 6 * u * (1 - u) * (x2 - x1) + 3 * u * u * (1 - x2);
  let u = t;
  for (let i = 0; i < 8; i++) {
    const err = bx(u) - t;
    if (Math.abs(err) < 1e-6) return by(u);
    const d = dbx(u);
    if (Math.abs(d) < 1e-9) break;
    u -= err / d;
    if (u <= 0 || u >= 1) break;
  }
  let lo = 0, hi = 1;
  u = t;
  for (let i = 0; i < 24; i++) {
    if (bx(u) < t) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return by(u);
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
    : channel === 'sy' ? part.rest.sy
    : channel === 'opacity' ? part.rest.opacity
    : 0; // 'z' has no RestPose field — its stacking offset rests at 0 (CHANNEL_DEFAULTS.z)
  if (time === null) return rest;
  const clip = activeClip();
  const track = clip?.tracks.find((t) => t.target === part.id && t.channel === channel);
  if (!track || track.keyframes.length === 0) return rest;
  return sampleChannel(part.id, channel, time);
}

/**
 * Interpolate a sorted keyframe list at a time (pure — no state lookup).
 *
 * `stepped` (the draw-order `z` channel) switches to HOLD semantics: return the value of
 * the latest key at-or-before `time`, with easing/bezier ignored (a stacking rank is
 * discrete, not blendable). BEFORE the first key there is no rank yet, so it falls back to
 * `fallback` (rest 0) — unlike the interpolated path, which holds the first key backward.
 */
export function sampleKeyList(
  keys: Keyframe[], time: number, fallback: number, stepped = false,
): number {
  if (keys.length === 0) return fallback;
  if (stepped) {
    if (time < keys[0].time) return fallback; // no key has occurred yet → rest
    let v = keys[0].value;
    for (const k of keys) {
      if (k.time <= time) v = k.value;
      else break;
    }
    return v;
  }
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;

  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i];
    const k1 = keys[i + 1];
    if (time >= k0.time && time <= k1.time) {
      const span = k1.time - k0.time;
      const t = span === 0 ? 1 : (time - k0.time) / span;
      const eased = k1.bezier
        ? cubicBezierEase(k1.bezier[0], k1.bezier[1], k1.bezier[2], k1.bezier[3], t)
        : ease(t, k1.easing);
      return k0.value + (k1.value - k0.value) * eased;
    }
  }
  return fallback;
}

/** Sample a channel value from the active clip at the given time. */
export function sampleChannel(target: string, channel: Channel, time: number): number {
  const clip = activeClip();
  const fallback = CHANNEL_DEFAULTS[channel];
  if (!clip) return fallback;
  const track = clip.tracks.find((t) => t.target === target && t.channel === channel);
  if (!track) return fallback;
  return sampleKeyList(track.keyframes, time, fallback, channel === 'z');
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

/**
 * The keyframe on a channel at (approximately) a time, or null. Tolerance matches
 * `setKeyframeAt`'s replace-in-place window and the timeline's playhead-key match
 * (both `< 5`/`<= 5` ms, half the 10ms grid keys snap to) — a key created at the
 * playhead by one code path is found "at the playhead" by the other.
 */
export function keyAt(target: string, channel: Channel, time: number): Keyframe | null {
  const track = activeClip()?.tracks.find((t) => t.target === target && t.channel === channel);
  if (!track) return null;
  return track.keyframes.find((k) => Math.abs(k.time - time) <= 5) ?? null;
}

/**
 * Remove the keyframe at (approximately) a time — the inspector's keyframe-toggle-
 * circle "un-key" action. Reuses `deleteKeyframe`, so an emptied track is dropped from
 * the clip exactly like the timeline's key-delete button. Returns whether a keyframe
 * was actually removed.
 */
export function removeKeyAt(target: string, channel: Channel, time: number): boolean {
  const track = activeClip()?.tracks.find((t) => t.target === target && t.channel === channel);
  const key = track?.keyframes.find((k) => Math.abs(k.time - time) <= 5);
  if (!track || !key) return false;
  deleteKeyframe(track, key);
  return true;
}

// ---- AI Animate System v2 (A1: session & intent UX) ----

/**
 * A keyframe locked by the AI panel's "protect playhead keys" checkbox: the user is
 * parked at a specific frame while asking Claude to modify the clip, and wants exactly
 * the keys AT that frame (across every track) to survive untouched no matter what the
 * response contains. `snapshotProtectedKeys` captures them BEFORE the request (same
 * `<= 5` tolerance as `keyAt`, so a key "at the playhead" here is the same key
 * `keyAt`/`removeKeyAt` would find there); `enforceProtectedKeys` restores them AFTER the
 * response is applied — belt-and-suspenders on top of the prompt also listing them as
 * untouchable, since a model can still ignore instructions.
 */
export interface ProtectedKey {
  target: string; // part id, or 'root' (legacy)
  channel: Channel;
  time: number;
  value: number;
  easing: Easing;
  bezier?: [number, number, number, number] | null;
}

export function snapshotProtectedKeys(clip: Clip, atTime: number): ProtectedKey[] {
  const out: ProtectedKey[] = [];
  for (const track of clip.tracks) {
    const key = track.keyframes.find((k) => Math.abs(k.time - atTime) <= 5);
    if (key) {
      out.push({
        target: track.target,
        channel: track.channel,
        time: key.time,
        value: key.value,
        easing: key.easing,
        bezier: key.bezier ?? null,
      });
    }
  }
  return out;
}

/**
 * Force every protected key back onto `clip` exactly as snapshotted, whether the AI
 * response left the track alone, changed the key's value/easing/bezier, or dropped the
 * track (or just that key) entirely. Returns how many keys actually needed correcting —
 * 0 means the model behaved and this was a no-op. Pure and synchronous; callers wrap it
 * in their own checkpoint (see panels/ai.ts's `applyAiResult`).
 */
export function enforceProtectedKeys(clip: Clip, protectedKeys: ProtectedKey[]): number {
  let restored = 0;
  for (const pk of protectedKeys) {
    let track = clip.tracks.find((t) => t.target === pk.target && t.channel === pk.channel);
    if (!track) {
      track = { target: pk.target, channel: pk.channel, keyframes: [] };
      clip.tracks.push(track);
    }
    const existing = track.keyframes.find((k) => Math.abs(k.time - pk.time) <= 5);
    const changed =
      !existing
      || existing.value !== pk.value
      || existing.easing !== pk.easing
      || JSON.stringify(existing.bezier ?? null) !== JSON.stringify(pk.bezier ?? null);
    if (changed) restored++;
    if (existing) {
      existing.time = pk.time;
      existing.value = pk.value;
      existing.easing = pk.easing;
      existing.bezier = pk.bezier ?? undefined;
    } else {
      track.keyframes.push({
        time: pk.time, value: pk.value, easing: pk.easing, bezier: pk.bezier ?? undefined,
      });
      track.keyframes.sort((a, b) => a.time - b.time);
    }
  }
  return restored;
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

import {
  CHANNEL_DEFAULTS, Channel, Clip, Keyframe, RigDoc, Track, sampleKeyList,
} from '../../core/model';
import { PoseSampler } from '../../geometry/pose';
import { FPS } from './keys';

const trackKey = (track: Pick<Track, 'target' | 'channel'>) =>
  `${track.target}\u0000${track.channel}`;

/** Export-only state animation closure; authored lanes remain untouched. */
export function stateMachinePoseCompleteClips(doc: RigDoc): Map<string, Clip> {
  const closureByClip = new Map<string, Set<string>>();
  for (const machine of doc.stateMachines ?? []) {
    const names = [...new Set(machine.states
      .filter((machineState) => machineState.kind === 'animation' && machineState.clipName)
      .map((machineState) => machineState.clipName!))];
    const clips = names.map((name) => doc.clips.find((clip) => clip.name === name))
      .filter((clip): clip is Clip => !!clip);
    const closure = new Set(clips.flatMap((clip) => clip.tracks.map(trackKey)));
    for (const name of names) {
      const target = closureByClip.get(name) ?? new Set<string>();
      closure.forEach((key) => target.add(key));
      closureByClip.set(name, target);
    }
  }
  const partById = new Map(doc.parts.map((part) => [part.id, part]));
  const defaultValue = (target: string, channel: Channel): number => {
    if (channel === 'warp' || channel === 'z') return 0;
    if (target === 'root') return CHANNEL_DEFAULTS[channel];
    const part = partById.get(target);
    if (!part) return CHANNEL_DEFAULTS[channel];
    if (channel === 'visibility') return part.hidden ? 0 : 1;
    return part.rest[channel as keyof typeof part.rest] as number;
  };
  const result = new Map<string, Clip>();
  for (const clip of doc.clips) {
    const closure = closureByClip.get(clip.name);
    if (!closure) { result.set(clip.name, clip); continue; }
    const existing = new Set(clip.tracks.map(trackKey));
    const tracks = [...clip.tracks];
    for (const key of closure) {
      if (existing.has(key)) continue;
      const split = key.lastIndexOf('\u0000');
      const target = key.slice(0, split);
      const channel = key.slice(split + 1) as Channel;
      const value = defaultValue(target, channel);
      tracks.push({
        target, channel,
        keyframes: [
          { time: 0, value, easing: 'linear' },
          { time: clip.duration, value, easing: 'linear' },
        ],
      });
    }
    result.set(clip.name, { ...clip, tracks });
  }
  return result;
}

/** Rive's integer-frame clock expressed back in milliseconds for sampleKeyList. */
export function frameQuantizedKeys(track: Track | undefined, fps: number): Keyframe[] {
  const byFrame = new Map<number, Keyframe>();
  const sorted = [...(track?.keyframes ?? [])].sort((a, b) => a.time - b.time);
  for (const key of sorted) {
    const frame = Math.max(0, Math.round(key.time / 1000 * fps));
    byFrame.set(frame, { ...key, time: frame / fps * 1000 });
  }
  return [...byFrame.values()].sort((a, b) => a.time - b.time);
}

/** Canonical pose sampler for geometry compiled into an integer-frame Rive clip. */
export function riveFramePoseSampler(
  doc: RigDoc, clip: Clip, time: number, fps = doc.fps && doc.fps > 0 ? doc.fps : FPS,
): PoseSampler {
  const byId = new Map(doc.parts.map((part) => [part.id, part]));
  return (targetId, channel) => {
    const track = clip.tracks.find((candidate) =>
      candidate.target === targetId && candidate.channel === channel);
    const part = byId.get(targetId);
    let rest = CHANNEL_DEFAULTS[channel];
    if (part) {
      if (channel === 'visibility') rest = part.hidden ? 0 : 1;
      else if (channel !== 'z' && channel !== 'warp') {
        rest = part.rest[channel as keyof typeof part.rest] as number;
      }
    }
    return sampleKeyList(
      frameQuantizedKeys(track, fps), time, rest,
      channel === 'z' || channel === 'visibility',
    );
  };
}

import { Clip, effectiveVisibilityAt, RigDoc, RigPart, sampleKeyList } from '../../core/model';
import { argb, INTERP_HOLD, INTERP_LINEAR } from './keys';
import type { OpacityColorTarget } from './animation';

export interface BakedOpacityKey {
  frame: number;
  value: number;
  interpType: number;
  interpId: number;
}

export function bakeVisibilityOpacity(
  doc: RigDoc, clip: Clip, partId: string, targets: OpacityColorTarget[], fps: number,
  toFrame: (milliseconds: number, fps: number) => number,
): { colorIndex: number; keys: BakedOpacityKey[] }[] | null {
  const byId = new Map(doc.parts.map((candidate) => [candidate.id, candidate]));
  const part = byId.get(partId);
  if (!part) return null;
  const opacityKeys = [...(clip.tracks.find((track) =>
    track.target === partId && track.channel === 'opacity')?.keyframes ?? [])]
    .sort((left, right) => left.time - right.time);
  const ancestorIds = new Set<string>();
  let current: RigPart | undefined = part;
  while (current && !ancestorIds.has(current.id)) {
    ancestorIds.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  const visibilityAnimated = clip.tracks.some((track) =>
    track.channel === 'visibility' && track.keyframes.length > 0 && ancestorIds.has(track.target));
  if (!visibilityAnimated) return null;

  const frameMs = 1000 / fps;
  const frames = new Map<number, { opacity: number; visibility: number }>();
  for (let time = 0; time <= clip.duration + frameMs / 2; time += frameMs) {
    const at = Math.min(clip.duration, time);
    const visibility = effectiveVisibilityAt(doc, clip, part, at);
    frames.set(toFrame(at, fps), {
      visibility,
      opacity: Math.min(1, Math.max(0, sampleKeyList(opacityKeys, at, part.rest.opacity) * visibility)),
    });
  }
  return targets.map((target) => ({
    colorIndex: target.colorIndex,
    keys: [...frames].map(([frame, sample], index, all) => ({
      frame, value: argb(target.hex, target.baseOpacity * sample.opacity),
      interpType: all[index + 1]?.[1].visibility !== sample.visibility ? INTERP_HOLD : INTERP_LINEAR,
      interpId: -1,
    })),
  }));
}

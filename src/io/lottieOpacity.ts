import {
  effectiveVisibilityAt, RigDoc, RigPart, sampleKeyList,
} from '../core/model';

type JsonObj = Record<string, unknown>;
const rnd = (n: number): number => Number(n.toFixed(3));
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
const toFrames = (ms: number, fps: number): number => rnd((ms * fps) / 1000);

export function partPaintOpacityProp(
  doc: RigDoc, clip: RigDoc['clips'][number], part: RigPart, fps: number,
): JsonObj {
  const opacityKeys = [...(clip.tracks.find((track) =>
    track.target === part.id && track.channel === 'opacity')?.keyframes ?? [])]
    .sort((left, right) => left.time - right.time);
  const byId = new Map(doc.parts.map((candidate) => [candidate.id, candidate]));
  const ancestorIds = new Set<string>();
  let current: RigPart | undefined = part;
  while (current && !ancestorIds.has(current.id)) {
    ancestorIds.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  const visibilityAnimated = clip.tracks.some((track) =>
    track.channel === 'visibility' && track.keyframes.length > 0 && ancestorIds.has(track.target));
  if (opacityKeys.length === 0 && !visibilityAnimated) {
    return { a: 0, k: rnd(part.rest.opacity * effectiveVisibilityAt(doc, clip, part, 0) * 100) };
  }
  const frameMs = 1000 / fps;
  const samples = new Map<number, { opacity: number; visibility: number }>();
  for (let time = 0; time <= clip.duration + frameMs / 2; time += frameMs) {
    const at = Math.min(clip.duration, time);
    const visibility = effectiveVisibilityAt(doc, clip, part, at);
    samples.set(toFrames(at, fps), {
      visibility,
      opacity: rnd(clamp01(sampleKeyList(opacityKeys, at, part.rest.opacity) * visibility) * 100),
    });
  }
  if (samples.size <= 1) return { a: 0, k: [...samples.values()][0]?.opacity ?? 0 };
  const values = [...samples];
  return { a: 1, k: values.map(([frame, sample], index) => {
      const key: JsonObj = { t: frame, s: [sample.opacity] };
      if (values[index + 1]?.[1].visibility !== sample.visibility) key.h = 1;
      else if (index < values.length - 1) {
        key.o = { x: [0.333], y: [0.333] };
        key.i = { x: [0.667], y: [0.667] };
      }
      return key;
    }) };
}

export function partVisibleInSomeClip(doc: RigDoc, part: RigPart, fps: number): boolean {
  return doc.clips.some((clip) => {
    const step = 1000 / fps;
    for (let time = 0; time <= clip.duration + step / 2; time += step) {
      if (effectiveVisibilityAt(doc, clip, part, Math.min(clip.duration, time)) >= 0.5) return true;
    }
    return false;
  });
}

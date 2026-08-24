import { Clip, RigDoc, RigPart } from './docTypes';
import { sampleKeyList } from './channels';

export function partVisibilityAt(part: RigPart, clip: Clip | null, time: number | null): number {
  const rest = part.hidden ? 0 : 1;
  if (time === null || !clip) return rest;
  const track = clip.tracks.find((candidate) =>
    candidate.target === part.id && candidate.channel === 'visibility');
  if (!track?.keyframes.length) return rest;
  return sampleKeyList(track.keyframes, time, rest, true) >= 0.5 ? 1 : 0;
}

export function effectiveVisibilityAt(
  doc: RigDoc, clip: Clip | null, part: RigPart, time: number | null,
): number {
  const byId = new Map(doc.parts.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  let current: RigPart | undefined = part;
  while (current && !seen.has(current.id)) {
    if (partVisibilityAt(current, clip, time) === 0) return 0;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return 1;
}

export function hasVisibilityAnimation(doc: RigDoc, part: RigPart): boolean {
  const byId = new Map(doc.parts.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  let current: RigPart | undefined = part;
  while (current && !seen.has(current.id)) {
    if (doc.clips.some((clip) => clip.tracks.some((track) =>
      track.target === current!.id && track.channel === 'visibility' && track.keyframes.length > 0))) return true;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

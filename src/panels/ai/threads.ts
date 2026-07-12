/**
 * AI Animate System v2 A4 "clip-scoped refinement threads": the STORE. A thread is a
 * per (doc name, clip name) conversation — app-state backed by localStorage so it
 * survives a reload for the SAME doc+clip (keyed by name strings, not object identity —
 * a doc-replace/reload swaps `state.doc` to a new object but the name strings match, so
 * `getThread` finds the same thread; see `../../ai/threads.ts` for the pure request-
 * block text this feeds into a follow-up request).
 *
 * Capped at MAX_TURNS (oldest pruned first) per thread; each turn stores the user's
 * instruction, mode, a compact "what changed" summary (`summarizeTracks`), and the
 * resulting clip's tracks (NOT the whole doc — "capped" per the wave brief). A turn is
 * recorded ONLY on a successful APPLY (`panels/ai/panel.ts`'s `handleApply`) — never on
 * preview-entry or a Retry that's never applied — so the thread always reflects what
 * actually landed in the document, not abandoned candidates.
 *
 * Deletion sweep: deleting a clip (timeline.ts, not this module's concern) can leave a
 * thread pointing at a clip name that no longer exists. Rather than hook timeline.ts's
 * delete path, `./threadStrip.ts` sweeps stale threads for the CURRENT doc once per doc
 * load/build (see `sweepStaleThreads` + its call site) — a storage-side prune instead
 * of a cross-module delete hook.
 */
import { Track } from '../../core/model';
import { ThreadContextTurn } from '../../ai/threads';

const KEY_PREFIX = 'rig-studio-ai-thread:';
export const MAX_TURNS = 6;

export interface ThreadTurn extends ThreadContextTurn {
  id: string;
  atMs: number;
  /** The resulting clip's tracks only (not the whole Clip/doc) — capped by MAX_TURNS
   *  bounding total turn count, not by truncating an individual turn's tracks. */
  clip: { duration: number; tracks: Track[] };
}

export interface AiThread {
  docName: string;
  clipName: string;
  turns: ThreadTurn[];
}

function threadKey(docName: string, clipName: string): string {
  return `${KEY_PREFIX}${encodeURIComponent(docName)}:${encodeURIComponent(clipName)}`;
}

export function getThread(docName: string, clipName: string): AiThread | null {
  const raw = localStorage.getItem(threadKey(docName, clipName));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AiThread;
  } catch {
    return null;
  }
}

/** Append a turn (assigning `id`/`atMs`), capping at MAX_TURNS by dropping the oldest,
 *  and persist. Returns the resulting thread. */
export function recordTurn(
  docName: string,
  clipName: string,
  turn: Omit<ThreadTurn, 'id' | 'atMs'>,
): AiThread {
  const existing = getThread(docName, clipName);
  const full: ThreadTurn = { id: `t${Date.now()}${Math.random().toString(36).slice(2, 8)}`, atMs: Date.now(), ...turn };
  const turns = [...(existing?.turns ?? []), full].slice(-MAX_TURNS);
  const next: AiThread = { docName, clipName, turns };
  localStorage.setItem(threadKey(docName, clipName), JSON.stringify(next));
  return next;
}

export function clearThread(docName: string, clipName: string): void {
  localStorage.removeItem(threadKey(docName, clipName));
}

/** Prune every thread for `docName` whose clip name isn't in `existingClipNames` —
 *  called once per doc load/build by `./threadStrip.ts` (see the module doc comment's
 *  "Deletion sweep" paragraph). Collects keys to remove before removing any, so
 *  mutating localStorage mid-scan never skips an entry. */
export function sweepStaleThreads(docName: string, existingClipNames: string[]): void {
  const keep = new Set(existingClipNames);
  const prefix = `${KEY_PREFIX}${encodeURIComponent(docName)}:`;
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix)) continue;
    if (!keep.has(decodeURIComponent(key.slice(prefix.length)))) toRemove.push(key);
  }
  for (const key of toRemove) localStorage.removeItem(key);
}

/** Compact "what changed" summary for a turn, e.g. "left_arm.rotate ×3, right_leg.ty
 *  ×2" — derived straight from the applied result's resolved (id-targeted) tracks, so
 *  it always matches what actually landed. `labelOf` resolves ids back to the labels a
 *  human (and a future prompt) reads. */
export function summarizeTracks(tracks: Track[], labelOf: (id: string) => string): string {
  const parts = tracks
    .filter((t) => t.keyframes.length > 0)
    .map((t) => `${t.target === 'root' ? 'root' : labelOf(t.target)}.${t.channel} ×${t.keyframes.length}`);
  return parts.length > 0 ? parts.join(', ') : 'no tracks';
}

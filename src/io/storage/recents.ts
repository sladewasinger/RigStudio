/**
 * D1 recent-files RING: name + timestamp only (JSON-safe) — the actual FS Access handle,
 * when one exists, is persisted separately in IndexedDB (`handleStore.ts`) and cross-
 * referenced by `id`, since a handle isn't structured-clone-safe for `JSON.stringify`.
 * Capped at MAX_RECENTS, newest first, deduped by name (reopening/resaving a project
 * moves it back to the front rather than growing a duplicate row) — the same ring shape
 * `panels/ai/threads.ts` established for AI thread history.
 *
 * localStorage access is guarded (try/catch, degrading to a no-op/empty list): this
 * module is imported by `io/storage/index.ts`, reachable from the unit-test project's
 * plain `node` environment, which has no global `localStorage` at all (confirmed: only
 * jsdom-opted-in test files do) — mirrors `core/appState.ts`'s `readSnapEnabled` guard.
 */

export interface RecentEntry {
  id: string;
  name: string;
  savedAt: number;
  /** Whether a FileSystemFileHandle is persisted in IndexedDB under this entry's `id` —
   *  see `handleStore.ts`. False for fallback-storage saves/opens (no handle exists) and
   *  for entries whose IDB write failed (e.g. a non-cloneable test double). */
  hasHandle: boolean;
}

const KEY = 'rig-studio-recent-files';
export const MAX_RECENTS = 10;

function readAll(): RecentEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as RecentEntry[] : [];
  } catch {
    return [];
  }
}

function writeAll(list: RecentEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* localStorage unavailable (node/test env, private browsing, quota) — degrade to
       in-memory-only for this call; the ring just won't survive a reload. */
  }
}

function freshId(): string {
  return `r${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

/** Add (or move-to-front + refresh) an entry by NAME, capped at MAX_RECENTS. Always
 *  starts `hasHandle: false` — `markRecentHasHandle` flips it once the caller confirms
 *  the IDB write actually succeeded. Returns the entry so a caller can associate a
 *  handle with its fresh `id`. */
export function pushRecent(name: string): RecentEntry {
  const list = readAll().filter((e) => e.name !== name);
  const entry: RecentEntry = { id: freshId(), name, savedAt: Date.now(), hasHandle: false };
  list.unshift(entry);
  writeAll(list.slice(0, MAX_RECENTS));
  return entry;
}

export function listRecents(): RecentEntry[] {
  return readAll();
}

export function markRecentHasHandle(id: string): void {
  const list = readAll();
  const entry = list.find((e) => e.id === id);
  if (!entry) return;
  entry.hasHandle = true;
  writeAll(list);
}

export function clearRecents(): void {
  writeAll([]);
}

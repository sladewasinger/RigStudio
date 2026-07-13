/**
 * Pure re-export facade over `src/io/storage/` — consumers import ONLY `../io/storage`,
 * never a deep path (the `view/`/`panels/` convention, CLAUDE.md "The facade pattern for
 * wide surfaces"). Owns the ACTIVE-storage seam (`getProjectStorage`/
 * `setProjectStorageForTest`) and the two composition helpers (`addRecent`/
 * `reopenRecent`) that stitch `recents.ts`'s localStorage ring together with
 * `handleStore.ts`'s IndexedDB handle persistence — everything else here is a straight
 * re-export of an implementation module's public surface.
 */
import { ProjectStorage } from './types';
import { fileSystemAccessStorage, supportsFileSystemAccess } from './fileSystemAccess';
import { downloadFallbackStorage } from './downloadFallback';
import { RecentEntry, pushRecent, markRecentHasHandle } from './recents';
import { saveHandleFor, loadHandleFor, supportsHandleStore } from './handleStore';

export type { ProjectStorage, StorageFile, SaveResult } from './types';
export { fileSystemAccessStorage, supportsFileSystemAccess } from './fileSystemAccess';
export { downloadFallbackStorage, readFile } from './downloadFallback';
export type { RecentEntry } from './recents';
export { listRecents, clearRecents, MAX_RECENTS } from './recents';

function defaultStorage(): ProjectStorage {
  return supportsFileSystemAccess() ? fileSystemAccessStorage : downloadFallbackStorage;
}

let testOverride: ProjectStorage | null = null;

/**
 * Test-only seam (mirrors `core/history.ts`'s `setRestoreHandler` / `panels/ai/
 * requests.ts`'s `__setAnimateCallForTest`): production code always resolves the REAL
 * storage by feature detection. Interaction tests inject either the real
 * `downloadFallbackStorage` (to exercise the pre-D1 fallback UX deterministically — the
 * interaction harness's `bootRig()` does exactly this for every test file by default) or
 * a genuinely FAKE `ProjectStorage` (to exercise the handle-based quick-save/Save-As
 * flow without ever touching a native OS picker, which headless Chromium exposes but
 * cannot drive — the dialog can never be dismissed by a synthetic event).
 */
export function setProjectStorageForTest(storage: ProjectStorage | null): void {
  testOverride = storage;
}

export function getProjectStorage(): ProjectStorage {
  return testOverride ?? defaultStorage();
}

/** Record a successful project open/save in the recents ring, persisting `handle` to
 *  IndexedDB when one exists and the browser supports it. Degrades silently (name-only
 *  entry) when handle persistence isn't possible or the handle isn't structured-clone-
 *  safe — never blocks the open/save flow that called it. */
export async function addRecent(name: string, handle?: FileSystemFileHandle): Promise<void> {
  const entry = pushRecent(name);
  if (!handle || !supportsHandleStore()) return;
  try {
    await saveHandleFor(entry.id, handle);
    markRecentHasHandle(entry.id);
  } catch {
    /* not cloneable, IDB unavailable/blocked, quota — the name-only entry still stands */
  }
}

export interface ReopenedFile {
  text: string;
  handle: FileSystemFileHandle;
}

/**
 * Try to reopen a recent entry via its persisted handle: re-requests permission (needs
 * the CALLER's own user-gesture context — invoke this directly from a click handler,
 * never after an intervening `await`) and reads the file. Returns null — the caller's
 * cue to fall back to a normal file-picker open — when there's no usable handle
 * (fallback-storage saves, IndexedDB unavailable, a revoked/denied permission, or an
 * entry that predates handle persistence). `requestPermission` is called defensively
 * (some handle sources, e.g. the Origin Private File System, don't implement the
 * permission extension at all and need none).
 */
export async function reopenRecent(entry: RecentEntry): Promise<ReopenedFile | null> {
  if (!entry.hasHandle || !supportsHandleStore()) return null;
  const handle = await loadHandleFor(entry.id);
  if (!handle) return null;
  try {
    const perm = typeof handle.requestPermission === 'function'
      ? await handle.requestPermission({ mode: 'readwrite' })
      : 'granted';
    if (perm !== 'granted') return null;
    const file = await handle.getFile();
    return { text: await file.text(), handle };
  } catch {
    return null;
  }
}

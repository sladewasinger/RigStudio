/**
 * IndexedDB persistence for File System Access `FileSystemFileHandle`s (structured-
 * clone-safe, unlike a plain object — that's specifically why the real API can round-trip
 * through IDB at all) — backs D1's real "recent files": `recents.ts` keeps the
 * name+timestamp ring in localStorage (JSON-safe, cheap to read every render); a handle
 * itself can't go in JSON, so it lives here keyed by the SAME entry id, looked up only
 * when the user actually clicks a recent item. `supportsHandleStore()` is false in Node
 * (unit tests) and in browsers without IndexedDB; callers already only reach this when
 * `ProjectStorage.supportsFileHandles` is true (the fallback implementation never
 * produces a handle to store), so no extra gating is needed here beyond that.
 */

const DB_NAME = 'rig-studio-file-handles';
const STORE = 'handles';
const DB_VERSION = 1;

export function supportsHandleStore(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Persist `handle` under `id`. Rejects (caller's job to catch) when `handle` isn't
 *  structured-clone-safe — a real `FileSystemFileHandle` always is; a hand-rolled test
 *  double with function properties is not, and `io/storage/index.ts`'s `addRecent`
 *  degrades gracefully when this throws. */
export async function saveHandleFor(id: string, handle: FileSystemFileHandle): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function loadHandleFor(id: string): Promise<FileSystemFileHandle | null> {
  const db = await openDb();
  try {
    return await new Promise<FileSystemFileHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve((req.result as FileSystemFileHandle | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

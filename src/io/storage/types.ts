/**
 * D1 (ROADMAP.md "Desktop / real file access"): the storage-INTERFACE discipline. Every
 * caller (`ui/shortcutActions.ts`'s save flow, `ui/openFlow.ts`'s open flow) talks to
 * `ProjectStorage` only, never a concrete implementation — TWO exist today
 * (`fileSystemAccess.ts` for Chromium's real File System Access API, `downloadFallback.ts`
 * for every other browser, reproducing the exact pre-D1 anchor-download + file-input
 * behavior) and D2 (a Tauri fs/dialog backend, out of scope here) is a planned THIRD:
 * a drop-in backend swap, nothing above this seam changes.
 *
 * A `null` return from any method means "the user cancelled the picker" — callers treat
 * it exactly like today's `dialog.prompt` returning null. `handle` fields are real
 * Chromium `FileSystemFileHandle`s; the fallback implementation never produces one.
 *
 * Ambient declarations below fill two gaps in the installed TypeScript DOM lib: it ships
 * `FileSystemFileHandle`/`FileSystemWritableFileStream` themselves but not the
 * `showOpenFilePicker`/`showSaveFilePicker` entry points, and not the permission-query
 * methods (`FileSystemHandle.queryPermission`/`requestPermission`) the recent-files
 * reopen flow needs.
 */

export interface StorageFile {
  name: string;
  text: string;
  handle?: FileSystemFileHandle;
}

export interface SaveResult {
  name: string;
  handle?: FileSystemFileHandle;
}

export interface ProjectStorage {
  /** True for the File System Access implementation, false for the download fallback —
   *  callers branch quick-save (write-in-place) vs filename-memory on this. */
  readonly supportsFileHandles: boolean;
  /** Open a project (.rig.json) or artwork (.svg) file — mirrors the toolbar's single
   *  Open… button, which has always accepted either. */
  openProject(): Promise<StorageFile | null>;
  /** Open artwork only (.svg) — a narrower primitive than `openProject`, kept for
   *  interface symmetry and any future dedicated "Import SVG" entry point. */
  openSvg(): Promise<StorageFile | null>;
  /** Write `text` through an existing handle with NO picker (quick-save). Implementations
   *  without a live handle (or that don't support handles at all) fall back to
   *  `saveProjectAs` with a generic suggested name — callers that care about a specific
   *  name should call `saveProjectAs` directly instead of relying on that fallback. */
  saveProject(text: string, handle?: FileSystemFileHandle): Promise<SaveResult | null>;
  /** Always resolve a NEW target: the real implementation shows `showSaveFilePicker`
   *  (which doubles as the "ask for a name" UI, so `suggestedName` is only a suggestion);
   *  the fallback implementation has no native save dialog, so `suggestedName` is
   *  authoritative there — callers on that path must prompt for a name THEMSELVES first
   *  (see `ui/shortcutActions.ts`'s fallback branch, preserving the pre-D1 UX exactly). */
  saveProjectAs(text: string, suggestedName: string): Promise<SaveResult | null>;
}

declare global {
  interface FilePickerAcceptType {
    description?: string;
    accept: Record<string, string | string[]>;
  }
  interface FilePickerOptions {
    types?: FilePickerAcceptType[];
    excludeAcceptAllOption?: boolean;
  }
  interface OpenFilePickerOptions extends FilePickerOptions {
    multiple?: boolean;
  }
  interface SaveFilePickerOptions extends FilePickerOptions {
    suggestedName?: string;
  }
  interface Window {
    showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>;
  }
  interface FileSystemHandlePermissionDescriptor {
    mode?: 'read' | 'readwrite';
  }
  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  }
}

/**
 * The pre-D1 behavior, moved behind `ProjectStorage`: browsers without the File System
 * Access API (Firefox/Safari, or any Chromium context where it's been feature-detected
 * off) open files through a transient `<input type=file>` and "save" by triggering an
 * anchor download — there is no live handle, so every save is a fresh download and no
 * native "Save As" dialog exists (see `types.ts`'s `saveProjectAs` doc comment: callers
 * on this path must prompt for a filename THEMSELVES before calling it).
 */
import { download } from '../../ui/download';
import { ProjectStorage, SaveResult, StorageFile } from './types';

/** Pure: a `File` → `{name, text}`. Split out from `pickFile` so unit tests can exercise
 *  the read path with a real Blob-backed `File` (available under jsdom) without ever
 *  driving a native picker. */
export async function readFile(file: File): Promise<{ name: string; text: string }> {
  return { name: file.name, text: await file.text() };
}

/**
 * Opens a transient, invisible `<input type=file>` and resolves with the chosen File (or
 * null on cancel). A fresh element per call — this module owns no DOM node of its own
 * (index.html no longer ships a dedicated `#file-input`; D1 decoupled the picker from any
 * specific page markup), so it works regardless of what shell embeds it. Modern Chromium/
 * Firefox fire a `cancel` event when the native dialog is dismissed with no selection;
 * engines that don't just leave a stray un-clicked input in the DOM (harmless — hidden,
 * unreachable, garbage-collected with the page).
 */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    input.click();
  });
}

async function openWith(accept: string): Promise<StorageFile | null> {
  const file = await pickFile(accept);
  return file ? readFile(file) : null;
}

async function saveProjectAs(text: string, suggestedName: string): Promise<SaveResult> {
  download(suggestedName, text, 'application/json');
  return { name: suggestedName };
}

export const downloadFallbackStorage: ProjectStorage = {
  supportsFileHandles: false,
  openProject: () => openWith('.svg,.json'),
  openSvg: () => openWith('.svg'),
  // No live handle to write through — every "save" is a fresh download under a caller-
  // supplied name; ui/shortcutActions.ts's fallback branch never actually reaches this
  // with a handle (it never has one), but the interface requires the method to exist.
  saveProject: (text) => saveProjectAs(text, 'project.rig.json'),
  saveProjectAs,
};

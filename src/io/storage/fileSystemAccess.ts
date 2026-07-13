/**
 * Chromium's real File System Access API backend — `showOpenFilePicker`/
 * `showSaveFilePicker`/`handle.createWritable()`, feature-detected by
 * `supportsFileSystemAccess()` (needs a secure context, which localhost and any HTTPS
 * deploy both satisfy). Every method that can be user-cancelled resolves `null` on the
 * picker's `AbortError` rather than throwing — see `types.ts`'s interface doc comment.
 */
import { ProjectStorage, SaveResult, StorageFile } from './types';

export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' &&
    typeof window.showOpenFilePicker === 'function' &&
    typeof window.showSaveFilePicker === 'function';
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

const PROJECT_TYPES: FilePickerAcceptType[] = [{
  description: 'Rig Studio project or SVG artwork',
  accept: { 'application/json': ['.json'], 'image/svg+xml': ['.svg'] },
}];
const SVG_TYPES: FilePickerAcceptType[] = [{
  description: 'SVG artwork',
  accept: { 'image/svg+xml': ['.svg'] },
}];
const SAVE_TYPES: FilePickerAcceptType[] = [{
  description: 'Rig Studio project',
  accept: { 'application/json': ['.json'] },
}];

async function openWith(types: FilePickerAcceptType[]): Promise<StorageFile | null> {
  try {
    const [handle] = await window.showOpenFilePicker!({ types });
    const file = await handle.getFile();
    return { name: file.name, text: await file.text(), handle };
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

async function writeTo(handle: FileSystemFileHandle, text: string): Promise<void> {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

async function saveProjectAs(text: string, suggestedName: string): Promise<SaveResult | null> {
  try {
    const handle = await window.showSaveFilePicker!({ suggestedName, types: SAVE_TYPES });
    await writeTo(handle, text);
    return { name: handle.name, handle };
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

async function saveProject(text: string, handle?: FileSystemFileHandle): Promise<SaveResult | null> {
  if (!handle) return saveProjectAs(text, 'project.rig.json');
  await writeTo(handle, text);
  return { name: handle.name, handle };
}

export const fileSystemAccessStorage: ProjectStorage = {
  supportsFileHandles: true,
  openProject: () => openWith(PROJECT_TYPES),
  openSvg: () => openWith(SVG_TYPES),
  saveProject,
  saveProjectAs,
};

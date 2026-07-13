/**
 * Two shared actions that used to be main.ts-local functions, each driven by BOTH a
 * keyboard binding and a toolbar button — moved here (a dependency-free leaf: nothing
 * in `shortcut*.ts` or `main.ts` needs to import them back) so the binding and the
 * button share ONE implementation instead of main.ts's local function plus a
 * registry entry that has to call back into main.ts (which would cycle).
 */

import { state, notify, markClean, serializeDoc, EditorMode } from '../core/model';
import { renderPose } from '../view';
import { clearKeySelection } from '../timeline/timeline';
import { dialog } from './dialogs';
import { getProjectStorage, addRecent } from '../io/storage';

/** Tab's action, and the Setup/Animate toolbar buttons'. */
export function setEditorMode(mode: EditorMode): void {
  if (state.editorMode === mode) return;
  state.editorMode = mode;
  state.playing = false;
  if (mode === 'animate') state.mode = 'rig'; // node editing is Setup-only
  if (mode === 'setup') clearKeySelection();
  notify();
  renderPose();
}

/**
 * Quick-save vs Save As (Category B item 3, superseded in its FS-Access-capable form by
 * D1 — ROADMAP.md "Desktop / real file access"): PRECEDENCE, highest first —
 *   1. a live `state.projectFileHandle` + `ProjectStorage.supportsFileHandles`: Ctrl+S
 *      writes straight through the handle, no dialog at all (real overwrite-in-place).
 *   2. `supportsFileHandles` but no handle yet (first save this session, or the doc was
 *      never opened from a real file): the native `showSaveFilePicker` handles BOTH
 *      naming and permission — no in-app dialog needed either.
 *   3. no File System Access support (Firefox/Safari): the pre-D1 filename-MEMORY
 *      fallback — the last filename actually saved under is remembered per DOC NAME in
 *      localStorage (simplest keying choice, matches autosave's single global slot in
 *      spirit), so Ctrl+S only prompts the FIRST time a given doc name is saved.
 * Autosave (main.ts, localStorage, unconditional) stays the crash net underneath all
 * three — it never competes with any of this, it just never loses the in-memory doc.
 * Ctrl+Shift+S (`saveProjectAs` below) always takes tier 2's picker (or tier 3's prompt)
 * regardless of an existing handle — "Save As" always asks, D1 or not.
 */
const LAST_FILENAME_PREFIX = 'rig-studio-last-filename:';

function lastFilenameKey(docName: string): string {
  return `${LAST_FILENAME_PREFIX}${docName}`;
}

async function doSave(forcePrompt: boolean): Promise<void> {
  if (!state.doc) {
    await dialog.alert('Nothing to save yet — import an SVG first.');
    return;
  }
  const storage = getProjectStorage();
  const text = serializeDoc(state.doc);

  if (!forcePrompt && state.projectFileHandle && storage.supportsFileHandles) {
    const res = await storage.saveProject(text, state.projectFileHandle);
    if (!res) return;
    state.projectFileHandle = res.handle ?? state.projectFileHandle;
    void addRecent(res.name, res.handle);
    markClean();
    notify();
    return;
  }

  if (storage.supportsFileHandles) {
    const res = await storage.saveProjectAs(text, `${state.doc.name}.rig.json`);
    if (!res) return; // cancelled
    state.projectFileHandle = res.handle ?? null;
    void addRecent(res.name, res.handle);
    markClean();
    notify();
    return;
  }

  const key = lastFilenameKey(state.doc.name);
  const remembered = localStorage.getItem(key);
  let filename = remembered;
  if (forcePrompt || !remembered) {
    filename = await dialog.prompt('Save project as', remembered ?? `${state.doc.name}.rig.json`);
    if (!filename) return;
  }
  const res = await storage.saveProjectAs(text, filename!);
  if (!res) return;
  localStorage.setItem(key, filename!);
  void addRecent(res.name);
  markClean(); // the download completed — nothing left unsaved
  notify();
}

/** Ctrl+S's action, and the toolbar Save button's: quick-save using the remembered
 *  filename, only prompting the first time this doc name is saved. */
export async function saveProject(): Promise<void> {
  return doSave(false);
}

/** Ctrl+Shift+S's action, and the toolbar Save As button's: always prompts, and updates
 *  the remembered filename to whatever was typed. */
export async function saveProjectAs(): Promise<void> {
  return doSave(true);
}

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
import { download } from './download';

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
 * Quick-save vs Save As (Category B item 3): the last filename actually saved under is
 * remembered per DOC NAME (simplest keying choice — matches autosave's single global
 * slot in spirit; a project renamed via "Save As" naturally gets its own remembered
 * slot next time). Browser downloads can't overwrite a real file on disk (no File
 * System Access handle) — this is filename MEMORY only, so Ctrl+S doesn't re-prompt
 * every time; a genuine "save over the same file" arrives with D1's storage layer.
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
  const key = lastFilenameKey(state.doc.name);
  const remembered = localStorage.getItem(key);
  let filename = remembered;
  if (forcePrompt || !remembered) {
    filename = await dialog.prompt('Save project as', remembered ?? `${state.doc.name}.rig.json`);
    if (!filename) return;
  }
  download(filename!, serializeDoc(state.doc), 'application/json');
  localStorage.setItem(key, filename!);
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

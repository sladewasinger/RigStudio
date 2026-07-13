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

/** Ctrl+S's action, and the toolbar Save button's. */
export async function saveProject(): Promise<void> {
  if (!state.doc) {
    await dialog.alert('Nothing to save yet — import an SVG first.');
    return;
  }
  const filename = await dialog.prompt('Save project as', `${state.doc.name}.rig.json`);
  if (!filename) return;
  download(filename, serializeDoc(state.doc), 'application/json');
  markClean(); // the download completed — nothing left unsaved
  notify();
}

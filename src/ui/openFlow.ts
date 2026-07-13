/**
 * D1: the toolbar Open button's full flow (recents dropdown → pick → confirm-replace-
 * if-dirty → load) plus the shared "open a project through the storage interface"
 * primitive Ctrl+O reaches by proxy-clicking the button (`shortcutBindings.ts`'s `open`
 * entry). Takes its doc-loading callbacks as PARAMETERS rather than importing main.ts
 * back — main.ts is the bootstrap entry point, nothing imports it — the same
 * dependency-free-leaf shape `shortcutActions.ts` already established for save.
 */
import { state } from '../core/model';
import {
  getProjectStorage, addRecent, reopenRecent, listRecents, RecentEntry,
} from '../io/storage';
import { dialog } from './dialogs';
import { showContextMenu, ContextMenuItem } from './contextMenu';

export interface OpenFlowDeps {
  confirmReplaceIfDirty(): Promise<boolean>;
  loadProjectText(text: string): boolean;
  loadSvgText(text: string, name: string): void;
}

/** A `.json` open re-establishes the project file handle (enabling an immediate in-place
 *  Ctrl+S) and records a recents entry; a `.svg` import is fresh artwork, not a project
 *  continuation, so it does neither (afterDocReplaced already cleared any prior handle). */
export async function openProjectFlow(deps: OpenFlowDeps): Promise<void> {
  const file = await getProjectStorage().openProject();
  if (!file) return; // cancelled
  if (!(await deps.confirmReplaceIfDirty())) return;
  if (/\.json$/i.test(file.name)) {
    if (deps.loadProjectText(file.text)) {
      state.projectFileHandle = file.handle ?? null;
      void addRecent(file.name, file.handle);
    }
  } else {
    deps.loadSvgText(file.text, file.name);
  }
}

/** Reopen a recent-files entry: tries its persisted handle first (permission re-request
 *  needs THIS click's user-gesture context — never call outside one), and falls back to
 *  a normal Open dialog when there's no usable handle (fallback-storage saves, a revoked
 *  permission, or an entry from before D1's handle persistence — native pickers can't be
 *  pre-filled for an OPEN dialog, so the entry's name is surfaced via the alert instead). */
async function reopenRecentFlow(entry: RecentEntry, deps: OpenFlowDeps): Promise<void> {
  if (!(await deps.confirmReplaceIfDirty())) return;
  const reopened = await reopenRecent(entry);
  if (reopened) {
    if (deps.loadProjectText(reopened.text)) {
      state.projectFileHandle = reopened.handle;
      void addRecent(entry.name, reopened.handle);
    }
    return;
  }
  await dialog.alert(`Couldn't reopen "${entry.name}" automatically — locate it in the file picker.`);
  await openProjectFlow(deps);
}

/** Wires the toolbar Open button: a plain open when there are no recents yet, else a
 *  dropdown (Browse… + recent projects, newest first) positioned under the button. */
export function wireOpenButton(btn: HTMLButtonElement, deps: OpenFlowDeps): void {
  btn.onclick = () => {
    const recents = listRecents();
    if (recents.length === 0) {
      void openProjectFlow(deps);
      return;
    }
    const rect = btn.getBoundingClientRect();
    const items: ContextMenuItem[] = [
      { label: 'Browse for file…', onSelect: () => { void openProjectFlow(deps); } },
      ...recents.map((entry, i) => ({
        label: entry.name,
        separatorBefore: i === 0,
        onSelect: () => { void reopenRecentFlow(entry, deps); },
      })),
    ];
    showContextMenu(items, rect.left, rect.bottom + 4);
  };
}

/**
 * Shared editing actions for layer/artwork context menus — the exact same mutation call
 * paths main.ts's keyboard shortcuts and canvasTools.ts's buttons already use (checkpoint
 * → model mutation → canvas/notify), factored out here so the layer-row and canvas
 * context menus (and main.ts's Ctrl+D / Delete-key handlers) call ONE implementation
 * instead of three copies. Duplicate/Delete/Group/Ungroup/Flip are all Edit(Setup)-mode-
 * only, mirroring the existing keyboard/button gating; z-order (bring forward / send
 * backward) is not — PageUp/PageDown already work in both editor modes.
 */

import {
  state, notify, selectedParts, selectPart, deleteParts, duplicateParts,
  canMoveSelectedInDrawOrder, moveSelectedInDrawOrder, partById, RigPart,
} from '../core/model';
import { renderPose, reorderCanvas, unregisterPart, buildCanvas, syncPartPathDom } from '../view';
import { checkpoint } from '../core/history';
import { flipAction, groupAction, ungroupAction } from '../panels';
import { dialog } from './dialogs';
import { ContextMenuItem } from './contextMenu';

function canvasEl(): HTMLElement {
  return document.getElementById('canvas')!;
}

// ---- Duplicate ----

export function canDuplicateSelection(): boolean {
  return state.editorMode === 'setup' &&
    state.selectedPartIds.some((id) => !partById(id)?.skin);
}

/** Ctrl+D's mutation, also driven by the context menus. */
export function duplicateSelectedParts(): void {
  if (!canDuplicateSelection()) return;
  const dupable = state.selectedPartIds.filter((id) => !partById(id)?.skin);
  checkpoint();
  const newIds = duplicateParts(dupable);
  // Same rebuild path undo/redo uses, so the canvas picks up the new part groups
  // without a second hand-rolled registration path.
  buildCanvas(canvasEl());
  state.selectedPartIds = newIds;
  state.selectedPartId = newIds[newIds.length - 1] ?? null;
  state.selectedPathId = null;
  notify();
}

// ---- Delete ----

export function canDeleteSelection(): boolean {
  return state.editorMode === 'setup' && state.selectedPartIds.length > 0;
}

/**
 * The Setup-pose-mode Delete-key branch's mutation, also driven by the context menus.
 *
 * `deleteParts` (core/structuralOps.ts) properly UNBINDS a skinned part whose every skin
 * bone just died (folds its ancestor chain away so the model's ROOT-space baked geometry
 * renders correctly again — see its doc comment), but core/ never touches the DOM. A
 * part that was posed while skinned had its DOM path `d` overwritten by the LBS
 * deformation (`view/skinRender.ts`; `path.d` itself is never mutated, only the DOM
 * attribute), and renderPose()'s plain (non-skinned) branch only ever refreshes a part's
 * group TRANSFORM, never `d` — a static part's `d` never changes at render time, so
 * nothing else would reset that stale deformed attribute back to the model's rest data.
 * Left alone, the newly-unbound part would keep rendering its frozen mid-pose SHAPE
 * (just sitting at the now-correct identity-ish position) instead of returning to its
 * true rest/bind-pose look. `syncPartPathDom` (already used elsewhere for exactly this
 * "resync DOM path data with the model" job) fixes it for every part that WAS skinned
 * and no longer is.
 */
export function deleteSelectedParts(): void {
  if (!canDeleteSelection()) return;
  checkpoint();
  const wasSkinned = new Set(state.doc!.parts.filter((p) => p.skin).map((p) => p.id));
  const removed = deleteParts([...state.selectedPartIds]);
  removed.forEach(unregisterPart);
  for (const id of wasSkinned) {
    const part = partById(id);
    if (part && !part.skin) syncPartPathDom(part);
  }
  notify();
  renderPose();
}

// ---- Z-order ----

export function canBringForward(): boolean {
  return canMoveSelectedInDrawOrder(1);
}
export function canSendBackward(): boolean {
  return canMoveSelectedInDrawOrder(-1);
}

function moveInDrawOrder(delta: 1 | -1): void {
  if (!canMoveSelectedInDrawOrder(delta)) return;
  checkpoint();
  moveSelectedInDrawOrder(delta);
  reorderCanvas();
  notify();
}
export function bringForward(): void { moveInDrawOrder(1); }
export function sendBackward(): void { moveInDrawOrder(-1); }

// ---- Node editing entry ----

export function canEnterNodeEditing(part: RigPart): boolean {
  return state.editorMode === 'setup' && part.paths.length > 0;
}

/** Select the part and switch to node-editing mode (mirrors the inspector's Pose/Node
 *  tool-switch row) — the canvas context menu's "Edit nodes" item. */
export function enterNodeEditing(part: RigPart): void {
  if (!canEnterNodeEditing(part)) return;
  selectPart(part.id);
  state.mode = 'nodes';
  notify();
  renderPose();
}

// ---- Rename (dialog-based; the Layers panel additionally offers inline rename) ----

export async function renamePartViaDialog(part: RigPart): Promise<void> {
  const name = await dialog.prompt('Rename layer', part.label);
  if (!name) return;
  const label = name.trim().replace(/\s+/g, '_');
  if (!label || label === part.label) return;
  checkpoint();
  part.label = label;
  notify();
}

// ---- Shared context-menu item list (layer rows + canvas artwork) ----

/** Build the part-targeted context-menu items. `canvasExtras` adds Flip/Edit-nodes,
 *  shown on the canvas menu but not the Layers panel's (which already has dedicated
 *  inline rename and doesn't expose per-path node editing). */
export function buildPartContextMenu(
  part: RigPart, opts: { canvasExtras?: boolean } = {},
): ContextMenuItem[] {
  const setup = state.editorMode === 'setup';
  const anyArt = selectedParts().some((p) => p.paths.length > 0);
  const items: ContextMenuItem[] = [
    { label: 'Rename', onSelect: () => { void renamePartViaDialog(part); } },
    { label: 'Duplicate', disabled: !canDuplicateSelection(), onSelect: duplicateSelectedParts },
    { label: 'Delete', disabled: !canDeleteSelection(), onSelect: deleteSelectedParts },
  ];
  if (opts.canvasExtras) {
    items.push(
      { label: 'Edit nodes', disabled: !canEnterNodeEditing(part), separatorBefore: true,
        onSelect: () => enterNodeEditing(part) },
      { label: 'Flip horizontal', disabled: !setup || !anyArt, onSelect: () => flipAction('h') },
      { label: 'Flip vertical', disabled: !setup || !anyArt, onSelect: () => flipAction('v') },
    );
  }
  items.push(
    { label: 'Group selection', disabled: !setup || state.selectedPartIds.length === 0,
      separatorBefore: true, onSelect: groupAction },
    { label: 'Ungroup', disabled: !setup || part.paths.length > 0, onSelect: ungroupAction },
    { label: 'Bring forward', disabled: !canBringForward(), separatorBefore: true, onSelect: bringForward },
    { label: 'Send backward', disabled: !canSendBackward(), onSelect: sendBackward },
  );
  return items;
}

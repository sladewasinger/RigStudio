/**
 * Path-level context-menu actions — the object (`RigPath`) equivalent of `actions.ts`'s
 * part-level menu, split into its own module so `actions.ts` doesn't crowd its budget
 * (CLAUDE.md "Small, focused files"). Every mutation here reuses an existing, already
 * render-neutral primitive rather than inventing new geometry math:
 *  - Raise/Lower in part reuse `actions.ts`'s `bringForward`/`sendBackward`, which already
 *    special-case `state.selectedPathId` (`core/structuralOps.ts`'s
 *    `moveSelectedInDrawOrder` — since U4 a SLOT step through `core/slotReorder.ts`'s
 *    `moveChildSlot`, the same chokepoint the Layers drag-reorder executes through).
 *  - Move to part… and Extract path → own part both reuse the view facade's
 *    `movePathToPart` (render-neutral cross-part rebake) + `pathMoveRefusal` chokepoint;
 *    Extract additionally reuses `addNullPart` (canonical z-order insertion) +
 *    `registerPart` (canvas group registration) — the same pair `view/interactions/
 *    pipelines/boneChain.ts` and `panels/canvasTools.ts`'s `groupAction` call after
 *    creating a partless part.
 *
 * LAST-PATH DELETE decision: allowed. `movePathToPart`'s own doc comment already settles
 * this precedent ("an art source emptied of its last path keeps its kind") — an empty
 * `kind: 'art'` part is inert (nothing to render/export) but perfectly valid, matching how
 * a `group`/`bone` null already renders nothing on its own. Refusing would be an arbitrary
 * restriction with no analog anywhere else in the model.
 */

import {
  state, notify, selectPart, RigPart, RigPath, addNullPart, slotRemovePath,
} from '../core/model';
import { checkpoint } from '../core/history';
import {
  renderPose, syncPartPathDom, registerPart, movePathToPart, pathMoveRefusal,
} from '../view';
import { dialog } from './dialogs';
import { ContextMenuItem, showContextMenu } from './contextMenu';
import { canBringForward, canSendBackward, bringForward, sendBackward } from './actions';

// ---- Rename (dialog fallback; the Layers panel additionally offers inline rename) ----

export async function renamePathViaDialog(path: RigPath): Promise<void> {
  const name = await dialog.prompt('Rename object', path.label);
  if (!name) return;
  const label = name.trim().replace(/\s+/g, '_');
  if (!label || label === path.label) return;
  checkpoint();
  path.label = label;
  notify();
}

// ---- Delete ----

/**
 * Skinned parts are refused, like `pathMoveRefusal`'s move-in/move-out guard: a whole-
 * path removal that touches skin overrides belongs behind `view/nodeEditing/`'s
 * `applyStructuralEdit` chokepoint (`dropSkinOverridesForPath` is call-site-restricted to
 * that package — `__tests__/nodeEditingChokepoint.test.ts`), not a menu action outside it.
 * An unskinned part's last path is still allowed to go (see the file header).
 */
export function canDeletePath(part: RigPart, pathId: string): boolean {
  return state.editorMode === 'setup' && !part.skin && part.paths.some((p) => p.id === pathId);
}

/** Drop the whole path object from its part — see the file header's last-path decision. */
export function deletePathFromPart(part: RigPart, pathId: string): void {
  if (!canDeletePath(part, pathId)) return;
  checkpoint();
  part.paths = part.paths.filter((p) => p.id !== pathId);
  slotRemovePath(part, pathId); // childOrder.ts chokepoint
  syncPartPathDom(part);
  if (state.selectedPathId === pathId) state.selectedPathId = null;
  renderPose();
  notify();
}

// ---- Move to part… (a picker menu opened on top of the path menu) ----

/** Every OTHER part `src`'s path could legally move into (see `pathMoveRefusal`),
 *  topmost-drawn first — same ordering convention as the Layers tree. */
function eligibleMoveDestinations(src: RigPart): RigPart[] {
  const doc = state.doc;
  if (!doc) return [];
  return [...doc.parts].reverse().filter((p) => p.id !== src.id && pathMoveRefusal(src, p) === null);
}

function movePathAndSelect(src: RigPart, dest: RigPart, pathId: string): void {
  checkpoint();
  if (!movePathToPart(src, dest, pathId)) return;
  selectPart(dest.id);
  state.selectedPathId = pathId;
  notify();
}

function buildMovePathMenu(src: RigPart, pathId: string, destinations: RigPart[]): ContextMenuItem[] {
  return destinations.map((dest) => ({
    label: dest.label,
    onSelect: () => movePathAndSelect(src, dest, pathId),
  }));
}

// ---- Extract path → own part ----

export function canExtractPath(part: RigPart, pathId: string): boolean {
  return state.editorMode === 'setup' && !part.skin && part.paths.some((p) => p.id === pathId);
}

/** New part is a SIBLING of `part` (same parent), positioned canonically by `addNullPart`;
 *  the path arrives via the same render-neutral rebake every other path move uses. One
 *  checkpoint for the whole op; selection lands on the new part (never a sub-path scope). */
export function extractPathToOwnPart(part: RigPart, pathId: string): void {
  if (!canExtractPath(part, pathId)) return;
  const path = part.paths.find((p) => p.id === pathId);
  if (!path) return;
  checkpoint();
  // kind starts 'group' (addNullPart only makes partless nulls); movePathToPart flips it
  // to 'art' the instant it receives a path, matching the import invariant.
  const newPart = addNullPart('group', { ...part.pivot }, part.parentId, path.label);
  registerPart(newPart);
  movePathToPart(part, newPart, pathId);
  selectPart(newPart.id);
  notify();
}

// ---- The menu itself ----

/**
 * `x`/`y` (client px) are the picker's own opening point for "Move to part…" — the same
 * coordinates the caller passed to `showContextMenu` for this menu. `renameHandler`, when
 * given, overrides the dialog fallback (the Layers panel passes its own inline-rename
 * trigger; the canvas leaves it unset).
 */
export function buildPathContextMenu(
  part: RigPart, path: RigPath, x: number, y: number, renameHandler?: () => void,
): ContextMenuItem[] {
  const destinations = eligibleMoveDestinations(part);
  return [
    { label: 'Rename',
      onSelect: () => { if (renameHandler) renameHandler(); else void renamePathViaDialog(path); } },
    { label: 'Delete path', disabled: !canDeletePath(part, path.id), separatorBefore: true,
      onSelect: () => deletePathFromPart(part, path.id) },
    { label: 'Raise in part', disabled: !canBringForward(), separatorBefore: true, onSelect: bringForward },
    { label: 'Lower in part', disabled: !canSendBackward(), onSelect: sendBackward },
    { label: 'Move to part…', disabled: destinations.length === 0, separatorBefore: true,
      onSelect: () => showContextMenu(buildMovePathMenu(part, path.id, destinations), x, y) },
    { label: 'Extract path → own part', disabled: !canExtractPath(part, path.id),
      onSelect: () => extractPathToOwnPart(part, path.id) },
  ];
}

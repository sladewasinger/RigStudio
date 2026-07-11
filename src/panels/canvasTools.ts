/**
 * The canvas-tools bar: tool switcher (select/translate/rotate/IK), the snapping
 * toggle, and (Setup mode) flip/group/ungroup/bone/bind actions. Also home to the
 * flip/group/ungroup/bind action handlers themselves, since main.ts binds them to
 * keyboard shortcuts (H/V, Ctrl+G, Ctrl+Shift+G) as well as these buttons.
 */

import {
  state, notify, selectedPart, selectedParts, selectPart, groupParts,
  ungroupPart, setSnapEnabled,
} from '../core/model';
import {
  renderPose, partRootBoxes, registerPart, unregisterPart, startBonePlacement,
  flipSelected, bindSelectedToBones, reorderCanvas,
} from '../view';
import { checkpoint } from '../core/history';
import { icon, iconButton, ICON_PATHS } from './icons';
import { dialog } from '../ui/dialogs';

// ---- Canvas tools bar + shared editing actions ----

/** Flip the selection (also bound to H/V keys in main.ts). */
export function flipAction(axis: 'h' | 'v'): void {
  if (state.editorMode !== 'setup') return;
  if (!selectedParts().some((p) => p.paths.length > 0)) return;
  checkpoint();
  flipSelected(axis);
  notify();
}

/** Wrap the selection in a group null (Ctrl+G). */
export function groupAction(): void {
  if (state.editorMode !== 'setup' || state.selectedPartIds.length === 0) return;
  const ids = [...state.selectedPartIds];
  // Pivot at the center of the selection's rendered bbox; bones-only selections
  // fall back to the average of their joints.
  const boxes = partRootBoxes(ids);
  let pivot: { x: number; y: number };
  if (boxes.size > 0) {
    const all = [...boxes.values()];
    const x0 = Math.min(...all.map((b) => b.x));
    const y0 = Math.min(...all.map((b) => b.y));
    const x1 = Math.max(...all.map((b) => b.x + b.w));
    const y1 = Math.max(...all.map((b) => b.y + b.h));
    pivot = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  } else {
    const parts = selectedParts();
    pivot = {
      x: parts.reduce((s, p) => s + p.pivot.x, 0) / parts.length,
      y: parts.reduce((s, p) => s + p.pivot.y, 0) / parts.length,
    };
  }
  checkpoint();
  const group = groupParts(ids, pivot);
  if (!group) return;
  registerPart(group);
  reorderCanvas();
  selectPart(group.id);
  notify();
}

/** Dissolve the selected group/bone (Ctrl+Shift+G). */
export function ungroupAction(): void {
  const part = selectedPart();
  if (state.editorMode !== 'setup' || !part || part.paths.length > 0) return;
  checkpoint();
  if (!ungroupPart(part.id)) {
    void dialog.alert('This null is animated — delete its keyframes first, then ungroup.');
    return;
  }
  unregisterPart(part.id);
  notify();
  renderPose();
}

/** Bind the selected art parts to the selected bones (skinning). */
export function bindAction(): void {
  checkpoint();
  const err = bindSelectedToBones();
  if (err) {
    void dialog.alert(err);
    return;
  }
  notify();
}

export function buildCanvasTools(el: HTMLElement): void {
  el.innerHTML = '';
  const doc = state.doc;
  if (!doc) return;
  const setup = state.editorMode === 'setup';
  const sep = () => {
    const s = document.createElement('span');
    s.className = 'tool-sep';
    el.appendChild(s);
  };

  // Tool switcher (both modes): select / translate / rotate / IK, keys V T R I.
  const tools = document.createElement('div');
  tools.className = 'tool-switch';
  const toolDefs: [typeof state.tool, keyof typeof ICON_PATHS, string][] = [
    ['select', 'select', 'Select (V) — Edit drags move, Animate drags rotate'],
    ['translate', 'translate', 'Translate (T) — drag the X/Y arrows or the part'],
    ['rotate', 'rotate', 'Rotate (R) — drag the ring or the part'],
    ['ik', 'ik', 'IK (I) — drag a limb end; its parent joints solve to follow'],
  ];
  for (const [tool, ic, title] of toolDefs) {
    const b = document.createElement('button');
    b.appendChild(icon(ic));
    b.title = title;
    if (state.tool === tool) b.classList.add('active');
    b.onclick = () => {
      state.tool = tool;
      notify();
      renderPose();
    };
    tools.appendChild(b);
  }
  el.appendChild(tools);
  sep();

  // Snapping toggle (Setup-mode editing aid; also the % key). Persisted preference,
  // shown in both modes; the active class follows state.snapEnabled.
  const snapBtn = iconButton('snap', '', 'Snapping (%)', () => {
    setSnapEnabled(!state.snapEnabled);
    notify();
    renderPose();
  });
  if (state.snapEnabled) snapBtn.classList.add('active');
  el.appendChild(snapBtn);
  sep();

  if (setup) {
    const anyArt = selectedParts().some((p) => p.paths.length > 0);
    const part = selectedPart();
    const add = (b: HTMLButtonElement, enabled: boolean) => {
      b.disabled = !enabled;
      el.appendChild(b);
      return b;
    };

    add(iconButton('flipH', '', 'Flip the selection horizontally, in place (Shift+H)',
      () => flipAction('h')), anyArt);
    add(iconButton('flipV', '', 'Flip the selection vertically, in place (Shift+V)',
      () => flipAction('v')), anyArt);
    sep();
    add(iconButton('group', 'group', 'Wrap the selection in a group (Ctrl+G)', groupAction),
      state.selectedPartIds.length > 0);
    add(iconButton('ungroup', '', 'Dissolve the selected group/bone (Ctrl+Shift+G)', ungroupAction),
      !!part && part.paths.length === 0);
    sep();
    const boneBtn = add(iconButton('bone', 'bone',
      'Press on the canvas to place the joint, drag to the bone tip, release. Escape cancels.',
      () => {
        startBonePlacement();
        boneBtn.classList.add('armed');
      }), true);
    const arts = selectedParts().filter((p) => p.paths.length > 0);
    const bones = selectedParts().filter((p) => p.kind === 'bone');
    add(iconButton('bind', 'bind', 'Skin the selected art to the selected bones (auto weights)',
      bindAction), arts.length > 0 && bones.length > 0);

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = part
      ? 'Drag moves · click again for scale/rotate handles · double-click enters'
      : 'Click selects · Shift adds · scroll zooms · middle-drag pans';
    el.appendChild(hint);
  } else {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent =
      'Animate — drags key at the playhead. IK tool bends parent chains.';
    el.appendChild(hint);
  }
}

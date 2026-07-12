/**
 * The canvas-tools bar: tool switcher (select/translate/rotate/IK), the snapping
 * toggle, and (Setup mode) flip/group/ungroup/bone actions. Also home to the
 * flip/group/ungroup action handlers themselves, since main.ts binds them to
 * keyboard shortcuts (H/V, Ctrl+G, Ctrl+Shift+G) as well as these buttons.
 *
 * Binding art to bones moved out of this bar in v2.13 — auto-bind (on bone placement)
 * covers the whole-part case, and manual per-node refinement now lives in the
 * node-editing inspector's "bind to bone…" action (`panels/inspector.ts`).
 *
 * Layout: a fixed CONTROLS row (buttons never shrink/hide — see the GOTCHA this fixes
 * in the header of `buildCanvasTools`) plus a slim single-line HINT row below it.
 */

import {
  state, notify, selectedPart, selectedParts, selectPart, groupParts,
  ungroupPart, setSnapEnabled, setFreezeMode,
} from '../core/model';
import {
  renderPose, partRootBoxes, registerPart, unregisterPart, startBonePlacement,
  flipSelected, reorderCanvas,
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
  // BUG FIX: reorderCanvas() above repaints with the OLD (pre-group) selection —
  // selectPart() only changes state, so without this the canvas overlay stayed stale
  // (still showing the previous selection's handles) until the next unrelated canvas
  // interaction. ungroupAction already does this; groupAction was missing it.
  renderPose();
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

/**
 * The controls row + hint row are BOTH fixed height (`style.css`); the hint's own text
 * gets ellipsis overflow (+ a `title` tooltip for the full line) instead of the button
 * row being pushed out — a long hint (the IK tool's, especially) used to shrink the
 * `<p>` down to its unwrapped intrinsic width, which is WIDER than the container, and a
 * flex child can't shrink below that without `overflow`/`text-overflow` handling, so it
 * shoved the tool buttons after it out of the visible bar (queued v2.13 follow-up).
 */
export function buildCanvasTools(el: HTMLElement): void {
  el.innerHTML = '';
  const doc = state.doc;
  if (!doc) return;
  const setup = state.editorMode === 'setup';

  const controls = document.createElement('div');
  controls.className = 'ct-controls';
  const sep = () => {
    const s = document.createElement('span');
    s.className = 'tool-sep';
    controls.appendChild(s);
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
  controls.appendChild(tools);
  sep();

  // Snapping toggle (Setup-mode editing aid; also the % key). Persisted preference,
  // shown in both modes; the active class follows state.snapEnabled.
  const snapBtn = iconButton('snap', '', 'Snapping (%)', () => {
    setSnapEnabled(!state.snapEnabled);
    notify();
    renderPose();
  });
  if (state.snapEnabled) snapBtn.classList.add('active');
  controls.appendChild(snapBtn);

  // Freeze (origin-editing) toggle (Y). While OFF (default) pivot/origin/joint handles
  // are inert; while ON they're draggable and the canvas shows a banner + tint. A
  // momentary mode, so it reads state.freezeMode live (never persisted).
  const freezeBtn = document.createElement('button');
  freezeBtn.className = 'freeze-btn';
  freezeBtn.textContent = '❄ Freeze';
  freezeBtn.title = 'Freeze mode (Y) — unlock pivot / origin / joint editing. ' +
    'Off by default so origins never drag by accident.';
  if (state.freezeMode) freezeBtn.classList.add('active');
  freezeBtn.onclick = () => {
    setFreezeMode(!state.freezeMode);
    notify();
    renderPose();
  };
  controls.appendChild(freezeBtn);
  sep();

  const part = selectedPart();
  if (setup) {
    const anyArt = selectedParts().some((p) => p.paths.length > 0);
    const add = (b: HTMLButtonElement, enabled: boolean) => {
      b.disabled = !enabled;
      controls.appendChild(b);
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
  }
  el.appendChild(controls);

  // One hint line, always — the IK tool's overrides the mode hint (never stacks a
  // second paragraph) so the bar never needs more than the one slim row.
  const hint = document.createElement('p');
  hint.className = 'hint ct-hint';
  hint.textContent = state.tool === 'ik'
    ? "IK: drag a chain's end — parent joints follow"
    : setup
      ? part
        ? 'Drag moves · click again for scale/rotate handles · double-click enters'
        : 'Click selects · Shift adds · scroll zooms · middle-drag pans'
      : 'Animate — drags key at the playhead. IK tool bends parent chains.';
  hint.title = hint.textContent;
  el.appendChild(hint);
}

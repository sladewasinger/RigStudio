/**
 * THE keyboard-shortcut registry, part 1 of 2 (File + Edit contexts — `shortcutBindings
 * Tools.ts` holds Tools/View/Timeline; the 300-code-line budget doesn't fit one file).
 * Together with its sibling, this is a Chain-of-Responsibility DATA table — a SIBLING of
 * `shortcutCascades.ts` (whose DELETE_HANDLERS/ESCAPE_HANDLERS this file's
 * `deleteCascade`/`escapeCascade` entries walk via `runCascade`). `shortcuts.ts`'s
 * `installShortcuts()` concatenates both halves into one `REGISTRY` and checks it on
 * every keydown: the FIRST entry whose `patterns` match the event (and whose `mode`, if
 * set, matches state.editorMode) wins, its `run()` fires, and the search stops. Every
 * entry carries its own `help` metadata (keys/description/context) right next to its
 * match/run, so the "?" overlay (generated in `help.ts`) cannot drift from what the code
 * actually does — the bug this whole redesign exists to prevent (see CLAUDE.md "Think
 * in named patterns, not conventions" + ROADMAP's "Pattern-driven redesign pass").
 *
 * `patterns` are OR'd `KeyPattern`s; each modifier field is `true` (required), `false`
 * (forbidden), or `undefined` (ignored) — this mirrors EXACTLY what the pre-redesign
 * if-cascade checked per binding, audited line-by-line. Several bindings deliberately
 * don't gate every modifier (Tab and PageUp/PageDown never checked ANY modifier) — those
 * quirks are preserved here rather than "fixed", since tightening them would be an
 * unrelated behavior change outside this redesign's scope. `ctrl` matches
 * `ev.ctrlKey || ev.metaKey` (Mac parity), exactly like the old code.
 *
 * All bindings across BOTH halves are structurally DISJOINT (no two entries share an
 * identical key+ctrl+shift+alt+mode signature) — pinned by `shortcuts.test.ts`'s
 * registry-integrity check — so "first match wins" in `shortcuts.ts` is equivalent to
 * "the one matching entry wins"; array order only matters for readability here, not
 * correctness.
 */

import {
  state, notify, activeClip, EditorMode, canMoveSelectedInDrawOrder, moveSelectedInDrawOrder,
  selectAllParts, selectPart, invertSelection,
} from '../core/model';
import { checkpoint, undo, redo } from '../core/history';
import {
  renderPose, reorderCanvas, hasSelectedNode, nudgeSelectedNodes, nudgeSelectedParts, selectAllNodes,
} from '../view';
import { groupAction, ungroupAction } from '../panels';
import {
  render as renderTimeline, copySelectedKeys, pasteKeysAtPlayhead, nudgeSelectedKeys,
  hasKeySelection,
} from '../timeline/timeline';
import { canDuplicateSelection, duplicateSelectedParts } from './actions';
import { saveProject, saveProjectAs } from './shortcutActions';
import { DELETE_HANDLERS, runCascade } from './shortcutCascades';

/** Shared by selectNone/invertSelection below: both are pose-mode selection gestures,
 *  same scope Ctrl+A's non-node branch uses — a no-op in node-editing (nodes have their
 *  own Ctrl+A-driven select-all; "select none/invert of these NODES" is a separate,
 *  unbuilt gesture — out of scope for this wave, see ROADMAP Category B item 4). */
function inPoseSelectionScope(): boolean {
  return !(state.editorMode === 'setup' && state.mode === 'nodes');
}

/** true = required, false = forbidden, undefined = not checked. */
export type ModReq = boolean | undefined;

/** A single OR-alternative a binding's `patterns` matches against. `key` compares
 *  case-insensitively for single-character keys (`ev.key.toLowerCase()`) and exactly for
 *  named keys ('Escape', 'Tab', 'Enter', 'ArrowLeft', 'PageUp', 'F1', ' '). */
export interface KeyPattern {
  key: string;
  ctrl?: ModReq;
  shift?: ModReq;
  alt?: ModReq;
}

export interface ShortcutHelp {
  keys: string;
  description: string;
  context: string;
}

export interface ShortcutBinding {
  id: string;
  patterns: KeyPattern[];
  /** Gates on state.editorMode; omit to fire in both modes (run() may still branch
   *  internally on it, same as the pre-redesign code did for e.g. Ctrl+A/Ctrl+V). */
  mode?: EditorMode;
  run(ev: KeyboardEvent): void;
  help: ShortcutHelp;
}

export const FILE_EDIT_BINDINGS: ShortcutBinding[] = [
  // ---- File ----
  {
    id: 'save',
    // Explicit shift:false (was unchecked pre-Category-B) — Ctrl+Shift+S is now the
    // distinct saveAs entry below; this disambiguates the two signatures.
    patterns: [{ key: 's', ctrl: true, shift: false }],
    run(ev) { ev.preventDefault(); void saveProject(); },
    help: {
      keys: 'Ctrl+S',
      description: 'Quick-save the project — writes in place with no dialog once a file handle is ' +
        'held (D1, Chromium), else downloads a .rig.json reusing the last filename after the first save',
      context: 'File',
    },
  },
  {
    id: 'saveAs',
    patterns: [{ key: 's', ctrl: true, shift: true }],
    run(ev) { ev.preventDefault(); void saveProjectAs(); },
    help: { keys: 'Ctrl+Shift+S', description: 'Save the project As… — always asks for a filename', context: 'File' },
  },
  {
    id: 'open',
    patterns: [{ key: 'o', ctrl: true }],
    run(ev) {
      ev.preventDefault();
      // Proxy-clicks the toolbar button (ui/openFlow.ts's wireOpenButton) rather than
      // duplicating its recents-dropdown-vs-plain-open branch here.
      (document.getElementById('btn-open') as HTMLButtonElement | null)?.click();
    },
    help: {
      keys: 'Ctrl+O',
      description: 'Open an SVG or a saved .rig.json project, or pick from Recent files',
      context: 'File',
    },
  },

  // ---- Edit ----
  {
    id: 'undoRedo',
    patterns: [{ key: 'z', ctrl: true }],
    run(ev) { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); },
    help: { keys: 'Ctrl+Z', description: 'Undo (Shift+Ctrl+Z = redo)', context: 'Edit' },
  },
  {
    id: 'redo',
    patterns: [{ key: 'y', ctrl: true }],
    run(ev) { ev.preventDefault(); redo(); },
    help: { keys: 'Ctrl+Shift+Z / Ctrl+Y', description: 'Redo', context: 'Edit' },
  },
  {
    id: 'copyKeys',
    patterns: [{ key: 'c', ctrl: true }],
    run(ev) {
      if (state.editorMode !== 'animate' || !hasKeySelection()) return;
      ev.preventDefault();
      copySelectedKeys();
    },
    help: { keys: 'Ctrl+C', description: 'Copy the selected keyframes (Animate)', context: 'Edit' },
  },
  {
    id: 'pasteKeys',
    patterns: [{ key: 'v', ctrl: true }],
    run(ev) {
      if (state.editorMode !== 'animate') return;
      ev.preventDefault();
      pasteKeysAtPlayhead();
    },
    help: { keys: 'Ctrl+V', description: 'Paste keyframes at the playhead (Animate)', context: 'Edit' },
  },
  {
    id: 'selectAll',
    // Explicit shift:false (was unchecked pre-Category-B) — Ctrl+Shift+A is now the
    // distinct selectNone entry below; this disambiguates the two signatures.
    patterns: [{ key: 'a', ctrl: true, shift: false }],
    run(ev) {
      ev.preventDefault();
      // Node-editing mode selects nodes; Setup/Animate select every part (same
      // multi-selection mechanism Shift+click extends) — never keyframes.
      if (state.editorMode === 'setup' && state.mode === 'nodes') selectAllNodes();
      else selectAllParts();
      notify();
      renderPose();
    },
    help: {
      keys: 'Ctrl+A',
      description: 'Select all — every part in Edit/Animate, or every node of the edited path in node-editing mode',
      context: 'Edit',
    },
  },
  {
    id: 'selectNone',
    patterns: [{ key: 'a', ctrl: true, shift: true }],
    run(ev) {
      if (!inPoseSelectionScope()) return; // node-editing has its own selection; out of scope here
      ev.preventDefault();
      selectPart(null);
      notify();
      renderPose();
    },
    help: {
      keys: 'Ctrl+Shift+A',
      description: 'Deselect all parts (Edit/Animate pose selection; a no-op in node-editing mode)',
      context: 'Edit',
    },
  },
  {
    id: 'invertSelection',
    patterns: [{ key: 'i', ctrl: true, shift: false, alt: false }],
    run(ev) {
      if (!inPoseSelectionScope()) return; // node-editing has its own selection; out of scope here
      ev.preventDefault();
      invertSelection();
      notify();
      renderPose();
    },
    help: {
      keys: 'Ctrl+I',
      description: 'Invert the part selection — every non-hidden part not currently selected ' +
        '(Edit/Animate pose selection; a no-op in node-editing mode)',
      context: 'Edit',
    },
  },
  {
    id: 'duplicate',
    patterns: [{ key: 'd', ctrl: true }],
    run(ev) {
      if (!canDuplicateSelection()) return; // no preventDefault — lets the browser default proceed
      ev.preventDefault();
      duplicateSelectedParts();
    },
    help: {
      keys: 'Ctrl+D',
      description: 'Duplicate the selected part(s), offset +12,+12 (Edit only, skips skinned parts)',
      context: 'Edit',
    },
  },
  {
    id: 'group',
    patterns: [{ key: 'g', ctrl: true, shift: false }],
    run(ev) { ev.preventDefault(); groupAction(); },
    help: { keys: 'Ctrl+G', description: 'Group the selection into a null', context: 'Edit' },
  },
  {
    id: 'ungroup',
    patterns: [{ key: 'g', ctrl: true, shift: true }],
    run(ev) { ev.preventDefault(); ungroupAction(); },
    help: { keys: 'Ctrl+Shift+G', description: 'Ungroup/dissolve the selected group or bone', context: 'Edit' },
  },
  {
    id: 'deleteCascade',
    patterns: [{ key: 'Delete' }, { key: 'Backspace' }],
    run(ev) { runCascade(DELETE_HANDLERS, ev); },
    help: {
      keys: 'Delete / Backspace',
      description: `Delete ${DELETE_HANDLERS.map((h) => h.short).join(', else ')} (first that applies wins)`,
      context: 'Edit',
    },
  },
  {
    id: 'drawOrderStep',
    patterns: [{ key: 'PageUp' }, { key: 'PageDown' }],
    run(ev) {
      // Step the entered path (within its part) or the selected part through the draw
      // order: PageUp = bring forward (up the layer list), PageDown = send back.
      const delta = ev.key === 'PageUp' ? 1 : -1;
      if (!canMoveSelectedInDrawOrder(delta)) return;
      ev.preventDefault();
      checkpoint();
      moveSelectedInDrawOrder(delta);
      reorderCanvas();
      notify();
    },
    help: {
      keys: 'PageUp / PageDown',
      description: 'Bring the selected part (or entered path) forward / send it backward in draw order ' +
        '(rest stacking; animate a per-part z offset in Animate mode to restack over time)',
      context: 'Edit',
    },
  },
  {
    id: 'arrows',
    patterns: [{ key: 'ArrowLeft' }, { key: 'ArrowRight' }, { key: 'ArrowUp' }, { key: 'ArrowDown' }],
    run(ev) {
      // Node mode: arrows nudge the selected nodes in document units.
      if (state.editorMode === 'setup' && state.mode === 'nodes' && hasSelectedNode()) {
        ev.preventDefault();
        const step = ev.shiftKey ? 5 : 0.5;
        const dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
        const dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
        checkpoint();
        nudgeSelectedNodes(dx, dy);
        return;
      }
      // Setup pose mode: arrows nudge the selected parts, 2 screen px per press
      // (Shift = 20) so the step follows the zoom level. Animate keeps arrows for
      // keyframe nudge / playhead scrub below.
      if (state.editorMode === 'setup' && state.mode === 'rig' && state.selectedPartIds.length > 0) {
        ev.preventDefault();
        const px = ev.shiftKey ? 20 : 2;
        const dx = ev.key === 'ArrowLeft' ? -px : ev.key === 'ArrowRight' ? px : 0;
        const dy = ev.key === 'ArrowUp' ? -px : ev.key === 'ArrowDown' ? px : 0;
        checkpoint();
        if (nudgeSelectedParts(dx, dy)) notify();
        return;
      }
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      const clip = activeClip();
      if (!clip || state.editorMode !== 'animate') return;
      ev.preventDefault();
      const step = (ev.shiftKey ? 100 : 10) * (ev.key === 'ArrowLeft' ? -1 : 1);
      // With keyframes selected the arrows nudge them; otherwise they step the playhead.
      if (nudgeSelectedKeys(step)) return;
      state.currentTime = Math.min(clip.duration, Math.max(0, state.currentTime + step));
      renderPose();
      renderTimeline();
    },
    help: {
      keys: 'Arrow keys',
      description: 'Nudge selected nodes (node-editing mode, 0.5 doc units / Shift = 5), else nudge selected ' +
        'parts (Setup pose mode, 2 screen px / Shift = 20), else scrub the playhead ←/→ (10 ms / Shift = 100 ms) ' +
        'or nudge selected keyframes (Animate)',
      context: 'Edit',
    },
  },
];

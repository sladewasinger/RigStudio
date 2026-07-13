/**
 * THE keyboard-shortcut registry, part 2 of 2 (Tools + View + Timeline contexts —
 * `shortcutBindings.ts` holds File/Edit + the shared `KeyPattern`/`ShortcutBinding`
 * types; see that file's header for the full design rationale, which applies equally
 * here). `shortcuts.ts` concatenates `FILE_EDIT_BINDINGS` (sibling file) with this
 * file's `TOOLS_VIEW_BINDINGS` into one `REGISTRY`.
 */

import { state, notify, setSnapEnabled, setFreezeMode, setCleanPreview } from '../core/model';
import { renderPose, resetView, endBoneChain, zoomBy, startBonePlacement } from '../view';
import { flipAction } from '../panels';
import { togglePlay } from '../timeline/timeline';
import { toggleHelp } from './help';
import { setEditorMode } from './shortcutActions';
import { ESCAPE_HANDLERS, runCascade } from './shortcutCascades';
import { ShortcutBinding } from './shortcutBindings';

export const TOOLS_VIEW_BINDINGS: ShortcutBinding[] = [
  // ---- Tools ----
  {
    id: 'toolSelect',
    patterns: [{ key: 'v', ctrl: false, shift: false, alt: false }],
    run() { state.tool = 'select'; notify(); renderPose(); },
    help: { keys: 'V', description: 'Select tool', context: 'Tools' },
  },
  {
    id: 'toolTranslate',
    patterns: [{ key: 't', ctrl: false, shift: false, alt: false }],
    run() { state.tool = 'translate'; notify(); renderPose(); },
    help: { keys: 'T', description: 'Translate tool', context: 'Tools' },
  },
  {
    id: 'toolRotate',
    patterns: [{ key: 'r', ctrl: false, shift: false, alt: false }],
    run() { state.tool = 'rotate'; notify(); renderPose(); },
    help: { keys: 'R', description: 'Rotate tool', context: 'Tools' },
  },
  {
    id: 'toolIk',
    patterns: [{ key: 'i', ctrl: false, shift: false, alt: false }],
    run() { state.tool = 'ik'; notify(); renderPose(); },
    help: { keys: 'I', description: 'IK tool — drag a limb end, its parent joints solve to follow', context: 'Tools' },
  },
  {
    // NEW (Pattern-driven redesign pass, user-approved 2026-07-12): a real key for the
    // bone tool, arming the SAME pen-tool chain the canvas-tools femur button does
    // (`startBonePlacement`, view/rigOpsPlacement.ts). Setup-mode-gated (unlike V/T/R/I)
    // because the femur button itself only renders in Setup (panels/canvasTools.ts) —
    // arming a chain in Animate would silently hijack every canvas click into bone
    // placement with no visual affordance explaining why.
    id: 'toolBone',
    patterns: [{ key: 'b', ctrl: false, shift: false, alt: false }],
    mode: 'setup',
    run() { startBonePlacement(); notify(); },
    help: {
      keys: 'B',
      description: 'Bone tool — arm a pen-tool bone chain (Setup only; click to place joints, ' +
        'Enter/Escape/double-click finishes)',
      context: 'Tools',
    },
  },
  {
    id: 'snapToggle',
    patterns: [{ key: '%', ctrl: false, alt: false }],
    run(ev) { ev.preventDefault(); setSnapEnabled(!state.snapEnabled); notify(); renderPose(); },
    help: { keys: '%', description: 'Toggle Edit-mode snapping', context: 'Tools' },
  },
  {
    id: 'freezeToggle',
    patterns: [{ key: 'y', ctrl: false, alt: false }],
    run(ev) { ev.preventDefault(); setFreezeMode(!state.freezeMode); notify(); renderPose(); },
    help: {
      keys: 'Y',
      description: 'Toggle freeze (origin-editing) mode — unlocks pivot / origin / joint dragging ' +
        '(off by default so origins never move by accident)',
      context: 'Tools',
    },
  },
  {
    id: 'flipH',
    patterns: [{ key: 'h', shift: true, ctrl: false, alt: false }],
    mode: 'setup',
    run() { flipAction('h'); }, // no preventDefault (pre-redesign parity)
    help: { keys: 'Shift+H', description: 'Flip the selection horizontally, in place (Edit)', context: 'Tools' },
  },
  {
    id: 'flipV',
    patterns: [{ key: 'v', shift: true, ctrl: false, alt: false }],
    mode: 'setup',
    run() { flipAction('v'); }, // no preventDefault (pre-redesign parity)
    help: { keys: 'Shift+V', description: 'Flip the selection vertically, in place (Edit)', context: 'Tools' },
  },
  {
    id: 'cleanPreview',
    patterns: [{ key: 'c', ctrl: false, alt: false, shift: false }],
    mode: 'animate',
    run(ev) { ev.preventDefault(); setCleanPreview(!state.cleanPreview); notify(); renderPose(); },
    help: {
      keys: 'C',
      description: 'Toggle clean preview (Animate) — hide all editor chrome (handles, pivots, bones, ' +
        'gizmos, artboard, onion) to watch the animation. Also in canvas-tools',
      context: 'Tools',
    },
  },

  // ---- View ----
  {
    id: 'fitView',
    patterns: [{ key: 'f', ctrl: false, alt: false }],
    run() { resetView(); renderPose(); }, // no preventDefault (pre-redesign parity)
    help: { keys: 'F', description: 'Fit the view to the document', context: 'View' },
  },
  {
    id: 'zoomIn',
    patterns: [{ key: '+', ctrl: false, alt: false }, { key: '=', ctrl: false, alt: false }],
    run(ev) { ev.preventDefault(); zoomBy(1.25); },
    help: { keys: '+ / =', description: 'Zoom in, centered on the canvas', context: 'View' },
  },
  {
    id: 'zoomOut',
    patterns: [{ key: '-', ctrl: false, alt: false }],
    run(ev) { ev.preventDefault(); zoomBy(1 / 1.25); },
    help: { keys: '-', description: 'Zoom out, centered on the canvas', context: 'View' },
  },
  {
    id: 'tabMode',
    patterns: [{ key: 'Tab' }], // no modifier gate at all (pre-redesign parity)
    run(ev) { ev.preventDefault(); setEditorMode(state.editorMode === 'setup' ? 'animate' : 'setup'); },
    help: { keys: 'Tab', description: 'Toggle Edit / Animate mode', context: 'View' },
  },
  {
    id: 'helpToggleQuestion',
    // '?' (Shift+/ on US layouts — browsers already report the shifted character).
    patterns: [{ key: '?', ctrl: false, alt: false }],
    run(ev) { ev.preventDefault(); toggleHelp(); },
    help: { keys: '? / F1', description: 'Toggle this shortcut overlay', context: 'View' },
  },
  {
    id: 'helpToggleF1',
    patterns: [{ key: 'F1' }], // no modifier gate at all (pre-redesign parity)
    run(ev) { ev.preventDefault(); toggleHelp(); },
    help: { keys: 'F1', description: 'Toggle this shortcut overlay (same as ?)', context: 'View' },
  },
  {
    id: 'finishBoneChainEnter',
    patterns: [{ key: 'Enter', ctrl: false, alt: false }],
    run(ev) {
      // Falls through (no-op) when no chain is active, mirroring Escape / double-click.
      if (!endBoneChain()) return;
      ev.preventDefault();
      notify();
    },
    help: {
      keys: 'Enter',
      description: 'Finish an in-progress bone chain (keeps every committed bone)',
      context: 'View',
    },
  },
  {
    id: 'escapeCascade',
    patterns: [{ key: 'Escape' }],
    run(ev) { runCascade(ESCAPE_HANDLERS, ev); },
    help: {
      keys: 'Escape',
      description: `Step back out: close this overlay → ${ESCAPE_HANDLERS.map((h) => h.short).join(' → ')}`,
      context: 'View',
    },
  },

  // ---- Timeline ----
  {
    id: 'playToggle',
    patterns: [{ key: ' ', ctrl: false, alt: false }],
    run(ev) { ev.preventDefault(); togglePlay(); },
    help: { keys: 'Space', description: 'Play / pause', context: 'Timeline' },
  },
];

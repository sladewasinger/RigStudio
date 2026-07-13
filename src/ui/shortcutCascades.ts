/**
 * The two genuine priority cascades inside the keyboard-shortcut handler — Chain of
 * Responsibility, documented in the style of `view/interactions/priority.ts` (see
 * CLAUDE.md "Think in named patterns, not conventions" + ROADMAP's "Pattern-driven
 * redesign pass"). `DELETE_HANDLERS` and `ESCAPE_HANDLERS` are the ordered tier lists
 * `shortcutBindings.ts`'s `deleteCascade`/`escapeCascade` entries walk via `runCascade`:
 * the first tier whose `run()` returns true wins the key press and every later tier
 * never runs. The order below is the MINED, load-bearing order of the pre-redesign
 * main.ts if-cascade — each row's comment says why it must precede the next.
 *
 * `short` is a human-readable phrase for the tier's target/effect. `help.ts` joins these
 * to generate the ONE composite help row each cascade renders as — the same array a
 * developer reads to understand precedence also produces its own documentation, so the
 * two can no longer drift apart (the bug this whole redesign exists to prevent).
 */

import { state, notify, setFreezeMode } from '../core/model';
import { checkpoint } from '../core/history';
import { hasSelectedNode, deleteSelectedNodes, endBoneChain, stepOutFocus, renderPose } from '../view';
import { deleteSelectedParts } from './actions';
import { hasKeySelection, deleteSelectedKeys } from '../timeline/timeline';
import { smHandleDelete, smHandleEscape } from '../panels/smPanel';
import { aiHandleEscape } from '../panels/ai';

export interface CascadeTier {
  name: string;
  /** Human phrase for the generated help description (e.g. "selected keyframes"). */
  short: string;
  /** Returns true if this tier consumed the press. NOT every tier calls
   *  ev.preventDefault() when it acts — see each row's comment; preserved exactly from
   *  the pre-redesign behavior rather than "fixed" as an unrelated change. */
  run(ev: KeyboardEvent): boolean;
}

/** Walk `tiers` in order; the first `run()` to return true stops the chain. */
export function runCascade(tiers: readonly CascadeTier[], ev: KeyboardEvent): void {
  for (const tier of tiers) {
    if (tier.run(ev)) return;
  }
}

export const DELETE_HANDLERS: CascadeTier[] = [
  // 1. The state-machine editor owns Delete while the logic view is on screen — it must
  //    run before ANY keyframe/node/part interpretation of the same press.
  {
    name: 'stateMachine',
    short: "the logic editor's selected transition/state",
    run(ev) {
      if (!smHandleDelete()) return false;
      ev.preventDefault();
      return true;
    },
  },
  // 2. Animate mode: a keyframe selection outranks node/part deletion (nodes/parts only
  //    exist in Setup, so this and the tiers below are mutually exclusive by editor mode).
  {
    name: 'animateKeys',
    short: 'selected keyframes (Animate)',
    run(ev) {
      if (!(state.editorMode === 'animate' && hasKeySelection())) return false;
      ev.preventDefault();
      deleteSelectedKeys();
      return true;
    },
  },
  // 3. Node-editing mode: delete the selected path nodes before falling back to
  //    whole-part deletion.
  {
    name: 'nodes',
    short: 'selected path nodes (node-editing mode)',
    run(ev) {
      if (!(state.editorMode === 'setup' && state.mode === 'nodes' && hasSelectedNode())) return false;
      ev.preventDefault();
      checkpoint();
      deleteSelectedNodes();
      return true;
    },
  },
  // 4. Setup pose mode: delete the selected layers (children re-adopt grandparents; fully
  //    undoable). The final fallback — node-editing mode with nothing selected falls
  //    through to here too, so the mode check below stays explicit.
  {
    name: 'setupParts',
    short: 'selected layers (Setup pose mode)',
    run(ev) {
      if (!(state.editorMode === 'setup' && state.mode === 'rig' && state.selectedPartIds.length > 0)) {
        return false;
      }
      ev.preventDefault();
      deleteSelectedParts();
      return true;
    },
  },
];

export const ESCAPE_HANDLERS: CascadeTier[] = [
  // 1. Freeze mode exits first (its own early tier) — Escape drops out of origin editing
  //    before anything else, so a stray Escape can't cancel a bone placement or step out
  //    of a group while the user only meant to leave freeze.
  {
    name: 'freezeMode',
    short: 'exit freeze mode',
    run(ev) {
      if (!state.freezeMode) return false;
      ev.preventDefault();
      setFreezeMode(false);
      notify();
      renderPose();
      return true;
    },
  },
  // 2. AI preview next: Escape discards an active preview-before-apply candidate (doc
  //    untouched) without also deselecting or stepping out of anything.
  {
    name: 'aiPreview',
    short: 'discard the AI preview',
    run(ev) {
      if (!aiHandleEscape()) return false;
      ev.preventDefault();
      return true;
    },
  },
  // 3. State-machine editor next: cancel an armed transition or stop a running preview.
  {
    name: 'stateMachine',
    short: 'stop the logic preview',
    run(ev) {
      if (!smHandleEscape()) return false;
      ev.preventDefault();
      return true;
    },
  },
  // 4. Finish an in-progress bone chain (keeps committed bones, auto-binds once), then
  //    step out one drill-down level — Inkscape parity. UNLIKE the tiers above, this one
  //    does NOT call ev.preventDefault() (preserved exactly from the pre-redesign code).
  {
    name: 'boneChain',
    short: 'finish the bone chain',
    run(_ev) {
      if (!endBoneChain()) return false;
      notify();
      return true;
    },
  },
  // 5. Universal fallback: step out one drill-down level (entered path → deselect → pop
  //    the innermost entered group). Always wins — nothing runs after this tier, and it
  //    also does NOT call ev.preventDefault() (matches the pre-redesign code).
  {
    name: 'stepOut',
    short: 'exit path / exit group / deselect',
    run(_ev) {
      stepOutFocus();
      notify();
      renderPose();
      return true;
    },
  },
];

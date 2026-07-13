/**
 * THE gesture-pipeline priority table (Chain of Responsibility, user mandate 2026-07-12 —
 * see CLAUDE.md "Think in named patterns, not conventions"). `GESTURE_PIPELINES` is the
 * ordered list the router (`index.ts`) walks on every pointerdown: the first pipeline whose
 * `claim()` returns non-null wins the gesture, and every later row never runs. The order
 * below is the mined, load-bearing order of the OLD if-cascade — see each row's comment for
 * why it must precede the next; the ordering itself is what this table makes readable at a
 * glance instead of buried in nesting.
 *
 * `claim` returns a fresh DragState (a drag starts — the router installs it as `ctx.drag`
 * and remembers this pipeline as the gesture's claimant), `'handled'` (the press is
 * consumed with no drag — a plain selection click, an inert freeze no-op, a pen-tool chain
 * click), or `null` (this pipeline doesn't apply — try the next row). `move`/`release` are
 * optional: the router calls them on the CLAIMANT only, for as long as the gesture runs.
 */

import { HitContext } from './hit';
import { DragState } from '../context';

export interface GesturePipeline {
  name: string;
  claim(hit: HitContext, ev: PointerEvent): DragState | 'handled' | null;
  move?(ev: PointerEvent, d: DragState): void;
  release?(ev: PointerEvent, d: DragState): void;
}

import { BONE_CHAIN_PIPELINE } from './pipelines/boneChain';
import { GIZMO_PIPELINE } from './pipelines/gizmo';
import { BONE_TIP_PIPELINE } from './pipelines/boneTip';
import { PAN_PIPELINE, BLANK_PIPELINE } from './pipelines/blank';
import { HANDLES_PIPELINE } from './pipelines/handles';
import { NODE_PIPELINE } from './pipelines/node';
import { PIVOT_PIPELINE } from './pipelines/pivot';
import { NODE_BEND_MARQUEE_PIPELINE } from './pipelines/nodesBendMarquee';
import { ARTWORK_PIPELINE } from './pipelines/artwork';

/**
 * Non-primary-button guard: none of the DOM-driven checks in the rows below (handles/
 * node/pivot/nodes/artwork) gate on `ev.button`, so once boneChain/gizmo/boneTip/pan have
 * all passed on a non-left button, this swallows the press outright — the original cascade
 * did this with a bare `if (ev.button !== 0) return;`, which also means a right-click (or
 * any other button) on blank canvas does NOT fall through to the blank-deselect fallback.
 */
const NON_PRIMARY_BUTTON_GUARD: GesturePipeline = {
  name: 'nonPrimaryButtonGuard',
  claim(_hit, ev) {
    return ev.button !== 0 ? 'handled' : null;
  },
};

export const GESTURE_PIPELINES: readonly GesturePipeline[] = [
  // 1. Armed pen tool: a click is not a drag, so this must run before anything else can
  //    interpret the press as a handle/gizmo/artwork hit while a chain is in progress.
  BONE_CHAIN_PIPELINE,
  // 2. Tool-gizmo (translate arrows / rotate ring): drawn ON TOP of the Setup handle set
  //    and artwork, so it must win any overlap with `handles`/`artwork` below.
  GIZMO_PIPELINE,
  // 3. Bone-tip reshape handle: must win over `pivot` below — a child bone's tip and its
  //    child's shared-joint origin marker can sit at the same point, and the tip handle
  //    wins the direct press.
  BONE_TIP_PIPELINE,
  // 4. Middle-button pan: claims regardless of what's under the cursor (checked before the
  //    left-button-only rows below).
  PAN_PIPELINE,
  // 5. Everything below requires the primary (left) button.
  NON_PRIMARY_BUTTON_GUARD,
  // 6. Setup handle set (scale/skew/rotate-handle corners+sides) on the selected part.
  HANDLES_PIPELINE,
  // 7. Node endpoint/control-handle: must win over `pivot`/nodes-bend-marquee below — a
  //    node handle sits directly on the edited outline, where a bend hit-test could match.
  NODE_PIPELINE,
  // 8. Freeze-gated joint/pivot marker (a shared child-bone joint is live in both modes;
  //    a root-bone origin or art pivot is freeze-only, inert-but-consuming otherwise).
  PIVOT_PIPELINE,
  // 9. Node-editing mode's remaining canvas ownership: bend the edited outline near it,
  //    else rubber-band a node marquee. Never reached outside node-editing mode.
  NODE_BEND_MARQUEE_PIPELINE,
  // 10. Artwork body press: select (+ group substitution/multi-select) then translate/
  //     rotate/IK-pose — since the 2026-07-12 ruling this includes SKINNED art
  //     (rotate/translate carry its bone chain; IK stays its own sub-branch). The last
  //     DOM-driven row — every row above is a more specific hit target that must win first.
  ARTWORK_PIPELINE,
  // 11. Blank canvas (or a click-through fall from dimmed artwork): the universal
  //     fallback when nothing else claimed the press. Always last.
  BLANK_PIPELINE,
];

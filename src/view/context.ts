/**
 * Shared editing-canvas state — the view "context".
 *
 * The canvas view began as one large module; it is being split into `src/view/*`
 * layers. All mutable module-level state those layers share lives here in a single
 * `ctx` object so any layer can read and write it without importing the facade.
 * Constants, the DragState union, and the handful of pure micro-utils that everything
 * needs live here too. (The linear-blend skin cache is deliberately NOT here —
 * skinRender.ts owns it privately.)
 */

import { state, Channel, RigPart } from '../core/model';
import { Mat } from '../geometry/transforms';
import { SnapCandidate } from '../geometry/snap';

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const ROTATE_SNAP_DEGREES = 15;
/** Client-pixel movement before a drag counts as a drag (keeps clicks mutation-free). */
export const DRAG_THRESHOLD_PX = 3;
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 50;
/** A pen-tool chain click closer than this (SCREEN px, so zoom-consistent) to the pending
 *  origin commits no bone — it's a mis-click or the second click of a finishing double-click. */
export const MIN_BONE_LENGTH_PX = 6;

export type DragState =
  | {
      kind: 'rotate';
      /** Every selected part with its starting (absolute) value; setup writes rest. */
      targets: { part: RigPart; start: number }[];
      pivotX: number; pivotY: number; // primary part's live pivot, root coords
      startAngle: number;
      /** Accumulation state (P2b bug fix): raw atan2 snapshots jump ±360° when the
       * drag crosses the ±180° ray, and sampleKeyList interpolates absolute values
       * linearly, so a naive (angle - startAngle) diff sent recorded rotations the
       * "wrong direction" on multi-turn winds. lastAngle/accumDeg instead sum each
       * move's WRAPPED step (wrapToPi), which never jumps by more than one step. */
      lastAngle: number;
      accumDeg: number;
      current: { x: number; y: number } | null;
      currentDelta: number;
      snapped: boolean;
      startClient: { x: number; y: number };
      active: boolean;
      /** A motionless body-drag rotate click cycles the handle set (scale↔rotate); the
       * gizmo-ring / rotate-handle rotate drags leave this unset. */
      toggleOnClick?: boolean;
    }
  | {
      kind: 'translate';
      /** invLinear maps a root-space delta into each part's parent-chain space. */
      targets: { part: RigPart; startTx: number; startTy: number; invLinear: Mat }[];
      startX: number; startY: number;
      current: { x: number; y: number } | null;
      startClient: { x: number; y: number };
      active: boolean;
      /** Gizmo axis constraint: deltas lock to root-space x or y. */
      axis: 'x' | 'y' | null;
      /** Click (no movement) on the already-primary part cycles scale↔rotate handles. */
      toggleOnClick: boolean;
      /** Frozen snap features (start pose), computed lazily on the first snapped frame. */
      snapFeatures?: { moving: SnapCandidate[]; targets: SnapCandidate[] } | null;
    }
  | {
      kind: 'ik';
      /** The full bone chain FABRIK rotates, ROOT→effector (outermost first). Every bone
       *  participates incl. the grabbed one — the n-joint replacement for the old two-joint
       *  p1/p2. Recomputed at drag start; rotations are written back per bone from the
       *  solved joint polyline (interactions.ts). */
      chain: RigPart[];
      /** Effector bone (deepest in `chain`) whose TIP FABRIK drives to the pointer. */
      grabbed: RigPart;
      /** Effector point in the grabbed bone's own frame (its tip): the FABRIK end-effector
       *  and the overlay target-line / effector-marker anchor. */
      grabLocal: { x: number; y: number };
      /** Live pointer position (root coords) — the FABRIK target, and the drag-time target
       *  line from the effector to the pointer showing how far short a clamped reach falls. */
      current: { x: number; y: number } | null;
      startClient: { x: number; y: number };
      active: boolean;
    }
  | { kind: 'boneTip'; part: RigPart; startClient: { x: number; y: number }; active: boolean }
  | {
      kind: 'scale';
      part: RigPart;
      handle: string; // nw|ne|se|sw|n|e|s|w
      startSx: number; startSy: number;
      startTx: number; startTy: number;
      grabLocal: { x: number; y: number };
      anchorLocal: { x: number; y: number };
      anchorRoot: { x: number; y: number };
      /** root → part-local at drag start (frozen frame for stable factors). */
      invStart: Mat;
      invChainLinear: Mat;
      current: { x: number; y: number } | null;
      startClient: { x: number; y: number };
      active: boolean;
    }
  | {
      kind: 'groupScale';
      group: RigPart;
      handle: string; // nw|ne|se|sw|n|e|s|w
      /** Group's effective pivot at drag start — the frozen anchor every descendant
       * scales about (root space). Never changes during the drag: a scale never
       * touches the group's OWN rest, so its effective pivot is genuinely constant. */
      pivotRoot: { x: number; y: number };
      /** The dragged handle's root position at drag start — the scale factor's 1.0
       * reference distance from pivotRoot. */
      grabRoot: { x: number; y: number };
      /** Every descendant's frozen drag-start snapshot (rigOps.ts's GroupScaleMember
       * shape, matched structurally so this layer never imports from rigOps). */
      members: {
        part: RigPart;
        startSx: number; startSy: number;
        startPivotRoot: { x: number; y: number };
      }[];
      /** poseTime() at drag start — Setup's null, threaded through so applyGroupScale's
       *  live chainMatOf re-reads use the same sampling mode as the seed snapshot. */
      poseT: number | null;
      current: { x: number; y: number } | null;
      startClient: { x: number; y: number };
      active: boolean;
    }
  | {
      kind: 'skew';
      part: RigPart;
      side: 'n' | 'e' | 's' | 'w';
      startTanKx: number; startTanKy: number;
      startTx: number; startTy: number;
      grabLocal: { x: number; y: number };
      anchorLocal: { x: number; y: number };
      anchorRoot: { x: number; y: number };
      invStart: Mat;
      invChainLinear: Mat;
      current: { x: number; y: number } | null;
      startClient: { x: number; y: number };
      active: boolean;
    }
  | {
      kind: 'pivot';
      part: RigPart;
      /** Pivot + own translate at drag start: compensation is solved absolutely from
       * these so per-move rounding never accumulates into artwork drift. */
      startPivot: { x: number; y: number };
      startTranslate: { x: number; y: number };
      startClient: { x: number; y: number };
      active: boolean;
    }
  | {
      kind: 'node'; part: RigPart; pathId: string; cmdIndex: number;
      field: 'x' | 'x1' | 'x2';
      startClient: { x: number; y: number }; active: boolean;
    }
  | {
      kind: 'nodeMarquee';
      startClient: { x: number; y: number };
      rect: HTMLDivElement;
      additive: boolean;
    }
  | {
      kind: 'bendSegment';
      part: RigPart;
      pathId: string;
      /** The L/C command forming the grabbed segment (bends between its two nodes). */
      cmdIndex: number;
      /** Curve parameter of the grab point, clamped away from the endpoints. */
      t: number;
      startClient: { x: number; y: number };
      active: boolean;
    }
  | { kind: 'pan'; startClient: { x: number; y: number }; startRect: { x: number; y: number; w: number; h: number } };

/**
 * PEN-TOOL BONE CHAIN in progress (Item: pen-tool bone chains). Non-null between the
 * first click of a chain (which sets `origin`) and the chain ending (Escape/Enter/
 * double-click). Each subsequent click commits a bone `origin`→click and advances `origin`
 * to that new tip. ONE checkpoint (`checkpointed`, deferred to the first COMMIT — a bare
 * origin click stays history-free) covers the whole chain; auto-bind runs ONCE at the end,
 * so a chain of N bones is a single undo. `placingBone` stays true throughout (the tool is
 * armed); `boneChain` distinguishes "awaiting first click" (null) from "chain running".
 */
export interface BoneChainState {
  /** Pending origin (root/doc space) — where the NEXT committed bone starts. */
  origin: { x: number; y: number };
  /** Parent for the FIRST committed bone: the art/bone selected when the chain started
   *  (hierarchy-as-assignment / continue-an-existing-chain), or null for a free-form root.
   *  Later bones parent to the previously committed bone (see `committed`). */
  parentId: string | null;
  /** Ids of bones committed so far this chain, in order (auto-bind + one-undo bookkeeping). */
  committed: string[];
  /** True once checkpoint() has fired (before the first commit) — the drag-deferral pattern. */
  checkpointed: boolean;
  /** Live pointer (root space) for the preview segment; null before the first move / just
   *  after a commit (so the ghost only draws once the cursor actually moves). */
  cursor: { x: number; y: number } | null;
}

/** Mutable state shared across the view layers (formerly view.ts's module-level lets). */
export interface ViewContext {
  svg: SVGSVGElement | null;
  rootGroup: SVGGElement | null;
  onionGroup: SVGGElement | null;
  overlay: SVGGElement | null;
  /**
   * Every DOM `<g>` currently painting a part's OWN paths (U2: `RigPart.childOrder`
   * runs — see `core/paintOrder.ts`), in run order. Every part has AT LEAST one entry
   * (an empty-pathIds "anchor" group for a partless bone/group, or a doc whose
   * childOrder is the synthesized paths-first shape — the pre-U2, single-group-per-part
   * case); a part whose childOrder interleaves its own paths with children gets MORE
   * than one, each carrying the part's SAME composed transform (flat siblings, like
   * before — no DOM nesting, no inheritance change). Consumers that only need the
   * part's transform/CTM may read any entry (`[0]`, via `partDom.ts`'s
   * `primaryPartGroup`); consumers that need the part's own rendered GEOMETRY (bbox,
   * `<path>` elements) must consider every entry (`partDom.ts`'s `partOwnBBox`/
   * `partOwnPathElements`) — see that module's header for the full consumer audit.
   */
  partGroups: Map<string, SVGGElement[]>;

  // Which handle set the selected part shows in Setup mode; clicking the part again
  // toggles it (Inkscape behavior). Resets when the primary selection changes.
  handleMode: 'scale' | 'rotate';
  handlePartId: string | null;

  // Groups the user has double-clicked into (clicks inside them select parts directly).
  enteredGroups: Set<string>;

  // The point (in SVG user/viewBox space) a live drag is currently snapped to, drawn as
  // an overlay marker. Null when no snap is engaged; cleared when the drag ends.
  snapMarker: { x: number; y: number } | null;

  // Node-editing selection: every selected endpoint (multi-select), plus the primary
  // (last-clicked) node the inspector reports on. Keys are `${pathId}|${cmdIndex}`.
  selectedNodes: Set<string>;
  selectedNode: { pathId: string; cmdIndex: number } | null;

  // Current viewBox rect — the zoom/pan state. Survives canvas rebuilds (undo/redo);
  // reset explicitly on document import.
  viewRect: { x: number; y: number; w: number; h: number } | null;

  placingBone: boolean;
  /** The in-progress pen-tool bone chain (see BoneChainState), or null. */
  boneChain: BoneChainState | null;

  /**
   * State-machine PREVIEW override: when set (by smPanel), renderPose samples every channel
   * from the running SMInstance — which owns its own clocks — instead of the active clip at
   * the current time. Null restores normal Animate/Setup sampling. This is the ONLY hook the
   * state-machine editor needs inside the view monolith.
   */
  poseSampler: ((target: string, channel: Channel) => number) | null;

  drag: DragState | null;
}

export const ctx: ViewContext = {
  svg: null,
  rootGroup: null,
  onionGroup: null,
  overlay: null,
  partGroups: new Map<string, SVGGElement[]>(),
  handleMode: 'scale',
  handlePartId: null,
  enteredGroups: new Set<string>(),
  snapMarker: null,
  selectedNodes: new Set<string>(),
  selectedNode: null,
  viewRect: null,
  placingBone: false,
  boneChain: null,
  poseSampler: null,
  drag: null,
};

// Snapping is a SETUP-mode editing aid only (node/pivot/part-body drags line up on
// nearby geometry). Animate posing stays free — keyed motion should never jump to art.
export function snappingActive(): boolean {
  return state.snapEnabled && state.editorMode === 'setup';
}

// ---- U2 partGroups read helpers ----
//
// `ctx.partGroups` may hold MORE THAN ONE `<g>` per part (see the field's own doc comment
// above) — these live in context.ts, the layering DAG's lowest tier, so every other
// view/* module can reach them regardless of where it sits (the overlay cluster sits
// BELOW view/partDom.ts, which owns WRITING the registry — see that module's header —
// so these READS can't live there). `partDom.ts` re-exports all three for discoverability.

/** A representative DOM group for `partId` — for reading the part's TRANSFORM/CTM only
 *  (every run of a part shares the same composed transform — flat siblings, no DOM
 *  nesting). Never use this for bbox/path-content — see `partOwnBBox`/`partOwnPathElements`. */
export function primaryPartGroup(partId: string): SVGGElement | undefined {
  return ctx.partGroups.get(partId)?.[0];
}

interface Box { x: number; y: number; width: number; height: number; }

function unionBox(a: Box, b: Box): Box {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width), y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Root-space-PRE-transform union bbox of every one of `partId`'s own run groups that
 * actually contains path content (an empty anchor run is excluded, not folded in as a
 * spurious box at the origin). Every run's children live in the SAME local coordinate
 * space (they share one transform), so a plain box union is valid before mapping through
 * it — exactly reproduces the pre-U2 `g.getBBox()` call when a part has only one run.
 * Null when the part currently renders no geometry of its own (a partless bone/group, or
 * a not-yet-built part) — callers that need a fallback box supply their own `?? {0,0,0,0}`
 * (see `canvas.ts`'s pivot seeding, which relies on that exact pre-U2 fallback shape).
 */
export function partOwnBBox(partId: string): Box | null {
  let box: Box | null = null;
  for (const g of ctx.partGroups.get(partId) ?? []) {
    if (g.childElementCount === 0) continue;
    const b = g.getBBox();
    box = box ? unionBox(box, b) : b;
  }
  return box;
}

/** Every `<path>` DOM element belonging to `partId`'s OWN paths, across all its runs. */
export function partOwnPathElements(partId: string): SVGPathElement[] {
  const groups = ctx.partGroups.get(partId) ?? [];
  return groups.flatMap((g) => Array.from(g.querySelectorAll<SVGPathElement>('[data-path-id]')));
}

export function nodeKey(pathId: string, cmdIndex: number): string {
  return `${pathId}|${cmdIndex}`;
}

export function parseNodeKey(key: string): { pathId: string; cmdIndex: number } {
  const i = key.lastIndexOf('|');
  return { pathId: key.slice(0, i), cmdIndex: Number(key.slice(i + 1)) };
}

/** Strip translation from a matrix (for converting deltas rather than points). */
export function linearOnly(m: Mat): Mat {
  return { ...m, e: 0, f: 0 };
}

/** Signed angle wrapped into (-π, π] — the per-step building block for accumulating
 * a rotate drag's total angle without a ±360° jump when it crosses the ±180° ray. */
export function wrapToPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Lightweight keyframe-lane refresh during a drag (vs. the full-panel notify() on
 *  pointerup) — shared by every pose-drag pipeline that keys as it moves. */
export function notifyTimelineOnly(): void {
  document.dispatchEvent(new CustomEvent('rig-keys-changed'));
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** For values that must stay finer than the 0.1 rest grid (zoomed-in nudges, pivot
 * compensation) — still coarse enough to keep serialized floats clean. */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

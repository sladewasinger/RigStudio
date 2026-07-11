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
      /** Nearest ancestor (link 2, e.g. forearm) — rotated by delta2. */
      p1: RigPart;
      /** Second ancestor (link 1, e.g. upper arm) — rotated by delta1; null = aim. */
      p2: RigPart | null;
      /** Grab point in the clicked part's full-pose frame (rides the chain). */
      grabLocal: { x: number; y: number };
      grabbed: RigPart;
      startClient: { x: number; y: number };
      active: boolean;
    }
  | { kind: 'boneTip'; part: RigPart; startClient: { x: number; y: number }; active: boolean }
  | {
      kind: 'placeBone';
      originRoot: { x: number; y: number };
      current: { x: number; y: number } | null;
    }
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

/** Mutable state shared across the view layers (formerly view.ts's module-level lets). */
export interface ViewContext {
  svg: SVGSVGElement | null;
  rootGroup: SVGGElement | null;
  onionGroup: SVGGElement | null;
  overlay: SVGGElement | null;
  partGroups: Map<string, SVGGElement>;

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
  partGroups: new Map<string, SVGGElement>(),
  handleMode: 'scale',
  handlePartId: null,
  enteredGroups: new Set<string>(),
  snapMarker: null,
  selectedNodes: new Set<string>(),
  selectedNode: null,
  viewRect: null,
  placingBone: false,
  poseSampler: null,
  drag: null,
};

// Snapping is a SETUP-mode editing aid only (node/pivot/part-body drags line up on
// nearby geometry). Animate posing stays free — keyed motion should never jump to art.
export function snappingActive(): boolean {
  return state.snapEnabled && state.editorMode === 'setup';
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

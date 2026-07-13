/**
 * Shared pan/zoom math for the timeline curve editor (`timeline/graph.ts`) and the
 * state-machine logic graph (`panels/sm/graphCamera.ts`) — both editors window a 2D
 * "view rect" over their own content and let the user wheel-zoom at the cursor /
 * middle-drag pan it, clamped to 0.2x-5x of a fit-to-content rect, with per-entity
 * session state (NOT persisted, NOT checkpointed — navigation, not document data).
 *
 * Deliberately excludes `view/camera.ts` (the main canvas's pan/zoom): that one uses
 * absolute doc-size clamps and a single global view rather than per-entity fit-relative
 * state, so despite the superficially similar wheel/middle-drag gestures it is NOT the
 * same abstraction (see CLAUDE.md's pattern-audit note on this refactor).
 *
 * DOM event wiring (wheel/pointerdown listeners, screen-CTM/client-rect scale
 * derivation) stays in each consumer: the curve editor windows a FIXED pixel viewBox
 * through an inner padded "plot" rect and its value axis is y-flipped (increasing
 * value means DECREASING pixel y), while the SM graph windows the svg's own viewBox
 * directly with a plain y-down axis and no inner inset — different enough that forcing
 * one DOM wiring path onto both would risk changing feel. What's genuinely identical
 * between the two is the recentering/clamping algebra and the per-entity cache
 * pattern, so only that moves here — verbatim, per axis, from both originals.
 */

export interface ViewRect { x: number; y: number; w: number; h: number }

/** Zoom range, relative to each entity's own fit-to-content rect (not absolute). */
export const VIEW_ZOOM_MIN = 0.2;
export const VIEW_ZOOM_MAX = 5;

/** Clamp a candidate span to 0.2x-5x of a reference (fit) span on the same axis. */
export function clampZoomSpan(span: number, fitSpan: number): number {
  return Math.min(fitSpan / VIEW_ZOOM_MIN, Math.max(fitSpan / VIEW_ZOOM_MAX, span));
}

/**
 * Recenter a 1-D window so the anchor point (e.g. the cursor, expressed in this
 * axis's own units) stays fixed as its span changes oldSpan -> newSpan: the classic
 * `anchor - (anchor - origin) * (newSpan / oldSpan)` zoom-at-a-point formula. Used for
 * BOTH axes of a plain top-left-origin rect (the SM graph's x and y both recenter on
 * their low/origin edge), and — passing the axis's HIGH edge as `origin` instead —
 * for an axis whose ViewRect stores its low edge but must recenter on its high edge
 * (the curve editor's value axis, where increasing value means decreasing pixel y);
 * the caller derives the low edge back out afterward in that case.
 */
export function recenterAxis(anchor: number, origin: number, oldSpan: number, newSpan: number): number {
  return anchor - (anchor - origin) * (newSpan / oldSpan);
}

/**
 * New origin after panning by a delta already expressed in this axis's own units
 * (client-pixel delta / screen scale, or further converted into data units by the
 * caller). `sign` flips the direction for axes where a positive on-screen drag should
 * INCREASE rather than decrease the origin (again, the curve editor's y-flipped value
 * axis — every other axis in both consumers uses the default).
 */
export function panAxis(startOrigin: number, deltaInAxisUnits: number, sign: 1 | -1 = -1): number {
  return startOrigin + sign * deltaInAxisUnits;
}

/** This entity's cached view rect, fitting it once the first time it's shown. */
export function getFittedViewRect<K, V>(store: Map<K, V>, key: K, fit: () => V): V {
  let vr = store.get(key);
  if (!vr) {
    vr = fit();
    store.set(key, vr);
  }
  return vr;
}

/** Force-refit an entity's view rect (the "fit" button), replacing any cached state. */
export function refitViewRect<K, V>(store: Map<K, V>, key: K, fit: () => V): V {
  const vr = fit();
  store.set(key, vr);
  return vr;
}

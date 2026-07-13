/**
 * Unit tests for `geometry/viewRect.ts` — the pan/zoom math shared by the timeline
 * curve editor (`timeline/graph.ts`) and the state-machine logic graph
 * (`panels/sm/graphCamera.ts`). Covers the primitives directly (clamp/recenter/pan/
 * per-entity cache), plus an EQUALITY-ORACLE section: the two consumers' pre-refactor
 * formulas, copied here VERBATIM as hardcoded oracles (0.2/5 written as literals, not
 * imported from the module under test, so the oracle can't drift with it), asserted
 * against the same math assembled from the shared primitives the way each consumer
 * now assembles it. This is what "behavior-identical refactor" is pinned against.
 */

import { describe, expect, it } from 'vitest';
import {
  ViewRect, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX, clampZoomSpan, recenterAxis, panAxis,
  getFittedViewRect, refitViewRect,
} from '../geometry/viewRect';

describe('clampZoomSpan', () => {
  it('passes spans through unchanged inside the 0.2x-5x band', () => {
    expect(clampZoomSpan(50, 100)).toBe(50); // 0.5x of fit — inside 0.2x-5x
  });

  it('clamps zooming in past 5x the fit span', () => {
    expect(clampZoomSpan(1, 100)).toBe(20); // 100/5
  });

  it('clamps zooming out past 0.2x (5x span) the fit span', () => {
    expect(clampZoomSpan(10000, 100)).toBe(500); // 100/0.2
  });

  it('constants match the documented 0.2x-5x range', () => {
    expect(VIEW_ZOOM_MIN).toBe(0.2);
    expect(VIEW_ZOOM_MAX).toBe(5);
  });
});

describe('recenterAxis', () => {
  it('keeps the anchor point at the same normalized position under any span change', () => {
    for (const [anchor, origin, oldSpan, newSpan] of [
      [25, 0, 100, 40],
      [-10, -50, 200, 900],
      [0, 0, 1, 1],
      [37.5, 10, 60, 12],
    ] as const) {
      const newOrigin = recenterAxis(anchor, origin, oldSpan, newSpan);
      const oldFrac = (anchor - origin) / oldSpan;
      const newFrac = (anchor - newOrigin) / newSpan;
      expect(newFrac).toBeCloseTo(oldFrac, 9);
    }
  });

  it('is a no-op when the span is unchanged', () => {
    expect(recenterAxis(12, 3, 50, 50)).toBeCloseTo(3, 9);
  });
});

describe('panAxis', () => {
  it('subtracts the delta by default (dragging content one way moves the window the other)', () => {
    expect(panAxis(10, 5)).toBe(5);
    expect(panAxis(10, -5)).toBe(15);
  });

  it('adds the delta when sign is +1 (the curve editor y-flipped value axis)', () => {
    expect(panAxis(10, 5, 1)).toBe(15);
  });
});

describe('per-entity view-rect cache', () => {
  const fit = (x: number): ViewRect => ({ x, y: 0, w: 10, h: 10 });

  it('fits once per key and caches thereafter', () => {
    const store = new Map<string, ViewRect>();
    let fitCalls = 0;
    const fitFn = () => { fitCalls++; return fit(1); };
    const first = getFittedViewRect(store, 'a', fitFn);
    const second = getFittedViewRect(store, 'a', fitFn);
    expect(fitCalls).toBe(1);
    expect(second).toBe(first); // same cached object, not just equal value
  });

  it('keeps separate entries isolated per key', () => {
    const store = new Map<string, ViewRect>();
    const a = getFittedViewRect(store, 'a', () => fit(1));
    const b = getFittedViewRect(store, 'b', () => fit(2));
    expect(a.x).toBe(1);
    expect(b.x).toBe(2);
    a.x = 999; // mutating one entity's live rect (as zoom/pan do)
    expect(store.get('b')!.x).toBe(2); // the other is untouched
  });

  it('refitViewRect always replaces, even when an entry is already cached', () => {
    const store = new Map<string, ViewRect>();
    getFittedViewRect(store, 'a', () => fit(1));
    const refit = refitViewRect(store, 'a', () => fit(42));
    expect(refit.x).toBe(42);
    expect(store.get('a')!.x).toBe(42);
  });
});

// ---- Equality oracle: pre-refactor formulas vs. the shared-primitive assembly ----

describe('equality oracle: graphCamera.ts-style zoom (aspect-preserving)', () => {
  /** Copied verbatim from the pre-refactor `zoomGraphAround` body in
   *  panels/sm/graphCamera.ts (0.2/5 hardcoded, not imported from the module under test). */
  function oracleZoom(vr: ViewRect, fitW: number, px: number, py: number, factor: number): ViewRect {
    const minW = fitW / 5;
    const maxW = fitW / 0.2;
    const newW = Math.min(maxW, Math.max(minW, vr.w / factor));
    const applied = vr.w / newW;
    return {
      x: px - (px - vr.x) / applied,
      y: py - (py - vr.y) / applied,
      w: newW,
      h: vr.h / applied,
    };
  }

  /** Assembled from the shared primitives exactly as the current `zoomGraphAround` does. */
  function newZoom(vr: ViewRect, fitW: number, px: number, py: number, factor: number): ViewRect {
    const newW = clampZoomSpan(vr.w / factor, fitW);
    const applied = vr.w / newW;
    const newH = vr.h / applied;
    return {
      x: recenterAxis(px, vr.x, vr.w, newW),
      y: recenterAxis(py, vr.y, vr.h, newH),
      w: newW,
      h: newH,
    };
  }

  const cases: Array<[ViewRect, number, number, number, number]> = [
    [{ x: 0, y: 0, w: 480, h: 260 }, 480, 240, 130, 1.2], // ordinary zoom-in
    [{ x: -40, y: -20, w: 500, h: 300 }, 480, 100, 50, 0.8], // zoom-out, off-origin
    [{ x: 0, y: 0, w: 480, h: 260 }, 480, 0, 0, 1e6], // clamp: way past 5x zoom-in
    [{ x: 0, y: 0, w: 480, h: 260 }, 480, 500, 300, 1e-6], // clamp: way past 0.2x (zoom-out)
  ];

  it('matches the original formula field-for-field, including clamped cases', () => {
    for (const [vr, fitW, px, py, factor] of cases) {
      const oracle = oracleZoom(vr, fitW, px, py, factor);
      const actual = newZoom(vr, fitW, px, py, factor);
      expect(actual.x).toBeCloseTo(oracle.x, 9);
      expect(actual.y).toBeCloseTo(oracle.y, 9);
      expect(actual.w).toBeCloseTo(oracle.w, 9);
      expect(actual.h).toBeCloseTo(oracle.h, 9);
    }
  });
});

describe('equality oracle: graph.ts-style zoom (independent per-axis, y-flipped value axis)', () => {
  /** Copied verbatim from the pre-refactor `zoomViewRect` body in timeline/graph.ts
   *  (dataT/dataV stand in for plot.tOf(px)/plot.vOf(py) — the DOM-facing pixel->data
   *  conversion is orthogonal to the math under test). */
  function oracleZoom(vr: ViewRect, fit: ViewRect, dataT: number, dataV: number, factor: number): ViewRect {
    const minT = fit.w / 5, maxT = fit.w / 0.2;
    const minV = fit.h / 5, maxV = fit.h / 0.2;
    const newTSpan = Math.min(maxT, Math.max(minT, vr.w / factor));
    const newVSpan = Math.min(maxV, Math.max(minV, vr.h / factor));
    const v1Old = vr.y + vr.h;
    const v1New = dataV + (v1Old - dataV) * (newVSpan / vr.h);
    return {
      x: dataT - (dataT - vr.x) * (newTSpan / vr.w),
      y: v1New - newVSpan,
      w: newTSpan,
      h: newVSpan,
    };
  }

  /** Assembled from the shared primitives exactly as the current `zoomViewRect` does. */
  function newZoom(vr: ViewRect, fit: ViewRect, dataT: number, dataV: number, factor: number): ViewRect {
    const newW = clampZoomSpan(vr.w / factor, fit.w);
    const newH = clampZoomSpan(vr.h / factor, fit.h);
    const v1Old = vr.y + vr.h;
    const v1New = recenterAxis(dataV, v1Old, vr.h, newH);
    return {
      x: recenterAxis(dataT, vr.x, vr.w, newW),
      y: v1New - newH,
      w: newW,
      h: newH,
    };
  }

  const fit: ViewRect = { x: 0, y: -10, w: 1000, h: 20 };
  const cases: Array<[ViewRect, number, number, number]> = [
    [{ x: 0, y: -10, w: 1000, h: 20 }, 400, -2, 1.3], // ordinary zoom-in
    [{ x: 100, y: -5, w: 300, h: 8 }, 250, -1, 0.7], // zoom-out, off-origin
    [{ x: 0, y: -10, w: 1000, h: 20 }, 400, -2, 1e6], // clamp both axes past 5x
    [{ x: 0, y: -10, w: 1000, h: 20 }, 400, -2, 1e-6], // clamp both axes past 0.2x
  ];

  it('matches the original formula field-for-field, including the y-flip and clamps', () => {
    for (const [vr, dataT, dataV, factor] of cases) {
      const oracle = oracleZoom(vr, fit, dataT, dataV, factor);
      const actual = newZoom(vr, fit, dataT, dataV, factor);
      expect(actual.x).toBeCloseTo(oracle.x, 9);
      expect(actual.y).toBeCloseTo(oracle.y, 9);
      expect(actual.w).toBeCloseTo(oracle.w, 9);
      expect(actual.h).toBeCloseTo(oracle.h, 9);
    }
  });

  it('one axis can clamp while the other keeps zooming (impossible under aspect-preserving zoom)', () => {
    // h is already zoomed in past its own floor (fit.h/5 = 2) while w sits at the fit
    // span — a state the aspect-preserving graphCamera zoom could never reach (it
    // derives h purely from w's applied ratio, so the two axes are always locked).
    const wideFit: ViewRect = { x: 0, y: 0, w: 10000, h: 10 };
    const vr: ViewRect = { x: 0, y: 0, w: 10000, h: 1 };
    const factor = 3;
    const oracle = oracleZoom(vr, wideFit, 5000, 0.5, factor);
    const actual = newZoom(vr, wideFit, 5000, 0.5, factor);
    expect(actual.w).toBeCloseTo(oracle.w, 9);
    expect(actual.h).toBeCloseTo(oracle.h, 9);
    // w keeps zooming in (10000/3); h is already past its floor and clamps to it (2).
    expect(actual.w).toBeCloseTo(10000 / 3, 6);
    expect(actual.h).toBeCloseTo(2, 9);
  });
});

describe('equality oracle: pan (client-delta math)', () => {
  it('graphCamera.ts-style pan: origin - delta/scale on both axes', () => {
    const scale = 2.4;
    const dx = 37, dy = -19;
    const startX = 10, startY = -5;
    const oracleX = startX - dx / scale;
    const oracleY = startY - dy / scale;
    expect(panAxis(startX, dx / scale)).toBeCloseTo(oracleX, 9);
    expect(panAxis(startY, dy / scale)).toBeCloseTo(oracleY, 9);
  });

  it('graph.ts-style pan: t subtracts, v ADDS (y-flipped value axis)', () => {
    const plotW = 400, plotH = 180;
    const tSpan = 2000, vSpan = 50;
    const dxPx = 60, dyPx = -22;
    const startT0 = 0, startV0 = -25;
    const oracleT0 = startT0 - (dxPx / plotW) * tSpan;
    const oracleV0 = startV0 + (dyPx / plotH) * vSpan;
    expect(panAxis(startT0, (dxPx / plotW) * tSpan)).toBeCloseTo(oracleT0, 9);
    expect(panAxis(startV0, (dyPx / plotH) * vSpan, 1)).toBeCloseTo(oracleV0, 9);
  });
});

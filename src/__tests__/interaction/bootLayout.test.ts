/**
 * Boot-time layout regression (2026-07-13 user report): "the first thing I see [on
 * launch] is a giant black blob / giant translucent circles, self-healing on the
 * first zoom or pan." Root cause: `#layout`'s CSS grid (style.css, since the
 * "Ergonomics" wave e623d4a) declares FOUR columns —
 * `var(--layers-width, 200px) 6px 1fr 260px` — where the 6px column is reserved for
 * the `#layers-splitter` div that `panels/layersResize.ts`'s `ensureLayersSplitter`
 * inserts as `#layers`' next sibling. That insertion only happens inside
 * `buildLayersPanel`, which only ever runs from `main.ts`'s `subscribe()` callback —
 * i.e. on `notify()`. Every doc-loading path (main.ts's autosave-restore boot block,
 * and `afterDocReplaced` for New/Open/Load-sample) calls `buildCanvas()` — which does
 * a synchronous render-then-measure pass (view/canvas.ts's pivot seeding, plus the
 * first `renderPose()`/`renderOverlay()`) — BEFORE its own trailing `notify()` call.
 * So whenever `state.doc` is ALREADY set the very first time `buildCanvas()` ever
 * runs in a page session (precisely the autosave-restore boot path — including a
 * hard reload right after "Load sample", which autosaves Pip first), `#layout` still
 * has only its 3 static HTML children (`#layers`/`#canvas-col`/`#inspector`); with
 * implicit grid auto-placement they land in columns 1/2/3, so `#canvas-col` (and
 * therefore `#canvas`'s 100%-sized `<svg>`) is measured at the SECOND column's width
 * — a fixed 6px, not the intended `1fr`. `handleSize()`/`screenScaleOf()`
 * (view/coords.ts) read that degenerate `getScreenCTM()` and bake wildly oversized
 * radii into every overlay chrome element (pivot ghosts, bone kites, gizmos) for that
 * one `renderPose()` call; they stay wrong until the NEXT renderPose() (any zoom/pan/
 * click) recomputes them against the by-then-correct CTM — exactly the reported
 * "self-healing on first interaction." Artwork geometry itself is unaffected (it's
 * driven by the live CSS/viewBox, not a baked JS scale reading), and so is seeded
 * pivot DATA (view/canvas.ts's pivot-seeding math uses `getCTM()`, not
 * `getScreenCTM()` — the SVG's own internal viewBox-space transform, independent of
 * on-screen CSS pixel size) — consistent with the corruption being purely visual,
 * transient chrome rather than a persisted doc corruption.
 *
 * The existing suite never caught this because `harness.ts`'s shared `bootRig()`
 * always `localStorage.clear()`s before importing main.ts, so `state.doc` is null at
 * main.ts's own first (unconditional) `notify()` — which harmlessly inserts the
 * splitter while the grid still only has 3 real children — and only THEN does the
 * harness click "Load sample", by which point the grid is already correct. This file
 * is its OWN standalone test file (Vitest Browser Mode isolates each file in its own
 * module registry/iframe — see harness.ts's `bootRig` doc comment) so its
 * `import('../../main')` is a genuinely FRESH module evaluation, with localStorage
 * pre-seeded like a real returning user's autosave.
 */
import { describe, it, expect } from 'vitest';
import { importSvg } from '../../io/importSvg';
import { serializeDoc, RigDoc } from '../../core/model';
import { INDEX_BODY, waitFor, elementScreenSize } from './harness';

const AUTOSAVE_KEY = 'rig-studio-autosave';

async function fetchPipDoc(): Promise<RigDoc> {
  const res = await fetch(`${import.meta.env.BASE_URL}PIP_MASTER.svg`);
  if (!res.ok) throw new Error('PIP_MASTER.svg not found under public/');
  return importSvg(await res.text(), 'pip');
}

describe('scenario 13 — boot-time layout (autosave restore)', () => {
  it('renders sane chrome and a correctly-fitted viewBox with ZERO interactions', async () => {
    const doc = await fetchPipDoc();
    localStorage.clear();
    localStorage.setItem(AUTOSAVE_KEY, serializeDoc(doc));

    document.body.innerHTML = INDEX_BODY;
    await import('../../main'); // fresh module eval: the real boot-time autosave restore

    await waitFor(() => document.getElementById('rig-svg'), { message: 'boot canvas built' });

    const svg = document.getElementById('rig-svg')!;

    // (a) the fitted viewBox matches the doc within tolerance — resetView() derives it
    // purely from doc data (never a DOM measurement), so this should ALWAYS hold; it's
    // asserted anyway as the baseline sanity check the task calls for. (The degenerate
    // #canvas-col grid column this scenario exercises is itself already self-healed by
    // the time `import()` resolves — main.ts's own trailing `notify()` call fixes it
    // within the same synchronous module evaluation — so it can't be asserted directly
    // here; what's left BROKEN afterward is exactly the chrome baked during the one
    // `renderPose()` call that ran before that fix, which (b) below pins.)
    const [vx, vy, vw, vh] = (svg.getAttribute('viewBox') ?? '').split(/\s+/).map(Number);
    expect(vx).toBeCloseTo(doc.viewBox.x, 5);
    expect(vy).toBeCloseTo(doc.viewBox.y, 5);
    expect(vw).toBeCloseTo(doc.viewBox.w, 5);
    expect(vh).toBeCloseTo(doc.viewBox.h, 5);

    // (b) chrome is screen-SANE at boot, before any pointer/zoom interaction. A
    // pivot-ghost's on-screen diameter is designed to be screen-constant chrome (a
    // few px); under the bug it bakes in the inverse of a ~0.028 stale scale instead
    // of the real ~1.2+ one — a ~40x blowup, easily over 100px. Pip's fresh import has
    // no bones, so every art part draws a `.pivot-ghost` (renderPivotGhosts skips only
    // the selected part and empty-path parts; nothing is selected at boot).
    const ghost = elementScreenSize('.pivot-ghost');
    expect(ghost.w).toBeLessThan(30);
    expect(ghost.h).toBeLessThan(30);
  });
});

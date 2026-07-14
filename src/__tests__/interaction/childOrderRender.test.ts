/**
 * U2 (rendering honors childOrder) — the live-canvas half of the wave. Covers:
 *  - BYTE-IDENTITY: a LEGACY doc (childOrder stripped from every part, so normalizeDoc
 *    synthesizes paths-first on load — exactly any pre-U1 save) renders EXACTLY the
 *    pre-U2 DOM — one run per part, no `data-run` attribute, doc.parts order, every
 *    group's own paths matching part.paths. (Until U4 the bundled sample itself was
 *    that doc; the importer now records TRUE document order, so the legacy shape is
 *    reconstructed here by stripping the recorded slots first.)
 *  - U4: the freshly imported Pip sample paints its recorded interleaving — the outer
 *    body's own shadow run comes AFTER the nested body's group (the restacking-fidelity
 *    correction), and face's own run after eyes'.
 *  - A fabricated INTERLEAVED doc (body: [path shadow_under, child innerA, child innerB,
 *    path shadow_over]) paints in slot order: the two shadow runs bracket the children.
 *  - Animate-mode keyed `z` on a child re-sorts SIBLING part slots only; the bracketing
 *    path runs never move. Edit mode always shows the pure rest/slot order regardless.
 *  - Segment-op slot healing (U1's documented gap, closed here): deleteSelectedSegment
 *    splitting one path into two keeps childOrder coherent IMMEDIATELY, no reload/
 *    normalizeDoc needed.
 *  - The partDom "multi-run consumer" audit: a part whose OWN geometry spans more than
 *    one run must still measure its FULL bbox (partOwnBBox's union, not just the first
 *    run) — flipSelected's rest-translation compensation is the sharpest instrument for
 *    this, since it lands at a hand-computed exact value (0) only when the bbox is right.
 *
 * The fabricated doc is installed directly (buildCanvas/resetView/notify — mirrors
 * harness.ts's loadFixtureSvg, minus the SVG-import step) so its slot shapes stay
 * hand-pinned and independent of the sample's own (now genuinely interleaved, since
 * U4) recorded order.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { checkpoint } from '../../core/history';
import {
  RigDoc, RigPart, state, notify, setKeyframeAt, serializeDoc, deserializeDoc,
  isChildOrderCoherent, childOrderAgreesWithCanonicalPartOrder,
} from '../../core/model';
import {
  buildCanvas, resetView, canDeleteSegment, deleteSelectedSegment, flipSelected,
} from '../../view';
import {
  bootRig, resetRig, rootGEl, svgEl, overlayEl, pathElById, repaint, setEditorMode,
  click, clientCenterOf, enterNodeMode, selectByLabel,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

/** Every top-level paint entry (a part's own run, or a bone/group glyph anchor) in live
 *  DOM order: {partId, run (undefined for the degenerate single-run case), pathIds}. */
function domRuns(): { partId: string; run: string | undefined; pathIds: string[] }[] {
  return Array.from(rootGEl().children).map((g) => ({
    partId: (g as SVGElement).dataset.partId!,
    run: (g as SVGElement).dataset.run,
    pathIds: Array.from(g.querySelectorAll('[data-path-id]')).map((p) => (p as SVGElement).dataset.pathId!),
  }));
}

describe('scenario — byte-identity: a LEGACY doc (no childOrder) renders EXACTLY as before U2', () => {
  it('one run per part, no data-run attribute, doc.parts order, own paths matching part.paths', () => {
    // Reconstruct the pre-U1 save shape from the live sample: strip every recorded
    // childOrder and reload — deserializeDoc's normalizeDoc synthesizes paths-first,
    // the legacy order.
    const raw = JSON.parse(serializeDoc(state.doc!));
    for (const part of raw.doc.parts) delete part.childOrder;
    installDoc(deserializeDoc(JSON.stringify(raw)));

    const runs = domRuns();
    const doc = state.doc!;
    expect(runs.length).toBe(doc.parts.length);
    expect(runs.map((r) => r.partId)).toEqual(doc.parts.map((p) => p.id));
    expect(runs.every((r) => r.run === undefined), 'no part.paths ever split into >1 run').toBe(true);
    for (const part of doc.parts) {
      const r = runs.find((x) => x.partId === part.id)!;
      expect(r.pathIds, `part ${part.label}`).toEqual(part.paths.map((p) => p.id));
    }
  });
});

describe('scenario — U4: the freshly imported sample paints its recorded TRUE document order', () => {
  it('outer body\'s shadow run paints ABOVE the nested body; face\'s own run above eyes', () => {
    const doc = state.doc!;
    const outerBody = doc.parts.find((p) => p.label === 'body' && !p.parentId)!;
    const innerBody = doc.parts.find((p) => p.label === 'body' && !!p.parentId)!;
    const face = doc.parts.find((p) => p.label === 'face' && !p.parentId)!;
    const eyes = doc.parts.find((p) => p.label === 'eyes')!;
    // The recorded slots (importer document order — see importSvg.test.ts for the model
    // half; this is the CANVAS half).
    expect(outerBody.childOrder!.map((s) => s.kind)).toEqual(['part', 'path']);
    const order = domRuns().map((r) => r.partId);
    expect(order.indexOf(outerBody.id), 'body\'s own (shadow) run after the nested body')
      .toBeGreaterThan(order.indexOf(innerBody.id));
    expect(order.indexOf(face.id), 'face\'s own (mouth) run after eyes')
      .toBeGreaterThan(order.indexOf(eyes.id));
  });
});

// ---- A fabricated interleaved doc ----

const REST = { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 };
const PAINT = { nodeTypes: null, fill: '#336699', fillOpacity: 1, stroke: null, strokeWidth: 1, strokeOpacity: 1, transform: '' };

function makeInterleavedDoc(): RigDoc {
  const body: RigPart = {
    id: 'body', label: 'body', kind: 'art', transform: '', pivot: { x: 20, y: 20 }, pivotHint: null,
    rest: { ...REST }, parentId: null,
    paths: [
      { id: 'shadow_under', label: 'shadow_under', d: 'M 0,0 L 40,0 L 40,10 L 0,10 Z', ...PAINT },
      { id: 'shadow_over', label: 'shadow_over', d: 'M 0,30 L 40,30 L 40,40 L 0,40 Z', ...PAINT },
    ],
    childOrder: [
      { kind: 'path', id: 'shadow_under' },
      { kind: 'part', id: 'innerA' },
      { kind: 'part', id: 'innerB' },
      { kind: 'path', id: 'shadow_over' },
    ],
  };
  const innerA: RigPart = {
    id: 'innerA', label: 'innerA', kind: 'art', transform: '', pivot: { x: 10, y: 10 }, pivotHint: null,
    rest: { ...REST }, parentId: 'body',
    // Open, 4-node path (M + 3 L) so the segment-healing scenario below can split it.
    paths: [{ id: 'innerA_p', label: 'innerA_p', d: 'M 0,0 L 20,0 L 20,20 L 0,20', ...PAINT }],
    childOrder: [{ kind: 'path', id: 'innerA_p' }],
  };
  const innerB: RigPart = {
    id: 'innerB', label: 'innerB', kind: 'art', transform: '', pivot: { x: 5, y: 5 }, pivotHint: null,
    rest: { ...REST }, parentId: 'body',
    paths: [{ id: 'innerB_p', label: 'innerB_p', d: 'M 0,0 L 10,0 L 10,10 L 0,10 Z', ...PAINT }],
    childOrder: [{ kind: 'path', id: 'innerB_p' }],
  };
  return {
    name: 'interleave-fixture',
    viewBox: { x: -20, y: -20, w: 100, h: 100 },
    parts: [body, innerA, innerB],
    rootPivot: { x: 0, y: 0 },
    clips: [{ name: 'idle', duration: 1000, tracks: [] }],
  };
}

function installDoc(doc: RigDoc): void {
  state.doc = doc;
  state.editorMode = 'setup';
  state.mode = 'rig';
  state.selectedPartId = null;
  state.selectedPartIds = [];
  state.selectedPathId = null;
  state.activeClipIndex = 0;
  state.currentTime = 0;
  buildCanvas(document.getElementById('canvas')!);
  resetView();
  notify();
}

describe('scenario — interleaved childOrder paints in document-slot order (fabricated doc)', () => {
  beforeEach(() => installDoc(makeInterleavedDoc()));

  it('body splits into 2 runs bracketing innerA/innerB, in slot order', () => {
    const runs = domRuns();
    expect(runs.map((r) => (r.run !== undefined ? `${r.partId}:${r.run}` : r.partId))).toEqual([
      'body:0', 'innerA', 'innerB', 'body:1',
    ]);
    expect(runs[0].pathIds).toEqual(['shadow_under']);
    expect(runs[3].pathIds).toEqual(['shadow_over']);
  });

  it('shadow_over\'s element is AFTER innerA\'s group in DOM order — paints on top of it', () => {
    const shadowOverG = pathElById('shadow_over').closest('[data-part-id]')!;
    const innerAG = svgEl().querySelector('[data-part-id="innerA"]')!;
    const all = Array.from(rootGEl().children);
    expect(all.indexOf(shadowOverG)).toBeGreaterThan(all.indexOf(innerAG));
  });

  it('shadow_under\'s element is BEFORE innerA\'s group — paints underneath it', () => {
    const shadowUnderG = pathElById('shadow_under').closest('[data-part-id]')!;
    const innerAG = svgEl().querySelector('[data-part-id="innerA"]')!;
    const all = Array.from(rootGEl().children);
    expect(all.indexOf(shadowUnderG)).toBeLessThan(all.indexOf(innerAG));
  });
});

describe('scenario — Animate-mode keyed z re-sorts SIBLING part slots only; path runs hold', () => {
  beforeEach(() => installDoc(makeInterleavedDoc()));

  it('a z key on innerA (originally drawn FIRST/behind) lifts it past innerB; the bracketing shadow runs never move', () => {
    // Ascending z-sort: a HIGHER z sorts LATER (drawn last = on top). innerA already
    // paints before innerB by default (doc.parts sibling order), so keying innerA's z
    // ABOVE innerB's rest 0 is what actually swaps their relative order — keying innerB
    // instead would be a no-op (it's already drawn last).
    setEditorMode('animate');
    checkpoint();
    setKeyframeAt('innerA', 'z', 500, 5);
    notify();
    state.currentTime = 500;
    repaint();

    const order = domRuns().map((r) => (r.run !== undefined ? `${r.partId}:${r.run}` : r.partId));
    expect(order).toEqual(['body:0', 'innerB', 'innerA', 'body:1']);
    expect(domRuns()[0].pathIds).toEqual(['shadow_under']);
    expect(domRuns()[3].pathIds).toEqual(['shadow_over']);
  });

  it('Edit mode shows the pure rest/slot order regardless of the z key', () => {
    setEditorMode('animate');
    checkpoint();
    setKeyframeAt('innerA', 'z', 500, 5);
    notify();
    state.currentTime = 500;
    repaint();
    expect(domRuns().map((r) => r.partId)).toEqual(['body', 'innerB', 'innerA', 'body']); // restacked

    setEditorMode('setup');
    repaint();
    expect(domRuns().map((r) => r.partId)).toEqual(['body', 'innerA', 'innerB', 'body']); // back to authored slot order
  });
});

describe('scenario — segment-op slot healing (U1\'s documented gap, closed by U2)', () => {
  beforeEach(() => installDoc(makeInterleavedDoc()));

  it('deleteSelectedSegment splitting innerA_p into two paths keeps childOrder coherent IMMEDIATELY', () => {
    enterNodeMode('innerA', 'innerA_p');
    const nodeHandle = (i: number): SVGElement => {
      const el = overlayEl().querySelector(
        `[data-role="node"][data-path-id="innerA_p"][data-cmd-index="${i}"][data-field="x"]`,
      );
      if (!el) throw new Error(`no node handle at cmd ${i}`);
      return el as SVGElement;
    };
    // Nodes 1 and 2 are the two ADJACENT interior nodes (20,0) and (20,20) — deleting
    // that segment splits the 4-node open path into two 2-node pieces, both kept.
    const c1 = clientCenterOf(nodeHandle(1));
    click(c1.x, c1.y);
    const c2 = clientCenterOf(nodeHandle(2));
    click(c2.x, c2.y, { shiftKey: true });
    expect(canDeleteSegment(), 'exactly 2 adjacent nodes selected').toBe(true);

    expect(deleteSelectedSegment()).toBe(true);

    const innerA = state.doc!.parts.find((p) => p.id === 'innerA')!;
    expect(innerA.paths.length, 'split into two pieces, both >= 2 nodes so both kept').toBe(2);
    expect(isChildOrderCoherent(state.doc!), 'set coherence — no reload needed').toBe(true);
    expect(childOrderAgreesWithCanonicalPartOrder(state.doc!), 'rule 4 still holds').toBe(true);
    expect(
      innerA.childOrder!.filter((s) => s.kind === 'path').map((s) => s.id).sort(),
      'both path ids have a slot',
    ).toEqual(innerA.paths.map((p) => p.id).sort());
  });
});

describe('scenario — a part\'s own geometry spans multiple runs (partDom multi-run consumers)', () => {
  beforeEach(() => installDoc(makeInterleavedDoc()));

  it('flipping body VERTICALLY needs ZERO rest-translation compensation: its pivot (20,20) ' +
    'already sits at the UNION bbox center of BOTH shadow paths, split across 2 runs', () => {
    // shadow_under (0,0)-(40,10) center (20,5), 15 ABOVE the pivot; shadow_over
    // (0,30)-(40,40) center (20,35), 15 BELOW it — union (0,0)-(40,40) center EXACTLY
    // (20,20) == body.pivot, offset ZERO. Both shapes share the SAME x-offset from the
    // pivot (0), so an 'h' flip can't tell the two bbox sources apart — only 'v' (which
    // depends on the Y offset, deliberately made non-zero and DIFFERENT for each single
    // run vs the union) does. Scaling around the pivot leaves a pivot-coincident point
    // fixed, so the correct union bbox needs NO compensating rest.ty — a consumer that
    // only measured shadow_under's run (the pre-U2 single-group assumption) would
    // compute center (20,5), 15 off-pivot, and the flip would visibly shift the artwork
    // (a large, exactly-predictable nonzero rest.ty).
    selectByLabel('body');
    expect(flipSelected('v')).toBe(true);

    const body = state.doc!.parts.find((p) => p.id === 'body')!;
    expect(body.rest.sy).toBe(-1);
    expect(body.rest.tx).toBeCloseTo(0, 5);
    expect(body.rest.ty).toBeCloseTo(0, 5);
  });
});

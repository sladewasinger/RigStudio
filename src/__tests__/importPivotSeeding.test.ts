// @vitest-environment jsdom
/// <reference types="vite/client" />
/**
 * Headless-import pivot seeding (2026-07-14). The importer marks every part whose
 * rotation pivot it couldn't recover with an EXPLICIT pivotHint (a `bboxCenter`
 * placeholder, or an Inkscape `centerOffset` crosshair); `seedImportedPivots` resolves
 * those pure-doc for a headless import (the in-app canvas does the same live). Without it
 * a CLI/MCP import keeps (near-)origin pivots and later rotations orbit off the artwork
 * (the far-orbit Girl file). Run under jsdom so `importSvg` gets a real DOMParser — the
 * seeding function itself is pure and needs no DOM.
 */
import { describe, expect, it } from 'vitest';
import { importSvg } from '../io/importSvg';
import { seedImportedPivots, RigDoc, RigPart } from '../core/model';
// eslint-disable-next-line import/no-unresolved
import PIP_SVG from '../../public/PIP_MASTER.svg?raw';

const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';
function svg(body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="${INKSCAPE_NS}" ` +
    `viewBox="0 0 300 300">${body}</svg>`
  );
}
const part = (label: string) => (d: RigDoc) => d.parts.find((p) => p.label === label)!;

function makePart(over: Partial<RigPart> & { id: string }): RigPart {
  return {
    label: over.id, kind: 'art', transform: '', pivot: { x: 0, y: 0 },
    pivotHint: null, parentId: null, paths: [],
    rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 },
    ...over,
  };
}
const rect = (id: string, x: number, y: number, w: number, h: number) => ({
  id, label: id, d: `M ${x},${y} L ${x + w},${y} L ${x + w},${y + h} L ${x},${y + h} Z`,
  fill: '#000', fillOpacity: 1, stroke: null, strokeWidth: 1, strokeOpacity: 1, transform: '',
});

describe('importSvg records explicit placeholder hints', () => {
  it('a group with no rotation and no crosshair gets a bboxCenter hint (not a bare null)', () => {
    const doc = importSvg(svg(`<g inkscape:label="a"><rect x="40" y="60" width="20" height="20"/></g>`), 't');
    const a = part('a')(doc);
    expect(a.pivotHint).toEqual({ kind: 'bboxCenter' });
    expect(a.pivot).toEqual({ x: 0, y: 0 }); // still the unresolved placeholder pre-seed
  });

  it('an Inkscape transform-center becomes a centerOffset hint (+y flipped)', () => {
    const doc = importSvg(svg(
      `<g inkscape:label="a" inkscape:transform-center-x="5" inkscape:transform-center-y="7">` +
      `<rect x="40" y="60" width="20" height="20"/></g>`), 't');
    expect(part('a')(doc).pivotHint).toEqual({ kind: 'centerOffset', dx: 5, dy: -7 });
  });

  it('a genuine rotate() transform recovers the fixed point and leaves NO hint', () => {
    const doc = importSvg(svg(`<g inkscape:label="a" transform="rotate(30 150 150)"><rect x="40" y="60" width="20" height="20"/></g>`), 't');
    const a = part('a')(doc);
    expect(a.pivotHint).toBeNull();
    expect(a.pivot.x).toBeCloseTo(150, 3);
    expect(a.pivot.y).toBeCloseTo(150, 3);
  });

  it('a NON-origin placeholder (composed ancestor translate) still gets a hint — not sniffed from (0,0)', () => {
    // The Girl-file shape: an outer translate wraps a child group with no rotation.
    const doc = importSvg(svg(
      `<g transform="translate(-0.5,0)"><g inkscape:label="inner"><rect x="40" y="60" width="20" height="20"/></g></g>`), 't');
    expect(part('inner')(doc).pivotHint).toEqual({ kind: 'bboxCenter' });
  });
});

describe('seedImportedPivots resolves hints to geometry centers', () => {
  it('a leaf art seeds to its own path bbox center', () => {
    const doc: RigDoc = {
      name: 't', viewBox: { x: 0, y: 0, w: 300, h: 300 }, rootPivot: { x: 0, y: 0 }, clips: [],
      parts: [makePart({ id: 'a', pivotHint: { kind: 'bboxCenter' }, paths: [rect('pa', 40, 60, 20, 40)] })],
    };
    seedImportedPivots(doc);
    expect(doc.parts[0].pivot).toEqual({ x: 50, y: 80 });
    expect(doc.parts[0].pivotHint).toBeNull();
  });

  it('a PARTLESS wrapper group seeds to its SUBTREE geometry center, not the origin (the Girl case)', () => {
    const doc: RigDoc = {
      name: 't', viewBox: { x: 0, y: 0, w: 300, h: 300 }, rootPivot: { x: 0, y: 0 }, clips: [],
      parts: [
        makePart({ id: 'grp', kind: 'group', pivotHint: { kind: 'bboxCenter' } }),
        makePart({ id: 'child', parentId: 'grp', paths: [rect('pc', 100, 200, 40, 40)] }),
      ],
    };
    seedImportedPivots(doc);
    const grp = doc.parts[0];
    expect(grp.pivot).toEqual({ x: 120, y: 220 }); // amid the child, NOT (0,0)
    expect(grp.pivot.x).not.toBe(0);
  });

  it('a centerOffset hint adds its crosshair offset to the bbox center', () => {
    const doc: RigDoc = {
      name: 't', viewBox: { x: 0, y: 0, w: 300, h: 300 }, rootPivot: { x: 0, y: 0 }, clips: [],
      parts: [makePart({ id: 'a', pivotHint: { kind: 'centerOffset', dx: 5, dy: -7 }, paths: [rect('pa', 40, 60, 20, 20)] })],
    };
    seedImportedPivots(doc);
    expect(doc.parts[0].pivot).toEqual({ x: 50 + 5, y: 70 - 7 });
  });

  it('leaves a rotation-recovered part (no hint) untouched, and is idempotent', () => {
    const doc: RigDoc = {
      name: 't', viewBox: { x: 0, y: 0, w: 300, h: 300 }, rootPivot: { x: 0, y: 0 }, clips: [],
      parts: [makePart({ id: 'a', pivot: { x: 150, y: 150 }, pivotHint: null, paths: [rect('pa', 40, 60, 20, 20)] })],
    };
    seedImportedPivots(doc);
    expect(doc.parts[0].pivot).toEqual({ x: 150, y: 150 });
    seedImportedPivots(doc); // idempotent — no hint left to act on
    expect(doc.parts[0].pivot).toEqual({ x: 150, y: 150 });
  });
});

describe('end-to-end on PIP_MASTER (import + seed)', () => {
  it('seeds every placeholder to a real geometry center; keeps the recovered joint', () => {
    const doc = importSvg(PIP_SVG, 'pip');
    seedImportedPivots(doc);
    // right_arm authors a rotation — its joint is recovered and must NOT move.
    const rightArm = doc.parts.find((p) => p.label === 'right_arm')!;
    expect(rightArm.pivot.x).toBeCloseTo(66.64, 1);
    expect(rightArm.pivot.y).toBeCloseTo(119.59, 1);
    // face had a placeholder (0,0) — now amid the face geometry.
    const face = doc.parts.find((p) => p.label === 'face')!;
    expect(face.pivot.x).toBeCloseTo(105.0, 0);
    expect(face.pivot.y).toBeCloseTo(88.65, 0);
    // nothing is left unresolved: no hint, and no part stranded at the origin.
    for (const p of doc.parts) {
      expect(p.pivotHint ?? null).toBeNull();
      expect(p.pivot.x === 0 && p.pivot.y === 0).toBe(false);
    }
  });
});

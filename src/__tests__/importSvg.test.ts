// @vitest-environment jsdom
/**
 * Tests for the SVG → RigDoc importer, run under jsdom for DOMParser. Fixtures are
 * small inline SVG strings; the inkscape namespace is declared on the root so
 * getAttributeNS() resolves inkscape:* attributes exactly as in a real Inkscape file.
 */

import { describe, expect, it } from 'vitest';
import { importSvg } from '../io/importSvg';

const INKSCAPE_NS = 'http://www.inkscape.org/namespaces/inkscape';

function svg(body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="${INKSCAPE_NS}" ` +
    `viewBox="0 0 100 100">${body}</svg>`
  );
}

const LEAF = '<path d="M 0,0 L 1,1" />';

describe('importSvg', () => {
  it('unwraps Inkscape layer groups into top-level parts', () => {
    const doc = importSvg(
      svg(
        `<g inkscape:groupmode="layer" inkscape:label="Layer 1">` +
          `<g inkscape:label="arm">${LEAF}</g>` +
          `<g id="leg_group">${LEAF}</g>` +
        `</g>` +
        `<g inkscape:label="torso">${LEAF}</g>`,
      ),
      'pip.svg',
    );
    // The layer itself is not a part; its children are, followed by non-layer roots.
    expect(doc.parts.map((p) => p.label)).toEqual(['arm', 'leg_group', 'torso']);
    expect(doc.name).toBe('pip');
    expect(doc.viewBox).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });

  it('seeds the pivot from rotate(a,cx,cy) with no pivotHint', () => {
    const doc = importSvg(
      svg(`<g inkscape:label="arm" transform="rotate(30,10,20)">${LEAF}</g>`),
      'a.svg',
    );
    expect(doc.parts[0].pivot.x).toBeCloseTo(10, 6);
    expect(doc.parts[0].pivot.y).toBeCloseTo(20, 6);
    expect(doc.parts[0].pivotHint).toBeNull();
  });

  it('seeds the same fixed point from the matrix() spelling Inkscape rewrites to', () => {
    // The matrix equivalent of rotate(30, 10, 20) in SVG's +y-down space.
    const rad = (30 * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = 10;
    const cy = 20;
    const e = cx - cos * cx + sin * cy;
    const f = cy - sin * cx - cos * cy;
    const doc = importSvg(
      svg(
        `<g inkscape:label="arm" transform="matrix(${cos},${sin},${-sin},${cos},${e},${f})">${LEAF}</g>`,
      ),
      'a.svg',
    );
    expect(Math.abs(doc.parts[0].pivot.x - 10)).toBeLessThan(1e-3);
    expect(Math.abs(doc.parts[0].pivot.y - 20)).toBeLessThan(1e-3);
    expect(doc.parts[0].pivotHint).toBeNull();
  });

  it('falls back to inkscape:transform-center-x/y as a centerOffset hint (+y flipped)', () => {
    // A reflection has no rotation fixed point, so the hint applies.
    const doc = importSvg(
      svg(
        `<g inkscape:label="arm" transform="matrix(-1,0,0,1,50,0)" ` +
          `inkscape:transform-center-x="5" inkscape:transform-center-y="7">${LEAF}</g>`,
      ),
      'a.svg',
    );
    expect(doc.parts[0].pivot).toEqual({ x: 0, y: 0 });
    expect(doc.parts[0].pivotHint).toEqual({ kind: 'centerOffset', dx: 5, dy: -7 });
  });

  it('converts an ellipse to arc path data', () => {
    const doc = importSvg(
      svg(`<g inkscape:label="head"><ellipse cx="10" cy="20" rx="5" ry="3" /></g>`),
      'a.svg',
    );
    expect(doc.parts[0].paths[0].d).toBe(
      'M 5,20 a 5,3 0 1 0 10,0 a 5,3 0 1 0 -10,0 Z',
    );
  });

  it('converts a circle and a rect to path data', () => {
    const doc = importSvg(
      svg(
        `<g inkscape:label="p">` +
          `<circle cx="4" cy="4" r="2" />` +
          `<rect x="1" y="2" width="3" height="4" />` +
        `</g>`,
      ),
      'a.svg',
    );
    expect(doc.parts[0].paths[0].d).toBe('M 2,4 a 2,2 0 1 0 4,0 a 2,2 0 1 0 -4,0 Z');
    expect(doc.parts[0].paths[1].d).toBe('M 1,2 L 4,2 L 4,6 L 1,6 Z');
  });

  it('accumulates nested group transforms onto the leaf path, not the part transform', () => {
    const doc = importSvg(
      svg(
        `<g inkscape:label="arm" transform="translate(100,0)">` +
          `<g transform="translate(1,2)">` +
            `<path d="M 0,0 L 1,1" transform="scale(2)" />` +
          `</g>` +
        `</g>`,
      ),
      'a.svg',
    );
    expect(doc.parts[0].transform).toBe('translate(100,0)');
    expect(doc.parts[0].paths).toHaveLength(1);
    expect(doc.parts[0].paths[0].transform).toBe('translate(1,2) scale(2)');
  });

  it('uses the leaf inkscape:label as the RigPath label, falling back to id', () => {
    const doc = importSvg(
      svg(
        `<g inkscape:label="arm">` +
          `<path inkscape:label="forearm" d="M 0,0 L 1,1" />` +
          `<path id="hand_path" d="M 0,0 L 1,1" />` +
        `</g>`,
      ),
      'a.svg',
    );
    expect(doc.parts[0].paths.map((p) => p.label)).toEqual(['forearm', 'hand_path']);
  });

  it('imports parts with an identity rest pose and no parent', () => {
    const doc = importSvg(
      svg(`<g inkscape:label="arm">${LEAF}</g><g inkscape:label="leg">${LEAF}</g>`),
      'a.svg',
    );
    for (const part of doc.parts) {
      expect(part.rest).toEqual({ rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 });
      expect(part.parentId).toBeNull();
    }
    expect(doc.clips).toEqual([{ name: 'idle', duration: 2000, tracks: [] }]);
  });
});

describe('sodipodi node types', () => {
  it('imports sodipodi:nodetypes onto paths and leaves shapes untyped', () => {
    const doc = importSvg(
      `<svg xmlns="http://www.w3.org/2000/svg"
            xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
            viewBox="0 0 100 100">
         <g id="part">
           <path d="M 0,0 C 1,1 2,2 3,3 C 4,4 5,5 6,6" sodipodi:nodetypes="csc"/>
           <rect x="0" y="0" width="10" height="10"/>
         </g>
       </svg>`,
      'typed.svg',
    );
    expect(doc.parts[0].paths[0].nodeTypes).toBe('csc');
    expect(doc.parts[0].paths[1].nodeTypes).toBeNull();
  });
});

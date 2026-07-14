// @vitest-environment jsdom
/// <reference types="vite/client" />
/**
 * Tests for the SVG → RigDoc importer, run under jsdom for DOMParser. Fixtures are
 * small inline SVG strings; the inkscape namespace is declared on the root so
 * getAttributeNS() resolves inkscape:* attributes exactly as in a real Inkscape file.
 * The one real-world fixture (girl_example.svg) is pulled in as a raw string via
 * Vite's `?raw` import (avoids a node:fs/@types/node dependency this package doesn't
 * otherwise need).
 */

import { describe, expect, it } from 'vitest';
import { importSvg } from '../io/importSvg';
import { applyMat, matrixOfTransform, multiply } from '../geometry/transforms';
// eslint-disable-next-line import/no-unresolved
import GIRL_SVG from '../../public/girl_example.svg?raw';
// eslint-disable-next-line import/no-unresolved
import PIP_SVG from '../../public/PIP_MASTER.svg?raw';

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

  it('gives every nested group — even unlabeled — its own part; a path only ever carries its own transform', () => {
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
    // Nothing dissolves: the unlabeled wrapper is its OWN part (id/fresh-labeled),
    // parented to "arm" — not folded into the leaf path's transform.
    expect(doc.parts).toHaveLength(2);
    const [arm, wrapper] = doc.parts;
    expect(arm.transform).toBe('translate(100,0)');
    expect(arm.paths).toHaveLength(0);
    expect(arm.kind).toBe('group'); // no direct paths of its own anymore
    expect(wrapper.parentId).toBe(arm.id);
    expect(wrapper.label).toMatch(/^part_\d+$/); // no id, no inkscape:label -> fresh
    // DOC-SPACE INVARIANT: the wrapper's baked transform is the FULL chain (arm's own
    // composed with its own), not just its own local "translate(1,2)".
    expect(wrapper.transform).toBe('translate(100,0) translate(1,2)');
    expect(wrapper.paths).toHaveLength(1);
    expect(wrapper.paths[0].transform).toBe('scale(2)');
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
      expect(part.rest).toEqual({ rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0, opacity: 1 });
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

describe('nested groups', () => {
  it('turns every nested group into its own part, parented to its immediate enclosing group', () => {
    const doc = importSvg(
      svg(
        `<g inkscape:label="Girl">` +
          `<g inkscape:label="Head">${LEAF}</g>` +
          `<g inkscape:label="RightArm"><g inkscape:label="Arm">${LEAF}</g></g>` +
          `<g inkscape:label="Pants">` +
            `<g inkscape:label="Pants">${LEAF}</g>` +
          `</g>` +
        `</g>`,
      ),
      'x.svg',
    );

    // doc.parts order = depth-first document order = paint order (last = topmost).
    expect(doc.parts.map((p) => p.label)).toEqual([
      'Girl', 'Head', 'RightArm', 'Arm', 'Pants', 'Pants',
    ]);

    const [girl, head, rightArm, arm, pantsOuter, pantsInner] = doc.parts;
    expect(head.parentId).toBe(girl.id);
    expect(rightArm.parentId).toBe(girl.id);
    expect(arm.parentId).toBe(rightArm.id);
    expect(pantsOuter.parentId).toBe(girl.id);
    expect(pantsInner.parentId).toBe(pantsOuter.id);
    expect(girl.parentId).toBeNull();
  });

  it('assigns kind "group" to a part with no direct drawable content of its own, "art" otherwise', () => {
    const doc = importSvg(
      svg(`<g inkscape:label="folder"><g inkscape:label="leaf">${LEAF}</g></g>`),
      'x.svg',
    );
    const folder = doc.parts.find((p) => p.label === 'folder')!;
    const leaf = doc.parts.find((p) => p.label === 'leaf')!;
    expect(folder.paths).toHaveLength(0);
    expect(folder.kind).toBe('group');
    expect(leaf.paths).toHaveLength(1);
    expect(leaf.kind).toBe('art');
  });

  it('does NOT dissolve unlabeled wrapper groups — they become parts too, labeled by id or freshly minted, and still carry the full doc-space chain', () => {
    const doc = importSvg(
      svg(
        `<g inkscape:label="torso" transform="translate(10,0)">` +
          `<g transform="rotate(15,5,5)">` + // no id, no label -> fresh id
            `<g id="autogen_wrapper" transform="scale(1.5)">` + // id, no label -> id
              `<g inkscape:label="head" transform="translate(2,3)">${LEAF}</g>` +
            `</g>` +
          `</g>` +
        `</g>`,
      ),
      'x.svg',
    );
    // All FOUR groups become parts now — nothing dissolves.
    expect(doc.parts).toHaveLength(4);
    const [torso, bareWrapper, idWrapper, head] = doc.parts;
    expect(torso.label).toBe('torso');
    expect(bareWrapper.label).toMatch(/^part_\d+$/); // neither id nor inkscape:label
    expect(idWrapper.label).toBe('autogen_wrapper'); // id, no inkscape:label
    expect(head.label).toBe('head');

    expect(bareWrapper.parentId).toBe(torso.id);
    expect(idWrapper.parentId).toBe(bareWrapper.id);
    expect(head.parentId).toBe(idWrapper.id); // immediate parent, not a shortcut to torso

    // The full doc-space chain baked into the deepest part: all four transforms,
    // composed left to right, root to leaf — regardless of which ones got labels.
    const expected = [
      'translate(10,0)', 'rotate(15,5,5)', 'scale(1.5)', 'translate(2,3)',
    ].reduce((m, t) => multiply(m, matrixOfTransform(t)), matrixOfTransform(''));
    const actual = matrixOfTransform(head.transform);
    expect(actual.a).toBeCloseTo(expected.a, 9);
    expect(actual.b).toBeCloseTo(expected.b, 9);
    expect(actual.c).toBeCloseTo(expected.c, 9);
    expect(actual.d).toBeCloseTo(expected.d, 9);
    expect(actual.e).toBeCloseTo(expected.e, 9);
    expect(actual.f).toBeCloseTo(expected.f, 9);
  });

  it('bakes the full ancestor chain into a deeply nested part, matching direct composition of the raw SVG transforms (doc-space equivalence)', () => {
    // Three levels of plain (unlabeled) wrapper groups around one leaf path. Each
    // wrapper is its own part now; the doc-space position of the leaf endpoint (1,1)
    // must be identical to what you'd get by concatenating every original SVG
    // transform into one list and applying it directly — proof that baking ancestors'
    // transforms into each part's own `transform` (rather than relying on parenting,
    // which composes POSE only) reproduces the pre-nesting flattened behavior exactly.
    const doc = importSvg(
      svg(
        `<g inkscape:label="arm" transform="translate(100,0)">` +
          `<g transform="translate(1,2)">` +
            `<g transform="rotate(10,3,4)">` +
              `<path d="M 0,0 L 1,1" transform="scale(2)" />` +
            `</g>` +
          `</g>` +
        `</g>`,
      ),
      'a.svg',
    );
    expect(doc.parts).toHaveLength(3);
    const [arm, wrapper1, wrapper2] = doc.parts;
    expect(wrapper1.parentId).toBe(arm.id);
    expect(wrapper2.parentId).toBe(wrapper1.id);
    expect(wrapper2.paths).toHaveLength(1);
    expect(wrapper2.paths[0].transform).toBe('scale(2)'); // only its own transform

    const naive = matrixOfTransform('translate(100,0) translate(1,2) rotate(10,3,4) scale(2)');
    const actual = multiply(
      matrixOfTransform(wrapper2.transform), matrixOfTransform(wrapper2.paths[0].transform),
    );
    const expectedPoint = applyMat(naive, 1, 1);
    const actualPoint = applyMat(actual, 1, 1);
    expect(actualPoint.x).toBeCloseTo(expectedPoint.x, 9);
    expect(actualPoint.y).toBeCloseTo(expectedPoint.y, 9);
  });
});

describe('girl_example.svg fixture (real-world nested Illustrator/Inkscape export)', () => {
  it('imports EVERY group — labeled or not — as its own part, in depth-first paint order', () => {
    const doc = importSvg(GIRL_SVG, 'girl_example.svg');
    expect(doc.name).toBe('girl_example');

    // Every <g> in the file becomes a part (21 total: labeled ones like Girl/Head/
    // RightArm/Arm/Pants keep their inkscape:label; plain Illustrator wrapper groups
    // like Head's inner g142-7/g173-9/g155-8/g1/g164-5/g166-0/g181-1 fall back to their
    // id). Order is depth-first document order == paint order (last = topmost).
    expect(doc.parts.map((p) => p.label)).toEqual([
      'Girl', 'Head', 'g142-7', 'g173-9', 'g155-8', 'g1', 'g164-5', 'g166-0', 'g181-1',
      'RightArm', 'Arm', 'g291-2', 'g289',
      'LeftArm', 'Arm', 'g291', 'g289-4',
      'Pants', 'g112-5', 'g118-5', 'Pants',
    ]);

    const byLabelAt = (label: string, occurrence = 0) =>
      doc.parts.filter((p) => p.label === label)[occurrence];
    const girl = byLabelAt('Girl');
    const head = byLabelAt('Head');
    const rightArm = byLabelAt('RightArm');
    const leftArm = byLabelAt('LeftArm');
    const pantsOuter = byLabelAt('Pants', 0);
    const pantsInner = byLabelAt('Pants', 1);
    const [armR, armL] = doc.parts.filter((p) => p.label === 'Arm');

    // The brief's headline shapes: Girl->Head, Girl->RightArm->Arm, Pants->Pants.
    expect(head.parentId).toBe(girl.id);
    expect(rightArm.parentId).toBe(girl.id);
    expect(armR.parentId).toBe(rightArm.id);
    expect(leftArm.parentId).toBe(girl.id);
    expect(armL.parentId).toBe(leftArm.id);
    expect(pantsOuter.parentId).toBe(girl.id);
    expect(pantsInner.parentId).toBe(pantsOuter.id);
    expect(girl.parentId).toBeNull();

    // An id-only wrapper (no inkscape:label) still becomes a real part, parented under
    // its nearest enclosing group's part — Head's inner g142-7/g173-9/g181-1.
    const g142 = doc.parts.find((p) => p.label === 'g142-7')!;
    const g173 = doc.parts.find((p) => p.label === 'g173-9')!;
    const g181 = doc.parts.find((p) => p.label === 'g181-1')!;
    expect(g142.parentId).toBe(head.id);
    expect(g173.parentId).toBe(head.id);
    expect(g181.parentId).toBe(head.id);
    // ...and wrapper nesting keeps going below that (g155-8 -> g1 -> both under g173-9).
    const g155 = doc.parts.find((p) => p.label === 'g155-8')!;
    const g1 = doc.parts.find((p) => p.label === 'g1')!;
    expect(g155.parentId).toBe(g173.id);
    expect(g1.parentId).toBe(g155.id);

    // Girl's OWN direct paths (Hair, Neck, and an id-only third path) are authored
    // right in the Girl group in the source file, not under Head or any limb.
    expect(girl.paths.map((p) => p.label)).toEqual(
      expect.arrayContaining(['Hair', 'Neck']),
    );
    expect(head.paths.some((p) => p.label === 'Hair')).toBe(false);

    // RightArm/LeftArm carry no direct paths of their own now (their old dissolved
    // content lives in the "g289"/"g289-4" wrapper parts instead) -> honestly 'group'.
    expect(rightArm.paths).toHaveLength(0);
    expect(rightArm.kind).toBe('group');
    expect(leftArm.paths).toHaveLength(0);
    expect(leftArm.kind).toBe('group');

    // Every other part is honestly marked: 'art' iff it carries a direct path, and
    // (aside from RightArm/LeftArm above) this fixture has real content everywhere.
    for (const part of doc.parts) {
      expect(part.kind).toBe(part.paths.length > 0 ? 'art' : 'group');
    }
  });

  it('keeps gradient-fill paths verbatim (no gradient resolution attempted)', () => {
    const doc = importSvg(GIRL_SVG, 'girl_example.svg');
    const gradientPath = doc.parts
      .flatMap((p) => p.paths)
      .find((p) => (p.fill ?? '').startsWith('url('));
    expect(gradientPath).toBeDefined();
    expect(gradientPath!.fill).toMatch(/^url\(#/);
  });
});

// ---- U4: the importer records TRUE SVG document order into childOrder ----
//
// The dying two-bucket approximation put a part's own paths ALWAYS below its child
// parts; these tests pin that the recorded slots reproduce the authored interleaving
// instead — the labeled slot sequence IS the document sequence, per part.

/** ['P:label'|'d:label', ...] of a part's childOrder, resolved against the doc — the
 *  human-readable shape all the assertions below compare ('P' = child part, 'd' = path). */
function slotLabels(doc: ReturnType<typeof importSvg>, part: (typeof doc.parts)[number]): string[] {
  return (part.childOrder ?? []).map((s) => {
    if (s.kind === 'path') return `d:${part.paths.find((p) => p.id === s.id)!.label}`;
    return `P:${doc.parts.find((p) => p.id === s.id)!.label}`;
  });
}

describe('importSvg — U4 document-order childOrder', () => {
  it('records paths interleaved between groups exactly as authored', () => {
    const doc = importSvg(
      svg(
        `<g inkscape:label="holder">` +
          `<path inkscape:label="under" d="M 0,0 L 1,1" />` +
          `<g inkscape:label="middle">${LEAF}</g>` +
          `<path inkscape:label="over" d="M 0,0 L 2,2" />` +
        `</g>`,
      ),
      'i.svg',
    );
    const holder = doc.parts.find((p) => p.label === 'holder')!;
    expect(slotLabels(doc, holder)).toEqual(['d:under', 'P:middle', 'd:over']);
    // paths[] keeps document order too — the slot list mirrors it (U1 rule 4).
    expect(holder.paths.map((p) => p.label)).toEqual(['under', 'over']);
  });

  it('gives EVERY imported part an explicit childOrder, including one-shape parts', () => {
    const doc = importSvg(
      svg(`<ellipse cx="5" cy="5" rx="2" ry="2" id="blob" /><g inkscape:label="grp">${LEAF}</g>`),
      'e.svg',
    );
    for (const part of doc.parts) expect(part.childOrder).toBeDefined();
    const blob = doc.parts.find((p) => p.label === 'blob')!;
    expect(blob.childOrder).toEqual([{ kind: 'path', id: blob.paths[0].id }]);
  });

  it('girl fixture: Head interleaves part,part,path,part,path; Pants puts paths ABOVE its parts', () => {
    const doc = importSvg(GIRL_SVG, 'girl_example.svg');
    const head = doc.parts.find((p) => p.label === 'Head')!;
    expect(slotLabels(doc, head)).toEqual(
      ['P:g142-7', 'P:g173-9', 'd:path174-4', 'P:g181-1', 'd:path182-7'],
    );
    // Pants (the outer one, under Girl): two wrapper groups and a nested Pants group
    // first, its own two paths LAST (drawn on top) — the exact reverse of the old
    // paths-first synthesis.
    const girl = doc.parts.find((p) => p.label === 'Girl')!;
    const pantsOuter = doc.parts.find((p) => p.label === 'Pants' && p.parentId === girl.id)!;
    expect(slotLabels(doc, pantsOuter)).toEqual(
      ['P:g112-5', 'P:g118-5', 'P:Pants', 'd:path126-7', 'd:path129-8'],
    );
  });

  it('PIP_MASTER: body\'s shadow paints ABOVE the nested body; face\'s mouth above the eyes', () => {
    // THE ORIGINATING U4 COMPLAINT ("I STILL can't move PIP's body shading (called
    // shadow) up or down in this layer"): the author drew the shading AFTER the nested
    // body group, so it belongs on top — the two-bucket import buried it underneath.
    const doc = importSvg(PIP_SVG, 'PIP_MASTER.svg');
    const outerBody = doc.parts.find((p) => p.label === 'body' && !p.parentId)!;
    expect(slotLabels(doc, outerBody)).toEqual(['P:body', 'd:shadow']);
    const face = doc.parts.find((p) => p.label === 'face' && !p.parentId)!;
    expect(slotLabels(doc, face)).toEqual(['P:eyes', 'd:path3']);
  });
});

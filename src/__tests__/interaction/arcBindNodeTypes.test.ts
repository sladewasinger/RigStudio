/**
 * Bind-bake nodeTypes lockstep for literal arc commands (the latent desync flagged by
 * the chokepoint wave, commit 68f24fc): `bindPartsToBones` bakes every path through
 * `pathToCubics`, which expands an `A` command into MULTIPLE cubics — but nodeTypes is
 * one char per non-Z command, so a bound path that still carried a literal arc ended up
 * with fewer type chars than commands, desyncing every node op after it.
 *
 * REPRODUCED before the fix: with the splice absent, the post-bind assertion below
 * fails (nodeTypes length 3 vs 4 commands on the semicircle fixture). The fix splices
 * (k-1) synthesized 'c' chars per arc (free corners — they never impose mirror behavior
 * on a drag) and keeps the arc's ORIGINAL char on its endpoint, so typed nodes survive
 * the bake exactly.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { selectPart as modelSelectPart } from '../../core/model';
import { parsePath, arcToCubics } from '../../geometry/paths';
import { renderPose } from '../../view';
import {
  bootRig, resetRig, state, notify, partByLabel, medialPoints, placeBoneChain,
} from './harness';

beforeAll(bootRig);
beforeEach(resetRig);

describe('bind bake keeps nodeTypes in lockstep through arc expansion', () => {
  it('a literal-arc path bound to a chain gets its arc chars spliced, original endpoint types preserved', () => {
    const part = partByLabel('right_arm');
    // Replace the part's first path with a fixture carrying a LITERAL semicircular arc.
    // Non-Z commands: M ('c'), A ('s' — a deliberately distinctive type), L ('z').
    const path = part.paths[0];
    path.d = 'M 60,110 A 8,8 0 0 1 76,110 L 76,126 Z';
    path.transform = '';
    path.nodeTypes = 'csz';
    const parsedBefore = parsePath(path.d);
    const arc = parsedBefore.find((c) => c.cmd === 'A')!;
    // How many cubics THIS arc expands to (semicircle => >1, or the test proves nothing).
    const k = arcToCubics(60, 110, arc as Parameters<typeof arcToCubics>[2]).length;
    expect(k, 'fixture sanity: the arc must expand to MULTIPLE cubics').toBeGreaterThan(1);
    notify();
    renderPose();

    // Bind: select the art, place a 2-bone chain down it (auto-binds on completion).
    modelSelectPart(part.id);
    notify();
    renderPose();
    placeBoneChain(medialPoints('right_arm', 2));

    const cur = state.doc!.parts.find((p) => p.id === part.id)!;
    expect(cur.skin, 'the chain bound the part').toBeTruthy();
    const baked = cur.paths.find((p) => p.id === path.id)!;
    const nonZ = parsePath(baked.d).filter((c) => c.cmd !== 'Z').length;

    // THE INVARIANT (pre-fix this fails: length stayed 3 while commands grew):
    expect(baked.nodeTypes, 'typed path stays typed through the bake').not.toBeNull();
    expect(baked.nodeTypes!.length, 'one type char per non-Z command after the bake').toBe(nonZ);
    // M keeps 'c'; the arc becomes (k-1) synthesized 'c' + its ORIGINAL 's' endpoint; L keeps 'z'.
    expect(baked.nodeTypes).toBe('c' + 'c'.repeat(k - 1) + 's' + 'z');
  });

  it('an UNTYPED (null) arc path stays untyped through the bake — no fabricated flags', () => {
    const part = partByLabel('left_leg');
    const path = part.paths[0];
    path.d = 'M 110,195 A 6,6 0 0 1 122,195 L 122,210 Z';
    path.transform = '';
    path.nodeTypes = null;
    notify();
    renderPose();

    modelSelectPart(part.id);
    notify();
    renderPose();
    placeBoneChain(medialPoints('left_leg', 2));

    const cur = state.doc!.parts.find((p) => p.id === part.id)!;
    expect(cur.skin).toBeTruthy();
    expect(cur.paths.find((p) => p.id === path.id)!.nodeTypes).toBeNull();
  });
});

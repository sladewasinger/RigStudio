/**
 * H1a end-to-end proof at the module level (the CLI-level equivalent lives in
 * headlessCli.test.ts): import PIP_MASTER.svg -> normalize -> round-trip serialize/
 * deserialize (what `rig validate` checks) -> exportRiv -> decode with the shared
 * `rivDecoder.ts` harness (already earmarked for headless-package tests — see its file
 * header) and assert every part landed as a Node. A second test pins the facade: the
 * headless-exported `exportRiv` must be the SAME function as `io/riv`'s, not a
 * reimplementation — proven by byte-identical output from two independently-built docs.
 */
import { describe, expect, it } from 'vitest';
import PIP_SVG from '../../public/PIP_MASTER.svg?raw';
import {
  RigDoc,
  deserializeDoc,
  exportRiv as exportRivHeadless,
  importSvgHeadless,
  normalizeDoc,
  serializeDoc,
} from '../headless';
import { exportRiv as exportRivDirect } from '../io/riv';
import { PROP, TYPE, decodeRiv } from './rivDecoder';

function buildDoc(): RigDoc {
  const doc = importSvgHeadless(PIP_SVG, 'PIP_MASTER');
  normalizeDoc(doc);
  return doc;
}

describe('headless pipeline: import -> validate round-trip -> export-riv', () => {
  it('imports, round-trips byte-stable, and exports a .riv decoding one Node per part', () => {
    const doc = buildDoc();
    expect(doc.parts.length).toBeGreaterThan(5);

    // What `rig validate` checks: serialize -> deserialize -> reserialize is byte-equal.
    const json = serializeDoc(doc);
    const reloaded = deserializeDoc(json);
    expect(serializeDoc(reloaded)).toBe(json);

    const bytes = exportRivHeadless(reloaded);
    const decoded = decodeRiv(bytes);
    expect(decoded.animations.length).toBe(reloaded.clips.length);

    const nodeNames = decoded.objects
      .filter((o) => o.typeKey === TYPE.NODE)
      .map((o) => o.props[PROP.NAME]);
    for (const part of reloaded.parts) expect(nodeNames).toContain(part.label);
  });

  it('exportRiv through the headless facade is byte-identical to calling io/riv directly', () => {
    const bytesA = exportRivHeadless(buildDoc());
    const bytesB = exportRivDirect(buildDoc());
    expect(Buffer.from(bytesA).equals(Buffer.from(bytesB))).toBe(true);
  });
});

// @vitest-environment jsdom
/**
 * Runs the Pip "take a pill" export pipeline (writing the three artifacts) and verifies
 * the produced .riv by decoding it the way the runtime does — mirroring the decoder in
 * `src/__tests__/exportRiv.test.ts` (that file's `decodeRiv` is module-local and not
 * exported, so the minimal reader here reuses the same structural approach). Asserts:
 * exactly one one-shot LinearAnimation named `take_pill`, the designed frame duration,
 * and keyed properties for the right-arm rotation and the pill scale.
 */

import { describe, expect, it } from 'vitest';
import { ensureDomParser, run, OUT_RIV_LOCAL, OUT_RIV_DOSEY, OUT_RIG_JSON } from './exportPipTakePill';

// ---- key table (subset needed for verification) ----
const TYPE = { NODE: 2, LINEAR_ANIM: 31, KEYED_OBJECT: 25, KEYED_PROPERTY: 26, KEYFRAME_DOUBLE: 30 };
const PROP = {
  NAME: 4, X: 13, Y: 14, ROTATION: 15, SCALE_X: 16, SCALE_Y: 17,
  OBJECT_ID: 51, PROPERTY_KEY: 53, ANIM_NAME: 55, FPS: 56, DURATION: 57, LOOP: 59,
  FRAME: 67, VALUE: 70,
};
const CONSUMES_INDEX = new Set([1, 2, 3, 16, 6, 20, 24, 18, 28]); // component objects

class Reader {
  i = 0;
  constructor(readonly b: Uint8Array) {}
  u8() { return this.b[this.i++]; }
  u32() { const v = this.b[this.i] | (this.b[this.i + 1] << 8) | (this.b[this.i + 2] << 16) | (this.b[this.i + 3] << 24); this.i += 4; return v >>> 0; }
  f32() { const dv = new DataView(this.b.buffer, this.b.byteOffset + this.i, 4); this.i += 4; return dv.getFloat32(0, true); }
  varuint() { let r = 0, s = 0, byte = 0; do { byte = this.b[this.i++]; r += (byte & 0x7f) * Math.pow(2, s); s += 7; } while (byte & 0x80); return r; }
  string() { const n = this.varuint(); let out = ''; for (let k = 0; k < n; k++) out += String.fromCharCode(this.b[this.i++]); return out; }
  eof() { return this.i >= this.b.length; }
}

interface DObj { typeKey: number; index: number; props: Record<number, number | string> }
interface DKeyframe { frame: number; value: number }
interface DProp { propertyKey: number; keyframes: DKeyframe[] }
interface DKeyed { objectId: number; props: DProp[] }
interface DAnim { name: string; fps: number; duration: number; loop: number; objects: DKeyed[] }

function decode(bytes: Uint8Array): { objects: DObj[]; animations: DAnim[] } {
  const r = new Reader(bytes);
  const fp = String.fromCharCode(r.u8(), r.u8(), r.u8(), r.u8());
  if (fp !== 'RIVE') throw new Error(`bad fingerprint ${fp}`);
  r.varuint(); r.varuint(); r.varuint(); // major, minor, fileId
  const keys: number[] = [];
  for (let k = r.varuint(); k !== 0; k = r.varuint()) keys.push(k);
  const toc = new Map<number, number>();
  for (let i = 0; i < keys.length; i += 4) {
    const word = r.u32();
    for (let j = 0; j < 4 && i + j < keys.length; j++) toc.set(keys[i + j], (word >>> (j * 2)) & 3);
  }
  const objects: DObj[] = [];
  const animations: DAnim[] = [];
  let nextIndex = 0;
  let curAnim: DAnim | null = null, curKeyed: DKeyed | null = null, curProp: DProp | null = null;
  while (!r.eof()) {
    const typeKey = r.varuint();
    const props: Record<number, number | string> = {};
    for (let pk = r.varuint(); pk !== 0; pk = r.varuint()) {
      const ft = toc.get(pk);
      if (ft === undefined) throw new Error(`property ${pk} missing from ToC`);
      props[pk] = ft === 1 ? r.string() : ft === 2 ? r.f32() : ft === 3 ? r.u32() : r.varuint();
    }
    const index = CONSUMES_INDEX.has(typeKey) ? nextIndex++ : -1;
    objects.push({ typeKey, index, props });
    if (typeKey === TYPE.LINEAR_ANIM) {
      curAnim = { name: String(props[PROP.ANIM_NAME] ?? ''), fps: Number(props[PROP.FPS] ?? 0), duration: Number(props[PROP.DURATION] ?? 0), loop: Number(props[PROP.LOOP] ?? 0), objects: [] };
      animations.push(curAnim); curKeyed = null; curProp = null;
    } else if (typeKey === TYPE.KEYED_OBJECT) {
      curKeyed = { objectId: Number(props[PROP.OBJECT_ID] ?? 0), props: [] };
      curAnim!.objects.push(curKeyed); curProp = null;
    } else if (typeKey === TYPE.KEYED_PROPERTY) {
      curProp = { propertyKey: Number(props[PROP.PROPERTY_KEY] ?? 0), keyframes: [] };
      curKeyed!.props.push(curProp);
    } else if (typeKey === TYPE.KEYFRAME_DOUBLE) {
      curProp!.keyframes.push({ frame: Number(props[PROP.FRAME] ?? 0), value: Number(props[PROP.VALUE] ?? 0) });
    }
  }
  return { objects, animations };
}

describe('pip take_pill export', () => {
  it('builds, writes, and verifies pip_take_pill.riv', async () => {
    await ensureDomParser();
    const result = run();

    // Log the imported/assembled part tree + choreography geometry for the record.
    // eslint-disable-next-line no-console
    console.log('part tree:\n' + result.meta.parts
      .map((p) => `  ${p.label} [${p.kind}] parent=${p.parent ?? '(root)'} pivot=(${p.pivot.x.toFixed(2)},${p.pivot.y.toFixed(2)}) paths=${p.paths}`)
      .join('\n'));
    // eslint-disable-next-line no-console
    console.log('geometry:', JSON.stringify(result.meta, (k, v) => (typeof v === 'number' ? Number(v.toFixed(3)) : v)));
    // eslint-disable-next-line no-console
    console.log('wrote:\n' + result.wrote.map((w) => '  ' + w).join('\n'));

    const { objects, animations } = decode(result.riv);

    // Exactly one one-shot LinearAnimation named take_pill, 60fps, 96 frames.
    expect(animations.length).toBe(1);
    const anim = animations[0];
    expect(anim.name).toBe('take_pill');
    expect(anim.loop).toBe(0); // oneShot
    expect(anim.fps).toBe(60);
    expect(anim.duration).toBe(96); // 1600ms @ 60fps

    const nodeIndex = (name: string): number => {
      const n = objects.find((o) => o.typeKey === TYPE.NODE && o.props[PROP.NAME] === name);
      if (!n) throw new Error(`node not found: ${name}`);
      return n.index;
    };
    // exportRiv emits one KeyedObject per channel, so several KeyedObjects can share an
    // objectId — aggregate all their KeyedProperties for a given target node.
    const keyedProps = (objectId: number): DProp[] =>
      anim.objects.filter((k) => k.objectId === objectId).flatMap((k) => k.props);
    const prop = (objectId: number, propertyKey: number): DProp | undefined =>
      keyedProps(objectId).find((p) => p.propertyKey === propertyKey);

    // Right-arm rotation keyed.
    const armRot = prop(nodeIndex('right_arm'), PROP.ROTATION);
    expect(armRot).toBeDefined();
    expect(armRot!.keyframes.length).toBeGreaterThanOrEqual(4);
    expect(armRot!.keyframes[armRot!.keyframes.length - 1].value).toBeCloseTo(0, 5); // settles at rest

    // Pill scale keyed (both axes), shrinking to zero.
    const pillSx = prop(nodeIndex('pill'), PROP.SCALE_X);
    const pillSy = prop(nodeIndex('pill'), PROP.SCALE_Y);
    expect(pillSx).toBeDefined();
    expect(pillSy).toBeDefined();
    expect(pillSx!.keyframes[0].value).toBeCloseTo(1, 5);
    expect(pillSx!.keyframes[pillSx!.keyframes.length - 1].value).toBeCloseTo(0, 5);
    expect(pillSy!.keyframes[pillSy!.keyframes.length - 1].value).toBeCloseTo(0, 5);

    // Whole-figure squash + lean keyed on the lean group (scaleX/scaleY + rotation).
    expect(prop(nodeIndex('lean_pivot'), PROP.SCALE_Y)).toBeDefined();
    expect(prop(nodeIndex('lean_pivot'), PROP.SCALE_X)).toBeDefined();
    expect(prop(nodeIndex('lean_pivot'), PROP.ROTATION)).toBeDefined();

    // Eye-blink scale keyed.
    expect(prop(nodeIndex('eyes'), PROP.SCALE_Y)).toBeDefined();

    // Files exist and are non-trivial.
    const fs = await import('node:fs');
    for (const f of [OUT_RIV_LOCAL, OUT_RIV_DOSEY, OUT_RIG_JSON]) {
      expect(fs.existsSync(f)).toBe(true);
      expect(fs.statSync(f).size).toBeGreaterThan(100);
    }
  });
});

/**
 * Binary writer primitives for the Rive (.riv) exporter: the little-endian byte
 * encodings (varuint/string/float32/uint32), the Scene object-stream helper that
 * tracks used property keys and assigns artboard component indices, and the final
 * header+ToC+body assembly.
 *
 * BINARY FORMAT (little-endian) per the official docs + rive-runtime:
 *   - https://rive.app/docs/runtimes/advanced-topic/format
 *   - runtime_header.hpp (fingerprint 'RIVE', varuint major/minor/fileId, then the ToC:
 *     varuint property keys terminated by 0, then a packed 2-bit backing-type array read
 *     as uint32 words, FOUR keys per word in bits 0..7). 0=uint/bool 1=string 2=double
 *     3=color.
 *   - src/file.cpp readRuntimeObject: each object = varuint typeKey, then (varuint
 *     propertyKey, value) pairs terminated by propertyKey 0. Known props read by type;
 *     unknown props skipped via the ToC field id (so every key we write is in the ToC).
 *   - References (parentId/objectId/interpolatorId) are indices into the artboard's
 *     component list in file read order: the Artboard is index 0, then every
 *     Node/Shape/Path/Vertex/Paint/SolidColor/Interpolator gets the next index.
 *     Animation objects (LinearAnimation/KeyedObject/KeyedProperty/KeyFrame) do NOT
 *     consume indices (verified against rive-lottie's reader + rive-runtime's
 *     ImportStack). So we emit all referenceable components (incl. interpolators) BEFORE
 *     the animations.
 */

import { FIELD_TYPE } from './keys';

// ---- Format constants ----

const RIVE_MAJOR = 7;
const RIVE_MINOR = 0;
/** Fixed file id keeps identical input -> identical bytes (the docs allow any/zero). */
const FILE_ID = 1380270931; // 'RIGS'

// ---- Binary writer ----

/** Little-endian byte writer with the Rive primitive encodings. */
export class ByteWriter {
  bytes: number[] = [];
  private scratch = new DataView(new ArrayBuffer(4));

  get length(): number {
    return this.bytes.length;
  }

  u8(v: number): void {
    this.bytes.push(v & 0xff);
  }

  /** uint32, little-endian (used for the ToC words and packed ARGB colors). */
  u32(v: number): void {
    const n = v >>> 0;
    this.bytes.push(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
  }

  /** float32, little-endian. */
  f32(v: number): void {
    this.scratch.setFloat32(0, v, true);
    this.bytes.push(
      this.scratch.getUint8(0),
      this.scratch.getUint8(1),
      this.scratch.getUint8(2),
      this.scratch.getUint8(3),
    );
  }

  /** LEB128 unsigned varint. */
  varuint(value: number): void {
    let v = Math.floor(value);
    if (v < 0) v = 0;
    do {
      let byte = v & 0x7f;
      v = Math.floor(v / 128);
      if (v !== 0) byte |= 0x80;
      this.bytes.push(byte);
    } while (v !== 0);
  }

  /** varuint length + UTF-8 bytes. */
  string(s: string): void {
    const utf8 = new TextEncoder().encode(s);
    this.varuint(utf8.length);
    for (const b of utf8) this.bytes.push(b);
  }

  concat(other: ByteWriter): void {
    for (const b of other.bytes) this.bytes.push(b);
  }
}

// ---- Object stream helper ----

/**
 * Writes objects into `body` while tracking which property keys were used (for the ToC)
 * and assigning each component a sequential artboard index. Property helpers add their
 * key to `usedKeys` so the ToC is always complete.
 */
export class Scene {
  body = new ByteWriter();
  usedKeys = new Set<number>();
  /** Next artboard component index. Artboard itself will take index 0. */
  index = 0;

  private key(k: number): void {
    this.body.varuint(k);
    this.usedKeys.add(k);
  }

  propUint(k: number, v: number): void {
    this.key(k);
    this.body.varuint(v);
  }

  propBool(k: number, v: boolean): void {
    this.key(k);
    this.body.u8(v ? 1 : 0);
  }

  propDouble(k: number, v: number): void {
    this.key(k);
    this.body.f32(v);
  }

  propString(k: number, v: string): void {
    this.key(k);
    this.body.string(v);
  }

  propColor(k: number, argb: number): void {
    this.key(k);
    this.body.u32(argb);
  }

  /** Begin an object: write its typeKey. Returns the component index it consumes. */
  begin(typeKey: number, consumesIndex = true): number {
    this.body.varuint(typeKey);
    return consumesIndex ? this.index++ : -1;
  }

  /** End an object (properties terminator). */
  end(): void {
    this.body.varuint(0);
  }
}

/** Assemble the header + ToC + object body into the final byte array. */
export function assemble(scene: Scene): Uint8Array {
  const head = new ByteWriter();
  head.u8(0x52); head.u8(0x49); head.u8(0x56); head.u8(0x45); // 'RIVE'
  head.varuint(RIVE_MAJOR);
  head.varuint(RIVE_MINOR);
  head.varuint(FILE_ID);

  const keys = [...scene.usedKeys].sort((a, b) => a - b);
  for (const k of keys) head.varuint(k);
  head.varuint(0); // property-key terminator

  // Packed 2-bit backing types: FOUR keys per uint32 word (bits 0..7), rest unused —
  // this exact layout is what runtime_header.hpp reads.
  for (let i = 0; i < keys.length; i += 4) {
    let word = 0;
    for (let j = 0; j < 4 && i + j < keys.length; j++) {
      word |= (FIELD_TYPE[keys[i + j]] & 3) << (j * 2);
    }
    head.u32(word);
  }

  head.concat(scene.body);
  return Uint8Array.from(head.bytes);
}

/**
 * Keyframe animation emission: builds the deterministic per-target channel plan (root
 * translate/scale + each part's rotate/tx/ty/sx/sy), registers CubicEaseInterpolators
 * for any custom/preset easing BEFORE the animation objects that reference them, then
 * emits one LinearAnimation per clip with its KeyedObject/KeyedProperty/KeyFrameDouble
 * tree. Keyed values are ABSOLUTE; a channel with no keyframes emits nothing here and
 * stays a static Node property (written by scene.ts) — rest fills only unkeyed channels.
 *
 * OPACITY CHANNEL (not fully mapped this wave): a keyed `opacity` channel / non-1
 * `RestPose.opacity` is SILENTLY IGNORED — channelSpecs below lists only
 * rotate/tx/ty/sx/sy, so no KeyedProperty is ever built for it, and no static Node
 * opacity property exists in the schema table (keys.ts) to write either. Real export
 * (Rive's Shape/Node don't carry opacity directly — it would need Feathering/opacity via
 * a Fill/Stroke alpha animation, or per-Shape visibility) is the next wave.
 */

import { Channel, Keyframe, RigDoc, Track } from '../../core/model';
import { Scene } from './writer';
import {
  DEG2RAD, EASING_CUBIC, FPS, INTERP_CUBIC, INTERP_LINEAR, P_ANIM_NAME, P_DURATION, P_FPS,
  P_FRAME, P_INTERP_TYPE, P_INTERPOLATOR_ID, P_LOOP, P_NODE_X, P_NODE_Y, P_OBJECT_ID,
  P_PROPERTY_KEY, P_ROTATION, P_SCALE_X, P_SCALE_Y, P_VALUE, P_X1, P_X2, P_Y1, P_Y2,
  T_CUBIC_INTERP, T_KEYED_OBJECT, T_KEYED_PROPERTY, T_KEYFRAME_DOUBLE, T_LINEAR_ANIM,
} from './keys';

/**
 * Build the plan for every clip and emit it into `scene`: root first, then every part's
 * rotate/tx/ty/sx/sy in a fixed order, root/parts in doc order. Any needed
 * CubicEaseInterpolators (which consume component indices) are written BEFORE any
 * animation object, since animation objects reference them but do not themselves
 * consume indices.
 */
export function emitAnimations(
  scene: Scene,
  doc: RigDoc,
  partIndex: Map<string, number>,
  rootIndex: number,
  rootBaseX: number,
  rootBaseY: number,
): void {
  const byId = new Map(doc.parts.map((p) => [p.id, p]));

  const interpCache = new Map<string, number>();
  const emitInterpolator = (b: [number, number, number, number]): number => {
    const cacheKey = b.map((n) => Math.fround(n)).join(',');
    const cached = interpCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const idx = scene.begin(T_CUBIC_INTERP);
    scene.propDouble(P_X1, b[0]);
    scene.propDouble(P_Y1, b[1]);
    scene.propDouble(P_X2, b[2]);
    scene.propDouble(P_Y2, b[3]);
    scene.end();
    interpCache.set(cacheKey, idx);
    return idx;
  };

  interface PlanKey { frame: number; value: number; interpType: number; interpId: number }
  interface PlanProp { objectId: number; propertyKey: number; keys: PlanKey[] }
  interface PlanClip { name: string; duration: number; loop: boolean; props: PlanProp[] }

  // Canonical, deterministic per-target channel plan: [target, channel, propertyKey,
  // base offset, isAngle]. root first, then parts in doc order; fixed channel order.
  interface ChannelSpec {
    target: string;
    channel: Channel;
    propertyKey: number;
    base: number;
    isAngle: boolean;
  }
  const channelSpecs: ChannelSpec[] = [
    { target: 'root', channel: 'tx', propertyKey: P_NODE_X, base: rootBaseX, isAngle: false },
    { target: 'root', channel: 'ty', propertyKey: P_NODE_Y, base: rootBaseY, isAngle: false },
    { target: 'root', channel: 'sx', propertyKey: P_SCALE_X, base: 0, isAngle: false },
    { target: 'root', channel: 'sy', propertyKey: P_SCALE_Y, base: 0, isAngle: false },
  ];
  for (const part of doc.parts) {
    const parent = part.parentId ? byId.get(part.parentId) ?? null : null;
    const parentRef = parent ? parent.pivot : doc.rootPivot;
    channelSpecs.push(
      { target: part.id, channel: 'rotate', propertyKey: P_ROTATION, base: 0, isAngle: true },
      { target: part.id, channel: 'tx', propertyKey: P_NODE_X, base: part.pivot.x - parentRef.x, isAngle: false },
      { target: part.id, channel: 'ty', propertyKey: P_NODE_Y, base: part.pivot.y - parentRef.y, isAngle: false },
      // sx/sy: absolute Node scale (base 0 -> raw value == the keyed scale). A part with
      // no scale keyframes produces an empty channel and emits nothing, so this is a
      // no-op for every doc that never animates part scale (all existing fixtures).
      { target: part.id, channel: 'sx', propertyKey: P_SCALE_X, base: 0, isAngle: false },
      { target: part.id, channel: 'sy', propertyKey: P_SCALE_Y, base: 0, isAngle: false },
    );
  }
  const objectIdOf = (target: string): number =>
    target === 'root' ? rootIndex : partIndex.get(target)!;

  const plans: PlanClip[] = doc.clips.map((clip) => {
    const props: PlanProp[] = [];
    const trackOf = (target: string, channel: Channel): Track | undefined =>
      clip.tracks.find((t) => t.target === target && t.channel === channel);

    for (const spec of channelSpecs) {
      const { channel, propertyKey, base, isAngle } = spec;
      const track = trackOf(spec.target, channel);
      const sorted = keysOf(track);
      if (sorted.length === 0) continue; // unkeyed -> stays a static Node property
      const keys: PlanKey[] = sorted.map((key, i) => {
        const raw = base + (isAngle ? key.value * DEG2RAD : key.value);
        let interpType = INTERP_LINEAR;
        let interpId = -1;
        // Easing lives on the ARRIVING keyframe; Rive stores it on the LEAVING key,
        // so segment i->i+1 uses sorted[i+1]'s easing/bezier.
        const next = sorted[i + 1];
        if (next) {
          const bez = cubicFor(next);
          if (bez) {
            interpType = INTERP_CUBIC;
            interpId = emitInterpolator(bez);
          }
        }
        return { frame: toFrame(key.time), value: raw, interpType, interpId };
      });
      props.push({ objectId: objectIdOf(spec.target), propertyKey, keys });
    }
    return {
      name: clip.name,
      duration: Math.max(1, Math.round((clip.duration / 1000) * FPS)),
      // Rive parity: looping is a LinearAnimation property (loopValue), not a per-state
      // one — see Clip.loop's doc comment in model.ts. Default true (absent = looping).
      loop: clip.loop !== false,
      props,
    };
  });

  // Now emit the animation objects (they do NOT consume component indices).
  for (const plan of plans) {
    scene.begin(T_LINEAR_ANIM, false);
    scene.propString(P_ANIM_NAME, plan.name);
    scene.propUint(P_FPS, FPS);
    scene.propUint(P_DURATION, plan.duration);
    scene.propUint(P_LOOP, plan.loop ? 1 : 0); // 1 loop / 0 oneShot (loopValue table above)
    scene.end();

    for (const prop of plan.props) {
      scene.begin(T_KEYED_OBJECT, false);
      scene.propUint(P_OBJECT_ID, prop.objectId);
      scene.end();

      scene.begin(T_KEYED_PROPERTY, false);
      scene.propUint(P_PROPERTY_KEY, prop.propertyKey);
      scene.end();

      for (const k of prop.keys) {
        scene.begin(T_KEYFRAME_DOUBLE, false);
        if (k.frame !== 0) scene.propUint(P_FRAME, k.frame);
        scene.propUint(P_INTERP_TYPE, k.interpType);
        if (k.interpId >= 0) scene.propUint(P_INTERPOLATOR_ID, k.interpId);
        scene.propDouble(P_VALUE, k.value);
        scene.end();
      }
    }
  }
}

// ---- Small helpers ----

/** Sorted copy of a track's keyframes (empty when the track is missing). */
function keysOf(track: Track | undefined): Keyframe[] {
  return [...(track?.keyframes ?? [])].sort((a, b) => a.time - b.time);
}

/** ms -> integer frame at 60 fps. */
export function toFrame(ms: number): number {
  return Math.round((ms / 1000) * FPS);
}

/**
 * Cubic-bezier handles for the segment arriving at `key`, or null for a linear segment.
 * Keyframe.bezier (custom curve editor) overrides the preset everywhere.
 */
export function cubicFor(key: Keyframe): [number, number, number, number] | null {
  if (key.bezier) return [key.bezier[0], key.bezier[1], key.bezier[2], key.bezier[3]];
  if (key.easing === 'linear') return null;
  return EASING_CUBIC[key.easing];
}

/**
 * Keyframe animation emission: builds the deterministic per-target channel plan (root
 * translate/scale + each part's rotate/tx/ty/sx/sy), registers CubicEaseInterpolators
 * for any custom/preset easing BEFORE the animation objects that reference them, then
 * emits one LinearAnimation per clip with its KeyedObject/KeyedProperty/KeyFrameDouble
 * tree. Keyed values are ABSOLUTE; a channel with no keyframes emits nothing here and
 * stays a static Node property (written by scene.ts) — rest fills only unkeyed channels.
 * Hidden parts (`isEffectivelyHidden`) never enter channelSpecs at all, so no clip can
 * accidentally key a Node/color that scene.ts never emitted.
 *
 * OPACITY CHANNEL (export-completions wave, 2026-07-13): a keyed `opacity` channel
 * animates each of the part's own Fill/Stroke SolidColor.colorValue (P_COLOR) via
 * KeyFrameColor, NOT Node.opacity. Verified against rive-runtime (src/transform_
 * component.cpp): TransformComponent::childOpacity() returns the already-composed
 * m_RenderOpacity, so Node opacity CASCADES multiplicatively down the whole Node
 * ancestor chain — every part's Node is a real nested child of its parent's Node here
 * (scene.ts's parentId chain), so targeting Node.opacity would incorrectly dim a part's
 * children too. This editor's opacity is explicitly NON-propagating
 * (core/docTypes.ts's RestPose.opacity: "applied to the part's own drawn geometry only
 * — does NOT propagate to children"), matching the LIVE canvas exactly (view/partDom.ts
 * appends every part `<g>` as a FLAT SIBLING of one root group, never nested — SVG
 * opacity inheritance never enters into it). Targeting the paint's own SolidColor alpha
 * is cascade-free by construction (a paint never affects descendants) and reuses the
 * exact "fold opacity into alpha" model rest opacity already uses (scene.ts's argb()
 * calls) — no double-application: a keyed color KeyFrame HARD-SETS colorValue (src/
 * animation/keyframe_color.cpp's applyColor, mix==1 -> CoreRegistry::setColor, a plain
 * overwrite), it never multiplies against the static rest-folded alpha scene.ts wrote,
 * exactly like every other keyed channel here overwrites its static Node property.
 *
 * DRAW ORDER (`z`) is delegated to drawRules.ts (DrawRules/DrawTarget + KeyFrameId) —
 * see its header for the full mechanism; this file only plans+emits per clip.
 */

import { Channel, Clip, Keyframe, RigDoc, Track } from '../../core/model';
import { Scene } from './writer';
import { DrawRulesEntry, DrawRulesSetup, emitZKeyedProperty, planZDrawTargets, ZPlanKey } from './drawRules';
import {
  argb, DEG2RAD, EASING_CUBIC, FPS, INTERP_CUBIC, INTERP_LINEAR, P_ANIM_NAME, P_COLOR,
  P_DURATION, P_FPS, P_FRAME, P_INTERP_TYPE, P_INTERPOLATOR_ID, P_KEYFRAME_COLOR_VALUE,
  P_LOOP, P_NODE_X, P_NODE_Y, P_OBJECT_ID, P_PROPERTY_KEY, P_ROOT_BONE_X, P_ROOT_BONE_Y,
  P_ROTATION, P_SCALE_X, P_SCALE_Y, P_VALUE, P_X1, P_X2, P_Y1, P_Y2, T_CUBIC_INTERP,
  T_KEYED_OBJECT, T_KEYED_PROPERTY, T_KEYFRAME_COLOR, T_KEYFRAME_DOUBLE, T_LINEAR_ANIM,
} from './keys';

/** One Fill or Stroke SolidColor a part owns (scene.ts's emitShape records these). */
export interface OpacityColorTarget {
  colorIndex: number;
  hex: string;
  /** The path's own fill-opacity/stroke-opacity — the multiplier the keyed part opacity
   *  applies on top of, exactly mirroring the static rest-opacity fold in scene.ts. */
  baseOpacity: number;
}

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
  partShapeIndex: Map<string, number>,
  opacityTargets: Map<string, OpacityColorTarget[]>,
  drawRules: DrawRulesSetup,
  hiddenIds: Set<string>,
): void {
  // Project frame rate (doc.fps): normalizeDoc always seeds it, but this exporter is a
  // pure function of its `doc` PARAMETER (test fixtures and headless callers may hand it
  // a raw, never-normalized doc — see scene.ts's effectivelyHiddenIds for the same
  // rationale), so fall back to the FPS constant here too.
  const fps = doc.fps && doc.fps > 0 ? doc.fps : FPS;
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
  interface ZPlan { entry: DrawRulesEntry; keys: ZPlanKey[] }
  interface OpacityPlan { colorIndex: number; keys: PlanKey[] }
  interface PlanClip {
    name: string; duration: number; loop: boolean;
    props: PlanProp[]; zPlans: ZPlan[]; opacityPlans: OpacityPlan[];
  }

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
    // Full exclusion (hidden-part export completions): a hidden part got no Node from
    // scene.ts, so no clip may key any channel on it — see this file's header.
    if (hiddenIds.has(part.id)) continue;
    const parent = part.parentId ? byId.get(part.parentId) ?? null : null;
    const parentRef = parent ? parent.pivot : doc.rootPivot;
    // Bones export as RootBone (scene.ts), whose position properties are its OWN
    // x(90)/y(91) — Node's x(13)/y(14) don't exist on it, so a keyed bone tx/ty must
    // target the RootBone keys. rotation/scale stay the shared TransformComponent keys.
    const isBone = part.kind === 'bone';
    channelSpecs.push(
      { target: part.id, channel: 'rotate', propertyKey: P_ROTATION, base: 0, isAngle: true },
      { target: part.id, channel: 'tx', propertyKey: isBone ? P_ROOT_BONE_X : P_NODE_X, base: part.pivot.x - parentRef.x, isAngle: false },
      { target: part.id, channel: 'ty', propertyKey: isBone ? P_ROOT_BONE_Y : P_NODE_Y, base: part.pivot.y - parentRef.y, isAngle: false },
      // sx/sy: absolute Node scale (base 0 -> raw value == the keyed scale). A part with
      // no scale keyframes produces an empty channel and emits nothing, so this is a
      // no-op for every doc that never animates part scale (all existing fixtures).
      { target: part.id, channel: 'sx', propertyKey: P_SCALE_X, base: 0, isAngle: false },
      { target: part.id, channel: 'sy', propertyKey: P_SCALE_Y, base: 0, isAngle: false },
    );
  }
  const objectIdOf = (target: string): number =>
    target === 'root' ? rootIndex : partIndex.get(target)!;

  /** One part's keyed `opacity` -> a KeyFrameColor plan for EACH SolidColor it owns
   *  (see this file's header for why the target is the paint, not Node.opacity). */
  const buildOpacityPlans = (clip: Clip, partId: string): OpacityPlan[] => {
    const targets = opacityTargets.get(partId);
    if (!targets || targets.length === 0) return [];
    const track = clip.tracks.find((t) => t.target === partId && t.channel === 'opacity');
    const sorted = keysOf(track);
    if (sorted.length === 0) return [];
    return targets.map((target) => ({
      colorIndex: target.colorIndex,
      keys: sorted.map((key, i) => {
        const opacity = Math.min(1, Math.max(0, key.value));
        let interpType = INTERP_LINEAR;
        let interpId = -1;
        const next = sorted[i + 1];
        if (next) {
          const bez = cubicFor(next);
          if (bez) { interpType = INTERP_CUBIC; interpId = emitInterpolator(bez); }
        }
        return {
          frame: toFrame(key.time, fps), value: argb(target.hex, target.baseOpacity * opacity),
          interpType, interpId,
        };
      }),
    }));
  };

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
        return { frame: toFrame(key.time, fps), value: raw, interpType, interpId };
      });
      props.push({ objectId: objectIdOf(spec.target), propertyKey, keys });
    }

    // Keyed draw order (z): one plan per part this doc gave DrawRules to (drawRules.ts
    // filters/creates its own DrawTarget objects on demand — see its header).
    const zPlans: ZPlan[] = [];
    for (const [partId, entry] of drawRules) {
      const part = byId.get(partId);
      if (!part) continue;
      const keys = planZDrawTargets(scene, doc, clip, part, entry, partShapeIndex, hiddenIds, fps);
      if (keys.length > 0) zPlans.push({ entry, keys });
    }

    // Keyed opacity: one plan per SolidColor owned by any part this clip keys opacity on.
    const opacityPlans: OpacityPlan[] = [];
    for (const partId of opacityTargets.keys()) opacityPlans.push(...buildOpacityPlans(clip, partId));

    return {
      name: clip.name,
      duration: Math.max(1, Math.round((clip.duration / 1000) * fps)),
      // Rive parity: looping is a LinearAnimation property (loopValue), not a per-state
      // one — see Clip.loop's doc comment in model.ts. Default true (absent = looping).
      loop: clip.loop !== false,
      props, zPlans, opacityPlans,
    };
  });

  // Now emit the animation objects (they do NOT consume component indices).
  for (const plan of plans) {
    scene.begin(T_LINEAR_ANIM, false);
    scene.propString(P_ANIM_NAME, plan.name);
    scene.propUint(P_FPS, fps);
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

    // Keyed draw order: KeyedObject/KeyedProperty(drawTargetId)/KeyFrameId* (drawRules.ts).
    for (const zp of plan.zPlans) emitZKeyedProperty(scene, zp.entry, zp.keys);

    // Keyed opacity: KeyedObject/KeyedProperty(colorValue)/KeyFrameColor* per SolidColor.
    for (const op of plan.opacityPlans) {
      scene.begin(T_KEYED_OBJECT, false);
      scene.propUint(P_OBJECT_ID, op.colorIndex);
      scene.end();

      scene.begin(T_KEYED_PROPERTY, false);
      scene.propUint(P_PROPERTY_KEY, P_COLOR);
      scene.end();

      for (const k of op.keys) {
        scene.begin(T_KEYFRAME_COLOR, false);
        if (k.frame !== 0) scene.propUint(P_FRAME, k.frame);
        scene.propUint(P_INTERP_TYPE, k.interpType);
        if (k.interpId >= 0) scene.propUint(P_INTERPOLATOR_ID, k.interpId);
        scene.propColor(P_KEYFRAME_COLOR_VALUE, k.value);
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

/** ms -> integer frame at `fps` (defaults to the 60fps fallback constant). */
export function toFrame(ms: number, fps: number = FPS): number {
  return Math.round((ms / 1000) * fps);
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

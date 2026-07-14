/**
 * Document model and application state for Rig Studio.
 *
 * A RigDoc is an imported SVG reorganized for rigging: each named top-level group
 * becomes a RigPart with a pivot point (the joint), verbatim baked transforms, and its
 * drawable paths. Parts may be parented to one another (parentId) so limbs chain.
 * Animation lives in Clips: named timelines of per-channel keyframes. Each part also
 * carries a rest pose — offsets edited in Setup mode that keyframes add on top of.
 */

import { Mat } from '../geometry/transforms';
import { StateMachine } from './smTypes';

export interface Vec2 {
  x: number;
  y: number;
}

export interface RigPath {
  id: string;
  /** Display name from the SVG leaf's inkscape:label (or id) — shown in the layers tree. */
  label: string;
  /** Normalized absolute path data (all shapes are converted to paths on import). */
  d: string;
  /**
   * Per-node type flags, one char per drawing command (Z excluded), Inkscape's
   * sodipodi:nodetypes convention: 'c' corner/cusp, 's' smooth, 'z' symmetric.
   * Null = untyped (handle drags fall back to collinearity detection).
   */
  nodeTypes?: string | null;
  fill: string | null;
  fillOpacity: number;
  stroke: string | null;
  strokeWidth: number;
  strokeOpacity: number;
  /** Verbatim SVG transform accumulated from ancestors between the part group and this path. */
  transform: string;
}

/** Where a part's pivot should land once geometry is measurable (resolved by the canvas). */
export type PivotHint =
  /** Offset from the part's rendered bbox center, in document units (+y down). */
  { kind: 'centerOffset'; dx: number; dy: number };

/**
 * One entry in a part's ordered, MIXED child list — see `RigPart.childOrder`. `id`
 * resolves to a `RigPath.id` (within the SAME part's `paths[]`) when `kind === 'path'`,
 * or another `RigPart.id` (a DIRECT child, `parentId === this part's id`) when
 * `kind === 'part'`.
 */
export type ChildSlot = { kind: 'path' | 'part'; id: string };

/**
 * The character's rest pose, edited in Setup mode. A channel with keyframes ignores
 * these (keyed values are ABSOLUTE); a channel without keyframes displays its rest
 * value. Scale is Setup-only (no scale keyframes on parts) and is applied along the
 * artwork's own axes around the joint, so resizing never moves the pivot.
 */
export interface RestPose {
  rotate: number;
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  /** Skew angles in degrees (Inkscape's rotate-mode side handles), innermost with scale. */
  kx: number;
  ky: number;
  /**
   * 0..1, applied to the part's own drawn geometry only (does NOT propagate to children —
   * same rule as rest scale/skew). This is the KEYABLE channel that maps to a real Rive/
   * Lottie runtime feature (layer/node opacity) — see the 'opacity' Channel doc below.
   */
  opacity: number;
}

/**
 * What a part IS: 'art' draws paths; 'bone' is a partless joint (a diamond glyph on
 * canvas) for building multi-joint chains; 'group' is a partless container created by
 * Ctrl+G that its children ride on. Bones and groups still pose/animate like any part.
 */
export type PartKind = 'art' | 'bone' | 'group';

/** One bone a skinned part is bound to, captured at bind time (rest space). */
export interface SkinBone {
  id: string;
  /** Inverse of the bone's rest world matrix — per-frame delta = current · this. */
  restWorldInv: Mat;
  /** The bone's rest segment (origin → tip) in doc space, for distance weights. */
  bindSeg: { p: Vec2; q: Vec2 };
}

/**
 * A manual per-node weight override (Bones 2.0 refinement mode). A node keyed by this
 * blends bone `a` at weight (1−t) with bone `b` at weight `t` — i.e. an origin↔tip
 * lerp when `a` and `b` share a joint (a's tip == b's origin). `b === null` means 100%
 * bone `a`. `a === null` means this node carries no bone-choice override at all (a
 * PIN-ONLY entry — see `pin` below); otherwise both ids reference the part's own
 * `skin.bones`. Dangling refs are pruned by normalizeDoc. Overrides win over auto
 * weights per node in the LBS render.
 */
export interface SkinOverride {
  a: string | null;
  b: string | null;
  t: number;
  /**
   * PIN-TO-REST (0..1, PIN-TO-REST wave 2026-07-14): the fraction of this node held at
   * its BIND-POSE root-space position instead of following the `a`/`b` bone blend above
   * — deformed = lerp(lbsResult, restPosition, pin). Absent/0 = fully bone-driven
   * (today's behavior, back-compat). Independent of `a`/`b`/`t`: a node can carry a pin
   * with no bone choice at all (`a: null`), blending pure auto weights toward rest. Both
   * the editor render (view/skinRender.ts) and the .riv export (io/riv/skin.ts's
   * synthetic per-part anchor bone) implement this identically. Exists because the
   * origin/tip blend above only ever chooses WHICH ARM BONE carries a node — there was
   * no way to say "don't follow any bone at all, stay near the body" (the reported
   * armpit-floats-away bug: an origin-end override still rotates with that bone).
   */
  pin?: number;
}

export interface RigPart {
  id: string;
  label: string;
  kind: PartKind;
  /** Verbatim SVG transform of the part's group — the authored rest placement. */
  transform: string;
  /** Joint location in root (document) coordinates. Animated rotation spins around it. */
  pivot: Vec2;
  /** Pending pivot placement that needs layout to resolve; cleared once applied. */
  pivotHint?: PivotHint | null;
  /** Bones only: the far end of the bone, in the same frame as the pivot. */
  boneTip?: Vec2 | null;
  rest: RestPose;
  /** Another part's id to inherit motion from (bone hierarchy), or null. */
  parentId: string | null;
  /**
   * Unified Skeleton (Phase 1, 2026-07-13): true when this BONE's parent is a bone
   * belonging to a DIFFERENT chain (a cross-chain attach via the Layers panel — e.g. an
   * arm chain's root bone parented onto the spine) rather than the classic same-chain
   * shared joint. A normal chain-internal child bone's origin (`pivot`) always sits
   * exactly at its parent's tip (`boneTip`) — see `boneChain`'s and the
   * `carryChild*Origins` helpers' doc comments. An attached root is LOOSE: its origin
   * need not (and generally does not) sit at the parent's tip — `rest.rotate/tx/ty`
   * instead hold a fixed offset in the parent's frame, solved once at attach time so the
   * bone's WORLD transform (and everything riding it — its own sub-chain, any bound
   * skin) stays byte-stable (`view/rigOpsAttach.ts`'s world-preserving fold). `boneChain`
   * treats an attachedRoot bone as the root of its OWN chain: it stops walking UP through
   * one (so climbing from a descendant never crosses INTO the parent chain) and stops
   * collecting DOWN past one from the far side (so the parent chain's own resolution
   * excludes the attached sub-chain) — while POSE composition (which just follows
   * `parentId`) is untouched, so the attached sub-chain still rides the parent's motion
   * exactly like any other child. `view/ikDrag.ts`'s `ikBoneChain` stops at the same
   * boundary (Phase 2 — IK solving ACROSS attachments — is a deferred decision, not
   * built). Only meaningful on a `kind: 'bone'` part whose `parentId` resolves to another
   * bone; `normalizeDoc` clears it otherwise (back-compat + repair).
   */
  attachedRoot?: boolean;
  /**
   * Linear-blend skinning binding (art parts): geometry deforms by these bones
   * instead of riding a parent chain. Bind bakes static transforms into path data
   * and zeroes the part's own pose but KEEPS parentId (see view/rigOpsBind.ts —
   * detaching nested art was a real regression); weights derive from bindSeg
   * distances at runtime. The .riv export emits this binding as real Rive
   * Skin/Tendon deformation (io/riv/skin.ts); Lottie and headless frame renders
   * stay rigid (documented limitation).
   *
   * `overrides` are manual per-node refinements: `overrides[pathId][cmdIndex]` pins
   * that node's weight (see SkinOverride). Keyed by the path COMMAND index (post-bind
   * geometry is all M/L/C/Z, so a command index === its node); structural node edits
   * shift those indexes, so they drop the affected path's overrides.
   *
   * `restWorldInv` is the PART-level analogue of SkinBone.restWorldInv (pin-tracking
   * fix 2026-07-14): the inverse of the part's own full-pose world matrix at bind time,
   * so the PIN-TO-REST render target `fullPose(part,t) · restWorldInv · bindPos` is
   * exactly the rigid-equivalent pose — identity delta at the bind moment, riding every
   * later ancestor/own pose change the way an unskinned vertex would. Written by
   * `bindPartsToBones` and refreshed by the freeze bind-refresh cycle alongside the
   * per-bone records (view/rigOpsBind.ts); absent (legacy docs) reads as identity,
   * which is exact for the overwhelmingly common bind-under-identity-chain case.
   */
  skin?: {
    bones: SkinBone[];
    overrides?: Record<string, Record<string, SkinOverride>>;
    restWorldInv?: Mat;
  } | null;
  paths: RigPath[];
  /**
   * Layers-panel visibility (the eye icon). EDITOR-ONLY, doc data but NEVER keyable and
   * NEVER animated — "Keyable channels must map to Rive runtime features" (CLAUDE.md),
   * and there is no Rive/Lottie runtime property for "this layer disappears at frame N"
   * short of a full opacity/visibility keyframe, which is what the `opacity` Channel is
   * for. Toggling this never touches a clip's tracks in either editor mode. Cascades DOWN
   * the parent chain at render/export time (`isEffectivelyHidden`) rather than being
   * copied onto descendants, since the doc is a flat part list, not nested DOM/JSON.
   * Absent/false = visible (the default for every part that predates this field).
   */
  hidden?: boolean;
  /**
   * U1 (unified child ordering, 2026-07-13): this part's OWN paths and DIRECT child
   * parts as ONE ordered, interleaved list — index 0 paints first (bottom), the last
   * entry paints last (top), matching the doc-wide "last = topmost" convention
   * (`doc.parts` sibling order, `RigPath[]` order). Optional: absent means "legacy /
   * not yet synthesized" — `normalizeDoc` SYNTHESIZES it (own paths in `paths[]` order,
   * then direct children in `doc.parts` sibling order — exactly today's two-bucket
   * paint order, so an absent `childOrder` renders identically to a present, synthesized
   * one) and every structural mutation keeps a PRESENT one in lockstep through the
   * `core/childOrder.ts` CHOKEPOINT (`slotAddPath`/`slotRemovePath`/`slotAddChild`/
   * `slotRemoveChild`/`slotMoveWithin`/`reconcileChildOrder`) — nothing else may write
   * this field. U1 is model-only: nothing reads `childOrder` yet (U2 wires rendering).
   */
  childOrder?: ChildSlot[];
}

/**
 * Animatable channels. Parts support rotate/tx/ty/opacity (+ the keyable draw-order `z`
 * offset); the root figure also supports scale.
 *
 * `z` is special: it is a STACKING OFFSET, not a transform. It never enters a part's
 * rendered matrix — render.ts sorts parts by (effective z ascending, doc.parts index
 * ascending) to decide paint order. Its rest value is a fixed 0 (there is no RestPose.z),
 * so an unkeyed doc renders in pure doc.parts order exactly as before. Keyed z is ABSOLUTE
 * like every channel but SAMPLED STEPPED (hold the latest key at-or-before t; easing/bezier
 * ignored — a stacking rank is discrete, not blendable). See sampleKeyList's `stepped` arg.
 *
 * `opacity` is a normal CONTINUOUS channel (0..1, eases like rotate/tx/ty — no stepped
 * flag) backed by `RestPose.opacity`. It is the keyable half of the Layers-panel eye: the
 * eye toggle (`RigPart.hidden`) is editor-only and never becomes a track, but fading a
 * part in/out over time is a real Rive/Lottie runtime feature, so it gets a real channel.
 */
export type Channel = 'rotate' | 'tx' | 'ty' | 'sx' | 'sy' | 'z' | 'opacity';

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export const EASINGS: Easing[] = ['linear', 'easeIn', 'easeOut', 'easeInOut'];

export interface Keyframe {
  time: number; // ms
  value: number;
  easing: Easing; // easing of the segment arriving at this keyframe
  /**
   * Custom cubic-bezier for the ARRIVING segment (CSS-style x1,y1,x2,y2 with x in
   * 0..1), set by the curve editor. Overrides `easing` when present.
   */
  bezier?: [number, number, number, number] | null;
}

export interface Track {
  /** A part id, or 'root' for the whole-figure group. */
  target: string;
  channel: Channel;
  keyframes: Keyframe[];
}

export interface Clip {
  name: string;
  duration: number; // ms
  /**
   * Loop the clip. Governs the state-machine evaluator (`stateMachine.ts`'s
   * `clip.loop !== false`) and the .riv export's LinearAnimation loopValue. Default
   * true (absent = looping); only an explicit `false` clamps at the clip's end. This is
   * DOC data (serialized, undoable) — unlike the timeline's ping-pong toggle, which is
   * an app-state playback preference. The timeline's own scrub/playback preview always
   * loops regardless of this flag (that's transport behavior, separate from what the
   * SM evaluator and exporter do). Moved here from `SMState.loop` (v2.12) to match
   * Rive, where looping is a property of the LinearAnimation, not the state that plays it.
   */
  loop?: boolean;
  tracks: Track[];
}

/**
 * Optional page frame ("canvas size"), independent of the imported SVG's viewBox.
 * When enabled it is drawn as a page rectangle behind the artwork and both exporters
 * use it as their reference frame (Artboard/composition width+height, and origin
 * offset) instead of viewBox. Disabled or absent = today's viewBox-only behavior.
 */
export interface Artboard {
  enabled: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RigDoc {
  name: string;
  viewBox: { x: number; y: number; w: number; h: number };
  parts: RigPart[];
  /** Pivot for root-level scale (e.g. squash-and-stretch around the ground). */
  rootPivot: Vec2;
  clips: Clip[];
  /** Rive-style interactive graphs over the clips. Optional (absent on older docs). */
  stateMachines?: StateMachine[];
  /** Optional page frame; absent on older docs and on freshly-imported SVGs. */
  artboard?: Artboard;
  /**
   * Project frame rate (both exporters' animation fps AND the timeline's frames
   * readout). Optional so pre-existing/hand-built docs stay valid; normalizeDoc seeds
   * it to 60 (matching the exporters' old hardcoded constant, so an absent value is
   * byte-identical to before) and repairs a non-positive/non-finite value the same way.
   */
  fps?: number;
}

export const CHANNEL_DEFAULTS: Record<Channel, number> = {
  rotate: 0,
  tx: 0,
  ty: 0,
  sx: 1,
  sy: 1,
  z: 0, // stacking OFFSET rest value; 0 = authored (doc.parts) draw order
  opacity: 1, // fully opaque; used for the synthetic 'root' target (no RestPose there)
};

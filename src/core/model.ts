/**
 * Document model and application state for Rig Studio.
 *
 * A RigDoc is an imported SVG reorganized for rigging: each named top-level group
 * becomes a RigPart with a pivot point (the joint), verbatim baked transforms, and its
 * drawable paths. Parts may be parented to one another (parentId) so limbs chain.
 * Animation lives in Clips: named timelines of per-channel keyframes. Each part also
 * carries a rest pose — offsets edited in Setup mode that keyframes add on top of.
 */

import { Mat, applyMat, multiply, rotationMat } from '../geometry/transforms';

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
   * Linear-blend skinning binding (art parts): geometry deforms by these bones
   * instead of riding a parent chain. Bind bakes static transforms into path data,
   * zeroes rest, and clears parentId; weights derive from bindSeg distances at
   * runtime. Exporters render skinned parts rigidly (documented limitation).
   */
  skin?: { bones: SkinBone[] } | null;
  paths: RigPath[];
}

/** Animatable channels. Parts support all three; the root figure also supports scale. */
export type Channel = 'rotate' | 'tx' | 'ty' | 'sx' | 'sy';

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
  tracks: Track[];
}

// ---- State machines ----
//
// Rive-style interactive animation graphs. A machine wires named INPUTS (bool/number/
// trigger) into STATES (each an animation clip, plus the special entry/any/exit nodes)
// connected by TRANSITIONS whose CONDITIONS gate them. LISTENERS map canvas pointer
// events on a part to input mutations. Shapes mirror Rive's own semantics so the .riv
// exporter can map 1:1. The runtime evaluator lives in stateMachine.ts (pure, no DOM).

export type SMInputType = 'bool' | 'number' | 'trigger';

export interface SMInput {
  id: string;
  name: string;
  type: SMInputType;
  /** Initial value (bool/number). Triggers start disarmed and take no default. */
  default?: boolean | number;
}

/**
 * 'entry' is the graph's start node (resolved once at create/reset); 'any' is a
 * source-only node whose transitions may fire from any state; 'exit' ends the machine
 * (done); 'animation' plays a clip by name.
 */
export type SMStateKind = 'entry' | 'any' | 'exit' | 'animation';

export interface SMState {
  id: string;
  name: string;
  kind: SMStateKind;
  /** The clip this state plays (kind 'animation' only). A dangling name samples rest. */
  clipName?: string;
  /** Loop the clip (kind 'animation'); defaults true — false clamps at the clip end. */
  loop?: boolean;
  /** Cosmetic graph-editor position (smPanel). Persisted for free; never affects runtime. */
  x?: number;
  y?: number;
}

export type SMConditionOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

export interface SMCondition {
  inputId: string;
  /** Comparison operator. Bool inputs accept only ==/!= (missing = ==); triggers ignore it. */
  op?: SMConditionOp;
  /** Right-hand value (bool/number). Trigger conditions omit it — they fire when armed. */
  value?: boolean | number;
}

export interface SMTransition {
  id: string;
  fromId: string;
  toId: string;
  /** Crossfade length into the target state, ms. 0 = instant. */
  durationMs: number;
  /** ANDed together; an empty list is an unconditional transition. */
  conditions: SMCondition[];
}

export interface SMListenerAction {
  inputId: string;
  type: 'setBool' | 'setNumber' | 'fireTrigger';
  value?: boolean | number;
}

export interface SMListener {
  id: string;
  targetPartId: string;
  event: 'down' | 'up' | 'enter' | 'exit';
  actions: SMListenerAction[];
}

export interface StateMachine {
  id: string;
  name: string;
  inputs: SMInput[];
  states: SMState[];
  transitions: SMTransition[];
  listeners: SMListener[];
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
}

/**
 * A fresh state machine with exactly the mandatory 'entry', 'any', and 'exit' nodes
 * (Rive rejects a layer missing any of the three as corrupt) and no clips wired yet.
 * The one place machines are minted, so the invariant holds from birth (normalizeDoc
 * re-establishes it on load). Exit gets a seeded position to the right of the default
 * entry/any/animation layout (smPanel's `ensureLayout` mirrors this for machines that
 * gain an exit later without a stored position, e.g. old projects via normalizeDoc).
 */
export function newStateMachine(name: string): StateMachine {
  return {
    id: freshId('sm'),
    name,
    inputs: [],
    states: [
      { id: freshId('state'), name: 'Entry', kind: 'entry' },
      { id: freshId('state'), name: 'Any', kind: 'any' },
      { id: freshId('state'), name: 'Exit', kind: 'exit', x: 520, y: 44 },
    ],
    transitions: [],
    listeners: [],
  };
}

export const CHANNEL_DEFAULTS: Record<Channel, number> = {
  rotate: 0,
  tx: 0,
  ty: 0,
  sx: 1,
  sy: 1,
};

// ---- Application state ----

/** The canvas tool within Setup mode: pose the rig or edit path nodes. */
export type Mode = 'rig' | 'nodes';

/**
 * The global editing mode. Setup edits the character itself (rest pose, pivots, nodes)
 * and never touches keyframes; Animate records keyframes at the playhead.
 */
export type EditorMode = 'setup' | 'animate';

/** Canvas transform tool. select = classic drags; the rest add gizmos/solvers. */
export type Tool = 'select' | 'translate' | 'rotate' | 'ik';

export interface AppState {
  doc: RigDoc | null;
  tool: Tool;
  /** Primary selection (inspector target). */
  selectedPartId: string | null;
  /** Full selection set for multi-part posing; always contains selectedPartId when set. */
  selectedPartIds: string[];
  /** A single path within the selected part ("entered" like an SVG editor group), or null. */
  selectedPathId: string | null;
  activeClipIndex: number;
  currentTime: number;
  playing: boolean;
  mode: Mode;
  editorMode: EditorMode;
  playbackSpeed: number;
  pingPong: boolean;
  /** Playback direction, flipped by ping-pong looping. */
  playDirection: 1 | -1;
  onionSkin: boolean;
  /**
   * Whether Setup-mode drags snap (node↔node, pivot↔pivot, bbox features). An EDITOR
   * preference — never serialized into a project; persisted separately in localStorage.
   */
  snapEnabled: boolean;
}

/** localStorage key for the snapping preference (a UI setting, not project data). */
const SNAP_STORAGE_KEY = 'rig-studio-snap-enabled';

function readSnapEnabled(): boolean {
  try {
    const v = localStorage.getItem(SNAP_STORAGE_KEY);
    return v === null ? true : v === 'true'; // default ON
  } catch {
    return true; // no localStorage (tests/node) — default ON
  }
}

/** Toggle snapping and persist the choice. */
export function setSnapEnabled(enabled: boolean): void {
  state.snapEnabled = enabled;
  try {
    localStorage.setItem(SNAP_STORAGE_KEY, String(enabled));
  } catch {
    /* persistence unavailable — keep the in-memory flag */
  }
}

export const state: AppState = {
  doc: null,
  tool: 'select',
  selectedPartId: null,
  selectedPartIds: [],
  selectedPathId: null,
  activeClipIndex: 0,
  currentTime: 0,
  playing: false,
  mode: 'rig',
  editorMode: 'setup',
  playbackSpeed: 1,
  pingPong: false,
  playDirection: 1,
  onionSkin: false,
  snapEnabled: readSnapEnabled(),
};

type Listener = () => void;
const listeners: Listener[] = [];

/** Subscribe to any state/document change. Panels re-render on notify(). */
export function subscribe(fn: Listener): void {
  listeners.push(fn);
}

export function notify(): void {
  for (const fn of listeners) fn();
}

export function activeClip(): Clip | null {
  if (!state.doc) return null;
  return state.doc.clips[state.activeClipIndex] ?? null;
}

export function selectedPart(): RigPart | null {
  if (!state.doc || !state.selectedPartId) return null;
  return state.doc.parts.find((p) => p.id === state.selectedPartId) ?? null;
}

export function selectedParts(): RigPart[] {
  if (!state.doc) return [];
  return state.selectedPartIds
    .map((id) => state.doc!.parts.find((p) => p.id === id))
    .filter((p): p is RigPart => !!p);
}

/** Set or extend the selection. Additive keeps existing parts (shift-click). */
export function selectPart(id: string | null, additive = false): void {
  if (id !== state.selectedPartId) state.selectedPathId = null;
  if (id === null) {
    state.selectedPartId = null;
    state.selectedPartIds = [];
    return;
  }
  if (additive) {
    if (!state.selectedPartIds.includes(id)) state.selectedPartIds.push(id);
    state.selectedPartId = id;
  } else {
    state.selectedPartId = id;
    state.selectedPartIds = [id];
  }
}

export function selectedPath(): { part: RigPart; path: RigPath } | null {
  const part = selectedPart();
  if (!part || !state.selectedPathId) return null;
  const path = part.paths.find((p) => p.id === state.selectedPathId);
  return path ? { part, path } : null;
}

/**
 * Select every part in the document (Ctrl+A in Setup/Animate) — the same additive
 * selection mechanism a chain of Shift+clicks would produce, just applied at once.
 */
export function selectAllParts(): void {
  if (!state.doc) return;
  state.selectedPartIds = state.doc.parts.map((p) => p.id);
  state.selectedPartId = state.selectedPartIds[state.selectedPartIds.length - 1] ?? null;
  state.selectedPathId = null;
}

// ---- Part hierarchy ----

export function partById(id: string): RigPart | null {
  return state.doc?.parts.find((p) => p.id === id) ?? null;
}

/** Ancestors of a part, outermost first. Cycle-safe (stops on repeat). */
export function ancestorChain(part: RigPart): RigPart[] {
  const chain: RigPart[] = [];
  const seen = new Set<string>([part.id]);
  let cur = part.parentId ? partById(part.parentId) : null;
  while (cur && !seen.has(cur.id)) {
    chain.unshift(cur);
    seen.add(cur.id);
    cur = cur.parentId ? partById(cur.parentId) : null;
  }
  return chain;
}

export function isAncestorOf(maybeAncestor: RigPart, part: RigPart): boolean {
  return ancestorChain(part).some((p) => p.id === maybeAncestor.id);
}

/** Reparent a part; refuses cycles. Returns whether the change was applied. */
export function setParent(childId: string, parentId: string | null): boolean {
  const child = partById(childId);
  if (!child) return false;
  if (parentId === null) {
    child.parentId = null;
    return true;
  }
  if (parentId === childId) return false;
  const parent = partById(parentId);
  if (!parent) return false;
  if (isAncestorOf(child, parent)) return false; // would create a cycle
  child.parentId = parentId;
  return true;
}

// ---- Bones, groups, structural edits ----

/** Create a partless bone/group part. Bones are the joints of multi-joint chains. */
export function addNullPart(
  kind: 'bone' | 'group', pivot: Vec2, parentId: string | null, label?: string,
): RigPart {
  const part: RigPart = {
    id: freshId('part'),
    label: label ?? freshId(kind),
    kind,
    transform: '',
    pivot: { ...pivot },
    pivotHint: null,
    rest: { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 },
    parentId,
    paths: [],
  };
  state.doc!.parts.push(part);
  return part;
}

/**
 * Wrap the outermost of the given parts in a new group null pivoted at `pivot`.
 * Members whose ancestor is also selected stay attached to that ancestor. The group
 * adopts the members' common parent (or none) and slots in just above them in draw
 * order.
 */
export function groupParts(ids: string[], pivot: Vec2): RigPart | null {
  const doc = state.doc;
  if (!doc) return null;
  const members = doc.parts.filter((p) => ids.includes(p.id));
  const outer = members.filter((p) => !ancestorChain(p).some((a) => ids.includes(a.id)));
  if (outer.length === 0) return null;

  const parents = new Set(outer.map((p) => p.parentId));
  const parentId = parents.size === 1 ? [...parents][0] : null;
  const group = addNullPart('group', pivot, parentId);
  // addNullPart pushed it last; move it just above the topmost member instead.
  doc.parts.pop();
  const insertAt = Math.max(...outer.map((p) => doc.parts.indexOf(p))) + 1;
  doc.parts.splice(insertAt, 0, group);
  for (const p of outer) p.parentId = group.id;
  return group;
}

/**
 * Dissolve a partless group/bone: children re-adopt its parent and absorb its rest
 * pose so nothing moves on canvas. The absorption is exact for the rest pose and for
 * keyed rotations (+= group rotation); keyed child translations are remapped through
 * the group's rigid transform — when the group is rotated and a child has tx/ty keys,
 * both tracks are resampled on the union of their key times (values exact at keys).
 * Refuses when the null itself is animated in any clip (remove its tracks first) or
 * when the part has artwork.
 */
export function ungroupPart(id: string): boolean {
  const doc = state.doc;
  const part = partById(id);
  if (!doc || !part || part.paths.length > 0) return false;
  for (const clip of doc.clips) {
    if (clip.tracks.some((t) => t.target === id && t.keyframes.length > 0)) return false;
  }

  const gr = part.rest.rotate;
  const gp = part.pivot;
  const gt = { x: part.rest.tx, y: part.rest.ty };

  for (const child of doc.parts.filter((p) => p.parentId === id)) {
    const oldRest = { tx: child.rest.tx, ty: child.rest.ty };
    // Composing two rigid poses: angles add, and the child's translation maps
    // affinely — t' = gt + A·t + k, where A rotates by the group angle and k is the
    // constant translation of R(gr,gp)·R(−gr,cp). Exact for rest AND every keyframe.
    const cp = child.pivot;
    const a = rotationMat(gr, 0, 0);
    const kMat = multiply(rotationMat(gr, gp.x, gp.y), rotationMat(-gr, cp.x, cp.y));
    const k = { x: kMat.e, y: kMat.f };
    const mapT = (x: number, y: number) => {
      const rotated = applyMat(a, x, y);
      return { x: gt.x + rotated.x + k.x, y: gt.y + rotated.y + k.y };
    };

    const newRest = mapT(oldRest.tx, oldRest.ty);
    child.rest.rotate += gr;
    child.rest.tx = newRest.x;
    child.rest.ty = newRest.y;
    child.parentId = part.parentId;

    for (const clip of doc.clips) {
      const rot = clip.tracks.find((t) => t.target === child.id && t.channel === 'rotate');
      if (rot) for (const key of rot.keyframes) key.value += gr;

      const txT = clip.tracks.find((t) => t.target === child.id && t.channel === 'tx');
      const tyT = clip.tracks.find((t) => t.target === child.id && t.channel === 'ty');
      if (!txT && !tyT) continue;

      if (gr === 0) {
        // No rotation: axes stay independent, keys just shift.
        if (txT) for (const key of txT.keyframes) key.value += gt.x + k.x;
        if (tyT) for (const key of tyT.keyframes) key.value += gt.y + k.y;
        continue;
      }
      // Rotation mixes x and y, so both channels must exist and share key times:
      // resample on the union of times (exact at every original key time).
      const times = [...new Set([
        ...(txT?.keyframes ?? []).map((key) => key.time),
        ...(tyT?.keyframes ?? []).map((key) => key.time),
      ])].sort((x, y) => x - y);
      const easingAt = (track: Track | undefined, time: number): Easing | null =>
        track?.keyframes.find((key) => key.time === time)?.easing ?? null;
      const remapped = times.map((time) => {
        const x = sampleKeyList(txT?.keyframes ?? [], time, oldRest.tx);
        const y = sampleKeyList(tyT?.keyframes ?? [], time, oldRest.ty);
        const p = mapT(x, y);
        return {
          time, x: p.x, y: p.y,
          ex: easingAt(txT, time) ?? easingAt(tyT, time) ?? ('easeInOut' as Easing),
          ey: easingAt(tyT, time) ?? easingAt(txT, time) ?? ('easeInOut' as Easing),
        };
      });
      const writeTrack = (channel: Channel, existing: Track | undefined, pick: 'x' | 'y') => {
        const keyframes = remapped.map((r) => ({
          time: r.time, value: r[pick], easing: pick === 'x' ? r.ex : r.ey,
        }));
        if (existing) existing.keyframes = keyframes;
        else clip.tracks.push({ target: child.id, channel, keyframes });
      };
      writeTrack('tx', txT, 'x');
      writeTrack('ty', tyT, 'y');
    }
  }

  doc.parts = doc.parts.filter((p) => p !== part);
  for (const clip of doc.clips) {
    clip.tracks = clip.tracks.filter((t) => t.target !== id);
  }
  if (state.selectedPartId === id) selectPart(null);
  return true;
}

/** Structural edits the AI assistant may request (opt-in). */
export interface RigChanges {
  addBones: { label: string; pivot: Vec2; parent: string | null }[];
  reparent: { part: string; parent: string | null }[];
  movePivots: { part: string; x: number; y: number }[];
}

/**
 * Apply AI structural edits by part LABEL (the AI never sees ids). Returns the
 * label → id map including newly created bones, for resolving clip targets after.
 * Invalid references and cycle-creating reparents are skipped, not fatal.
 */
export function applyRigChanges(changes: RigChanges): Map<string, string> {
  const doc = state.doc!;
  const byLabel = new Map<string, string>(doc.parts.map((p) => [p.label, p.id]));

  for (const b of changes.addBones ?? []) {
    if (byLabel.has(b.label)) continue; // labels must stay unique
    const parentId = b.parent ? (byLabel.get(b.parent) ?? null) : null;
    const bone = addNullPart('bone', b.pivot, parentId, b.label.replace(/\s+/g, '_'));
    byLabel.set(bone.label, bone.id);
  }
  for (const r of changes.reparent ?? []) {
    const childId = byLabel.get(r.part);
    if (!childId) continue;
    setParent(childId, r.parent ? (byLabel.get(r.parent) ?? null) : null);
  }
  for (const m of changes.movePivots ?? []) {
    const id = byLabel.get(m.part);
    const part = id ? partById(id) : null;
    if (part) part.pivot = { x: m.x, y: m.y };
  }
  return byLabel;
}

/**
 * Delete parts (layers). Children of a deleted part re-adopt its nearest SURVIVING
 * ancestor (artwork is never deleted implicitly), the parts' tracks vanish from every
 * clip, and skin bindings referencing deleted bones are dropped. Returns deleted ids
 * so the canvas can unregister their groups.
 */
export function deleteParts(ids: string[]): string[] {
  const doc = state.doc;
  if (!doc) return [];
  const dead = new Set(ids.filter((id) => doc.parts.some((p) => p.id === id)));
  if (dead.size === 0) return [];

  for (const part of doc.parts) {
    if (dead.has(part.id) || !part.parentId || !dead.has(part.parentId)) continue;
    let anc: RigPart | null = partById(part.parentId);
    while (anc && dead.has(anc.id)) anc = anc.parentId ? partById(anc.parentId) : null;
    part.parentId = anc?.id ?? null;
  }
  doc.parts = doc.parts.filter((p) => !dead.has(p.id));
  for (const clip of doc.clips) {
    clip.tracks = clip.tracks.filter((t) => !dead.has(t.target));
  }
  for (const part of doc.parts) {
    if (part.skin) {
      part.skin.bones = part.skin.bones.filter((b) => !dead.has(b.id));
      if (part.skin.bones.length === 0) part.skin = null;
    }
  }
  if (state.selectedPartId && dead.has(state.selectedPartId)) selectPart(null);
  else state.selectedPartIds = state.selectedPartIds.filter((id) => !dead.has(id));
  return [...dead];
}

/**
 * Duplicate parts (Ctrl+D, Setup only): deep-clones each part and its paths with fresh
 * ids, keeps the same parent, and nudges the rest translation by (+12,+12) doc units so
 * the copy is visibly offset from the source. No animation tracks are copied — a fresh
 * id has none by construction, since clip tracks are keyed by target id. Skinned parts
 * are skipped (their geometry is baked to a bind pose; a naive clone would double-bind
 * the same bones). Each copy is inserted immediately after its source, so the whole
 * duplicated set stays contiguous. Returns the new parts' ids, input order preserved.
 */
export function duplicateParts(ids: string[]): string[] {
  const doc = state.doc;
  if (!doc) return [];
  const newIds: string[] = [];
  for (const id of ids) {
    const part = doc.parts.find((p) => p.id === id);
    if (!part || part.skin) continue;
    const clone: RigPart = structuredClone(part);
    clone.id = freshId('part');
    clone.label = `${part.label} copy`;
    clone.pivotHint = null;
    clone.rest.tx += 12;
    clone.rest.ty += 12;
    clone.paths = part.paths.map((p) => ({ ...structuredClone(p), id: freshId('path') }));
    const insertAt = doc.parts.indexOf(part) + 1;
    doc.parts.splice(insertAt, 0, clone);
    newIds.push(clone.id);
  }
  return newIds;
}

// ---- Draw order (z-order) ----
// doc.parts array order IS the paint order: last = drawn on top. The layers panel
// lists topmost first, so "up the layer list" means "later in doc.parts".

/** Whether the current selection (entered path, else part) can move a step in z. */
export function canMoveSelectedInDrawOrder(delta: 1 | -1): boolean {
  const doc = state.doc;
  const part = selectedPart();
  if (!doc || !part) return false;
  if (state.selectedPathId) {
    const i = part.paths.findIndex((p) => p.id === state.selectedPathId);
    return i >= 0 && i + delta >= 0 && i + delta < part.paths.length;
  }
  const i = doc.parts.indexOf(part);
  return i + delta >= 0 && i + delta < doc.parts.length;
}

/** Move the entered path (within its part) or the selected part one z step (+1 = up). */
export function moveSelectedInDrawOrder(delta: 1 | -1): boolean {
  if (!canMoveSelectedInDrawOrder(delta)) return false;
  const doc = state.doc!;
  const part = selectedPart()!;
  if (state.selectedPathId) {
    const i = part.paths.findIndex((p) => p.id === state.selectedPathId);
    [part.paths[i], part.paths[i + delta]] = [part.paths[i + delta], part.paths[i]];
  } else {
    const i = doc.parts.indexOf(part);
    [doc.parts[i], doc.parts[i + delta]] = [doc.parts[i + delta], doc.parts[i]];
  }
  return true;
}

/**
 * Drop a part just above/below another in the layers tree: it draws immediately on
 * top of ('above') or beneath ('below') `refId` and becomes its sibling — adopting
 * ref's parent, like dropping between rows in any layer tree. Refuses when adopting
 * that parent would create a cycle.
 */
export function movePartRelativeTo(
  partId: string, refId: string, place: 'above' | 'below',
): boolean {
  const doc = state.doc;
  if (!doc || partId === refId) return false;
  const part = partById(partId);
  const ref = partById(refId);
  if (!part || !ref) return false;
  if (ref.parentId !== part.parentId && !setParent(partId, ref.parentId)) return false;
  doc.parts.splice(doc.parts.indexOf(part), 1);
  const refIdx = doc.parts.indexOf(ref);
  doc.parts.splice(place === 'above' ? refIdx + 1 : refIdx, 0, part);
  return true;
}

// ---- Pose evaluation ----

function ease(t: number, easing: Easing): number {
  switch (easing) {
    case 'easeIn': return t * t;
    case 'easeOut': return 1 - (1 - t) * (1 - t);
    case 'easeInOut': return t * t * (3 - 2 * t); // smoothstep
    default: return t;
  }
}

/**
 * CSS-style cubic-bezier easing: solve x(u) = t for u (Newton with bisection
 * fallback), then evaluate y(u). Control x's are assumed clamped to 0..1.
 */
export function cubicBezierEase(
  x1: number, y1: number, x2: number, y2: number, t: number,
): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const bx = (u: number) => 3 * u * (1 - u) * (1 - u) * x1 + 3 * u * u * (1 - u) * x2 + u ** 3;
  const by = (u: number) => 3 * u * (1 - u) * (1 - u) * y1 + 3 * u * u * (1 - u) * y2 + u ** 3;
  const dbx = (u: number) =>
    3 * (1 - u) * (1 - u) * x1 + 6 * u * (1 - u) * (x2 - x1) + 3 * u * u * (1 - x2);
  let u = t;
  for (let i = 0; i < 8; i++) {
    const err = bx(u) - t;
    if (Math.abs(err) < 1e-6) return by(u);
    const d = dbx(u);
    if (Math.abs(d) < 1e-9) break;
    u -= err / d;
    if (u <= 0 || u >= 1) break;
  }
  let lo = 0, hi = 1;
  u = t;
  for (let i = 0; i < 24; i++) {
    if (bx(u) < t) lo = u;
    else hi = u;
    u = (lo + hi) / 2;
  }
  return by(u);
}

/**
 * The value a part's channel displays at a time: the ABSOLUTE keyframed value when the
 * channel is keyed in the active clip, otherwise the part's rest value. This is what
 * makes editing the rest pose in Setup mode safe — it never shifts keyed animation.
 * Pass time = null to read the bare rest pose (Setup mode).
 */
export function channelValue(part: RigPart, channel: Channel, time: number | null): number {
  const rest =
    channel === 'rotate' ? part.rest.rotate
    : channel === 'tx' ? part.rest.tx
    : channel === 'ty' ? part.rest.ty
    : channel === 'sx' ? part.rest.sx
    : part.rest.sy;
  if (time === null) return rest;
  const clip = activeClip();
  const track = clip?.tracks.find((t) => t.target === part.id && t.channel === channel);
  if (!track || track.keyframes.length === 0) return rest;
  return sampleChannel(part.id, channel, time);
}

/** Interpolate a sorted keyframe list at a time (pure — no state lookup). */
export function sampleKeyList(keys: Keyframe[], time: number, fallback: number): number {
  if (keys.length === 0) return fallback;
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length - 1];
  if (time >= last.time) return last.value;

  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i];
    const k1 = keys[i + 1];
    if (time >= k0.time && time <= k1.time) {
      const span = k1.time - k0.time;
      const t = span === 0 ? 1 : (time - k0.time) / span;
      const eased = k1.bezier
        ? cubicBezierEase(k1.bezier[0], k1.bezier[1], k1.bezier[2], k1.bezier[3], t)
        : ease(t, k1.easing);
      return k0.value + (k1.value - k0.value) * eased;
    }
  }
  return fallback;
}

/** Sample a channel value from the active clip at the given time. */
export function sampleChannel(target: string, channel: Channel, time: number): number {
  const clip = activeClip();
  const fallback = CHANNEL_DEFAULTS[channel];
  if (!clip) return fallback;
  const track = clip.tracks.find((t) => t.target === target && t.channel === channel);
  if (!track) return fallback;
  return sampleKeyList(track.keyframes, time, fallback);
}

/**
 * Write a keyframe for the channel at an explicit time. Creates the track on first
 * use; replaces an existing keyframe at (almost) the same time. An explicit `easing`
 * overwrites the existing key's easing (paste); omitting it keeps a hand-set easing
 * intact when auto-key drags re-value the key.
 */
export function setKeyframeAt(
  target: string, channel: Channel, time: number, value: number, easing?: Easing,
): Keyframe {
  const clip = activeClip()!;
  let track = clip.tracks.find((t) => t.target === target && t.channel === channel);
  if (!track) {
    track = { target, channel, keyframes: [] };
    clip.tracks.push(track);
  }
  const existing = track.keyframes.find((k) => Math.abs(k.time - time) < 5);
  if (existing) {
    existing.value = value;
    if (easing !== undefined) existing.easing = easing;
    return existing;
  }
  const key: Keyframe = { time, value, easing: easing ?? 'easeInOut' };
  track.keyframes.push(key);
  track.keyframes.sort((a, b) => a.time - b.time);
  return key;
}

/** Auto-key at the playhead (canvas drags, inspector edits in Animate mode). */
export function setKeyframe(target: string, channel: Channel, value: number): void {
  if (!activeClip()) return;
  const time = Math.round(state.currentTime / 10) * 10;
  setKeyframeAt(target, channel, time, value);
}

export function deleteKeyframe(track: Track, keyframe: Keyframe): void {
  const clip = activeClip();
  if (!clip) return;
  track.keyframes = track.keyframes.filter((k) => k !== keyframe);
  if (track.keyframes.length === 0) {
    clip.tracks = clip.tracks.filter((t) => t !== track);
  }
}

// ---- Keyframe clipboard ----

export interface CopiedKey {
  target: string;
  channel: Channel;
  /** Offset from the earliest copied keyframe. */
  dt: number;
  value: number;
  easing: Easing;
}

let keyClipboard: CopiedKey[] = [];

export function copyKeys(entries: { track: Track; key: Keyframe }[]): number {
  if (entries.length === 0) return 0;
  const t0 = Math.min(...entries.map((e) => e.key.time));
  keyClipboard = entries.map(({ track, key }) => ({
    target: track.target,
    channel: track.channel,
    dt: key.time - t0,
    value: key.value,
    easing: key.easing,
  }));
  return keyClipboard.length;
}

export function clipboardSize(): number {
  return keyClipboard.length;
}

/** Paste the clipboard with its earliest key landing at `time`. Returns pasted keys. */
export function pasteKeysAt(time: number): Keyframe[] {
  const clip = activeClip();
  if (!clip || keyClipboard.length === 0) return [];
  const out: Keyframe[] = [];
  for (const ck of keyClipboard) {
    const t = Math.max(0, Math.round((time + ck.dt) / 10) * 10);
    out.push(setKeyframeAt(ck.target, ck.channel, t, ck.value, ck.easing));
  }
  return out;
}

/** Snapshot every animated channel's value at `time` into the clipboard (copy pose). */
export function copyPoseAt(time: number): number {
  const clip = activeClip();
  if (!clip) return 0;
  keyClipboard = clip.tracks
    .filter((t) => t.keyframes.length > 0)
    .map((t) => ({
      target: t.target,
      channel: t.channel,
      dt: 0,
      value: sampleChannel(t.target, t.channel, time),
      easing: 'easeInOut' as Easing,
    }));
  return keyClipboard.length;
}

// ---- Serialization (project save/load) ----

const DOC_FORMAT = 'rig-studio';
const DOC_VERSION = 2;

export function serializeDoc(doc: RigDoc): string {
  return JSON.stringify({ format: DOC_FORMAT, version: DOC_VERSION, doc }, null, 1);
}

/**
 * Parse a saved project (current or older format) into a usable RigDoc, filling in
 * fields that did not exist when the file was written.
 */
export function deserializeDoc(json: string): RigDoc {
  const raw = JSON.parse(json) as { format?: string; version?: number; doc?: unknown };
  const doc = (raw && typeof raw === 'object' && 'doc' in raw ? raw.doc : raw) as RigDoc;
  if (!doc || !Array.isArray(doc.parts) || !doc.viewBox) {
    throw new Error('Not a Rig Studio project file');
  }
  return normalizeDoc(doc);
}

/** Fill defaults for fields added after a document was serialized. */
export function normalizeDoc(doc: RigDoc): RigDoc {
  let maxId = 0;
  const trackId = (id: string) => {
    const m = /_(\d+)$/.exec(id);
    if (m) maxId = Math.max(maxId, Number(m[1]));
  };
  for (const part of doc.parts) {
    trackId(part.id);
    part.kind = part.kind ?? 'art';
    part.rest = part.rest ?? { rotate: 0, tx: 0, ty: 0, sx: 1, sy: 1, kx: 0, ky: 0 };
    part.rest.sx = part.rest.sx ?? 1;
    part.rest.sy = part.rest.sy ?? 1;
    part.rest.kx = part.rest.kx ?? 0;
    part.rest.ky = part.rest.ky ?? 0;
    part.parentId = part.parentId ?? null;
    part.boneTip = part.boneTip ?? null;
    part.skin = part.skin ?? null;
    if (part.skin && !Array.isArray(part.skin.bones)) part.skin = null;
    part.pivotHint = part.pivotHint ?? null;
    part.paths.forEach((p, i) => {
      trackId(p.id);
      p.label = p.label ?? `path_${i + 1}`;
      if (p.nodeTypes != null && typeof p.nodeTypes !== 'string') p.nodeTypes = null;
    });
  }
  // Drop dangling parent references (e.g. hand-edited files).
  const ids = new Set(doc.parts.map((p) => p.id));
  for (const part of doc.parts) {
    if (part.parentId && !ids.has(part.parentId)) part.parentId = null;
    if (part.skin) {
      part.skin.bones = part.skin.bones.filter((b) => ids.has(b.id));
      if (part.skin.bones.length === 0) part.skin = null;
    }
  }
  doc.clips = doc.clips?.length ? doc.clips : [{ name: 'idle', duration: 2000, tracks: [] }];
  for (const clip of doc.clips) {
    for (const track of clip.tracks) {
      for (const k of track.keyframes) {
        if (!EASINGS.includes(k.easing)) k.easing = 'easeInOut';
        if (k.bezier != null) {
          const b = k.bezier;
          const ok =
            Array.isArray(b) && b.length === 4 && b.every((n) => Number.isFinite(n));
          if (!ok) k.bezier = null;
          else {
            b[0] = Math.min(1, Math.max(0, b[0]));
            b[2] = Math.min(1, Math.max(0, b[2]));
          }
        }
      }
    }
  }
  // State machines: default to none on old files; per machine re-establish the
  // entry/any/exit invariant and prune dangling references, but KEEP a state whose
  // clipName no longer resolves — the evaluator treats it as rest pose, so deleting a
  // clip must not silently destroy a graph.
  doc.stateMachines = Array.isArray(doc.stateMachines) ? doc.stateMachines : [];
  for (const sm of doc.stateMachines) {
    trackId(sm.id);
    for (const inp of sm.inputs ?? []) trackId(inp.id);
    for (const st of sm.states ?? []) trackId(st.id);
    for (const tr of sm.transitions ?? []) trackId(tr.id);
    for (const ls of sm.listeners ?? []) trackId(ls.id);
  }
  // Get idCounter past every loaded id before minting any fresh entry/any/exit nodes.
  bumpIdCounter(maxId);
  const partIds = new Set(doc.parts.map((p) => p.id));
  for (const sm of doc.stateMachines) {
    sm.inputs = Array.isArray(sm.inputs) ? sm.inputs : [];
    sm.states = Array.isArray(sm.states) ? sm.states : [];
    sm.transitions = Array.isArray(sm.transitions) ? sm.transitions : [];
    sm.listeners = Array.isArray(sm.listeners) ? sm.listeners : [];
    if (!sm.states.some((s) => s.kind === 'entry')) {
      sm.states.unshift({ id: freshId('state'), name: 'Entry', kind: 'entry' });
    }
    if (!sm.states.some((s) => s.kind === 'any')) {
      sm.states.push({ id: freshId('state'), name: 'Any', kind: 'any' });
    }
    if (!sm.states.some((s) => s.kind === 'exit')) {
      sm.states.push({ id: freshId('state'), name: 'Exit', kind: 'exit' });
    }
    const stateIds = new Set(sm.states.map((s) => s.id));
    const inputIds = new Set(sm.inputs.map((i) => i.id));
    sm.transitions = sm.transitions.filter((t) => stateIds.has(t.fromId) && stateIds.has(t.toId));
    for (const t of sm.transitions) {
      t.durationMs = Math.max(0, Number.isFinite(t.durationMs) ? t.durationMs : 0);
      t.conditions = Array.isArray(t.conditions)
        ? t.conditions.filter((c) => inputIds.has(c.inputId))
        : [];
    }
    sm.listeners = sm.listeners.filter((l) => partIds.has(l.targetPartId));
    for (const l of sm.listeners) {
      l.actions = Array.isArray(l.actions)
        ? l.actions.filter((a) => inputIds.has(a.inputId))
        : [];
    }
  }
  bumpIdCounter(maxId);
  return doc;
}

let idCounter = 0;
export function freshId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

/** Keep freshId ahead of ids present in a loaded document. */
export function bumpIdCounter(min: number): void {
  if (min > idCounter) idCounter = min;
}

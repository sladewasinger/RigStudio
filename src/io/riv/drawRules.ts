/**
 * Exact animated draw order for the Rive exporter.
 *
 * The editor's z channel re-sorts sibling PART slots and then flattens the resulting
 * childOrder tree into drawable path runs. Rive animates DrawRules.drawTargetId instead
 * of a numeric z value, so the exporter materializes that final order at every discrete
 * z event (the union of every z key time in the clip, plus frame zero).
 *
 * Each real Shape owns a DrawRules directly. This prevents hierarchy inheritance from
 * accidentally moving a different drawable and gives multi-run parts exact granularity.
 * The rules never target one another: the exporter adds one empty, invisible Shape per
 * possible paint rank and targets each real Shape immediately in front of the sentinel
 * for its desired rank. Because sentinel order is fixed and exactly one real drawable
 * occupies each rank, arbitrary permutations are representable without DrawTarget
 * dependency cycles. Empty Shapes have no PointsPath or paint and therefore draw no
 * pixels; they exist only as stable ordering anchors.
 *
 * A clip with no z tracks still receives the frame-zero rest permutation when another
 * clip in the document uses z. That resets DrawRules deterministically when runtimes or
 * state machines switch animations instead of inheriting the previous clip's targets.
 */

import { Clip, RigDoc, flattenPaintOrder, sampleKeyList } from '../../core/model';
import { Scene } from './writer';
import {
  INTERP_LINEAR, P_DRAWABLE_ID, P_DRAW_TARGET_ID, P_FRAME, P_INTERP_TYPE,
  P_KEYFRAME_ID_VALUE, P_NAME, P_OBJECT_ID, P_PARENT_ID, P_PLACEMENT_VALUE,
  P_PROPERTY_KEY, PLACEMENT_BEFORE, T_DRAW_RULES, T_DRAW_TARGET, T_KEYED_OBJECT,
  T_KEYED_PROPERTY, T_KEYFRAME_ID, T_SHAPE,
} from './keys';

export interface DrawableShape {
  partId: string;
  pathId: string;
  shapeIndex: number;
}

export interface DrawRulesEntry {
  rulesIndex: number;
  targets: Map<number, number>;
}

export interface DrawRulesSetup {
  shapes: DrawableShape[];
  entries: Map<number, DrawRulesEntry>;
  rankAnchors: number[];
}

export interface ZPlanKey { frame: number; targetIndex: number }
export interface ZPlan { entry: DrawRulesEntry; keys: ZPlanKey[] }

const shapeKey = (partId: string, pathId: string): string => `${partId}\u0000${pathId}`;

export function setupDrawRules(
  scene: Scene, doc: RigDoc, shapes: DrawableShape[], rootIndex: number,
): DrawRulesSetup {
  const hasAnimatedZ = doc.clips.some((clip) =>
    clip.tracks.some((track) => track.channel === 'z' && track.keyframes.length > 0));
  const setup: DrawRulesSetup = { shapes, entries: new Map(), rankAnchors: [] };
  if (!hasAnimatedZ || shapes.length === 0) return setup;

  const seen = new Set<number>();
  for (const shape of shapes) {
    if (seen.has(shape.shapeIndex)) {
      throw new Error(`Cannot export Rive z-order: duplicate drawable index ${shape.shapeIndex}.`);
    }
    seen.add(shape.shapeIndex);
  }

  for (let rank = shapes.length - 1; rank >= 0; rank -= 1) {
    const anchorIndex = scene.begin(T_SHAPE);
    scene.propUint(P_PARENT_ID, rootIndex);
    scene.propString(P_NAME, `Rig Studio draw rank ${rank}`);
    scene.end();
    setup.rankAnchors[rank] = anchorIndex;
  }

  for (const shape of shapes) {
    const rulesIndex = scene.begin(T_DRAW_RULES);
    scene.propUint(P_PARENT_ID, shape.shapeIndex);
    scene.end();
    setup.entries.set(shape.shapeIndex, { rulesIndex, targets: new Map() });
  }
  return setup;
}

function targetFor(scene: Scene, entry: DrawRulesEntry, anchorIndex: number): number {
  const cached = entry.targets.get(anchorIndex);
  if (cached !== undefined) return cached;
  const targetIndex = scene.begin(T_DRAW_TARGET);
  scene.propUint(P_PARENT_ID, entry.rulesIndex);
  scene.propUint(P_DRAWABLE_ID, anchorIndex);
  scene.propUint(P_PLACEMENT_VALUE, PLACEMENT_BEFORE);
  scene.end();
  entry.targets.set(anchorIndex, targetIndex);
  return targetIndex;
}

function desiredShapeOrder(
  doc: RigDoc, clip: Clip, time: number, setup: DrawRulesSetup, hiddenIds: Set<string>,
): DrawableShape[] {
  const byPath = new Map(setup.shapes.map((shape) => [shapeKey(shape.partId, shape.pathId), shape]));
  const tracks = new Map(
    clip.tracks
      .filter((track) => track.channel === 'z' && track.keyframes.length > 0)
      .map((track) => [track.target, [...track.keyframes].sort((a, b) => a.time - b.time)]),
  );
  const runs = flattenPaintOrder(doc, (part) =>
    sampleKeyList(tracks.get(part.id) ?? [], time, 0, true));
  const ordered: DrawableShape[] = [];
  for (const run of runs) {
    if (hiddenIds.has(run.partId)) continue;
    for (const pathId of run.pathIds) {
      const shape = byPath.get(shapeKey(run.partId, pathId));
      if (shape) ordered.push(shape);
    }
  }

  const unique = new Set(ordered.map((shape) => shape.shapeIndex));
  if (ordered.length !== setup.shapes.length || unique.size !== setup.shapes.length) {
    throw new Error(
      `Cannot export exact Rive z-order for clip "${clip.name}" at ${time}ms: ` +
      `the editor paint graph resolved ${unique.size} of ${setup.shapes.length} drawables. ` +
      'Repair dangling/cyclic parenting or duplicate path ids and export again.',
    );
  }
  return ordered;
}

export function planZDrawTargets(
  scene: Scene, doc: RigDoc, clip: Clip, setup: DrawRulesSetup,
  hiddenIds: Set<string>, fps: number,
): ZPlan[] {
  if (setup.entries.size === 0) return [];
  const eventTimes = new Set<number>([0]);
  for (const track of clip.tracks) {
    if (track.channel !== 'z') continue;
    for (const key of track.keyframes) eventTimes.add(key.time);
  }

  const keysByShape = new Map<number, ZPlanKey[]>();
  const previousTarget = new Map<number, number>();
  const frameEvents = new Map<number, number>();
  for (const time of [...eventTimes].sort((a, b) => a - b)) {
    frameEvents.set(Math.round((time / 1000) * fps), time);
  }

  for (const [frame, time] of frameEvents) {
    const order = desiredShapeOrder(doc, clip, time, setup, hiddenIds);
    order.forEach((shape, rank) => {
      const entry = setup.entries.get(shape.shapeIndex)!;
      const targetIndex = targetFor(scene, entry, setup.rankAnchors[rank]);
      if (previousTarget.get(shape.shapeIndex) === targetIndex) return;
      const keys = keysByShape.get(shape.shapeIndex) ?? [];
      keys.push({ frame, targetIndex });
      keysByShape.set(shape.shapeIndex, keys);
      previousTarget.set(shape.shapeIndex, targetIndex);
    });
  }

  return setup.shapes.map((shape) => ({
    entry: setup.entries.get(shape.shapeIndex)!,
    keys: keysByShape.get(shape.shapeIndex)!,
  }));
}

export function emitZKeyedProperty(scene: Scene, entry: DrawRulesEntry, keys: ZPlanKey[]): void {
  scene.begin(T_KEYED_OBJECT, false);
  scene.propUint(P_OBJECT_ID, entry.rulesIndex);
  scene.end();
  scene.begin(T_KEYED_PROPERTY, false);
  scene.propUint(P_PROPERTY_KEY, P_DRAW_TARGET_ID);
  scene.end();
  for (const key of keys) {
    scene.begin(T_KEYFRAME_ID, false);
    if (key.frame !== 0) scene.propUint(P_FRAME, key.frame);
    scene.propUint(P_INTERP_TYPE, INTERP_LINEAR);
    scene.propUint(P_KEYFRAME_ID_VALUE, key.targetIndex);
    scene.end();
  }
}

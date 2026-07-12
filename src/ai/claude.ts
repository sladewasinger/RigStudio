/**
 * The AI animation assistant. Sends the current rig (part names, hierarchy, pivots,
 * rest pose, canvas coordinate frame) plus the active clip to Claude and asks for an
 * updated clip that realizes the user's direction ("wave the right arm", "bend at the
 * knees"), optionally grounded with a rendered snapshot of the current pose.
 *
 * Structured outputs (output_config.format with a JSON schema) guarantee the reply is a
 * valid Clip, so applying it is a straight JSON.parse. Critique mode is plain text.
 */

import Anthropic from '@anthropic-ai/sdk';
import { Channel, Clip, Keyframe, RigChanges, RigDoc, RigPart } from '../core/model';

const MODEL = 'claude-opus-4-8';

/** A clip as the AI returns it: track targets are part LABELS, not ids. */
export interface RawClip {
  name: string;
  duration: number;
  tracks: { target: string; channel: string; keyframes: Keyframe[] }[];
  /**
   * Model-proposed name for a brand-new clip (AI Animate System v2 A1 "Create new
   * animation" only — the schema only asks for this field on create-mode requests).
   * `name` above is kept for back-compat and is otherwise unused by the apply path;
   * this is the field that actually becomes the new clip's name, sanitized/deduped by
   * `core/model.ts`'s `sanitizeClipName`.
   */
  clipName?: string;
}

export interface AnimateResult {
  clip: RawClip;
  /** Structural edits (only when the user opted in), or null. */
  rig: RigChanges | null;
  /** How many keyframe times `clampRawClip` had to clamp into `[0, duration]` — surfaced
   *  in the panel's status text so the "duration pinned" clamp isn't silent. */
  clampedCount: number;
}

/**
 * The clip response schema, parameterized over the two independent axes a request can
 * vary on (AI Animate System v2 A1): `withRig` (the existing "allow rig changes" opt-in)
 * and `withClipName` (Create-new mode only). Built as a function rather than fixed consts
 * so the four combinations share one source of truth for the tracks/keyframes shape.
 */
function buildClipSchema(opts: { withRig: boolean; withClipName: boolean }): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    name: { type: 'string' },
    duration: {
      type: 'integer',
      description:
        'Clip length in milliseconds — ECHO BACK the exact pinned duration stated in the ' +
        'request; this response never resizes the clip (see the duration-pin rule below).',
    },
    tracks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description:
              "A part label from the rig (art/bone/group) — NEVER 'root' (deprecated; " +
              'target a group part for whole-figure motion, see the targeting rule)',
          },
          channel: { type: 'string', enum: ['rotate', 'tx', 'ty', 'sx', 'sy', 'z', 'opacity'] },
          keyframes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                time: { type: 'integer' },
                value: { type: 'number' },
                easing: {
                  type: 'string',
                  enum: ['linear', 'easeIn', 'easeOut', 'easeInOut'],
                },
              },
              required: ['time', 'value', 'easing'],
              additionalProperties: false,
            },
          },
        },
        required: ['target', 'channel', 'keyframes'],
        additionalProperties: false,
      },
    },
  };
  const required = ['name', 'duration', 'tracks'];

  // "gains an optional clipName" (A1 spec): optional relative to the BASE schema — it
  // only exists at all on Create-new requests, added on top of everything above — but
  // required WITHIN that variant, matching this file's existing strict-schema convention
  // (every schema below marks every property it declares as required; "optionality" for
  // fields that can genuinely be absent is expressed with a nullable type instead, e.g.
  // "parent"/"tip" on addBones). A create-mode response always needs a name to propose.
  if (opts.withClipName) {
    properties.clipName = {
      type: 'string',
      description:
        'A short, fitting name for this NEW clip (e.g. "wave", "idle_breathing") — will ' +
        "be sanitized and de-duplicated against the rig's existing clip names before use.",
    };
    required.push('clipName');
  }

  if (opts.withRig) {
    properties.rig = {
      type: 'object',
      description:
        'Structural rig edits, applied before the clip. Use empty arrays when the ' +
        'motion needs no structural change.',
      properties: {
        addBones: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'New unique snake_case name' },
              pivot: {
                type: 'object',
                description: "The bone's origin (joint).",
                properties: { x: { type: 'number' }, y: { type: 'number' } },
                required: ['x', 'y'],
                additionalProperties: false,
              },
              parent: {
                type: ['string', 'null'],
                description: 'Existing part label, an earlier new bone, or null',
              },
              tip: {
                type: ['object', 'null'],
                description:
                  "The bone's far end, same coordinate space as pivot. Gives the bone a " +
                  'visible length and lets it form a segment for auto-binding — set this ' +
                  'whenever bindParts is used.',
                properties: { x: { type: 'number' }, y: { type: 'number' } },
                required: ['x', 'y'],
                additionalProperties: false,
              },
              bindParts: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Art part labels to auto-bind (skin) to this bone and every bone it chains ' +
                  'with (bones parented to bones, or parenting later bones to this one). Only ' +
                  'existing ART parts with drawable geometry — never bone/group labels. Empty ' +
                  'array when this bone is a plain joint with nothing bound to it.',
              },
            },
            required: ['label', 'pivot', 'parent'],
            additionalProperties: false,
          },
        },
        reparent: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part: { type: 'string' },
              parent: { type: ['string', 'null'] },
            },
            required: ['part', 'parent'],
            additionalProperties: false,
          },
        },
        movePivots: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              part: { type: 'string' },
              x: { type: 'number' },
              y: { type: 'number' },
            },
            required: ['part', 'x', 'y'],
            additionalProperties: false,
          },
        },
      },
      required: ['addBones', 'reparent', 'movePivots'],
      additionalProperties: false,
    };
    required.push('rig');
  }

  return { type: 'object', properties, required, additionalProperties: false };
}

const RIG_EDIT_NOTES = `
Structural edits (the user has enabled them): alongside the clip you may return "rig"
changes — addBones creates JOINTS (a bone is a pivot other parts can parent to or that
can auto-bind artwork — see below), reparent attaches parts to bones or other parts
(children then ride the parent's motion), movePivots relocates a joint. Use them
sparingly and only when the requested motion genuinely needs articulation the current
rig lacks. New bone labels must be unique snake_case; keyframe tracks may target them.
Bones may parent to bones added earlier in the same list, forming a CHAIN (e.g. a
shoulder→elbow→wrist arm).

Bones and binding (mirrors the editor's "Bones 2.0" system): give a bone both "pivot"
(its origin/joint) and "tip" (its far end, same coordinate space as pivot) to make it a
real segment, not just a bare joint. When a chain of bones (via "parent") overlaps a
piece of existing artwork, that artwork can be BOUND to the chain — this deforms the
artwork so it bends smoothly at each joint (like a real limb), which is how you split a
single rigid shape into an articulated one WITHOUT the user hand-drawing separate parts.
List the art part labels to bind on "bindParts" (only on the bones that should carry
that binding — binding a chain member binds the whole chain it belongs to). Only use
bindParts on existing ART parts that already have drawable geometry (never bone/group
labels), and only when the motion genuinely needs the limb to bend, not just pivot as a
whole (e.g. a wave that only needs the whole forearm to swing needs no binding — parent
a wrist bone to the arm and key rotation; a wave that needs the forearm ITSELF to bend
along its length needs bindParts on the bone chain running through it). A bone with no
bindParts is a plain joint, as before.`;

const RIG_SEMANTICS = `The rig is an SVG-space skeleton. Coordinate system: x grows right, y grows DOWN.
Rotations are in degrees, POSITIVE = CLOCKWISE on screen, and each part rotates around
its own pivot (its joint — e.g. an arm's pivot is the shoulder). Channels per part:
- rotate: degrees, ABSOLUTE
- tx / ty: translation in document units, ABSOLUTE (+y is down, so a jump is NEGATIVE ty)
- sx / sy: per-part scale factors, ABSOLUTE and CONTINUOUS (rest 1 = unscaled). Scales the
  part around its OWN pivot, along its own axes, and does NOT propagate to children — use it
  to squash/stretch or grow/shrink a single part (e.g. blinking eyes flattening sy toward 0,
  a breathing chest, a bouncing ball's contact squash). Volume-preserving squash pairs sx and
  sy inversely. A part with no sx/sy track stays at its rest scale.
- z: draw-order OFFSET (stacking rank), ABSOLUTE and STEPPED — easing is IGNORED, the part
  jumps to the new rank exactly at the keyframe (no blending between ranks). 0 = the
  authored stacking; a POSITIVE z lifts the part toward the viewer (draws in front of parts
  at lower z), NEGATIVE pushes it behind. Use small integer-ish values. This is the tool for
  reach-behind / pass-in-front moves: a hand that must swing BEHIND the torso then return in
  FRONT keys z negative while behind and positive while in front; a part that never changes
  its stacking needs no z track at all (omit it — 0 is the default).
- opacity: 0 (fully transparent) to 1 (fully opaque), ABSOLUTE and CONTINUOUS — it eases
  normally like rotate/tx/ty (unlike z, it blends smoothly between keys). Use it for
  fade-in entrances, fade-out exits, or a part that should flicker/dissolve. A part with no
  opacity track stays at its rest opacity (given as "rest" in the rig JSON — usually 1).
Keyframed values are ABSOLUTE channel values, not offsets. A channel with NO keyframes
holds the part's rest value (given as "rest" in the rig JSON) — so to move a part
relative to how it currently stands, start your keyframes from its rest value; to keep
a part still, simply omit its tracks.
Some parts have a parent: their channels are RELATIVE to the parent's motion (rotating
a parent carries every descendant with it — like a forearm riding an upper arm), so do
not counter-animate children to compensate for parent motion.
Whole-figure motion (a jump, squash-and-stretch, a big pose shift) targets a GROUP part
that covers the figure, exactly like any other part — its own pivot, its own rotate/tx/
ty/sx/sy, propagating to every descendant through the normal parent chain. See the
targeting rule below for which group to pick and why 'root' is off-limits.
Easing is stored on the keyframe a segment ARRIVES at: linear, easeIn (accelerate),
easeOut (decelerate), easeInOut.`;

/**
 * Hard targeting rule (AI Animate System v2 A0 — "root demotion"). Root used to move the
 * whole figure by carrying along every part with no track of its own — including a
 * shadow or a prop that was never meant to move (the "shadow follows the figure" bug).
 * Whole-figure motion now targets a GROUP part instead, which only carries its own
 * descendants, so anything deliberately outside it stays put by construction.
 */
export const TARGETING_RULES = `Targeting rule — read carefully: NEVER set a track's "target" to
"root". Instead:
- For whole-figure motion (a jump, a walk, a big pose shift, squash-and-stretch), target
  the GROUP part representing the figure: prefer the user's current SELECTION (given in
  the scene JSON below) if it is a group covering the parts that should move; otherwise
  pick the group in the part TREE (also given below, with nesting and kinds) that
  contains exactly the parts the motion should carry.
- For a single limb or part's motion, target that part directly by its label.
- Parts deliberately outside the chosen group — a shadow, a prop, background scenery —
  must receive NO tracks from a whole-figure move; that is the reason to target a group
  instead of root in the first place.
- The scene JSON's "currentClip" may already contain a track targeting "root" from an
  older version of this clip — leave it exactly as-is (this app still renders and
  exports it), but never add a NEW "root" track yourself.
- Use the SELECTION and TREE to resolve vague references in the user's direction ("him",
  "the figure", "the arm", "it") to actual part labels.`;

/**
 * General statement of the A1 request contract — the CONCRETE numbers (which mode, the
 * pinned duration, any protected keyframes) are per-request values, so they travel in the
 * user message (see `buildRequestNotes`) rather than here; this paragraph just tells the
 * model the rules exist and that they're enforced regardless of compliance.
 */
const REQUEST_MODES_NOTE = `Each request states its MODE — "create a new clip" (the current
clip is reference context only, not modified) or "modify the current clip in place" — a
PINNED duration your keyframe times must stay within (out-of-range times are clamped, the
clip is never stretched), and sometimes a list of PROTECTED keyframes that must not change.
Follow those per-request instructions exactly; the app also enforces them afterward
regardless of what you return.`;

export const SYSTEM = `You are the animation assistant inside Rig Studio, a 2D cutout-rig editor.

${RIG_SEMANTICS}

${TARGETING_RULES}

${REQUEST_MODES_NOTE}

Craft notes: use anticipation and follow-through; overlap limb timing slightly; ease
in/out by default and linear only for mechanical motion; loop cleanly (first and last
keyframe of every track should match unless asked otherwise); keep times multiples of
10 ms. Angles beyond ±180° are allowed for wind-ups.

You receive the rig description (including the current SELECTION and the part TREE) and
the current clip as JSON (and possibly a rendered image of the current pose), plus the
user's direction. Return the COMPLETE updated clip (all tracks, not a diff). Keep
existing motion that the user didn't ask to change unless it conflicts with the request.`;

const CRITIQUE_SYSTEM = `You are an animation director reviewing a clip made in Rig Studio,
a 2D cutout-rig editor.

${RIG_SEMANTICS}

${TARGETING_RULES}

Critique the clip like a seasoned animator doing dailies: arcs, timing and spacing,
anticipation, follow-through and overlap, silhouette readability, weight, looping
cleanliness. Point at concrete tracks/keyframe times when something is off and suggest
specific fixes (times in ms, values in degrees/units). Be direct and useful, not
flattering. Keep it under ~300 words.`;

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } };

/**
 * One rendered frame of a clip (AI Animate System v2 A3 "filmstrip vision") — structurally
 * identical to `ui/snapshot.ts`'s `FilmstripFrame`, duplicated here rather than imported
 * since `ai/` is a leaf module that doesn't depend on `ui/` (see the architecture table's
 * folder layering). `dataUrl` is a full `data:image/png;base64,...` string, same shape
 * `rasterizeSvg` produces — `frameBlocks` below strips the prefix.
 */
export interface FilmstripFrame {
  timeMs: number;
  dataUrl: string;
}

/**
 * Payload budget: filmstrip frames are capped at MAX_FILMSTRIP_FRAMES (mirrors
 * `ui/snapshot.ts`'s `FILMSTRIP_MAX_FRAMES` — that module already caps what it returns,
 * this is a defensive second cap in case a caller ever passes more), each already
 * downscaled by the renderer to at most 320px on the long edge. A simple flat-color
 * vector rasterizes to roughly 5-30KB of PNG; six such frames base64-encode to well
 * under 300KB of request body — far inside Anthropic's per-image (~5MB) and
 * per-request payload limits, so the filmstrip is not a meaningful cost/latency concern
 * even at the cap.
 */
const MAX_FILMSTRIP_FRAMES = 6;

const FILMSTRIP_INTRO =
  'You are seeing RENDERED FRAMES of the CURRENT animation (not a target to match — ' +
  "this is what the clip actually looks like right now), sampled across its duration. " +
  'Critique or modify based on what you actually SEE: motion arcs, held poses, ' +
  'clipping/overlap, dead time between poses — not just the raw keyframe numbers below.';

/** Text+image block pairs for a filmstrip: one intro line, then one "frame at Xms of
 *  Yms" text block immediately followed by its image per frame, in time order — replaces
 *  the single pose-snapshot block when frames are provided (see `userContent`). Exported
 *  (alongside `userContent`) purely so the unit suite can assert on request payload
 *  shape without a live API call — no other caller needs it directly. */
export function frameBlocks(frames: FilmstripFrame[], totalDurationMs: number): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: FILMSTRIP_INTRO }];
  for (const f of frames.slice(0, MAX_FILMSTRIP_FRAMES)) {
    blocks.push({ type: 'text', text: `Frame at ${f.timeMs}ms of ${totalDurationMs}ms:` });
    const comma = f.dataUrl.indexOf(',');
    const base64 = comma >= 0 ? f.dataUrl.slice(comma + 1) : f.dataUrl;
    blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } });
  }
  return blocks;
}

/**
 * The part hierarchy as an indented tree ("label (kind)" per line, two spaces per depth
 * level, DFS in doc.parts order) — makes group/nesting structure obvious to the model
 * (a flat parts array with parent-by-label already existed, but reading nesting back out
 * of it requires following pointers; the AI Animate System v2 A0 "targeting" fix wants
 * this legible without that step, so 'him'/'the figure'/'the arm' resolve sensibly and a
 * whole-figure move can target the right GROUP). `visited` guards against a corrupted
 * doc with a parent cycle (setParent()/normalizeDoc keep real docs cycle-free, but this
 * function must never hang on bad input it's merely reporting on).
 */
function partTree(doc: RigDoc): string {
  const byParent = new Map<string | null, RigPart[]>();
  for (const p of doc.parts) {
    const list = byParent.get(p.parentId);
    if (list) list.push(p);
    else byParent.set(p.parentId, [p]);
  }
  const lines: string[] = [];
  const visited = new Set<string>();
  const visit = (parentId: string | null, depth: number) => {
    for (const p of byParent.get(parentId) ?? []) {
      if (visited.has(p.id)) continue;
      visited.add(p.id);
      lines.push(`${'  '.repeat(depth)}${p.label} (${p.kind})`);
      visit(p.id, depth + 1);
    }
  };
  visit(null, 0);
  return lines.join('\n');
}

/**
 * The request payload shape sent to Claude, factored out so it's testable without a live
 * API call (no network, no Anthropic client): a pure function of (doc, clip, selection).
 * `sceneJson` below is the only caller in production — it just stringifies this.
 */
export function buildScenePayload(doc: RigDoc, clip: Clip, selectedPartIds: string[] = []) {
  const labelOf = (id: string) => doc.parts.find((p) => p.id === id)?.label ?? id;
  return {
    viewBox: doc.viewBox,
    rootPivot: doc.rootPivot,
    // Nesting structure with kinds (see partTree's doc comment) plus the flat parts list
    // below (which every field like pivot/rest/bakedTransform still needs a flat scan
    // for) — deliberately redundant so the model gets hierarchy for free either way.
    tree: partTree(doc),
    selection: selectedPartIds
      .map((id) => doc.parts.find((p) => p.id === id))
      .filter((p): p is RigPart => !!p)
      .map((p) => ({ id: p.id, label: p.label })),
    parts: doc.parts.map((p) => ({
      label: p.label,
      kind: p.kind, // 'art' draws; 'bone'/'group' are partless transform joints
      pivot: p.pivot,
      parent: p.parentId ? labelOf(p.parentId) : null,
      rest: p.rest,
      bakedTransform: p.transform || 'none',
    })),
    currentClip: {
      name: clip.name,
      duration: clip.duration,
      tracks: clip.tracks.map((t) => ({
        target: t.target === 'root' ? 'root' : labelOf(t.target),
        channel: t.channel,
        keyframes: t.keyframes,
      })),
    },
  };
}

function sceneJson(doc: RigDoc, clip: Clip, selectedPartIds: string[]): string {
  return JSON.stringify(buildScenePayload(doc, clip, selectedPartIds), null, 2);
}

/** Visual grounding for a request: EITHER a filmstrip (preferred whenever frames were
 *  successfully rendered — see the two call sites below) OR the older single pose
 *  snapshot as a fallback, never both (frames REPLACE the snapshot when present, per
 *  the A3 spec). */
export interface VisualAttachment {
  imageBase64?: string | null;
  frames?: FilmstripFrame[];
  /** Required alongside `frames` (the "of Yms" half of each frame's caption); ignored
   *  otherwise. */
  totalDurationMs?: number;
}

/** Assembles a request's full user-message content: visual grounding blocks (a
 *  filmstrip, a single snapshot, or neither — see `VisualAttachment`) followed by the
 *  scene JSON + per-request instructions. Exported for the unit suite (see
 *  `frameBlocks`'s doc comment); not itself a network call. */
export function userContent(scene: string, tail: string, visuals: VisualAttachment = {}): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (visuals.frames && visuals.frames.length > 0) {
    blocks.push(...frameBlocks(visuals.frames, visuals.totalDurationMs ?? 0));
  } else if (visuals.imageBase64) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: visuals.imageBase64 },
    });
    blocks.push({ type: 'text', text: 'Rendered snapshot of the current pose above.' });
  }
  blocks.push({ type: 'text', text: `Rig and current clip:\n${scene}\n\n${tail}` });
  return blocks;
}

/** A protected keyframe as told to the model — by part LABEL (the scene JSON's frame of
 *  reference), not id; see `core/model.ts`'s `ProtectedKey` for the id-keyed doc-side form
 *  the panel actually enforces against after the response comes back. */
export interface PromptProtectedKey {
  target: string;
  channel: Channel;
  time: number;
  value: number;
}

/**
 * Per-request instructions that vary by call (unlike the static SYSTEM prompt, which only
 * states that these rules exist — see `REQUEST_MODES_NOTE`): which mode this is, the
 * pinned duration, any protected keyframes, and the user's direction. Exported for the
 * unit suite's inspection; not itself a network call.
 */
export function buildRequestNotes(
  mode: 'new' | 'modify',
  pinnedDuration: number,
  protectedKeys: PromptProtectedKey[] | undefined,
  instruction: string,
): string {
  const lines: string[] = [];
  lines.push(
    mode === 'new'
      ? 'Mode: CREATE A NEW CLIP for this direction. The "currentClip" below is REFERENCE ' +
        'CONTEXT ONLY (composition, timing, and part usage you may draw on) — this request ' +
        'does not modify it and you are not obligated to reuse its tracks. Propose a short, ' +
        'fitting "clipName" for the new clip.'
      : 'Mode: MODIFY THE CURRENT CLIP in place. Return the COMPLETE updated clip (every ' +
        'track, not a diff); keep existing motion the user did not ask to change.',
  );
  lines.push(
    `Duration is PINNED at ${pinnedDuration}ms for this clip: every keyframe "time" must ` +
      `fall within 0..${pinnedDuration}. Do not stretch or shrink the overall length — out-` +
      'of-range times will be clamped, not honored.',
  );
  if (protectedKeys && protectedKeys.length > 0) {
    lines.push(
      'The following keyframes are PROTECTED (locked by the user) and must be left EXACTLY ' +
        'as given if you touch that track at all — do not move, re-value, or remove them:\n' +
        protectedKeys.map((k) => `- ${k.target}.${k.channel} @ ${k.time}ms = ${k.value}`).join('\n'),
    );
  }
  lines.push(`Direction: ${instruction}`);
  return lines.join('\n\n');
}

/**
 * AI Animate System v2 A1 "duration pinned" rule: the response's own "duration" field is
 * NEVER trusted to resize the clip (no stretching) — every keyframe time is clamped into
 * `[0, duration]` instead, and the output's duration is forced to the pinned value. Pure
 * and exported so it's unit-testable without a network call.
 */
export function clampRawClip(raw: RawClip, duration: number): { clip: RawClip; clampedCount: number } {
  let clampedCount = 0;
  const tracks = raw.tracks.map((t) => ({
    ...t,
    keyframes: [...t.keyframes]
      .map((k) => {
        const time = Math.min(duration, Math.max(0, k.time));
        if (time !== k.time) clampedCount++;
        return { ...k, time };
      })
      .sort((a, b) => a.time - b.time),
  }));
  return { clip: { ...raw, duration, tracks }, clampedCount };
}

export interface AnimateCallOptions {
  imageBase64?: string | null;
  /** A3 filmstrip: replaces `imageBase64` when non-empty (see `userContent`). For mode
   *  'modify' this is the ACTIVE clip's own filmstrip (what's about to be edited); for
   *  'new' it's the active clip's filmstrip as reference context; on an A2 Retry with a
   *  preview active, the caller (panels/ai.ts) renders this from the CANDIDATE instead,
   *  so refinement reacts to what the model actually produced. */
  frames?: FilmstripFrame[];
  /** Opt-in structural rig edits (bones/reparenting/pivots) — same toggle as before,
   *  now shared by both Create-new and Modify requests. */
  allowRigChanges?: boolean;
  /** 'new' asks for a brand-new clip (the passed-in `clip` is reference context only,
   *  never mutated by the caller); 'modify' edits that clip's semantics in place. */
  mode: 'new' | 'modify';
  /** "Protect playhead keys" (mode 'modify' + the panel's checkbox) — listed in the
   *  prompt as untouchable. Real enforcement is app-side (model.ts's
   *  `enforceProtectedKeys`) since a model can still ignore this. */
  protectedKeys?: PromptProtectedKey[];
  signal?: AbortSignal;
}

export async function animateWithClaude(
  apiKey: string,
  doc: RigDoc,
  clip: Clip,
  instruction: string,
  selectedPartIds: string[],
  opts: AnimateCallOptions,
): Promise<AnimateResult> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  // The pinned duration is always the REFERENCE clip's current duration — for 'modify'
  // that's the target clip itself (no stretching); for 'new' there's no duration picker
  // yet (out of A1's scope), so a fresh clip simply matches the clip it was asked
  // alongside, which is also the most useful default for the user watching it play.
  const pinnedDuration = clip.duration;
  const allowRigChanges = !!opts.allowRigChanges;

  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: {
        format: {
          type: 'json_schema',
          schema: buildClipSchema({ withRig: allowRigChanges, withClipName: opts.mode === 'new' }),
        },
      },
      system: allowRigChanges ? SYSTEM + RIG_EDIT_NOTES : SYSTEM,
      messages: [
        {
          role: 'user',
          content: userContent(
            sceneJson(doc, clip, selectedPartIds),
            buildRequestNotes(opts.mode, pinnedDuration, opts.protectedKeys, instruction),
            { imageBase64: opts.imageBase64, frames: opts.frames, totalDurationMs: pinnedDuration },
          ),
        },
      ],
    },
    { signal: opts.signal },
  );

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined this request.');
  }
  const text = response.content.find(
    (b): b is Extract<(typeof response.content)[number], { type: 'text' }> => b.type === 'text',
  )?.text;
  if (!text) throw new Error('No response content.');

  const raw = JSON.parse(text) as RawClip & { rig?: RigChanges };
  const { clip: clamped, clampedCount } = clampRawClip(raw, pinnedDuration);
  // Track targets stay LABELS here — the caller applies rig changes first (new bones
  // don't have ids until then), then resolves targets against the updated doc.
  return { clip: clamped, rig: allowRigChanges ? (raw.rig ?? null) : null, clampedCount };
}

export interface CritiqueCallOptions {
  imageBase64?: string | null;
  /** A3 filmstrip of the clip being critiqued — replaces `imageBase64` when non-empty
   *  (see `userContent`). Critique has no candidate/preview concept, so this is always
   *  the DOC's active clip. */
  frames?: FilmstripFrame[];
  signal?: AbortSignal;
}

/** Plain-text animation review of the active clip. */
export async function critiqueWithClaude(
  apiKey: string,
  doc: RigDoc,
  clip: Clip,
  selectedPartIds: string[],
  opts: CritiqueCallOptions = {},
): Promise<string> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 2000,
      system: CRITIQUE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: userContent(
            sceneJson(doc, clip, selectedPartIds),
            'Critique this clip. What works, what reads poorly, and what specific keyframe changes would improve it?',
            { imageBase64: opts.imageBase64, frames: opts.frames, totalDurationMs: clip.duration },
          ),
        },
      ],
    },
    { signal: opts.signal },
  );

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined this request.');
  }
  const text = response.content
    .filter((b): b is Extract<(typeof response.content)[number], { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (!text) throw new Error('No response content.');
  return text;
}

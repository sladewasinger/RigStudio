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
import { Clip, Keyframe, RigChanges, RigDoc } from '../core/model';

const MODEL = 'claude-opus-4-8';

/** A clip as the AI returns it: track targets are part LABELS, not ids. */
export interface RawClip {
  name: string;
  duration: number;
  tracks: { target: string; channel: string; keyframes: Keyframe[] }[];
}

export interface AnimateResult {
  clip: RawClip;
  /** Structural edits (only when the user opted in), or null. */
  rig: RigChanges | null;
}

const CLIP_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    duration: { type: 'integer', description: 'Clip length in milliseconds' },
    tracks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: "A part label from the rig, or 'root' for the whole figure",
          },
          channel: { type: 'string', enum: ['rotate', 'tx', 'ty', 'sx', 'sy', 'z'] },
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
  },
  required: ['name', 'duration', 'tracks'],
  additionalProperties: false,
} as const;

/** CLIP_SCHEMA plus opt-in structural rig edits (bones, reparenting, pivots). */
const CLIP_WITH_RIG_SCHEMA = {
  type: 'object',
  properties: {
    ...CLIP_SCHEMA.properties,
    rig: {
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
    },
  },
  required: ['name', 'duration', 'tracks', 'rig'],
  additionalProperties: false,
} as const;

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
- z: draw-order OFFSET (stacking rank), ABSOLUTE and STEPPED — easing is IGNORED, the part
  jumps to the new rank exactly at the keyframe (no blending between ranks). 0 = the
  authored stacking; a POSITIVE z lifts the part toward the viewer (draws in front of parts
  at lower z), NEGATIVE pushes it behind. Use small integer-ish values. This is the tool for
  reach-behind / pass-in-front moves: a hand that must swing BEHIND the torso then return in
  FRONT keys z negative while behind and positive while in front; a part that never changes
  its stacking needs no z track at all (omit it — 0 is the default).
Keyframed values are ABSOLUTE channel values, not offsets. A channel with NO keyframes
holds the part's rest value (given as "rest" in the rig JSON) — so to move a part
relative to how it currently stands, start your keyframes from its rest value; to keep
a part still, simply omit its tracks.
Some parts have a parent: their channels are RELATIVE to the parent's motion (rotating
a parent carries every descendant with it — like a forearm riding an upper arm), so do
not counter-animate children to compensate for parent motion.
The special target 'root' moves the whole figure and also supports sx/sy scale around
the figure's ground pivot — use root.ty for jumps and root.sx/sy for squash-and-stretch
(volume preserving: when sy < 1, push sx > 1, and vice versa).
Easing is stored on the keyframe a segment ARRIVES at: linear, easeIn (accelerate),
easeOut (decelerate), easeInOut.`;

const SYSTEM = `You are the animation assistant inside Rig Studio, a 2D cutout-rig editor.

${RIG_SEMANTICS}

Craft notes: use anticipation and follow-through; overlap limb timing slightly; ease
in/out by default and linear only for mechanical motion; loop cleanly (first and last
keyframe of every track should match unless asked otherwise); keep times multiples of
10 ms. Angles beyond ±180° are allowed for wind-ups.

You receive the rig description and the current clip as JSON (and possibly a rendered
image of the current pose), plus the user's direction. Return the COMPLETE updated clip
(all tracks, not a diff). Keep existing motion that the user didn't ask to change unless
it conflicts with the request.`;

const CRITIQUE_SYSTEM = `You are an animation director reviewing a clip made in Rig Studio,
a 2D cutout-rig editor.

${RIG_SEMANTICS}

Critique the clip like a seasoned animator doing dailies: arcs, timing and spacing,
anticipation, follow-through and overlap, silhouette readability, weight, looping
cleanliness. Point at concrete tracks/keyframe times when something is off and suggest
specific fixes (times in ms, values in degrees/units). Be direct and useful, not
flattering. Keep it under ~300 words.`;

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } };

function sceneJson(doc: RigDoc, clip: Clip): string {
  const labelOf = (id: string) => doc.parts.find((p) => p.id === id)?.label ?? id;
  return JSON.stringify(
    {
      viewBox: doc.viewBox,
      rootPivot: doc.rootPivot,
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
    },
    null,
    2,
  );
}

function userContent(scene: string, tail: string, imageBase64?: string | null): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (imageBase64) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
    });
    blocks.push({ type: 'text', text: 'Rendered snapshot of the current pose above.' });
  }
  blocks.push({ type: 'text', text: `Rig and current clip:\n${scene}\n\n${tail}` });
  return blocks;
}

export async function animateWithClaude(
  apiKey: string,
  doc: RigDoc,
  clip: Clip,
  instruction: string,
  imageBase64?: string | null,
  allowRigChanges = false,
  signal?: AbortSignal,
): Promise<AnimateResult> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: {
        format: {
          type: 'json_schema',
          schema: allowRigChanges ? CLIP_WITH_RIG_SCHEMA : CLIP_SCHEMA,
        },
      },
      system: allowRigChanges ? SYSTEM + RIG_EDIT_NOTES : SYSTEM,
      messages: [
        {
          role: 'user',
          content: userContent(sceneJson(doc, clip), `Direction: ${instruction}`, imageBase64),
        },
      ],
    },
    { signal },
  );

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined this request.');
  }
  const text = response.content.find(
    (b): b is Extract<(typeof response.content)[number], { type: 'text' }> => b.type === 'text',
  )?.text;
  if (!text) throw new Error('No response content.');

  const raw = JSON.parse(text) as RawClip & { rig?: RigChanges };
  const clipOut: RawClip = {
    name: raw.name || clip.name,
    duration: raw.duration,
    tracks: raw.tracks.map((t) => ({
      ...t,
      keyframes: [...t.keyframes].sort((a, b) => a.time - b.time),
    })),
  };
  // Track targets stay LABELS here — the caller applies rig changes first (new bones
  // don't have ids until then), then resolves targets against the updated doc.
  return { clip: clipOut, rig: allowRigChanges ? (raw.rig ?? null) : null };
}

/** Plain-text animation review of the active clip. */
export async function critiqueWithClaude(
  apiKey: string,
  doc: RigDoc,
  clip: Clip,
  imageBase64?: string | null,
  signal?: AbortSignal,
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
            sceneJson(doc, clip),
            'Critique this clip. What works, what reads poorly, and what specific keyframe changes would improve it?',
            imageBase64,
          ),
        },
      ],
    },
    { signal },
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

/**
 * The AI animation assistant. Sends the current rig (part names, pivots, canvas
 * coordinate frame) plus the active clip to Claude and asks for an updated clip that
 * realizes the user's direction ("wave the right arm", "bend at the knees").
 *
 * Structured outputs (output_config.format with a JSON schema) guarantee the reply is a
 * valid Clip, so applying it is a straight JSON.parse.
 */

import Anthropic from '@anthropic-ai/sdk';
import { Clip, RigDoc } from './model';

const MODEL = 'claude-opus-4-8';

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
          channel: { type: 'string', enum: ['rotate', 'tx', 'ty', 'sx', 'sy'] },
          keyframes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                time: { type: 'integer' },
                value: { type: 'number' },
                easing: { type: 'string', enum: ['linear', 'easeInOut'] },
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

const SYSTEM = `You are the animation assistant inside Rig Studio, a 2D cutout-rig editor.

The rig is an SVG-space skeleton. Coordinate system: x grows right, y grows DOWN.
Rotations are in degrees, POSITIVE = CLOCKWISE on screen, and each part rotates around
its own pivot (its joint — e.g. an arm's pivot is the shoulder). Channels per part:
- rotate: degrees added to the part's rest pose
- tx / ty: translation in document units (remember +y is down, so a jump is NEGATIVE ty)
The special target 'root' moves the whole figure and also supports sx/sy scale around
the figure's ground pivot — use root.ty for jumps and root.sx/sy for squash-and-stretch
(volume preserving: when sy < 1, push sx > 1, and vice versa).

Craft notes: use anticipation and follow-through; overlap limb timing slightly; ease
in/out by default and linear only for mechanical motion; loop cleanly (first and last
keyframe of every track should match unless asked otherwise); keep times multiples of
10 ms. Angles beyond ±180° are allowed for wind-ups.

You receive the rig description and the current clip as JSON, plus the user's direction.
Return the COMPLETE updated clip (all tracks, not a diff). Keep existing motion that the
user didn't ask to change unless it conflicts with the request.`;

export async function animateWithClaude(
  apiKey: string,
  doc: RigDoc,
  clip: Clip,
  instruction: string,
): Promise<Clip> {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const scene = {
    viewBox: doc.viewBox,
    rootPivot: doc.rootPivot,
    parts: doc.parts.map((p) => ({
      label: p.label,
      pivot: p.pivot,
      restTransform: p.transform || 'none',
    })),
    currentClip: {
      name: clip.name,
      duration: clip.duration,
      tracks: clip.tracks.map((t) => ({
        target: t.target === 'root' ? 'root' : doc.parts.find((p) => p.id === t.target)?.label,
        channel: t.channel,
        keyframes: t.keyframes,
      })),
    },
  };

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: CLIP_SCHEMA } },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `Rig and current clip:\n${JSON.stringify(scene, null, 2)}\n\n` +
          `Direction: ${instruction}`,
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined this request.');
  }
  const text = response.content.find(
    (b): b is Extract<(typeof response.content)[number], { type: 'text' }> => b.type === 'text',
  )?.text;
  if (!text) throw new Error('No response content.');

  const raw = JSON.parse(text) as {
    name: string;
    duration: number;
    tracks: { target: string; channel: string; keyframes: Clip['tracks'][number]['keyframes'] }[];
  };

  // Map part labels back to ids; drop tracks aimed at unknown parts.
  const tracks: Clip['tracks'] = [];
  for (const t of raw.tracks) {
    const target =
      t.target === 'root' ? 'root' : doc.parts.find((p) => p.label === t.target)?.id;
    if (!target) continue;
    tracks.push({
      target,
      channel: t.channel as Clip['tracks'][number]['channel'],
      keyframes: [...t.keyframes].sort((a, b) => a.time - b.time),
    });
  }
  return { name: raw.name || clip.name, duration: raw.duration, tracks };
}

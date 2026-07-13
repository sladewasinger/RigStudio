/**
 * Shared zod parameter shapes for the MCP tools (`createServer.ts`'s `registerTool`
 * calls). `ClipInputSchema` mirrors `ai/claude.ts`'s `RawClip` — the SAME structured clip
 * shape the in-app AI assistant's `buildClipSchema` describes to Claude (ROADMAP H2: "one
 * schema, two front doors") — and `RigChangesSchema` mirrors `core/model`'s `RigChanges`
 * (`structuralOps.ts`). Kept as zod (not the JSON-schema `buildClipSchema` builder) since
 * the MCP SDK's `registerTool` takes a zod raw shape per tool, not a JSON-schema object.
 */
import { z } from 'zod';

export const SessionParam = z.string().min(1).optional()
  .describe('Named in-memory doc session (default "default"); reuse the same name across calls to keep editing one doc.');

const Vec2Schema = z.object({ x: z.number(), y: z.number() });

const EasingSchema = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut']);

const KeyframeSchema = z.object({
  time: z.number().describe('ms'),
  value: z.number(),
  easing: EasingSchema,
  bezier: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().optional()
    .describe('Custom cubic-bezier for the arriving segment; overrides `easing` when present.'),
});

const ChannelSchema = z.enum(['rotate', 'tx', 'ty', 'sx', 'sy', 'z', 'opacity']);

const TrackSchema = z.object({
  target: z.string().describe('A part label (or "root", legacy) — never a new/unresolved label.'),
  channel: ChannelSchema,
  keyframes: z.array(KeyframeSchema),
});

export const RigChangesSchema = z.object({
  addBones: z.array(z.object({
    label: z.string(),
    pivot: Vec2Schema,
    parent: z.string().nullable(),
    tip: Vec2Schema.nullable().optional(),
    bindParts: z.array(z.string()).optional()
      .describe('Existing art-part labels to bind (skin) to this bone\'s whole chain. EXPLICIT labels only — no geometric auto-bind headlessly.'),
  })).default([]),
  reparent: z.array(z.object({ part: z.string(), parent: z.string().nullable() })).default([]),
  movePivots: z.array(z.object({ part: z.string(), x: z.number(), y: z.number() })).default([]),
}).describe('Structural rig edits, applied before the clip (mirrors the in-app AI assistant\'s opt-in "rig" schema).');

export const ClipInputSchema = z.object({
  name: z.string(),
  duration: z.number().int().nonnegative().describe('ms; every keyframe time is clamped into [0, duration].'),
  clipName: z.string().optional().describe('Name for a brand-new clip (mode "new" only) — sanitized/deduped against existing clip names.'),
  tracks: z.array(TrackSchema),
  rig: RigChangesSchema.optional(),
});

export const ProtectedKeySchema = z.object({
  target: z.string(),
  channel: ChannelSchema,
  time: z.number(),
  value: z.number(),
  easing: EasingSchema,
  bezier: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable().optional(),
});

export const AddBoneInputSchema = z.object({
  label: z.string().optional().describe('Unique snake_case label; auto-generated ("bone_N") when omitted.'),
  x1: z.number().describe("The bone's origin (joint) x."),
  y1: z.number().describe("The bone's origin (joint) y."),
  x2: z.number().describe("The bone's tip x — gives it a visible length and a bindable segment."),
  y2: z.number().describe("The bone's tip y."),
  parentLabel: z.string().nullable().optional().describe('An existing part label, an earlier new bone in this same call, or null.'),
  bindParts: z.array(z.string()).optional()
    .describe('Existing art-part labels to bind to this bone\'s whole chain (explicit labels only).'),
});

export const SMInputSchema = z.object({
  name: z.string(),
  type: z.enum(['bool', 'number', 'trigger']),
  default: z.union([z.boolean(), z.number()]).optional(),
});

export const SMStateSchema = z.object({
  name: z.string(),
  clipName: z.string().optional().describe('The clip this state plays; a dangling name samples rest.'),
  x: z.number().optional(),
  y: z.number().optional(),
});

export const SMConditionSchema = z.object({
  inputName: z.string(),
  op: z.enum(['==', '!=', '<', '<=', '>', '>=']).optional(),
  value: z.union([z.boolean(), z.number()]).optional(),
});

export const SMTransitionSchema = z.object({
  from: z.string().describe('State name (or "Entry"/"Any"/"Exit").'),
  to: z.string(),
  durationMs: z.number().nonnegative().optional(),
  conditions: z.array(SMConditionSchema).optional(),
  exitFraction: z.number().min(0).max(1).nullable().optional(),
});

export const StateMachineInputSchema = z.object({
  name: z.string(),
  inputs: z.array(SMInputSchema).optional(),
  states: z.array(SMStateSchema).optional(),
  transitions: z.array(SMTransitionSchema).optional(),
});

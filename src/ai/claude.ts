/**
 * The AI animation assistant. Sends the current rig (part names, hierarchy, pivots,
 * rest pose, canvas coordinate frame) plus the active clip to Claude and asks for an
 * updated clip that realizes the user's direction ("wave the right arm", "bend at the
 * knees"), optionally grounded with a rendered snapshot of the current pose.
 *
 * Structured outputs (output_config.format with a JSON schema) guarantee the reply is a
 * valid Clip, so applying it is a straight JSON.parse. Critique mode is plain text.
 *
 * This module is the ORCHESTRATION half only — request payload assembly plus the two
 * SDK calls. The declarative half (every system-prompt constant and the response JSON
 * schema) lives in the `./prompts` leaf.
 */

import Anthropic from '@anthropic-ai/sdk';
import { boneChain, Channel, Clip, Keyframe, RigChanges, RigDoc, RigPart } from '../core/model';
import { buildClipSchema, CRITIQUE_SYSTEM, RIG_EDIT_NOTES, SYSTEM } from './prompts';

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
  /** How many keyframe times `clampRawClip` had to clamp into `[0, duration]`, PLUS the
   *  keyframes of any forbidden sx/sy-on-skinned-part tracks it dropped (the 2026-07-12
   *  skinned-pose ruling) — surfaced in the panel's status text so neither enforcement
   *  is silent. The panel's single "clamped N key times" note is the one reporting
   *  channel both counts share; splitting the message is a panels/-side follow-up. */
  clampedCount: number;
}

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
 * whole-figure move can target the right GROUP). Bones show here too, nested under the
 * limb their chain is parented to (hierarchy-as-assignment), so the model can see which
 * part each chain belongs to. `visited` guards against a corrupted doc with a parent
 * cycle (setParent()/normalizeDoc keep real docs cycle-free, but this function must
 * never hang on bad input it's merely reporting on).
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
 * A skinned part's controlling bone chain, root→leaf (the 2026-07-12 skinned-pose
 * ruling: these bones are the part's POSING HANDLES, and the scene payload must say
 * so). Resolved through `boneChain` from each `skin.bones` entry — NOT from
 * `skin.bones`'s own order, which is bind-time order and can lag a chain grown after
 * binding — then ordered by parent-link DFS from each chain root so "root first" holds
 * even if doc order was shuffled. Cycle-guarded like `partTree` (a corrupted doc
 * yields a short/empty list, never a hang).
 */
function controllingBones(doc: RigDoc, part: RigPart): { id: string; label: string }[] {
  const inChain = new Set<string>();
  for (const sb of part.skin?.bones ?? []) {
    for (const b of boneChain(doc.parts, sb.id)) inChain.add(b.id);
  }
  const members = doc.parts.filter((p) => inChain.has(p.id));
  const out: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  const visit = (b: RigPart): void => {
    if (seen.has(b.id)) return;
    seen.add(b.id);
    out.push({ id: b.id, label: b.label });
    for (const c of members) if (c.parentId === b.id) visit(c);
  };
  for (const m of members) if (!m.parentId || !inChain.has(m.parentId)) visit(m);
  return out;
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
      // Bones-awareness (2026-07-12 ruling): a skinned part advertises its posing
      // mechanism — the prompt's skinned-parts rules key off these two fields.
      ...(p.skin && p.skin.bones.length > 0
        ? { skinned: true, bones: controllingBones(doc, p) }
        : {}),
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
 * states that these rules exist — see `REQUEST_MODES_NOTE` in `./prompts`): which mode
 * this is, the pinned duration, any protected keyframes, and the user's direction.
 * Exported for the unit suite's inspection; not itself a network call.
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
 *
 * `skinnedLabels` (2026-07-12 skinned-pose ruling) additionally DROPS any sx/sy track
 * targeting a skinned part: part scale renders nothing on skinned geometry in the editor
 * (scale never propagates to children there) while Rive WOULD scale the node — a WYSIWYG
 * violation, so the track is removed outright. rotate/tx/ty on skinned parts are
 * legitimate whole-limb accents (the bones are parented under the part) and pass
 * through untouched, as do sx/sy tracks on unskinned parts and every bone track. Each
 * dropped keyframe counts toward `clampedCount` — the panel's existing clamp note is
 * the one surfacing channel (see `AnimateResult.clampedCount`).
 */
export function clampRawClip(
  raw: RawClip,
  duration: number,
  skinnedLabels: ReadonlySet<string> = new Set(),
): { clip: RawClip; clampedCount: number } {
  let clampedCount = 0;
  const tracks = raw.tracks
    .filter((t) => {
      const forbidden = (t.channel === 'sx' || t.channel === 'sy') && skinnedLabels.has(t.target);
      if (forbidden) clampedCount += t.keyframes.length;
      return !forbidden;
    })
    .map((t) => ({
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
  // Skinned parts by LABEL (the response's frame of reference) for the sx/sy drop rule.
  // Snapshot of the doc as sent — a rig-changes bind landing later this same request
  // can't be known here, and the prompt already forbids scaling anything skinned.
  const skinnedLabels = new Set(
    doc.parts.filter((p) => p.skin && p.skin.bones.length > 0).map((p) => p.label),
  );
  const { clip: clamped, clampedCount } = clampRawClip(raw, pinnedDuration, skinnedLabels);
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

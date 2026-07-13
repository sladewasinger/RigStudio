/**
 * AI Animate System v2 A6 "Polish": a one-click preset refinement turn on the ACTIVE
 * clip. Composes a rich, clip-analyzed animation-principles instruction and sends it
 * IMMEDIATELY through the existing Modify-current flow (`./requests.ts`'s `runAnimate`,
 * mode 'modify') — unlike A5's motion templates (`./templates.ts`), which FILL the
 * prompt box and wait for the user to click Create. One click is safe here precisely
 * because A2's preview-before-apply still gates it: nothing mutates the doc until
 * Apply, so Polish inherits protect-playhead-keys, duration pinning, the A5 RIG PROFILE
 * block, A3 filmstrips, and A4 thread recording for free — no parallel request path.
 *
 * The instruction goes where the prompt text would WITHOUT touching the prompt box:
 * `runAnimate` accepts an `instructionOverride` (this module is its only caller) and
 * `./requests.ts` mirrors it into `ai.polishInstruction` so `./panel.ts`'s `handleApply`
 * can record the RIGHT text as the thread turn and skip clearing the user's own,
 * completely unrelated, draft (see `./state.ts`'s doc comment for the field).
 *
 * `buildPolishInstruction` is a PURE function of (profile, clip) — no DOM, no rig-
 * specific literals (grepped by the unit suite, same pattern as `./templates.ts`'s
 * source guarantee). It analyzes the clip's own tracks rather than inventing generic
 * advice, so the model gets concrete, scale-relative candidates:
 *  - anticipation: per track, its single biggest consecutive-keyframe value jump, kept
 *    ONLY when there's real lead-in time before it (`ANTICIPATION_LEAD_MS`) — there's
 *    nothing before frame 0 to counter-move into.
 *  - follow-through: every bone chain from the rig profile, spelled by name exactly
 *    like A5's `followThroughNote` — a generic "let children lag" fallback when the
 *    rig has none.
 *  - settle-with-overshoot: the same big-jump candidates as arrival points (a curve/
 *    easing change needs no extra timeline room, unlike anticipation's new key).
 *  - squash-and-stretch: offered ONLY when some `ty` track moves a large fraction of
 *    its own value range within a short fraction of the clip's duration — both sides
 *    of the ratio are relative to the TRACK/CLIP themselves, never an absolute doc-unit
 *    speed, since that varies per rig.
 *  - loop-clean reminder: offered ONLY when every multi-key track's first and last
 *    keyframes currently match, so the model isn't told to honor a promise the clip
 *    never made.
 */
import { activeClip, Channel, Clip, state } from '../../core/model';
import { getRigProfile, RigProfile } from '../../ai/rigProfile';
import { AiRequestCtx, runAnimate } from './requests';
import { ai } from './state';

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Minimum lead-in time, ms, before a big move counts as having room for an
 *  anticipation counter-move ahead of it. */
const ANTICIPATION_LEAD_MS = 80;

/** A single track's biggest consecutive-keyframe jump — the anticipation/settle
 *  candidate pool, expressed in this clip's own values/times. */
interface BigMove {
  label: string;
  channel: Channel;
  fromMs: number;
  toMs: number;
  fromValue: number;
  toValue: number;
  delta: number;
}

function labelOf(profile: RigProfile, id: string): string {
  if (id === 'root') return 'root (whole-figure)';
  return profile.roles.find((r) => r.id === id)?.label ?? id;
}

/** Per track (with >=2 keyframes), the FIRST segment achieving its largest |Δvalue| —
 *  ties keep the earliest occurrence (deterministic). On a symmetric loop (0→40→0 has
 *  two equal deltas) that's the OUTBOUND move; if it starts inside ANTICIPATION_LEAD_MS
 *  the anticipation section simply skips the track — settle-with-overshoot still lists
 *  that move's arrival, so the track is never dropped outright. */
function biggestMoves(profile: RigProfile, clip: Clip): BigMove[] {
  const out: BigMove[] = [];
  for (const track of clip.tracks) {
    let best: BigMove | null = null;
    for (let i = 0; i < track.keyframes.length - 1; i++) {
      const a = track.keyframes[i];
      const b = track.keyframes[i + 1];
      const delta = Math.abs(b.value - a.value);
      if (delta < 1e-3 || (best && delta <= best.delta)) continue;
      best = {
        label: labelOf(profile, track.target),
        channel: track.channel,
        fromMs: a.time,
        toMs: b.time,
        fromValue: a.value,
        toValue: b.value,
        delta,
      };
    }
    if (best) out.push(best);
  }
  return out;
}

/** Mirrors A5's `followThroughNote` (`./templates.ts`) but spells EVERY chain in the
 *  rig, since Polish reasons about the whole clip rather than one gesture's target. */
function followThroughNote(profile: RigProfile): string {
  const chains = profile.chains.filter((c) => c.bones.length > 1);
  if (chains.length === 0) {
    return 'Follow-through: wherever a part has children in the rig hierarchy, let each ' +
      "child lag 40-80ms behind its parent's motion instead of moving as one rigid slab.";
  }
  const spelled = chains
    .map((c) => {
      const spine = c.bones.map((b) => b.label).join(' -> ');
      const deforming = c.deforms.length > 0
        ? ` (deforming ${c.deforms.map((d) => d.label).join(', ')})`
        : '';
      return `${spine}${deforming}`;
    })
    .join('; ');
  return `Follow-through: cascade motion down these bone chains — ${spelled} — delay ` +
    'each child bone 40-80ms behind its parent so the motion whips through the chain, ' +
    'never moves as one rigid slab.';
}

/** True (returning the target id) when a `ty` track moves a large share of its own
 *  value range within a short share of the clip's duration — both axes are relative,
 *  so this never hardcodes an absolute doc-unit speed. Bone-DEFORMED parts are skipped
 *  (`deformedIds`): sx/sy on a skinned part is forbidden (renders nothing in-editor,
 *  and the request validator drops such tracks) — suggesting squash-and-stretch there
 *  would ask the model for exactly what gets thrown away. */
function fastVerticalTarget(clip: Clip, deformedIds: ReadonlySet<string>): string | null {
  for (const track of clip.tracks) {
    if (deformedIds.has(track.target)) continue;
    if (track.channel !== 'ty' || track.keyframes.length < 2) continue;
    const values = track.keyframes.map((k) => k.value);
    const range = Math.max(...values) - Math.min(...values);
    if (range < 1e-3) continue;
    for (let i = 0; i < track.keyframes.length - 1; i++) {
      const a = track.keyframes[i];
      const b = track.keyframes[i + 1];
      const dt = b.time - a.time;
      if (dt <= 0) continue;
      const delta = Math.abs(b.value - a.value);
      if (delta / range >= 0.5 && dt <= clip.duration * 0.35) return track.target;
    }
  }
  return null;
}

/** True when every track with >=2 keyframes currently starts and ends on the same
 *  value — a clip that already loops cleanly, worth an explicit "keep it that way". */
function isLoopClean(clip: Clip): boolean {
  const multi = clip.tracks.filter((t) => t.keyframes.length >= 2);
  if (multi.length === 0) return false;
  return multi.every((t) => {
    const first = t.keyframes[0];
    const last = t.keyframes[t.keyframes.length - 1];
    return Math.abs(first.value - last.value) < 1e-3;
  });
}

/** The pure instruction builder — see the module doc for the analysis behind each
 *  section. Every section but the opening contract paragraph and follow-through is
 *  conditional on the clip actually having something for it to point at. */
export function buildPolishInstruction(profile: RigProfile, clip: Clip): string {
  const moves = biggestMoves(profile, clip);
  const anticipation = moves.filter((m) => m.fromMs >= ANTICIPATION_LEAD_MS);

  const lines: string[] = [
    `POLISH PASS on THIS EXACT clip (duration ${clip.duration}ms — fixed, never change ` +
      'it). The ONLY goal is to raise animation-principles QUALITY while PRESERVING THE ' +
      "CHOREOGRAPHY EXACTLY AS-IS: do NOT retime any story beat, do NOT remove or " +
      "replace any of the user's existing poses. You are refining HOW the figure moves " +
      'between the poses that are already there — never WHAT it does or WHEN the story ' +
      'beats land.',
  ];

  if (anticipation.length > 0) {
    lines.push(
      'Anticipation — each of these has real lead-in room: add a small counter-move ' +
        `(opposite direction, roughly 10-20% of the move) in the ~${ANTICIPATION_LEAD_MS}ms ` +
        'before it starts:',
    );
    for (const m of anticipation) {
      lines.push(
        `- ${m.label}.${m.channel}: ${round1(m.fromValue)} -> ${round1(m.toValue)} from ` +
          `${m.fromMs}ms to ${m.toMs}ms.`,
      );
    }
  }

  lines.push(followThroughNote(profile));

  if (moves.length > 0) {
    lines.push(
      'Settle with overshoot — at each of these arrivals, blow ~5-10% past the target ' +
        'then ease back onto it (easeOut arriving, easeInOut settling, or a custom feel ' +
        'via the existing easing presets):',
    );
    for (const m of moves) {
      lines.push(`- ${m.label}.${m.channel}: arrives at ${round1(m.toValue)} at ${m.toMs}ms.`);
    }
  } else {
    lines.push(
      'Settle with overshoot: wherever a track arrives at a strong pose, blow slightly ' +
        'past it then ease back (easeOut arriving, easeInOut settling).',
    );
  }

  const deformedIds: ReadonlySet<string> = new Set(
    profile.chains.flatMap((c) => c.deforms.map((d) => d.id)),
  );
  const fastTarget = fastVerticalTarget(clip, deformedIds);
  if (fastTarget) {
    lines.push(
      `Squash-and-stretch (SUBTLE, volume-preserving only): ${labelOf(profile, fastTarget)} ` +
        'has a fast vertical move — add light sx/sy counter-scale keys across it (sy down ' +
        'with sx up compressing, the reverse stretching), a few percent at most. Skip this ' +
        'if it would read as bouncy rather than weighty.',
    );
  }

  if (isLoopClean(clip)) {
    lines.push(
      "Every track's first and last keyframe currently match — this clip loops cleanly. " +
        "Keep that exact match: any key you add or adjust must land strictly between a " +
        "track's existing first and last keyframe times, never on or past them.",
    );
  }

  return lines.join('\n');
}

/** The Polish button — mounted by `./panel.ts` "near the Modify action" per the wave
 *  brief. Disabled (never hidden — CLAUDE.md's visible-mode-change-counterpart GOTCHA)
 *  while busy, with no active clip, or when the active clip has no keyframes at all
 *  (nothing to polish); the title always explains which. */
export function buildPolishButton(ctx: AiRequestCtx): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ai-polish-btn';
  btn.textContent = 'Polish';
  const clip = activeClip();
  const hasKeys = !!clip && clip.tracks.some((t) => t.keyframes.length > 0);
  const reason = ai.busy
    ? 'Busy with another request.'
    : !state.doc || !clip
      ? 'No active clip to polish.'
      : !hasKeys
        ? 'Add at least one keyframe before polishing.'
        : null;
  btn.disabled = reason !== null;
  btn.title = reason
    ?? 'One click: ask Claude to add anticipation, follow-through, and settle to THIS ' +
      'clip while preserving every pose and beat exactly. Lands in preview — review ' +
      'before it applies.';
  btn.onclick = () => {
    const doc = state.doc;
    const target = activeClip();
    if (btn.disabled || !doc || !target) return;
    const instruction = buildPolishInstruction(getRigProfile(doc.parts), target);
    void runAnimate(ctx, 'modify', undefined, instruction);
  };
  return btn;
}

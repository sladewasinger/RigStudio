/**
 * AI Animate System v2 A5 "motion templates": archetype quick-actions (walk cycle,
 * idle breathing, jump, wave, emphatic gesture) shown as a compact button row in the
 * AI panel. Each archetype is a PURE function (profile, durationMs) → a rich
 * structured INSTRUCTION — never keyframes: it names the actual target parts/chains
 * resolved from the rig profile (`ai/rigProfile.ts` — nothing here may hardcode any
 * specific character's part names, and the unit suite greps this file to prove it),
 * lays out a beat map in ABSOLUTE ms computed from the active clip's set duration
 * (per-archetype anticipation/action/settle/hold fractions), and adds motion notes
 * (arcs, follow-through down chains, symmetry counter-motion).
 *
 * DECISION — fill, don't fire: a template button FILLS the prompt box (and focuses
 * it) rather than sending immediately, so the user can edit the instruction and stays
 * in control; sending is the normal "Create new animation" click, which routes the
 * template through the standard create-new flow (A2 preview, A3 filmstrip, A4
 * thread-start all apply for free — no special-case request path).
 */
import { activeClip, state } from '../../core/model';
import {
  getRigProfile, PartRole, ProfileChain, RigProfile, SymmetryPair,
} from '../../ai/rigProfile';
import { AiFields } from './fields';
import { ai } from './state';

export interface MotionTemplate {
  id: string;
  /** Button text — kept short; `hint` carries the explanation. */
  label: string;
  hint: string;
  build: (profile: RigProfile, durationMs: number) => string;
}

// ---- target resolution (everything comes from the profile, with generic fallbacks) ----

function labelsFor(p: RigProfile, role: PartRole): string[] {
  return p.roles.filter((r) => r.role === role).map((r) => r.label);
}

const GENERIC_FIGURE = 'the group part covering the whole figure (pick it from the part tree)';

function figureLabel(p: RigProfile): string {
  return p.figureGroup?.label ?? labelsFor(p, 'torso')[0] ?? GENERIC_FIGURE;
}

function torsoLabel(p: RigProfile): string {
  return labelsFor(p, 'torso')[0] ?? figureLabel(p);
}

/** Pick a symmetry pair, preferring a base name containing one of `prefer` (GENERIC
 *  anatomical preference — e.g. a wave leads with an arm-like pair, a walk strides
 *  with a leg-like one; these are archetype knowledge, never a specific rig's part
 *  names), then any pair whose right side is limb-roled, then the first pair. */
function pickPair(p: RigProfile, prefer: string[]): SymmetryPair | undefined {
  return p.symmetryPairs.find((sp) => prefer.some((kw) => sp.base.includes(kw)))
    ?? p.symmetryPairs.find((sp) => p.roles.some((r) => r.id === sp.right.id && r.role === 'limb'))
    ?? p.symmetryPairs[0];
}

/** The limb a one-sided gesture leads with: a chain-deformed part beats an arm-like
 *  symmetry pair's right side beats any limb beats the whole figure. */
function gestureLimb(p: RigProfile): { label: string; chain: ProfileChain | null } {
  const chain = p.chains.find((c) => c.deforms.length > 0) ?? null;
  if (chain) return { label: chain.deforms[0].label, chain };
  const pair = pickPair(p, ['arm', 'hand', 'wing', 'paw', 'claw']);
  if (pair) return { label: pair.right.label, chain: null };
  const limb = labelsFor(p, 'limb')[0];
  return { label: limb ?? figureLabel(p), chain: null };
}

function followThroughNote(p: RigProfile, chain: ProfileChain | null): string {
  if (chain && chain.bones.length > 1) {
    return `follow-through: the bone chain ${chain.bones.map((b) => b.label).join(' -> ')} runs ` +
      'through it — delay each child bone 40–80ms behind its parent so the motion whips, never rigid';
  }
  return 'follow-through: let child parts lag 40–80ms behind their parent instead of moving as one slab';
}

function symmetryNote(p: RigProfile): string | null {
  if (p.symmetryPairs.length === 0) return null;
  const pairs = p.symmetryPairs.map((sp) => `${sp.left.label}/${sp.right.label}`).join(', ');
  return `symmetry: keep the pairs (${pairs}) coordinated — counter-phase or mirrored, never one side moving alone`;
}

function headNote(p: RigProfile, text: string): string | null {
  const head = labelsFor(p, 'head')[0];
  return head ? `${head}: ${text}` : null;
}

// ---- beat-map assembly ----

/** Fraction of the set duration in ms, rounded to a 10ms multiple (the model is told
 *  to keep times on 10ms multiples) and clamped so a beat never exceeds the clip. */
function ms(duration: number, f: number): number {
  return Math.min(duration, Math.round((duration * f) / 10) * 10);
}

function beat(d: number, from: number, to: number, name: string, note: string): string {
  return `- ${ms(d, from)}–${ms(d, to)}ms (${name}): ${note}`;
}

function assemble(
  title: string, duration: number, targets: string[], beats: string[], notes: (string | null)[],
): string {
  return [
    title,
    ...targets,
    `Beat map (clip duration ${duration}ms — every key inside it; first and last keys of ` +
      'every track must match so the clip loops cleanly):',
    ...beats,
    'Motion notes (arcs over straight lines; easeInOut on reversals; easeOut into holds):',
    ...notes.filter((n): n is string => n !== null).map((n) => `- ${n}`),
  ].join('\n');
}

// ---- the archetypes ----

const walkCycle: MotionTemplate = {
  id: 'walk',
  label: 'Walk',
  hint: 'In-place walk cycle: symmetric limb pairs in counter-phase, body bob, loop-clean.',
  build: (p, d) => {
    const pairs = p.symmetryPairs;
    const strider = pickPair(p, ['leg', 'foot', 'feet', 'paw']);
    const swing = strider
      ? `swing ${strider.left.label} forward while ${strider.right.label} swings back (rotate around their pivots)`
      : `alternate the limbs (${labelsFor(p, 'limb').join(', ') || 'whatever limb parts exist'}) in opposite phase`;
    const swingBack = strider
      ? `mirror it: ${strider.right.label} forward, ${strider.left.label} back`
      : 'mirror the first stride with the opposite limbs';
    const others = pairs.filter((sp) => sp !== strider)
      .map((sp) => `${sp.left.label}/${sp.right.label}`);
    return assemble(
      'Create an IN-PLACE WALK CYCLE (no ground travel — the figure stays put).',
      d,
      [
        `Primary striders: ${strider ? `${strider.left.label} and ${strider.right.label}` : 'the limb pairs'}.` +
          (others.length > 0 ? ` Counter-swing the remaining pairs (${others.join(', ')}) in OPPOSITE phase to the striders.` : ''),
        `Body: ${torsoLabel(p)} bobs vertically (ty), lowest at each passing pose.`,
      ],
      [
        beat(d, 0, 0.25, 'stride A', `contact pose at 0ms, then ${swing}, extremes at 25%`),
        beat(d, 0.25, 0.5, 'passing', `limbs pass under the body; ${torsoLabel(p)} at its lowest, rising into 50%`),
        beat(d, 0.5, 0.75, 'stride B', swingBack),
        beat(d, 0.75, 1, 'passing + loop', 'second passing pose, arriving back exactly at the 0ms contact pose'),
      ],
      [
        symmetryNote(p),
        headNote(p, 'stays level with a subtle counter-bob (about 1–2°, half a beat behind the body)'),
        'rotation extremes around ±20–35° per swinging limb; keep everything easeInOut',
      ],
    );
  },
};

const idleBreathing: MotionTemplate = {
  id: 'breathe',
  label: 'Breathe',
  hint: 'Idle breathing: slow torso scale swell with micro-motion — subtle, loop-clean.',
  build: (p, d) => {
    const torso = torsoLabel(p);
    return assemble(
      'Create a SUBTLE IDLE BREATHING loop — alive, not busy.',
      d,
      [`Primary target: ${torso} (scale sy about 1.00 → 1.03 and back, pivot-anchored; a hint of sx counter-scale keeps volume).`],
      [
        beat(d, 0, 0.45, 'inhale', `${torso} swells to the peak (easeInOut, slow)`),
        beat(d, 0.45, 0.85, 'exhale', 'ease back down slightly slower than the inhale'),
        beat(d, 0.85, 1, 'rest', 'hold the relaxed pose so the loop breathes with a pause'),
      ],
      [
        headNote(p, 'rises about 1° / a fraction of a unit on the inhale, a beat behind the chest'),
        'any hanging limbs drift 1–2° with the swell — delayed, never synchronized exactly',
        symmetryNote(p),
        'amplitudes stay tiny; nothing should read as deliberate movement',
      ],
    );
  },
};

const jump: MotionTemplate = {
  id: 'jump',
  label: 'Jump',
  hint: 'Vertical jump: crouch anticipation, launch with stretch, land with squash, recover.',
  build: (p, d) => {
    const fig = figureLabel(p);
    return assemble(
      'Create a VERTICAL JUMP in place (up and back down — no horizontal travel).',
      d,
      [`Primary target: ${fig} — its ty for the height, its sx/sy for squash-and-stretch (volume-preserving: sy down ⇒ sx up).`],
      [
        beat(d, 0, 0.22, 'anticipation', `${fig} crouches: ty sinks slightly, squash (sy ≈ 0.92, sx ≈ 1.06), easeIn`),
        beat(d, 0.22, 0.4, 'launch', 'explosive rise (large NEGATIVE ty — y grows down), stretch (sy ≈ 1.08), easeOut into the apex'),
        beat(d, 0.4, 0.62, 'airborne', 'float through the apex — slow spacing at the top, scale easing back to 1'),
        beat(d, 0.62, 0.8, 'land', 'fast fall (easeIn), impact squash deeper than the crouch'),
        beat(d, 0.8, 1, 'recover', 'settle back to the exact rest pose with one tiny overshoot'),
      ],
      [
        'limbs trail the body: rise a beat late on launch, keep drifting up briefly after landing (follow-through)',
        headNote(p, 'lags the body by ~40–60ms on both launch and landing'),
        symmetryNote(p),
      ],
    );
  },
};

const wave: MotionTemplate = {
  id: 'wave',
  label: 'Wave',
  hint: 'A friendly wave with one limb: raise, oscillate 2–3 swings, settle back.',
  build: (p, d) => {
    const { label, chain } = gestureLimb(p);
    return assemble(
      'Create a friendly WAVE.',
      d,
      [`Primary target: ${label} — everything else stays near rest.`],
      [
        beat(d, 0, 0.15, 'anticipation', `${label} dips slightly AWAY from the wave direction (small counter-rotation)`),
        beat(d, 0.15, 0.7, 'action', `raise ${label} and oscillate its rotation ±25–40° around the raised pose — 2 to 3 full swings, each reversal easeInOut, tracing an arc`),
        beat(d, 0.7, 0.9, 'settle', 'swing back toward rest with one small overshoot (~5°) before landing'),
        beat(d, 0.9, 1, 'hold', 'hold rest so the loop reads cleanly'),
      ],
      [
        followThroughNote(p, chain),
        headNote(p, 'tilts 2–3° toward the wave during the action, back to rest in the settle'),
        `${torsoLabel(p)} counter-tilts about 1–2° for balance`,
      ],
    );
  },
};

const emphaticGesture: MotionTemplate = {
  id: 'gesture',
  label: 'Gesture',
  hint: 'Emphatic gesture: wind-up, fast strike to an extreme, overshoot, held accent.',
  build: (p, d) => {
    const { label, chain } = gestureLimb(p);
    return assemble(
      'Create an EMPHATIC GESTURE — a strong, declarative accent (a point, a flourish).',
      d,
      [`Primary target: ${label}, supported by ${torsoLabel(p)} leaning into it.`],
      [
        beat(d, 0, 0.18, 'wind-up', `${label} pulls back OPPOSITE the gesture (10–15°), body coils slightly, easeIn`),
        beat(d, 0.18, 0.42, 'strike', 'fast, committed move to the extreme pose — easeOut, biggest spacing right after release'),
        beat(d, 0.42, 0.7, 'overshoot + settle', 'blow ~10% past the extreme, then settle onto it'),
        beat(d, 0.7, 1, 'hold + release', 'hold the accent, then return to rest at the very end so the loop closes'),
      ],
      [
        followThroughNote(p, chain),
        headNote(p, 'snaps toward the gesture a frame or two AFTER the strike lands'),
        symmetryNote(p),
      ],
    );
  },
};

export const MOTION_TEMPLATES: MotionTemplate[] = [
  walkCycle, idleBreathing, jump, wave, emphaticGesture,
];

// ---- the panel row ----

/** The compact quick-action row mounted under the prompt box (Animate mode — the whole
 *  panel is Animate-only). Clicking a button FILLS the prompt (see the module doc's
 *  fill-don't-fire decision); it re-resolves the profile and the ACTIVE clip's duration
 *  at click time, so a duration change or rig edit between render and click is honored. */
export function buildTemplateRow(fields: AiFields): HTMLElement | null {
  if (!state.doc || !activeClip()) return null;
  const row = document.createElement('div');
  row.className = 'ai-template-row';
  const cap = document.createElement('span');
  cap.className = 'ai-template-cap';
  cap.textContent = 'Templates';
  cap.title = 'Fill the prompt with a motion archetype tailored to THIS rig — edit it, then Create.';
  row.appendChild(cap);
  for (const t of MOTION_TEMPLATES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ai-template-btn';
    btn.dataset.template = t.id;
    btn.textContent = t.label;
    btn.title = `${t.hint} Fills the prompt — review/edit, then "Create new animation".`;
    btn.disabled = ai.busy;
    btn.onclick = () => {
      const doc = state.doc;
      const clip = activeClip();
      if (ai.busy || !doc || !clip) return;
      const text = t.build(getRigProfile(doc.parts), clip.duration);
      fields.promptBox.value = text;
      ai.promptText = text; // keep the module-scope mirror in sync (state.ts)
      fields.promptBox.focus();
    };
    row.appendChild(btn);
  }
  return row;
}

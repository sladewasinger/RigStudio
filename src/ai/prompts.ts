/**
 * The DECLARATIVE half of the AI assistant, extracted from `ai/claude.ts` (which sat
 * grandfathered AT its size-ratchet ceiling — CLAUDE.md "Small, focused files"): every
 * system-prompt constant and the response JSON schema, with zero behavior of its own.
 * A leaf sibling of `ai/threads.ts`/`ai/profileBlock.ts` following the same pattern —
 * `ai/claude.ts` (orchestration: payload assembly + the two SDK calls) composes these
 * into requests and is this module's only production consumer; nothing here imports
 * back, calls the network, or touches the DOM.
 */

/**
 * The clip response schema, parameterized over the two independent axes a request can
 * vary on (AI Animate System v2 A1): `withRig` (the existing "allow rig changes" opt-in)
 * and `withClipName` (Create-new mode only). Built as a function rather than fixed consts
 * so the four combinations share one source of truth for the tracks/keyframes shape.
 */
export function buildClipSchema(opts: { withRig: boolean; withClipName: boolean }): Record<string, unknown> {
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

export const RIG_EDIT_NOTES = `
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

export const RIG_SEMANTICS = `The rig is an SVG-space skeleton. Coordinate system: x grows right, y grows DOWN.
Rotations are in degrees, POSITIVE = CLOCKWISE on screen, and each part rotates around
its own pivot (its joint — e.g. an arm's pivot is the shoulder). Channels per part:
- rotate: degrees, ABSOLUTE
- tx / ty: translation in document units, ABSOLUTE (+y is down, so a jump is NEGATIVE ty)
- sx / sy: per-part scale factors, ABSOLUTE and CONTINUOUS (rest 1 = unscaled). Scales the
  part around its OWN pivot, along its own axes, and does NOT propagate to children — use it
  to squash/stretch or grow/shrink a single part (e.g. blinking eyes flattening sy toward 0,
  a breathing chest, a bouncing ball's contact squash). Volume-preserving squash pairs sx and
  sy inversely. A part with no sx/sy track stays at its rest scale. FORBIDDEN on skinned
  parts (see the skinned-parts rules below — the app drops such tracks).
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
 *
 * Skinned-part rules (2026-07-12 design ruling, after a user-confirmed failure: a
 * generated "gesture" keyed rotate directly on four skinned limb parts — one swung as
 * a rigid slab, another double-rotated a whole-part swing on top of its articulated
 * bones): a skinned part's bones are PARENTED under it, so part-level rotate/tx/ty
 * legitimately carries the whole chain (rigid whole-limb motion, matches the .riv
 * export) — but ARTICULATION lives on the bones, and sx/sy on a skinned part renders
 * nothing in the editor while Rive WOULD scale the node (WYSIWYG violation), so scale
 * is forbidden outright and enforced app-side (`ai/claude.ts`'s `clampRawClip`).
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
  "the figure", "the arm", "it") to actual part labels.

Skinned parts pose through their BONES (the scene JSON marks them "skinned": true and
lists the controlling chain in "bones", root first):
- To ARTICULATE a skinned part (bend it at its joints — waves, walk strides, gestures,
  anything that flexes), key "rotate" on its BONES, root-first down the chain, with a
  40-80ms follow-through delay per child bone. NEVER key only the part itself and
  expect it to bend — that swings the whole limb as one rigid slab.
- Part-level rotate/tx/ty on a skinned part moves the WHOLE limb rigidly (its bones are
  parented under it and ride along). Use it as an optional accent LAYERED ON TOP of
  bone articulation — never a substitute for it, and never a redundant duplicate of a
  swing the bones already perform (that double-rotates the limb).
- NEVER key sx/sy on a skinned part: the editor renders no scale on skinned geometry,
  so the track is a lie — the app DROPS such tracks from your response.
- Example — WRONG: a wave keying rotate on the arm part alone. RIGHT: rotate keys on
  the arm's chain bones (say shoulder_bone -> elbow_bone -> wrist_bone) cascading
  40-80ms per bone, plus at most a small rotate accent on the part itself.`;

/**
 * General statement of the A1 request contract — the CONCRETE numbers (which mode, the
 * pinned duration, any protected keyframes) are per-request values, so they travel in the
 * user message (see `buildRequestNotes`) rather than here; this paragraph just tells the
 * model the rules exist and that they're enforced regardless of compliance.
 */
export const REQUEST_MODES_NOTE = `Each request states its MODE — "create a new clip" (the current
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

export const CRITIQUE_SYSTEM = `You are an animation director reviewing a clip made in Rig Studio,
a 2D cutout-rig editor.

${RIG_SEMANTICS}

${TARGETING_RULES}

Critique the clip like a seasoned animator doing dailies: arcs, timing and spacing,
anticipation, follow-through and overlap, silhouette readability, weight, looping
cleanliness. Point at concrete tracks/keyframe times when something is off and suggest
specific fixes (times in ms, values in degrees/units). Be direct and useful, not
flattering. Keep it under ~300 words.`;

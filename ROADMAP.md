# Rig Studio Roadmap

Goal: a full-fledged 2D rigging/bones/animation tool with basic vector editing —
modeled loosely after Rive, but simple. Everything through **v2.12 is implemented and
verified** (checkboxes track status); **v3 — Future** at the bottom is the honest
out-of-scope list that new work should be drawn from.

## v1 — Vector editing basics

- [x] **Flip horizontal / vertical** for the selected part(s) — in place (around each
  part's own rendered bbox center), implemented as negative rest scale so it exports
  cleanly and never moves the joint. Shortcuts `H` / `V` in Setup mode + toolbar
  buttons.
- [x] **Align & distribute** (Setup mode, multi-selection) — align left / center /
  right / top / middle / bottom, distribute with equal gaps horizontally/vertically.
  Reference object options: selection bbox · first selected · last selected · canvas.
  Pure math in `src/align.ts` (unit-tested), applied through parent-chain-aware rest
  translation.
- [x] **Bezier node handles, properly** — visible handle lines connecting nodes to
  their control points; click to select a node; smooth-handle mirroring while
  dragging (opposite handle stays collinear when it was collinear, Alt breaks);
  one-shot **corner / smooth / symmetric** operations on the selected node; line ↔
  curve segment conversion.

## v1 — Rigging

- [x] **Bones** — first-class null parts (`kind: 'bone'`): no artwork, just a joint
  that renders as a canvas glyph, selectable/draggable like any part. Chains of bones
  = multiple joints per limb (shoulder → elbow → wrist), with artwork parts parented
  to any bone. Placed by click ("+ bone" then click canvas; parented to the current
  selection).
- [x] **Groups / ungrouping** — Ctrl+G wraps the selected parts in a group null
  (`kind: 'group'`) pivoted at the selection center; Ctrl+Shift+G dissolves it,
  children re-adopt its parent and absorb its rest translate/rotate exactly. Groups
  pose/animate as one (they're just parts with children).
- [x] **Group-aware selection** — clicking artwork inside a group selects the group;
  double-click steps inside (group → part → path, Escape steps back out). Layers
  panel: Ctrl+click toggles rows in/out of the multi-selection; bones and groups get
  distinct icons.
- [x] **Exports understand bones/groups** — Compose skips draw calls for partless
  nulls but keeps them in transform chains; Lottie emits them as native null layers.

## v1 — AI assistant

- [x] **Structural edits (opt-in)** — an "allow rig changes" toggle lets Claude
  return, alongside the clip: new bones (label/pivot/parent), reparenting, and pivot
  moves. Applied atomically with the clip in one undo step, with cycle guards.
- [x] **Richer rig context** — the scene JSON sent to Claude marks part kinds
  (art/bone/group), includes the full hierarchy and rest pose, so choreography can
  target bone chains sensibly.

## v1 — Quality gates (define "complete")

- [x] Type-check + `npm run build` clean.
- [x] Unit tests for all new pure logic (align/distribute, flip math, group/ungroup
  absorption, bone creation, structural-change application).
- [x] Live browser verification of every v1 feature via the preview harness.
- [x] CLAUDE.md + this file updated; conventions section covers new invariants.

## v2 — first batch (done)

- [x] **Context-aware movement** — a part selected in Layers (or via double-click
  entry) is manipulated directly on canvas even inside a group; Layers selection
  opens the part's ancestor groups. Clicking unselected grouped artwork still selects
  the group.
- [x] **Transform tools with axis gizmos** (Rive/Blender-style) — V select,
  T translate (red X / green Y arrows constrain to an axis, center square free-moves),
  R rotate (ring around the live pivot), I inverse kinematics. Tools work in both
  modes (Setup edits rest, Animate keys). Flips rebound to Shift+H / Shift+V.
- [x] **Inverse kinematics** — analytic two-bone solver (`src/ik.ts`, unit-tested for
  exact reach, out-of-range clamping, bend-direction preservation): drag a limb end
  with the IK tool and its two nearest ancestor joints solve to follow; one ancestor
  falls back to aiming.
- [x] **Bone polish** — bones are drawn by press-drag-release (origin → tip), render
  as classic kite glyphs, and the tip is draggable in Setup. Rotating a bone (body
  drag in Animate) spins its subtree around the origin with real leverage.
- [x] **Skinning / mesh deformation** — bind selected art to selected bones (one
  button, auto inverse-square-distance weights to bone segments; `src/skin.ts`
  unit-tested): static transforms bake into rest geometry, the part's motion then
  comes purely from bone deltas via per-frame linear-blend deformation. Unbind in the
  inspector. Skinned parts are marked ≋ in Layers. Limitation (documented): exports
  render skinned parts rigidly — LBS is not representable in Compose/Lottie
  transform replay.
- [x] **Graph/curve editor** — "curves" toggle in the timeline opens a value-vs-time
  plot of the selected key's track: draggable key dots (retime/re-value), per-segment
  bezier handles (dimmed = preset easing; grab to convert to a custom
  `cubic-bezier`), reset-to-preset. Custom beziers sample exactly in the app and
  export as `CubicBezierEasing(...)` (Compose) and native `o`/`i` handles (Lottie).
- [x] **Prettier icons** — inline SVG icon set for the tool switcher, flip, group,
  bone, bind, and align/distribute buttons.

## v2 — second batch (done)

- [x] **Persistent node-type flags** — `sodipodi:nodetypes` imports onto paths
  (`RigPath.nodeTypes`, one char per node: c/s/z), persists through projects, tints
  node handles (green = smooth, red = symmetric), and DRIVES handle dragging: 's'
  nodes mirror the opposite handle's direction, 'z' also matches its length, 'c'
  moves freely (untyped nodes fall back to collinearity detection). The
  smooth/symmetric/corner ops set the flag persistently; node insert/delete keep the
  string in sync.
- [x] **Full node multi-select** — Shift+click toggles nodes, dragging on blank
  canvas in node mode rubber-band-selects, dragging any selected node moves the whole
  set (cross-path deltas converted through each path's frame), ops apply to every
  selected node, Delete removes them, arrows nudge (Shift = ×10).
- [x] **Skew handles** — the rotate handle set now has Inkscape's side handles:
  dragging shears the part along that edge with the opposite edge pinned, stored as
  `rest.kx/ky` degrees (innermost with rest scale around the local pivot, tan-additive
  composition). skewX/skewY parse and compose in the transform layer; Compose exports
  a folded `svgMatrix(...)`, Lottie bakes it into geometry; inspector gets skew x/y
  fields.

## v2.5 — editing focus & node UX (done)

- [x] **Double-click drill-down fixed** — drills resolve the artwork under the cursor
  with `elementsFromPoint`, looking through overlay widgets. (Root cause of the
  regression: the first click of a double-click selects the group and draws its pivot
  grab circle exactly where the second click lands; the overlay ate the dblclick.)
  Pivot grab shrunk. Slow second click still swaps scale/rotate handle sets.
- [x] **Focus/fade drill-down mode** — inside an entered group or while node-editing,
  every part outside the context fades to ~20% and stops catching clicks: you can't
  select faded parts, clicks on them fall through (landing on blank exits the focus),
  and node-mode rubber bands sweep right across them.
- [x] **Node-mode canvas ownership** — in node editing, canvas clicks never switch
  parts: near the edited outline they bend; anywhere else they rubber-band. Leave via
  Layers or Escape.
- [x] **Inkscape node shapes** — diamond = corner, square = smooth, circle =
  symmetric (small circle = untyped), same colors as before.
- [x] **Segment bending** — drag anywhere on a segment between two nodes to bend the
  curve through the pointer (minimal-norm control-point solve, exact at the grab
  parameter); straight segments auto-convert to curves, growing handles.

## v2.6 — bug fixes & small improvements (done)

- [x] **Zoom-proof pivot handle** — the pivot crosshair/ring drew its strokes in
  document units while its radius stays screen-constant, so zooming in fattened the
  strokes until the handle collapsed into a featureless blob. Overlay strokes (pivot
  handle, pivot ghosts, bone lines, drag-gizmo lines/arcs) now use
  `vector-effect: non-scaling-stroke`.
- [x] **Pivot drags never move the artwork** — the pivot participates in the part's
  own rotation and in the innermost rest scale/skew anchor, so re-anchoring it used
  to shift the rendered part whenever the part had any rest rotation, scale, or skew.
  The drag now solves the pivot and a rest-translation compensation together, so the
  joint follows the pointer and the artwork stays exactly put. (Setup-only, like all
  pivot editing; keyed tx/ty values are absolute and intentionally unaffected.)
- [x] **Ctrl constrains moves to an axis** — holding Ctrl during any free translate
  drag (Setup body move, Animate Shift+move, the translate gizmo's center square)
  locks the delta to the dominant axis — perfectly horizontal or vertical. The dashed
  drag line and Δ readout show the constrained movement.
- [x] **Arrow-key part nudge** — in Setup pose mode, arrows nudge the selected parts
  by 2 screen pixels (Shift = 20), converted through the current zoom and each part's
  parent chain like a translate drag. Animate keeps arrows for keyframe nudge /
  playhead scrub; node editing keeps its node nudge.

## v2.7 — vector-app parity & polish (done)

- [x] **Segment delete (break path)** — select 2 adjacent nodes: a closed path opens
  at the break (seam rotates, old Z becomes a straight segment); an open path splits
  into two paths (second labeled `·2`, shows in Layers). Pure ops in `paths.ts`,
  `nodeTypes` kept in lockstep, compound paths refused (buttons disable).
- [x] **Join nodes (weld) & join with segment** — select the 2 free ends of open
  path(s): same path closes (weld to midpoint, or straight closing segment);
  different paths merge into one (one side auto-reverses; arcs reverse by sweep-flag
  flip, no cubic conversion).
- [x] **Double-click off the shape escapes node editing** — a dblclick that hits no
  artwork exits the entered path/group context and deselects everything.
- [x] **Snapping, toggleable** (from the v3 list, scoped small) — Setup drags only:
  node↔node (same part), pivot↔nodes/pivots, part-translate pivot↔pivot + bbox
  center/corners/edge-midpoints; 8 screen px threshold; respects Ctrl axis-lock; one
  overlay marker; magnet button + `%` key; persisted preference (default ON). Pure
  math in `snap.ts` (unit-tested).
- [x] **Standard shortcuts** — Ctrl+S save, Ctrl+O open, Ctrl+A select-all
  (context-aware), Ctrl+D duplicate parts (fresh ids, +12/+12, no tracks, skips
  skinned), `+`/`-` zoom at canvas center; F/Space/letter bindings hardened against
  held modifiers (Ctrl+F no longer double-fires with the browser find bar).
- [x] **`?` / F1 shortcut help overlay** — data-driven from `help.ts`'s SHORTCUTS
  registry (46 bindings, 7 groups), Escape/backdrop/✕ to close, `?` toolbar button.
- [x] **Visual polish pass** — CSS design tokens (spacing/control-height/radius/
  border/shadow), hover/active/disabled/focus-visible states everywhere, tabular
  numerals, themed scrollbars, grouped toolbar + brand mark, subtler checkerboard,
  keyframe/playhead affordances, reduced-motion support. No selector renames; canvas
  overlay color language untouched.

## v2.8 — Rive export & format confidence (done)

- [x] **Rive `.riv` exporter** — the whole doc, all clips as named animations, as one
  binary that plays in official Rive runtimes on every platform Rive supports
  (deliberately playback-only: the Rive editor cannot import .riv — Rig Studio IS
  the editor). Schema from rive-runtime `dev/defs`; verified live against
  `@rive-app/canvas` (exact keyed rotations, custom-bezier curve match, static
  unkeyed channels); unit-tested with an in-repo binary decoder.
- [x] **Project format verified lossless** — maximal-doc serialize→deserialize deep
  equality + byte-stable re-serialize + identical sampling, normalizeDoc back-compat
  for pre-feature files, autosave shares the same code path. Editor preferences
  intentionally stay out of the file.

## v2.9 — Rive-style state machines (done)

- [x] **Core model + evaluator** — inputs (bool/number/trigger), entry/any/exit/
  animation states, transitions with AND-ed conditions and crossfade blend
  durations, pointer listeners; pure deterministic evaluator (`stateMachine.ts`)
  with Rive-like trigger consumption and blend retargeting; serialized in
  `.rig.json` with back-compat.
- [x] **Graph editor + live preview** — timeline `🔀 logic` view: draggable state
  graph, transition arrows with condition/blend editors, inputs with live controls,
  listeners; ▶ preview drives the canvas in real time and canvas clicks fire
  listeners.
- [x] **.riv state-machine export** — machines export into the same .riv and are
  driven by name/inputs in official Rive runtimes (verified: bool-driven blend with
  exact midpoint, trigger transitions). Android: `RiveAnimationView` +
  `stateMachineName` + `setBooleanState`/`fireState`.

## v2.10 — generic editor & SM editor polish (done)

- [x] **Compose (.kt) exporter removed** — Rive `.riv` (rive-android) replaces it on
  Android; the editor is now export-target generic (Rive + Lottie).
- [x] **De-Dosey/de-Pip sweep** — no app-specific code, naming, or intentions left;
  README rewritten; the bundled sample is just a neutral demo asset.
- [x] **State-machine graph pan/zoom** — wheel-zoom-at-cursor, middle-drag pan,
  ⌂ fit, per-machine view memory; correct pointer math at any zoom.
- [x] **Exit state always exists** — entry/any/exit minted together, re-established
  on load, undeletable in the editor (matches what Rive runtimes require).

## v2.11 — interaction harness + view.ts split (done)

- [x] **Headless interaction-test harness** — Vitest Browser Mode (headless
  Chromium), `npm run test:interaction`: 19 real-gesture tests pinning the 12
  hard-learned canvas invariants in ~1 s; mutation-checked before being trusted.
- [x] **view.ts modular split** — 3,089-line monolith → permanent 33-line facade +
  13 layered `src/view/` modules with a binding import-layering rule; zero behavior
  change (all gates green after every mechanical step; export surface
  diff-identical; live manual pass at the end).

## v2.12 — UX overhaul program (done 2026-07-11)

Decisions locked with Austin: Setup mode renames to **Edit** (UI/docs only; internal
enum stays `setup`); bones **auto-bind on placement**; AI pose snapshot sends the
**current playhead pose** with clear labeling; the AI structural-edit schema must
work with the reworked bone system.

Implementation phases (P1 first — it moves files — then maximum parallelism):

- [x] **P1. Architecture docs + feature folders** — CLAUDE.md gains a code-
  architecture section (self-documenting code, ~200-line file guideline — a smell
  threshold, not a hard limit; feature-grouped folders). src/ reorganizes into
  feature folders (core model/history, geometry, io/export, view/, timeline/,
  panels split into layers/inspector/ai modules behind a facade like view's, ai,
  ui). `npm run pages` (Austin's new gh-pages script) must keep working.
- [x] **P2a. Dialog system + context menus + inline rename** — in-app modal dialogs
  replace every alert/prompt/confirm (save, exports, animation rename/add);
  double-click a layer renames INLINE (input-in-place); right-click context menus
  on layer rows (rename/duplicate/delete/group/ungroup/z-order/bind) and on canvas
  objects (mode-appropriate ops). "Setup" → "Edit" UI rename lands here.
- [x] **P2b. Node-editing polish + drag bug fixes** — node type glyphs scale with
  zoom (currently vanish when zoomed in); selected nodes get an outline + size
  bump; zero-length bezier handles hidden; segment-bend through a smooth/symmetric
  node preserves the node type (mirrors the opposite handle instead of silently
  degrading to corner); glyph shapes stay Inkscape-parity (diamond corner / square
  smooth / circle symmetric). Fix the gray-triangle visual artifact under the drag
  delta label. Fix rotation keys recording the "wrong direction" (angle wrapping).
- [x] **P2c. Artboard (canvas size)** — optional, toggleable, resizable canvas rect
  on the doc (defaults from the imported SVG viewBox): rendered as a page
  boundary, editable in the inspector, used as the export reference frame.
- [x] **P3. Selection & navigation semantics (Inkscape parity)** — double-click
  DIVES into a group (enters context without selecting); further double-clicks
  dive deeper; single clicks inside the context select individual children
  (bounding box on the active item only); blank-click/Escape steps out. Layers
  panel: Shift+click = range select, Ctrl+click = toggle; canvas Shift/Ctrl+click
  = add to selection. Unified V "gizmo" tool in BOTH modes: first click =
  translate/scale handles (body drag translates), second click = rotate/skew
  handles (body drag ROTATES around the pivot — Edit writes rest, Animate keys);
  gizmo shows a rotate circle + move cross with hover highlighting.
- [x] **P4. Bones 2.0 (the big one)** — femur icon; child bones spawn at the
  parent's tip; placing bones over/inside an art part AUTO-BINDS it (LBS weights)
  so a 3-bone chain bends an arm with zero manual steps; manual refinement mode:
  select path nodes → bind to a bone with an origin↔tip % slider (per-node weight
  overrides); richer inspector (bindings visible/editable per part and per node);
  IK verified end-to-end on a sample multi-bone limb (bend-direction preserving,
  reach-clamped; per-bone rotation limits deferred unless trivially cheap). The
  bone system gets its own design doc section (how weights/bindings work).
- [x] **P5a. Timeline/Animate overhaul** — named panel sections; per-property
  keyframe toggle circles in the inspector; marquee-friendly padding around key
  lanes; alternating lane colors; transport buttons (⏮ ◀ ▶/⏸ ▶| ⏭); curves/logic
  as a mutually exclusive mode picker + onion as a toggle; dialog-based add/rename;
  visual section separation; a resize splitter between canvas and timeline. Curves
  editor: value snapping + "reset to keyframe value", more vertical headroom,
  pan/zoom in the plot.
- [x] **P5b. AI assistant polish** — panel visible only in Animate; editor disabled
  during a request with a Cancel button; snapshot option relabeled with a help
  tooltip stating it sends the CURRENT PLAYHEAD pose; structural-edit schema
  extended to the new bone system (AI can split a limb into bound bones).

## v2.13 — bones-as-hierarchy, freeze mode, table stakes (planned 2026-07-11, in flight)

Decisions locked with Austin: a chain deforms ONLY the object it's parented under
(hierarchy IS the assignment — no hidden bindings; multi-object cases group first);
the ≋ "skinned" badge becomes a subtle renamed indicator (bone glyph + "deformed by
its bones" tooltip); bezier-handle-level manual weights are deferred (control points
inherit from their neighboring vertex).

- [x] **Bones/skinning bug overhaul** (done d1c26b5): reproduce-then-fix the six
  live-use bugs — bbox auto-bind grabbing the wrong parts (→ real point-in-fill
  targeting + selected-part preference), bind not render-neutral, stale overlay
  after placement, dead-end clicks on deformed parts, independently draggable
  child origins (→ shared joints), inert IK tool.
- [x] **Freeze mode (Rive parity)** (done b7ae446): `Y` key + toolbar toggle with an UNMISSABLE
  in-freeze indicator (banner + canvas tint). Pivots/origins/joints are visible
  but immovable (and don't change the cursor) outside freeze; freeze unlocks
  exactly that editing. Prevents the constant accidental origin-drags.
- [x] **Bone position model** (done b7ae446): only a chain's ROOT bone has a position; child
  bones are rotation + length from the parent tip (inspector shows exactly
  that; tips/origins derive). Editing length/rotation is how you fit a chain to
  artwork.
- [x] **Assignment via hierarchy** (done d1c26b5/b7ae446): placing a chain under an object is the whole
  assignment story; weights stay auto-derived data (per-vertex, manual override
  editor remains for refinement); the layers indicator gets the subtle rename.
- [x] **File → New** (done b7ae446): a New button (in-app confirm when unsaved work
  exists) starting a fresh blank document with a default artboard.
- [x] **Table-stakes gap audit** (done 2026-07-11) — findings filed below.

### Table-stakes gap audit findings (2026-07-11)

Category A — done (a66884c):
- [x] **Unsaved-changes guard** — dirty flag at the checkpoint() chokepoint; New/
  Open/Load sample confirm only when dirty; beforeunload warns when dirty.
- [x] **Still-image export (PNG, SVG)** — toolbar buttons, @1x/@2x, artboard or
  selection crop, chrome stripped, transparent background.

Follow-ups from live bones testing (queued behind the freeze-semantics wave):
- [x] **MAJOR: node editing on a bone-deformed part is incoherent** (f89d6dc) — node handles
  sit on the REST shape while the art draws deformed; dragging momentarily aligns
  them, release diverges again. Fix: entering node editing on a bound part renders
  THAT PART at rest (bind pose) for the duration — node editing edits rest data,
  so the visuals must show rest; deformation resumes on exit (+ a hint).
- [x] **Bones visible in node-editing mode** (f89d6dc) (currently dimmed/hidden with the
  other parts — they're the binding context and must stay visible/selectable).
- [x] **Bind button moves off the top bar** (f89d6dc) → node-editing-only, appears when
  node(s) are selected; if no bone tip/origin is co-selected, opens a dialog
  (which child bone of this part + tip-or-origin) — replaces the old whole-part
  bind (auto-bind covers that path now).
- [x] **Canvas-tools bar overflow** (f89d6dc) — long hint text (e.g. the IK tool's) pushes
  buttons out of view. Buttons must never hide: hint moves to its own slim second
  line (ellipsis + full text on hover).
- [x] **Bone glyphs not zoom-stable** (f89d6dc) (kite geometry in doc units) — fix per the
  new CLAUDE.md screen-constant-chrome gotcha, plus a generic zoom-sweep harness
  assertion so the whole class of bug gets caught.
- [x] **IK drag feedback** (f89d6dc) — highlight the solving chain + target line during an
  IK drag so the tool explains itself.
- [x] **Nested-group SVG import** (f89d6dc) — the importer flattens below the top level;
  rework to recursive: EVERY group becomes a part at any depth (exact SVG
  structure preserved — user decision; label = inkscape:label, else the SVG id,
  rename in-editor), parented per the nesting, geometry stays doc-space per the
  app convention. Acceptance fixture: public/girl_example.svg.
- [x] **Tip drags never change a child bone's length** (f89d6dc) — dragging a parent's tip
  moves the shared joint; every descendant's local geometry (length + relative
  direction) is invariant, riding the joint. (Reported with screenshots; child
  currently shortens.)
- [x] **Group handle sets** (next commit) — groups currently draw only the passive dashed union
  box: no scale/rotate corners, and the second-click mode toggle is invisible.
  Fix: first click = scale handles implemented as DISTRIBUTED rest edits (scale
  every descendant's rest size+position about the group pivot, one undo — the
  flipSelected pattern); second click = rotate handles (group rest.rotate,
  which genuinely propagates); skew skipped for groups (the set still visibly
  changes). Backed by the new visible-counterpart GOTCHA in CLAUDE.md.
- [x] **Full-chain IK (FABRIK)** (05f0803) — the current analytic solver rotates exactly two
  ancestor joints and never the grabbed bone itself (it and its parent move as one
  rigid unit; depth capped). Replace with an n-joint FABRIK solve from the grabbed
  tip to the chain root: every joint participates incl. the grabbed bone's own
  rotation, lengths preserved, current-pose bias (no flips), deterministic
  iterations; Edit writes rests, Animate keys; chain highlight covers all
  participating bones.
- [ ] **Keyframeable z-order** — paint order stays flat/hierarchy-independent (by
  design); add a keyable `z` offset channel per part (STEPPED sampling — no easing
  between stacking ranks), rendering sorts by (z, rest index); inspector shows
  stacking position + up/down in Edit and the keyable offset in Animate; AI schema
  learns the channel (the reach-behind-grab-pill use case). Phase 2 (blocked on
  the user's uncommitted exportRiv.ts WIP): .riv export via Rive DrawTarget/
  DrawRules keyed draw order; Lottie cannot animate layer order — documented
  limitation.
- [ ] **Opacity channel + layers eye (revised per Rive-parity principle)** —
  `opacity` becomes a keyable continuous channel (rest opacity in Edit, keyed in
  Animate; Rive-native, Lottie `o`). The layers EYE is editor-only and NEVER
  keyable (user decision — no visibility channel; animated invisibility = opacity
  0): `part.hidden` serializes, hidden parts don't render and are excluded from
  exports. New convention in CLAUDE.md: keyable channels must map to Rive runtime
  features.
- [ ] **Export wave (unblocked — user WIP committed)**: .riv keyed z draw order
  via DrawTarget/DrawRules; .riv + Lottie opacity keys; hidden-part exclusion in
  both exporters; verify against the user's headless rive-android pipeline.
## Pre-A0 bones fixes (user-reported, build BEFORE the AI program)

- [x] **Pen-tool bone chains** (cd277af) — click sets the origin, move shows a live preview
  bone, click sets the tip AND starts the next bone at that joint; repeat to grow
  the chain; Escape/Enter/double-click ends chain mode. One checkpoint for the
  whole chain (single undo removes it); auto-bind fires ONCE at chain completion.
  Replaces press-drag-release + per-bone rearming.
- [x] **Bones hoisted to root on bind (regression)** (cd277af — root cause: bindPartsToBones zeroed the ART part's parentId since P4; latent until nested import) — bones are again leaving
  their parent object when assigned. a374dbd's in-place world-preserving fold was
  supposed to keep parentId; reproduce the user's flow (suspect: art nested in a
  GROUP, or a bind entry point that never got the fold — node bind / AI bindParts
  / frozen rebind), fix, and pin parentId stability through EVERY bind path.

## Group-level auto-bind (user-blocked — IMMEDIATE, parallel with A0)

- [x] **Chains on a group bind ALL its art descendants** (7742f8c) — completing the locked
  strict-hierarchy design ("multi-object cases group first"): when a chain's
  parent/selection is a group (or any part with child art), auto-bind expands to
  every art descendant — each part gets its own weights from its own geometry
  against the same chain (binding is already multi-part capable; only TARGETING
  stops at one part today). Render-neutral per part; per-node overrides stay
  per-part; undo = one step with the chain.

## Post-A bone feel fixes (user-reported — build AFTER the A program, BEFORE H)

- [ ] **Freeze origin-drag rotates unselected bones** — origin/joint handles only
  hit-test on the SELECTED bone, so a click-drag on an unselected bone's origin
  falls through to the body-drag (rotate) pipeline; user must select first. Fix:
  in freeze mode the origin/joint press on ANY bone selects + starts the joint
  drag in one gesture. Rotation stays on body/gizmo-ring drags.
- [ ] **Grab-point-relative IK (no tip snap)** — the IK drag always uses the TIP
  as effector, so grabbing the bone body teleports the tip to the cursor. Fix:
  the grabbed point (tip, or any body point) is the effector anchor and follows
  the cursor exactly; grabbing mid-body reads as "translate this bone, chain
  solves parents along" — same FABRIK, cursor-anchored at the grab offset.

## AI Animate System v2 (program planned 2026-07-11 with Austin — build in order)

One coherent system, not bolted-on features: every phase feeds the next. Decisions
locked: root is DEMOTED (groups are the figure controls — the shadow-follows-pip
bug class dies here); create-vs-modify are two explicit buttons; refinement threads
are CLIP-scoped; templates are rig-agnostic via a learned Rig Profile; the
principles pass integrates last as a preset refinement turn.

- [x] **A0. Targeting & root demotion** (3226dbf) — the AI keys `root.tx/ty` and drags the
  shadow along. Fix: (1) request context gains the SELECTION (id/label of the
  selected part/group) + the part tree with group structure; (2) prompt rules:
  NEVER key `root`; whole-figure motion targets the user's selected group or the
  group covering the moving parts (props/shadows deliberately outside stay
  untouched); (3) UI: the Figure(root) inspector section is removed from Animate
  (legacy `root` tracks keep sampling/exporting for back-compat; docs note the
  deprecation). Also in this wave: the CLEAN-PREVIEW toggle — one Animate-mode
  button hiding ALL editor chrome (bones, pivots, joints, dashed lines, selection
  boxes, gizmos) to watch the animation clean.
- [ ] **A1. Session & intent UX** — prompt text persists across view/mode switches
  until sent (module state, like the busy flag). TWO actions replace the single
  button: [Create new animation] → AI returns a clip + a NAME, added to the clips
  dropdown and selected; [Modify current] → edits the active clip, with a
  "protect playhead keys" checkbox (keys at the current playhead time are locked:
  prompt instructs it AND post-apply enforcement restores any protected key the
  model touched). Duration is pinned: the schema echoes the clip's set duration
  and validation rejects/clamps drift.
- [ ] **A2. Preview-before-apply** (idea 4) — AI results NEVER mutate the doc
  directly: the returned clip renders as a looping preview (pose-sampler
  playback, the SM-preview infrastructure) with an Apply / Retry / Discard bar.
  Apply = the existing atomic one-undo path; Retry = posts back into the thread
  (A4) with the preview visible; Discard = zero trace. Structural changes (new
  bones) preview as ghost overlays where feasible, else summarized in the bar.
- [ ] **A3. Filmstrip vision** (idea 1) — replace the single playhead snapshot
  with a strip of rendered frames (t = 0/25/50/75/100% of the clip, or one per
  keyframe cluster when denser), downscaled, payload-capped. Sent on BOTH
  animate and critique calls so Claude sees motion arcs, clipping, dead holds —
  and on A2 Retry turns it re-renders the CANDIDATE clip so refinement reacts to
  what the model actually produced.
- [ ] **A4. Clip-scoped refinement threads** (idea 2) — each clip keeps a
  conversation thread (app-state + localStorage keyed by doc name + clip name;
  last N turns): prior clip JSON, user instructions, model changes-summaries.
  The prompt box becomes the thread composer; A2's Retry is a thread turn;
  switching clips switches threads. Clearing/deleting a clip drops its thread.
- [ ] **A5. Rig Profile + motion templates** (idea 5, rig-AGNOSTIC) — an
  "analyze rig" step (cheap heuristics + optional one AI call) builds a cached
  RigProfile: bone chains, symmetry pairs (left_/right_ label pairs, mirrored
  transforms), role guesses (torso/head/limb/face/prop), figure group. Template
  quick-actions (walk cycle, idle breathing, jump, wave, emphatic gesture) are
  motion ARCHETYPES parameterized by the profile and beat-mapped to the set
  duration (anticipation/action/settle/hold percentages). Works on any imported
  rig; profile invalidates when the hierarchy changes.
- [ ] **A6. Principles polish pass** (idea 3, LAST — integrates with everything) —
  a one-click "Polish" preset refinement turn (A4) on the current clip: adds
  anticipation before large moves, cascades follow-through down bone chains
  (children lag 40–80ms), settle-with-overshoot easings on arrivals, optional
  squash-stretch via part scale keys — choreography preserved, quality raised.
  Uses A3 filmstrips for before/after and A2 preview for acceptance.

(The former "swap default sample to girl_example" FINAL item was CANCELLED
2026-07-11 — user decision: Pip stays as the permanent public demo sample.
girl_example.svg remains a nested-import test fixture only.)

Category B — nice-to-have (untracked):
- [ ] **Find/search parts** in the Layers tree. (S–M)
- [ ] **Project frame rate + frames/timecode display** — add doc.fps (exporters
  hardcode 60), and a ms↔frames toggle on the timeline time readout. (M)
- [ ] **Quick-save vs Save As** — remember last filename so Ctrl+S doesn't re-prompt
  every time; keep Save As for renaming. (S)
- [ ] **Recent files** menu (localStorage ring), beyond the single autosave slot. (M)
- [ ] **Invert selection / Select None** menu + shortcut. (S)
- [ ] **Empty-state call-to-action** on the canvas/Layers/Inspector when no doc is
  loaded. (S)

(Already tracked — see v3 / v2.13: File→New, rulers/guides, zoom % + zoom-to-selection
+ 100% reset, copy/paste parts [note: Ctrl+C/V are keyframe-only, no-op in Edit mode],
marquee part-select, layers visibility/lock/opacity, playback range/work area,
key-pose + auto-key, SVG-import error surfacing.)

## Headless engine + MCP server (planned with Austin 2026-07-11 — NOT scheduled;
## build after/alongside the AI program, sharing its components)

Goal: agents (Claude Code, Codex, any MCP client) create and edit rigs/animations
in chat without the website, producing .rig.json the editor opens (and .riv
directly). Feasible because core/, geometry/, io/ are already DOM-free (the unit
suite runs in Node); the user's scripts/ take-pill pipeline is the proof-of-
concept seed.

- [ ] **H1. `rig-studio-core` headless package + CLI** — expose model/normalize/
  sampling/evaluator/exporters as a package entry; jsdom-assisted `rig import
  art.svg`; `rig validate` (normalizeDoc + round-trip guarantees editor
  compatibility by construction); `rig export-riv`; `rig render-frames --clip X`
  (resvg/sharp rasterization — gives agents visual feedback; shares A3's
  filmstrip renderer). Known caveat: geometric auto-bind uses DOM isPointInFill —
  headless binding either implements a pure point-in-fill test or requires
  explicit part targets (agents name parts anyway).
- [ ] **H2. `rig-studio-mcp` server** — LOCAL stdio transport (an npm package the
  AI client spawns on demand — no hosting, no ports; remote/HTTP hosting is an
  optional later tier). Strictly a wrapper over H1: needed for shell-less clients
  (Claude Desktop etc.) + schema-guided tool calls + in-memory doc sessions;
  Claude Code can already drive the H1 CLI directly. Tools: import_svg,
  list_parts/analyze_rig
  (A5's RigProfile), add_bones/bind, apply_clip (the SAME structured schema as
  the in-app assistant — one schema, two front doors), add_state_machine,
  render_filmstrip, export_riv, save/load. Output files open directly in the
  editor for review/refinement. One brain (the AI-animate system), two mouths
  (in-app panel, MCP).

## Desktop / real file access (planned with Austin 2026-07-11 — after A & H;
## Category B also queued after A & H per user decision)

- [ ] **D1. File System Access API + PWA (browser, no packaging)** — behind a
  small storage interface (open/save/saveAs/recents): Chromium's
  showSaveFilePicker gives writable in-place Save (no more download-per-save);
  persisted IndexedDB file handles make RECENT FILES real (subsumes the
  Category-B item — don't build it twice); PWA manifest for installability.
  Feature-detected; Firefox/Safari keep the download flow. Small (~day) —
  benefits the deployed Pages app immediately; may slot earlier if desired.
- [ ] **D2. Tauri desktop wrapper (NOT Electron — performance)** — native
  installable reusing D1's storage interface with a Tauri fs/dialog
  implementation: system WebView (WebView2=Chromium on Windows, so canvas
  behavior matches the dev browser), 3–10MB bundles vs Electron's 100MB+
  Chromium+Node, low memory, auto-updater, Win/macOS/Linux. macOS WKWebView
  needs a QA pass (Safari-engine quirks). Electron only if a Node-side need
  ever appears (none foreseen).

## Testing conventions (hard-learned)

- **Dispatch to the true hit target**: interaction tests must target
  `document.elementFromPoint(x, y)` — never a hand-picked element — so overlay
  occlusion bugs (pivot grabs, handles, gizmos) are caught.
- **Simulate full gestures**: a "double-click" is pointerdown/up ×2 then dblclick,
  each re-resolving the hit target (overlays appear between the clicks!). A "drag"
  includes intermediate pointermoves.
- **Never keep DOM references across renders** (test code AND app code): overlay
  rebuilds detach elements; a detached element's CTM is garbage. Re-query, or better,
  compute geometry from the transform strings.
- **Re-read `state.doc` after undo/redo** — snapshots replace the object; captured
  references silently point at the pre-undo clone.
- **Assert on the DOM, not just state** (selection boxes, dimming, handle shapes),
  and on **numeric** outcomes (px drift, cos of angles) rather than "it didn't throw".

## v3 — Future

- Per-bone length/stiffness constraints; pole targets for IK.
- Skin weight painting (manual override of the automatic weights).
- Path boolean ops (union/subtract/intersect), stroke→path outline conversion.
- Mirror-flip by dragging a scale handle through zero.
- 'auto' node type (Inkscape's 'a': continuous re-smoothing as neighbors move).
- Marquee part-selection in pose mode (rubber-band over parts, not just nodes/keys).
- Layers quality-of-life: visibility (eye) and lock toggles, per-part opacity,
  multi-row drag, rename-in-place instead of prompt().
- Copy/paste parts (with artwork) and paste-across-documents (duplicate shipped in
  v2.7 as Ctrl+D).
- Canvas chrome: rulers, guides, zoom percentage indicator + zoom-to-selection
  (simple snapping shipped in v2.7; alignment guide lines while dragging remain).
- Playback range (work area) markers on the timeline; loop a sub-range.
- Keyframe-all-channels button ("key pose") and auto-key toggle.
- Import: gradients, clip-paths, text-to-path fallback; better error surfacing for
  unsupported SVG features.
- Text, gradients, clipping/masks in imports and exports.
- Per-part motion-suggestion AI mode; conversational multi-turn choreography editing.
- Skinning export parity (baked-frame export or a runtime player).

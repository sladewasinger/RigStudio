# Rig Studio Roadmap

Goal: a full-fledged 2D rigging/bones/animation tool with basic vector editing —
modeled loosely after Rive, but simple. Everything through **v2.11 is implemented and
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

## v2.12 — UX overhaul program (planned 2026-07-11, in flight)

Decisions locked with Austin: Setup mode renames to **Edit** (UI/docs only; internal
enum stays `setup`); bones **auto-bind on placement**; AI pose snapshot sends the
**current playhead pose** with clear labeling; the AI structural-edit schema must
work with the reworked bone system.

Implementation phases (P1 first — it moves files — then maximum parallelism):

- [ ] **P1. Architecture docs + feature folders** — CLAUDE.md gains a code-
  architecture section (self-documenting code, ~200-line file guideline — a smell
  threshold, not a hard limit; feature-grouped folders). src/ reorganizes into
  feature folders (core model/history, geometry, io/export, view/, timeline/,
  panels split into layers/inspector/ai modules behind a facade like view's, ai,
  ui). `npm run pages` (Austin's new gh-pages script) must keep working.
- [ ] **P2a. Dialog system + context menus + inline rename** — in-app modal dialogs
  replace every alert/prompt/confirm (save, exports, animation rename/add);
  double-click a layer renames INLINE (input-in-place); right-click context menus
  on layer rows (rename/duplicate/delete/group/ungroup/z-order/bind) and on canvas
  objects (mode-appropriate ops). "Setup" → "Edit" UI rename lands here.
- [ ] **P2b. Node-editing polish + drag bug fixes** — node type glyphs scale with
  zoom (currently vanish when zoomed in); selected nodes get an outline + size
  bump; zero-length bezier handles hidden; segment-bend through a smooth/symmetric
  node preserves the node type (mirrors the opposite handle instead of silently
  degrading to corner); glyph shapes stay Inkscape-parity (diamond corner / square
  smooth / circle symmetric). Fix the gray-triangle visual artifact under the drag
  delta label. Fix rotation keys recording the "wrong direction" (angle wrapping).
- [ ] **P2c. Artboard (canvas size)** — optional, toggleable, resizable canvas rect
  on the doc (defaults from the imported SVG viewBox): rendered as a page
  boundary, editable in the inspector, used as the export reference frame.
- [ ] **P3. Selection & navigation semantics (Inkscape parity)** — double-click
  DIVES into a group (enters context without selecting); further double-clicks
  dive deeper; single clicks inside the context select individual children
  (bounding box on the active item only); blank-click/Escape steps out. Layers
  panel: Shift+click = range select, Ctrl+click = toggle; canvas Shift/Ctrl+click
  = add to selection. Unified V "gizmo" tool in BOTH modes: first click =
  translate/scale handles (body drag translates), second click = rotate/skew
  handles (body drag ROTATES around the pivot — Edit writes rest, Animate keys);
  gizmo shows a rotate circle + move cross with hover highlighting.
- [ ] **P4. Bones 2.0 (the big one)** — femur icon; child bones spawn at the
  parent's tip; placing bones over/inside an art part AUTO-BINDS it (LBS weights)
  so a 3-bone chain bends an arm with zero manual steps; manual refinement mode:
  select path nodes → bind to a bone with an origin↔tip % slider (per-node weight
  overrides); richer inspector (bindings visible/editable per part and per node);
  IK verified end-to-end on a sample multi-bone limb (bend-direction preserving,
  reach-clamped; per-bone rotation limits deferred unless trivially cheap). The
  bone system gets its own design doc section (how weights/bindings work).
- [ ] **P5a. Timeline/Animate overhaul** — named panel sections; per-property
  keyframe toggle circles in the inspector; marquee-friendly padding around key
  lanes; alternating lane colors; transport buttons (⏮ ◀ ▶/⏸ ▶| ⏭); curves/logic
  as a mutually exclusive mode picker + onion as a toggle; dialog-based add/rename;
  visual section separation; a resize splitter between canvas and timeline. Curves
  editor: value snapping + "reset to keyframe value", more vertical headroom,
  pan/zoom in the plot.
- [ ] **P5b. AI assistant polish** — panel visible only in Animate; editor disabled
  during a request with a Cancel button; snapshot option relabeled with a help
  tooltip stating it sends the CURRENT PLAYHEAD pose; structural-edit schema
  extended to the new bone system (AI can split a limb into bound bones).

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

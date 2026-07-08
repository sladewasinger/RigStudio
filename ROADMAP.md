# Rig Studio Roadmap

Goal: a full-fledged 2D rigging/bones/animation tool with basic vector editing —
modeled loosely after Rive, but simple. Two scopes: **v1** is the concrete feature set
being built now; **v2** collects the features a mature tool would add next, so scope
stays honest. Checkboxes track implementation status.

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
- Copy/paste/duplicate parts (with artwork), and paste-across-documents.
- Canvas chrome: rulers, guides, snapping (node↔node, pivot↔pivot, bbox edges),
  zoom percentage indicator + zoom-to-selection.
- Playback range (work area) markers on the timeline; loop a sub-range.
- Keyframe-all-channels button ("key pose") and auto-key toggle.
- Import: gradients, clip-paths, text-to-path fallback; better error surfacing for
  unsupported SVG features.
- A headless interaction-test harness (drive the preview with the realistic-gesture
  helpers from the testing conventions, run as a script) so canvas UX has regression
  coverage beyond unit tests.
- Text, gradients, clipping/masks in imports and exports.
- Animation events/triggers and state-machine blending (Rive's headline feature).
- Per-part motion-suggestion AI mode; conversational multi-turn choreography editing.
- Skinning export parity (baked-frame export or a runtime player).

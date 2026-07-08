# Rig Studio

A browser-based 2D rigging and animation editor for SVG characters that exports
Jetpack Compose rig code. Built originally inside the Dosey Android project
(`C:\Users\Austin\AndroidStudioProjects\Dosey`, branch `fable`) to animate its mascot
**Pip** — a pill with arms and legs — and now developed standalone in this repo.

## What it does

Import a labeled SVG (Inkscape layer groups) → each named group becomes a rig **part**
with a **pivot** (joint) and can be **parented** to another part (bone hierarchy) →
switch between **Setup mode** (edit the character itself: rest pose, pivots, parenting,
path nodes — never keyframed) and **Animate mode** (pose parts on a canvas and record
**keyframes** on a timeline) → organize animations as **clips** (one clip = one "mood")
→ export a Kotlin file that replays the whole rig with Compose `InfiniteTransition`
keyframes and `DrawScope` transforms, or a Lottie JSON file. There is also an AI
assistant panel that sends the rig + active clip (optionally with a rendered snapshot
of the current pose) to the Claude API and applies choreography from a natural-language
prompt, or critiques the existing clip.

## Commands

```sh
npm install
npm run dev        # Vite dev server, http://localhost:5173
npm run build      # tsc --noEmit type-check, then vite build
npm test           # vitest run — unit tests for the pure modules
```

Verify UI changes by loading `public/PIP_MASTER.svg` via the "Load Pip sample" button.
A debug hook exists on `window.__rigStudio` (`state`, `exportCompose`, `exportLottie`,
`renderPose`, `serializeDoc`, `loadProjectText`, `setEditorMode`) for driving the app
from the console.

## Architecture (src/)

| File | Responsibility |
|---|---|
| `model.ts` | Document model (`RigDoc`/`RigPart`/`Clip`/`Track`/`Keyframe`), part hierarchy helpers (`ancestorChain`, `setParent`, cycle-safe), rest pose, app state singleton (`editorMode`: `setup`\|`animate`, multi-selection, playback speed/ping-pong/onion flags), pub/sub (`subscribe`/`notify`), pose sampling (`sampleChannel`, 4 easings), keyframe clipboard (`copyKeys`/`pasteKeysAt`/`copyPoseAt`), project (de)serialization (`serializeDoc`/`deserializeDoc`/`normalizeDoc`) |
| `importSvg.ts` | SVG file → `RigDoc`. Unwraps Inkscape layers; named groups → parts; ellipse/circle/rect → path data; pivots seeded from the *composed matrix's fixed point* (works whether the group is authored as `rotate(a,cx,cy)` or the `matrix(...)` Inkscape rewrites it into) or from `inkscape:transform-center-x/y` as a `pivotHint` resolved once geometry is measurable |
| `view.ts` | Canvas: renders the rig as live SVG, wheel-zoom-at-cursor + middle-drag pan, Setup-vs-Animate drag semantics (Setup drags MOVE the part, Inkscape-style scale/rotate handle sets toggled by re-clicking the selection; Animate drags rotate around the pivot and auto-key), parent-chain-aware pose composition and effective pivots, bone lines, onion-skin ghost layers, multi-part selection/drag, path "entering" via double-click, node editing, overlay visuals |
| `timeline.ts` | Clip transport (play/pause/duplicate/rename/delete/duration, speed selector, ping-pong, onion toggle, fps readout), scrubber, keyframe lanes with click/shift-click/marquee selection, retime drag, a key-property row (time/value/easing) for the selection, copy/paste/nudge/column-select |
| `panels.ts` | Layers **tree** (parts nest under their parent, fold open to show child paths, drag-to-parent / drop-to-unparent), inspector (Setup: rest/pivot/parent fields; Animate: keyed channel fields), Claude assistant panel (prompt animate, critique, optional pose-snapshot attachment) |
| `history.ts` | Snapshot-based undo/redo; call `checkpoint()` BEFORE any doc mutation, one per user gesture |
| `paths.ts` | Path-data parser/serializer (normalizes to absolute M/L/C/A/Z), de Casteljau cubic split for node insertion, `arcToCubics`/`pathToCubics` (W3C endpoint→center parametrization) so arc segments can be split and exported as geometry |
| `transforms.ts` | SVG transform-list parser plus a small affine `Mat` toolkit (`multiply`/`invertMat`/`applyMat`/`rotationMat`); `rotationPivotOf` finds a transform list's fixed point by testing the *composed matrix* for a rigid rotation, so it recovers pivots regardless of whether Inkscape wrote `rotate(...)` or an equivalent `matrix(...)` |
| `exportCompose.ts` | `RigDoc` → Kotlin text (mood enum, keyframe choreography with all 4 easings mapped to Compose easings, rest-pose offsets folded into emitted channels, nested parent-chain `withTransform` calls, `DrawScope` replay of SVG transforms incl. `matrix(...)`) |
| `exportLottie.ts` | `RigDoc` + one clip → Lottie JSON (v5.7.0, 60fps): a root null layer for whole-figure translate/scale, one shape layer per part with Lottie-native `parent` layer references mirroring the bone hierarchy, geometry flattened through baked SVG transforms with arcs converted to cubics, easings converted to bezier handles |
| `ik.ts` | Analytic IK: `solveTwoBone` (law-of-cosines two-joint solve, bend-direction preserving, reach-clamped) and `solveAim`, both in degrees/root space |
| `skin.ts` | Skinning math: `distToSegment`, `skinWeights` (normalized inverse-square distance to bind-time bone segments) |
| `graph.ts` | Curve editor panel: value-vs-time plot per track, draggable keys, per-segment bezier handles writing `Keyframe.bezier` |
| `claude.ts` | Anthropic SDK calls (`claude-opus-4-8`): `animateWithClaude` (adaptive thinking, structured outputs guaranteeing a valid clip JSON, parent-aware system prompt, optional base64 pose snapshot for vision grounding) and `critiqueWithClaude` (plain-text animation review) |
| `main.ts` | Bootstrapping, toolbar (open SVG/project, sample, save project, undo/redo, Compose/Lottie export, Setup/Animate toggle), autosave to `localStorage`, keyboard shortcuts (Tab mode toggle, Ctrl+C/V keyframe copy-paste, Delete, arrow-key nudge-or-scrub, `F` fit-view, Space play) |

## Roadmap

Feature roadmap (v1 checklist + explicit v2 out-of-scope list) lives in `ROADMAP.md`.
All v1 items are implemented and verified as of 2026-07-07.

## Conventions that must hold

- **Coordinates are SVG document space:** +y down, positive rotation = clockwise.
  Every part rotates around its own pivot; `root` is a synthetic target for whole-figure
  translate + scale (jumps, squash-and-stretch) around `rootPivot`.
- **Setup mode edits the character; Animate mode edits keyframes.** Setup is
  Inkscape-like: dragging a part MOVES it (`rest.tx/ty`), the selected part shows
  corner/side scale handles, and clicking it again swaps them for corner rotate handles
  (`rest.rotate`); double-click "enters" a part and selects the path under the cursor
  (Escape backs out). In Animate, dragging a part rotates it around its pivot
  (Shift+drag moves) and calls `setKeyframe()` at the playhead. Pivots and node editing
  are Setup-only. Toggle with the top-right buttons or `Tab`.
- **Keyframed values are ABSOLUTE; the rest pose only fills unkeyed channels**
  (`model.channelValue`). Editing the rest pose in Setup must never shift keyed
  animation — this was an explicit bug fix, do not regress it. Both exporters mirror
  the rule: Compose emits the rest value as the `pose.at(key, default)` default, and
  Lottie emits rest as the static value only when a channel has no keyframes.
- **Rest scale (`rest.sx/sy`) applies innermost — after the baked transform — around
  the pivot mapped into pre-baked local space**, so artwork resizes along its own axes
  and the joint never moves. Like baked transforms, it does NOT propagate to children.
  Compose emits it as a trailing `scale(sx, sy, pivot = localPivot)`; Lottie bakes it
  into the flattened geometry (layer-scale axes would be wrong for rotated art).
- **Part parenting composes like a bone hierarchy.** A part's rendered transform is its
  ancestors' pose transforms (outermost first) followed by its own; `ancestorChain()` is
  cycle-safe and `setParent()` refuses to create one. Effective pivots for gizmos/bone
  lines account for the whole chain (`view.ts`'s `effectivePivot`/`chainMatOf`).
- **Bones and groups are partless parts** (`part.kind: 'art'|'bone'|'group'`,
  `paths: []`). They pose/animate/parent like any part; the canvas draws them as
  interactive glyphs (diamond/square) carrying `data-part-id`. Compose export skips
  their draw functions but keeps them in child transform chains; Lottie exports them
  as null layers (ty 3). `ungroupPart()` dissolves a REST-POSED null exactly (angles
  add; translations remap affinely, resampled on union key times when the group is
  rotated) and refuses if the null itself has keyframes.
- **Group-aware selection**: clicking artwork inside a closed `group` selects the
  group; double-click steps in (group → part → path); Escape/blank click steps out
  (`view.ts`'s `enteredGroups`).
- **Moving a pivot never moves the artwork.** A Setup pivot drag solves the new pivot
  together with a rest-translation compensation (`view.ts` pivot drag branch): the
  pivot anchors both the part's own rotation and the innermost rest scale/skew, so
  writing it alone shifts the rendered part. Keyed tx/ty are absolute and stay
  untouched (moving a joint under keyed animation legitimately changes those frames).
  Overlay handle strokes use `vector-effect: non-scaling-stroke` — widths are screen
  px, radii doc units via `handleSize()`; keep new overlay chrome on that pattern.
- **Flips are negative rest scale** pinned at the part's rendered bbox center — never
  a geometry rewrite — so both exporters inherit them through the existing rest-scale
  paths. The scale-drag clamp applies to drag factors, not stored values; don't
  "sanitize" negative sx/sy anywhere.
- **Keyed easing precedence:** `Keyframe.bezier` (CSS cubic-bezier on the ARRIVING
  segment, set by the curve editor) overrides `Keyframe.easing` everywhere — model
  sampling, Compose (`CubicBezierEasing`), Lottie (o/i handles). Presets stay the
  fallback; the AI schema only speaks presets.
- **Skinned parts** (`part.skin`) render via per-frame linear-blend deformation of
  their REST path data (never mutate `path.d` at render time — only the DOM `d`
  attribute). Binding bakes all static transforms into `path.d` and zeroes
  pose/parent; weights are runtime-derived from `bindSeg` distances. Skinned parts
  don't respond to pose drags and export rigidly.
- **Tool semantics** (`state.tool`): 'select' keeps the classic mode-dependent drags;
  'translate'/'rotate' force that manipulation in both editor modes (Setup → rest,
  Animate → keys); 'ik' rotates the two nearest ancestor joints (`src/ik.ts`). Gizmo
  drags reuse the exact same drag pipelines as body drags.
- **Node types are Inkscape's convention** (`RigPath.nodeTypes`, one char per drawing
  command, Z excluded): 'c' corner, 's' smooth (mirror direction), 'z' symmetric
  (mirror direction + length). They BIND handle-drag behavior and are set by the node
  ops; keep the string in sync through any command-count change (see
  `editNodeStructure` / `ensureNodeTypes`). Untyped (null) paths use collinearity
  detection — do not fabricate flags on import.
- **Rest skew (`rest.kx/ky`, degrees)** lives with rest scale in the innermost local
  transform around the local pivot and composes tan-additively during drags. Compose
  export folds scale+skew into one `svgMatrix` ONLY when skew ≠ 0 — the plain
  `scale(..., pivot = ...)` emission is load-bearing for skew-free parts (tests pin
  it).
- **Pivots are recovered from the composed transform matrix, not the transform-list
  syntax** — Inkscape freely rewrites `rotate(a,cx,cy)` as an equivalent `matrix(...)`,
  so `rotationPivotOf` in `transforms.ts` tests whether the *composed* matrix is a rigid
  rotation and solves for its fixed point either way. `inkscape:transform-center-x/y` is
  a fallback hint (bbox-center offset, +y flipped from Inkscape's legacy axis) resolved
  once the canvas can measure geometry.
- **Easing lives on the ARRIVING keyframe** in the model (`linear`/`easeIn`/`easeOut`/
  `easeInOut`); both exporters look one keyframe ahead to emit the correct easing on the
  segment leaving the previous key (Compose `using`, Lottie `o`/`i` bezier handles).
- **`checkpoint()` before every mutation, once per gesture.** Drags defer the checkpoint
  to the first pointer movement (past a small pixel threshold) so plain clicks don't
  pollute history.
- **Exported Kotlin must compile against the Dosey app** (Compose BOM there). Known
  traps already handled: float `f` suffixes, `rememberInfiniteTransition` lives in
  `androidx.compose.animation.core`, scientific notation in path data gets expanded,
  `withTransform` brace balance. If the exporter changes, re-verify by dropping an
  export into the Dosey app (`app/src/main/java/com/austinwasinger/dosey/ui/components/`)
  and running `gradlew :app:compileDebugKotlin`. A previous export lives there as
  `PipStudioRig.kt` and shows on Dosey's debug Test tab. **This has not been re-run**
  since the parent-chain/rest-folding/new-easings changes below — do it before treating
  the exporter as shippable.
- **The canonical Pip artwork** is `Dosey/media/PIP_MASTER.svg`; `public/PIP_MASTER.svg`
  here is a bundled sample copy — re-sync it when the master changes.

## Testing interactions (do not regress this)

Synthetic-event verification MUST simulate real input or it will pass while the app
is broken (this happened): dispatch to `document.elementFromPoint(x,y)` — the true
hit target — not a hand-picked element; simulate full gestures (double-click =
down/up ×2 + dblclick, re-resolving the target between clicks because overlays
appear); re-query elements after any render and re-read `state.doc` after undo;
assert numerically (px drift, cos angles) and on the DOM. Full checklist lives in
ROADMAP.md "Testing conventions".

## Status

### Eighth wave (v2.6 bug fixes & small improvements) — implemented and verified

All four ROADMAP v2.6 items, verified live with realistic gestures (true hit targets
via elementFromPoint, full down/move/up sequences, numeric assertions); `npm run
build` clean; 161 tests passing.

- **Zoom-proof pivot handle**: the pivot ring/crosshair drew strokes in document
  units while the radius stays screen-constant, so zooming in fattened the stroke
  until the handle collapsed into a blob. Pivot handle, pivot ghosts, bone lines, and
  drag-gizmo strokes now use `vector-effect: non-scaling-stroke`. Verified: ring held
  a 13.2 px screen diameter from fit zoom through 9.9×.
- **Pivot drags never move the artwork** (the reported bug): the pivot anchors the
  part's own rotation AND the innermost rest scale/skew, so re-anchoring it shifted
  any part with rest rotate/scale/skew. The drag now solves the new pivot together
  with a rest-translation compensation in one exact Jacobian step (the own matrix is
  affine in the pivot; compensation is computed absolutely from a drag-start snapshot
  so per-move rounding never accumulates; the compensation uses 0.001 rounding —
  `round3` — because 0.1 would visibly wiggle the art). Verified 0.002 px artwork
  drift at 10× zoom dragging the pivot of a part with rotate 25° / sx 1.3 / skew 5°,
  pivot marker chasing the pointer within 0.23 px; identity parts keep rest.tx/ty
  exactly 0; one undo restores the whole gesture.
- **Ctrl constrains moves to the dominant axis** in every free translate drag (Setup
  body move, Animate Shift+move, gizmo center square); the dashed line + Δ readout
  now show the CONSTRAINED point. Verified both dominance directions numerically
  (frozen channel stayed byte-identical, gizmo line exactly axis-aligned).
- **Arrow-key part nudge** (Setup pose mode): arrows nudge all selected non-skinned
  parts 2 screen px (Shift = 20) through the zoom and each part's parent chain
  (`view.ts nudgeSelectedParts`), checkpointed per press. Verified 0.855 units at
  2.34× fit zoom and 0.141 at 14×, both exactly 2 px; no tracks created in Setup;
  Animate arrows still nudge keys / scrub the playhead (precedence unchanged: nodes →
  setup parts → keys/scrub in main.ts).

### Seventh wave (drill-down UX overhaul) — implemented and verified

All verified with REALISTIC gestures (true hit targets via elementFromPoint, full
click sequences); build clean; 161 tests passing.

- **Double-click drill-down FIXED** (the reported bug): the first click of a
  double-click selects the group and draws its pivot grab circle at the selection
  center — exactly where the second click lands — so the overlay ate the dblclick
  (and could start an accidental pivot drag). dblclick now resolves artwork through
  the overlay via `elementsFromPoint` (`view.ts artworkUnderPointer`); pivot grab
  radius reduced 2.2×→1.6×. Verified with a true double-click on the body center of
  a full-figure group: drills to the body.
- **Focus/fade drill-down**: entered groups and node editing dim everything outside
  the context (`focusContext()` → `g.dimmed`, opacity 0.22 + pointer-events none).
  Faded parts can't be selected; clicks fall through (blank ⇒ exits focus). Verified:
  7/8 parts dimmed in node mode; clicking faded artwork selected nothing.
- **Node-mode canvas ownership**: canvas clicks in node mode never switch parts —
  near the edited outline they start a SEGMENT BEND; anywhere else (including over
  faded artwork) they rubber-band nodes. Verified a marquee swept across the faded
  body selecting 7 leg nodes without touching the selection.
- **Segment bending**: minimal-norm two-control-point solve keeps the endpoints
  fixed and moves the grab-parameter point exactly with the pointer (verified 0.4 px
  final error); L segments auto-convert to C ("handles grow"). `segmentHit` samples
  L/C segments within a handle-size tolerance; arcs are not bendable (insert a node
  to convert first). Two follow-up fixes, both verified on left_leg.leg's top edge:
  (1) the implicit Z CLOSING segment is bendable — first movement splices an
  explicit closing cubic in front of the Z (types string gets a 'c' for the new
  node, shape stays closed, curve-through-pointer 0.1 px); (2) bend hit-testing is
  GEOMETRIC against the edited paths only — the event target is ignored, so a
  sibling path drawn on top (the leg's inner shadow) can't swallow the drag.
- **Inkscape node shapes**: corner = diamond, smooth = square, symmetric = circle
  (untyped = small circle). Verified 5 squares + 2 diamonds on left_leg's `csssssc`.

### Sixth wave (bug fixes + polish) — implemented and verified

- **Node-drag teleport FIXED**: node/handle drags used a captured overlay element's
  screen matrix; the overlay rebuild on node-select detached that element, and a
  detached element's CTM is garbage → nodes flew off-screen. Drags now map the
  pointer through the svg's own screen CTM plus the TRANSFORM STRINGS
  (`pointerInPathSpace`), which also makes them exact under any zoom/pan. Verified:
  endpoint and control-handle drags land at 0.0 px from the pointer at 6× zoom with
  the view panned. Rule going forward: never keep overlay DOM references across
  renders — compute from strings.
- **Delete removes layers** (Setup, pose tool): deletes every selected part;
  children re-adopt the nearest surviving ancestor, tracks and skin references are
  scrubbed, canvas groups unregistered. Verified for a group (children survive and
  detach) and an art part, plus full undo. Delete still means keyframes in Animate
  and nodes in node-editing mode — that precedence order lives in main.ts.
- **Groups draw a dashed selection box** around the union of their descendants'
  rendered boxes (root-space AABB, passive holder), primary/secondary styling like
  parts. Verified on a body+face group.
- **Click-vs-double-click**: re-verified — slow second click on the selected part
  swaps scale/rotate handle sets; a quick double-click drills down
  (group → part → path).

### Fifth wave (v2 second batch) — implemented and verified

All three remaining v2 items from the original list. Verified live (Pip sample +
synthetic pointer/keyboard, DOM/numeric assertions), `npm run build` clean, **161
unit tests passing** (adds sodipodi import, skew parse/compose, and skew-export
tests; two stale tests updated for skew becoming a supported transform).

- **Persistent node types**: `sodipodi:nodetypes` imports verbatim (verified
  `cssssscc` on left_leg), tints handles, and drives dragging — a control-handle drag
  on a typed 's' node mirrors its partner exactly (cos = −1) regardless of prior
  collinearity; 'z' also matches lengths; 'c' is free; untyped falls back to
  collinearity detection. smooth/symmetric/corner ops write the flag (verified a
  marquee + corner op rewrote exactly the selected chars); insert/delete splice the
  string; Inkscape's occasional extra closing char is normalized lazily.
- **Node multi-select**: Shift+click toggle, blank-canvas rubber band (client-rect
  hit test, div anchored to #canvas), group drag with identical deltas across nodes
  (cross-path via holder-matrix conversion), multi-node ops, Delete, arrow nudge
  (0.5 / Shift 5 doc units). Structure edits clear the node selection (indexes
  shift).
- **Skew handles**: in the rotate handle set, side handles shear with the opposite
  edge pinned (verified kx = −5.6° with 0 px opposite-edge drift), tan-additive
  composition, ±85° clamp. `rest.kx/ky` render via skewX/skewY in the innermost
  local transform; skew parses/composes in transforms.ts (exhaustive union — the old
  "ignore with warning" behavior is gone). Compose folds pivot+scale+skew into one
  `svgMatrix(...)` (plain scale emission is preserved when skew is 0); Lottie bakes
  skew into geometry; baked SVG skewX/skewY in imports also export now.

### Fourth wave (v2 first batch) — implemented and verified

All verified live (synthetic pointer/keyboard + DOM/numeric assertions), build clean,
**158 unit tests passing** (adds `ik.test.ts` — solver reach/clamp/bend-direction and
skin-weight math — and the curve editor's `graph.test.ts`).

- **Context-aware movement** (bug fix): selecting a part inside a group via Layers
  now opens its ancestor groups and canvas drags manipulate THAT part; verified the
  reported scenario (group all but shadow → pick right_arm in Layers → drag moves the
  arm, group untouched). Already-selected parts are never hijacked back to the group.
- **Transform tools** (`state.tool`, keys V/T/R/I + icon switcher): translate gizmo
  with axis arrows (verified: X-arrow drag with a diagonal pointer moved tx only),
  rotate ring, IK tool. Flips rebound to Shift+H/V.
- **IK**: two-bone analytic solve in `src/ik.ts`; verified live on a placed bone
  chain — both ancestor joints rotate, the grabbed part's own channel untouched, the
  grab point chases the pointer. Works on rest (Setup) and keys (Animate).
- **Bones v2**: press-drag-release placement (origin→tip, live preview), kite glyph,
  Setup tip handle. `RigPart.boneTip` in the part's own frame.
- **Skinning**: `bindSelectedToBones()` bakes chain+rest+baked+path transforms into
  rest geometry (stroke widths scaled), zeroes pose, stores per-bone `restWorldInv` +
  `bindSeg`; per-frame LBS rewrites d attributes (`renderSkinnedPart`, runtime weight
  cache keyed by geometry signature). Verified: bind → bone rotation deforms the
  rendered path while `path.d` rest data stays untouched; Setup shows rest; unbind
  restores rigidity. Exports render skinned parts RIGIDLY (documented limitation).
- **Curve editor** (`src/graph.ts` + timeline "curves" toggle): verified a preset
  handle grab converts the segment to a custom bezier (x-clamped, y overshoots
  allowed), sampling honors it (rendered pose differs vs preset and restores
  exactly), and both exporters map it (Compose `CubicBezierEasing`, Lottie o/i).
  Gotcha fixed: never draw only inside requestAnimationFrame — headless previews
  produce no frames; draw immediately, refine on rAF.
- **Icons**: inline SVG set (`panels.ts` `ICON_PATHS`) for tools/flip/group/bone/
  bind/align buttons.

### Third wave (v1 roadmap) — implemented and verified

Everything in ROADMAP.md's v1 sections, all verified live in the preview with
numeric/DOM assertions; `npm run build` clean; **142 unit tests passing** (adds
`align.test.ts` — 35 tests — plus bone/group/structural and exporter-null coverage).

- **Flip H/V** (Setup: `H`/`V` keys + canvas-tools buttons): negates rest sx/sy with
  bbox-center compensation — verified 0.1 px center drift, pivot untouched, flip-back
  exact.
- **Align & distribute** (inspector section, Setup, with reference dropdown:
  selection/first/last/canvas): pure math in `src/align.ts`, applied through
  parent-chain-aware rest translation. Verified left-align converges edges to within
  the 0.1-unit rest rounding.
- **Bezier node editing**: handle lines, node click-selection, one-shot
  smooth/symmetric/corner(retract) ops, line↔curve conversion, and smooth-node
  mirroring during control-point drags (Alt breaks). Verified numerically: symmetric
  → equal lengths and cos = −1 opposition; mirror preserved through a drag; →line
  removes and →curve restores control handles.
- **Bones**: canvas-tools "+ bone" then click places a `kind:'bone'` part parented to
  the selection (pivot stored through the parent's full pose chain). Diamond glyph is
  selectable/draggable; bones ride parent chains and auto-key their own rotation in
  Animate. Multi-joint chains = bones parented to bones.
- **Groups**: Ctrl+G wraps selection (outermost members only, common parent adopted,
  pivot at selection-bbox center); Ctrl+Shift+G dissolves — verified ZERO render
  drift dissolving a 25°-rotated group, with keyed rotations shifted and keyed
  translations remapped (union-time resampling when rotated; unit-tested against
  composed matrices). Group-aware clicks: click selects group, dblclick enters,
  Layers Ctrl+click toggles rows; bone ◆ / group ▣ icons; ancestors of the selection
  auto-expand.
- **Exporters**: Compose skips partless draw functions but keeps bones/groups in
  child chains (unit-tested); Lottie emits them as ty:3 null layers (live-verified).
- **AI structural mode**: "allow rig changes" toggle → extended structured-output
  schema (addBones/reparent/movePivots by label), applied atomically before track
  resolution in one undo step (`model.applyRigChanges`, unit-tested: cycle guards,
  duplicate-label skip, label→id map). Scene JSON now carries part kinds. NOT run
  against the live API (needs a real key) — the apply path is unit-tested, the
  schema/prompt are reviewed only.
- Layout: new slim canvas-tools bar above the canvas (`#canvas-col` wrapper).

### Second wave — implemented and verified (previous session)

All verified live in the preview (synthetic pointer/keyboard events + DOM assertions),
type-check and `npm run build` clean, 40 existing unit tests still passing.

- **Absolute keyframe semantics** (bug fix): keying a rotation, then changing the rest
  rotation in Setup, used to shift the animation; now keyed channels are absolute and
  rest only fills unkeyed ones. Verified: a 45° rest change leaves both the keyed value
  and the rendered animate-mode transform byte-identical, and an unkeyed channel
  follows rest. Compose/Lottie exporters updated and verified for both cases.
- **Inkscape-style Setup handles**: select → 8 scale handles (corners + sides, Ctrl on
  a corner = uniform); click the part again → 4 rotate handles; click again → back.
  Body drag moves the part. Verified numerically: a 20% SE-corner drag set
  `rest.sx/sy = 1.2` with 0.1 px anchor drift and an unchanged pivot; rotate-handle
  drag wrote `rest.rotate` only; no keyframes were created by any Setup interaction.
- **Path-level selection**: clicking a sub-item in Layers or double-clicking artwork
  on canvas "enters" the part and selects that path (gold outline highlight); the
  inspector grows an object section (fill/stroke color pickers, opacities, width);
  node editing scopes to the entered path; Escape steps back out (path → part → none).
- **Timeline polish**: key bar is a fixed 30 px row (no more height jolt on key
  selection); clicking a keyframe scrubs the playhead to it and the playhead follows
  while retiming; "+ clip" renamed to "+ animation" ("delete clip" → "delete").
- **Blank-canvas deselect**: a click on empty canvas clears the whole multi-selection
  AND repaints the overlay. Two bugs lived here: the pre-rework svg only covered 96%
  of the canvas (gutter clicks hit dead space), and the blank-click branch called
  notify() without a repaint — state and Layers cleared but the selection box
  lingered on canvas, because only drags repaint on pointerup and a blank click
  starts no drag. Verified against the overlay DOM (boxes/handles/crosshair all gone
  on pointerdown) in both modes. Lesson: when verifying selection changes, assert on
  the overlay DOM, not just state.
- **Z-order (visibility) reordering**: `doc.parts` order is the paint order (last =
  topmost). Layer rows accept three drop zones — top edge places the dragged part
  just ABOVE the row (insertion line feedback), bottom edge just BELOW (both adopt
  the row's parent, i.e. sibling insertion), middle parents INTO it as before.
  PageUp/PageDown step the selected part — or the entered path within its part —
  up/down the draw order; `view.reorderCanvas()` re-appends the existing DOM nodes
  (no rebuild). Verified live: model order, DOM paint order, drop-zone feedback
  classes, sibling parent adoption, cycle refusal, and boundary no-ops.
- `vite.config.ts` now honors a `PORT` env var and `.claude/launch.json` sets
  `autoPort`, so the preview harness coexists with a manually running dev server
  on 5173.

### First wave — implemented and verified (previous session)

Verified via `npx tsc --noEmit` (clean) plus direct interaction in a live preview
(`window.__rigStudio` + synthetic pointer/keyboard events), including a full page
reload to confirm autosave.

- **Pivot fix** — the actual bug report: `right_arm`'s pivot was landing at the arm's
  bbox center instead of the shoulder. Root cause was `rotationPivotOf` only handling
  literal `rotate(a,cx,cy)` syntax; Inkscape had rewritten some of PIP_MASTER.svg's
  joints as `matrix(...)`. Now derives the fixed point from the composed matrix.
  Confirmed in-browser: `right_arm` now resolves to `(66.641, 119.592)`, matching the
  SVG's authored `rotate(-82.006791,66.641375,119.59214)` exactly.
- Setup/Animate mode toggle (top right, also `Tab`) — confirmed rig drags in Setup only
  change `part.rest` and never create tracks; the same drag in Animate keys the channel.
- Canvas zoom (scroll wheel, anchored at the cursor) and pan (middle-mouse drag) via
  viewBox manipulation, plus `F` to re-fit.
- Part parenting (bone hierarchy): Layers-panel drag-to-parent / drop-to-unparent,
  cycle-safe `setParent`, chained pose composition on canvas, bone-line overlay, and
  parent-chain `withTransform` nesting in the Compose exporter — confirmed a rotated
  parent carries its child's rendered transform correctly.
- Onion skinning — ghost layers of the previous/next keyed pose, toggle in the
  timeline transport bar.
- Multi-part selection (Shift+click) with a transform box per selected part; group
  rotate/translate drags apply to the whole selection.
- Keyframe selection (click, Shift+click, marquee box-select over empty lane space),
  a key-property row (time/value/easing) for the selection, Ctrl+C/Ctrl+V copy-paste
  at the playhead, "copy pose"/"select column" utilities, Delete/Backspace, arrow-key
  nudge — confirmed a full copy→retarget-playhead→paste round trip.
- Easing editor: 4 easings (`linear`/`easeIn`/`easeOut`/`easeInOut`) selectable per
  keyframe from the timeline.
- Layers panel rebuilt as a folder tree: parts nest under their parent, fold open to
  reveal child paths, rename via double-click.
- Project save (`.rig.json` download) / open (accepts `.svg` or a saved project) /
  autosave to `localStorage` — confirmed keyframes, pivots, and parenting all survive
  an actual page reload.
- Compose exporter updates: rest-pose offsets folded into emitted channel expressions,
  nested parent-chain transforms, new easing mapping (`easeOut` → `LinearOutSlowInEasing`,
  `easeIn` → `FastOutLinearInEasing`, `easeInOut` → `FastOutSlowInEasing`) — confirmed by
  inspecting generated Kotlin text for all three.
- Arc→cubic conversion (`arcToCubics`/`pathToCubics`) so node insertion works on arc
  segments and non-Compose exporters get pure-cubic geometry — covered by unit tests.
- `npx tsc --noEmit` passes clean across the whole codebase.

### Implemented but not independently verified

Code is written and type-checks, but either couldn't be exercised live (needs a real
Anthropic API key, or a real Lottie/Compose consumer) or was only checked structurally.
The second wave's exporter changes (absolute semantics, rest-scale emission) were
re-verified structurally but the two external-consumer checks below are still owed.

- **Lottie exporter** (`exportLottie.ts`) — verified structurally in-browser (layer
  count, parent references, anchor points, animated-rotation keyframe times, shape
  command types all look right for the Pip sample), but **not** opened in an actual
  Lottie player (lottie-web / After Effects / a Lottie preview site). Do that before
  relying on it.
- **Claude assistant updates** — new 4-easing schema, parent-aware system prompt,
  optional pose-snapshot (vision) attachment via canvas rasterization, and a new
  "Critique this animation" text-mode call. Reviewed but not run against the live API
  in this session (needs a real key).
- **Compose export re-verification against Dosey** — per the convention above, the
  exporter's output shape changed (rest folding, nested parent chains, new easing
  imports) and has **not** been re-dropped into the Dosey app / compiled with
  `gradlew :app:compileDebugKotlin`. Do this before shipping.
- Playback speed selector, ping-pong looping, and the fps readout — implemented and
  present in the DOM, but not exercised through an actual multi-second playback run in
  this session (only inspected statically).
- Drag-to-parent in the Layers panel — the underlying `setParent()`/cycle-rejection
  logic is verified, but the HTML5 drag-and-drop wiring itself wasn't exercised with
  synthetic `dragstart`/`drop` events (they're awkward to simulate outside a real
  browser drag gesture).

### Unit tests — done

`npm test`: **5 files, 101 tests, all passing.** `paths` (parse/serialize/arc→cubic/
node insertion), `transforms` (matrix ops, rotation fixed points from both rotate()
and matrix() spellings), `model` (channelValue absolute/rest-fallback semantics,
sampling/easings, keyframe clipboard, parenting/cycles, `normalizeDoc` back-compat),
`importSvg` (jsdom: layer unwrap, pivot seeding incl. transform-center y-flip, shape
conversion, label/transform accumulation), `exportCompose` (pose.at rest defaults,
rest-scale emission, parent-chain ordering, all easing suffixes). One bug found by the
test pass was fixed in `model.ts`: `setKeyframeAt` now applies an explicitly passed
easing when replacing an existing key (paste carries the copied easing) while drags,
which omit it, still preserve a hand-set easing. Not covered: the DOM-heavy modules
(`view`/`timeline`/`panels`/`main`), `exportLottie`, `claude.ts`.

### Not started

- No visual/screenshot regression proof exists (`preview_screenshot` reliably times
  out in this environment even though the page is responsive); verification relies on
  DOM inspection and scripted pointer/keyboard events through `window.__rigStudio`.
  Worth a manual look in a real browser before shipping.
- Skew (Inkscape's rotate-mode side handles) and mirror-flip through scale handles
  (factors are clamped positive) are unimplemented.
- Per-part AI motion suggestions and richer critique-mode UI (currently a single
  scrollable text block) are unbuilt.

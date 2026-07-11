# Rig Studio

A browser-based 2D rigging and animation editor for SVG artwork that exports Rive
`.riv` files and Lottie JSON. A generic tool for any character/app (it began life
animating an Android app's mascot; that coupling has been fully removed — keep it
that way: no app-specific code, naming, or export assumptions).

## What it does

Import a labeled SVG (Inkscape layer groups) → each named group becomes a rig **part**
with a **pivot** (joint) and can be **parented** to another part (bone hierarchy) →
switch between **Setup mode** (edit the character itself: rest pose, pivots, parenting,
path nodes — never keyframed) and **Animate mode** (pose parts on a canvas and record
**keyframes** on a timeline) → organize animations as **clips** (one clip = one "mood")
→ define **state machines** (inputs, transitions, listeners) in the `🔀 logic` view
→ export a Rive `.riv` binary (all clips as named animations plus state machines;
plays in official Rive runtimes everywhere — by design NOT openable in the Rive
editor, which cannot import .riv) or a Lottie JSON file. There is also an AI
assistant panel that sends the rig + active clip (optionally with a rendered snapshot
of the current pose) to the Claude API and applies choreography from a natural-language
prompt, or critiques the existing clip.

## Commands

```sh
npm install
npm run dev              # Vite dev server, http://localhost:5173
npm run build            # tsc --noEmit type-check, then vite build
npm test                 # vitest unit project — pure-module tests
npm run test:interaction # vitest browser project (headless Chromium) — real-gesture canvas tests
```

Verify UI changes by loading `public/PIP_MASTER.svg` via the "Load sample" button.
A debug hook exists on `window.__rigStudio` (`state`, `exportLottie`, `exportRiv`,
`renderPose`, `serializeDoc`, `loadProjectText`, `setEditorMode`) for driving the app
from the console; `window.__smPanel` drives the state-machine editor deterministically.

## Architecture (src/)

| File | Responsibility |
|---|---|
| `model.ts` | Document model (`RigDoc`/`RigPart`/`Clip`/`Track`/`Keyframe`), part hierarchy helpers (`ancestorChain`, `setParent`, cycle-safe), rest pose, app state singleton (`editorMode`: `setup`\|`animate`, multi-selection, playback speed/ping-pong/onion flags), pub/sub (`subscribe`/`notify`), pose sampling (`sampleChannel`, 4 easings), keyframe clipboard (`copyKeys`/`pasteKeysAt`/`copyPoseAt`), project (de)serialization (`serializeDoc`/`deserializeDoc`/`normalizeDoc`) |
| `importSvg.ts` | SVG file → `RigDoc`. Unwraps Inkscape layers; named groups → parts; ellipse/circle/rect → path data; pivots seeded from the *composed matrix's fixed point* (works whether the group is authored as `rotate(a,cx,cy)` or the `matrix(...)` Inkscape rewrites it into) or from `inkscape:transform-center-x/y` as a `pivotHint` resolved once geometry is measurable |
| `view.ts` | **Pure re-export facade (33 lines)** over the `src/view/` modules — consumers import ONLY `./view`, never deep paths. The canvas responsibilities live in 13 layered modules: `view/context.ts` (shared mutable state `ctx`, DragState type, constants, micro-utils), `view/coords.ts` (screen↔doc conversion from live CTM/transform strings), `view/pose.ts` (pose composition, effective pivots, `partRootBoxes`), `view/focus.ts` (drill-down/dimming, `artworkUnderPointer`), `view/skinRender.ts` (LBS deformation + private cache), `view/overlay.ts` (selection boxes, handle sets, pivots, gizmos, node handles — render-time side effects live here on purpose), `view/snapping.ts` (candidate collection wiring), `view/render.ts` (`renderPose`, onion skins, `setPoseSampler`), `view/partDom.ts` (part-group/path DOM registry), `view/nodeEditing.ts` (node ops, drag math, structural join/delete), `view/rigOps.ts` (flip/nudge/bind/bone placement), `view/camera.ts` (viewBox zoom/pan/fit), `view/interactions.ts` (pointer routing, every drag pipeline, checkpoint deferral), `view/canvas.ts` (`buildCanvas`, render-then-measure pivot seeding) |
| `timeline.ts` | Clip transport (play/pause/duplicate/rename/delete/duration, speed selector, ping-pong, onion toggle, fps readout), scrubber, keyframe lanes with click/shift-click/marquee selection, retime drag, a key-property row (time/value/easing) for the selection, copy/paste/nudge/column-select |
| `panels.ts` | Layers **tree** (parts nest under their parent, fold open to show child paths, drag-to-parent / drop-to-unparent), inspector (Setup: rest/pivot/parent fields; Animate: keyed channel fields), Claude assistant panel (prompt animate, critique, optional pose-snapshot attachment) |
| `history.ts` | Snapshot-based undo/redo; call `checkpoint()` BEFORE any doc mutation, one per user gesture |
| `paths.ts` | Path-data parser/serializer (normalizes to absolute M/L/C/A/Z), de Casteljau cubic split for node insertion, `arcToCubics`/`pathToCubics` (W3C endpoint→center parametrization) so arc segments can be split and exported as geometry |
| `transforms.ts` | SVG transform-list parser plus a small affine `Mat` toolkit (`multiply`/`invertMat`/`applyMat`/`rotationMat`); `rotationPivotOf` finds a transform list's fixed point by testing the *composed matrix* for a rigid rotation, so it recovers pivots regardless of whether Inkscape wrote `rotate(...)` or an equivalent `matrix(...)` |
| `exportLottie.ts` | `RigDoc` + one clip → Lottie JSON (v5.7.0, 60fps): a root null layer for whole-figure translate/scale, one shape layer per part with Lottie-native `parent` layer references mirroring the bone hierarchy, geometry flattened through baked SVG transforms with arcs converted to cubics, easings converted to bezier handles |
| `exportRiv.ts` | `RigDoc` + ALL clips → Rive `.riv` binary (format major 7): varuint/ToC writer, typeKey/propertyKey table derived from rive-runtime `dev/defs` (cited in-file), Backboard→Artboard→Node-per-part-at-pivot (geometry baked to docPoint−pivot, rest scale/skew baked in, rotation in RADIANS), Shape/PointsPath/CubicDetachedVertex geometry, Fill/Stroke/SolidColor (opacity folded into alpha), one LinearAnimation per clip with KeyedObject/KeyedProperty/KeyFrameDouble + CubicEaseInterpolators (interpolators emitted BEFORE animations — animation objects consume no component index). Deterministic bytes; playback-only (the Rive editor cannot import .riv) |
| `ik.ts` | Analytic IK: `solveTwoBone` (law-of-cosines two-joint solve, bend-direction preserving, reach-clamped) and `solveAim`, both in degrees/root space |
| `skin.ts` | Skinning math: `distToSegment`, `skinWeights` (normalized inverse-square distance to bind-time bone segments) |
| `graph.ts` | Curve editor panel: value-vs-time plot per track, draggable keys, per-segment bezier handles writing `Keyframe.bezier` |
| `align.ts` | Align & distribute math (`alignDeltas`/`distributeDeltas`, pure functions over part bboxes with selection/first/last/canvas reference options); applied through parent-chain-aware rest translation from the inspector |
| `snap.ts` | Pure snapping math (`snapPoint`/`snapDelta`/`boxFeaturePoints`: nearest candidate within a threshold, axis-lock aware, box = center + corners + edge midpoints); view.ts collects candidates and applies it to Setup-mode node/pivot/part-translate drags |
| `help.ts` | `SHORTCUTS` registry (single source of truth for documented bindings) and the `?`/F1 keyboard-shortcut overlay (`openHelp`/`closeHelp`/`toggleHelp`/`isHelpOpen`) |
| `stateMachine.ts` | Pure state-machine evaluator (`createSMInstance`): entry resolution, any-then-current transition evaluation (array order, at most one per advance), bool/number/trigger conditions (triggers arm until consumed at end of an advance's evaluation), crossfade blending running both clip clocks with the absolute-keys/rest-fallback rule, exit-freeze, rest pseudo-state (`SM_REST_STATE_ID`); deterministic — time flows only through `advance(dtMs)` |
| `smPanel.ts` | State-machine editor UI (the timeline's `🔀 logic` view): machine CRUD, draggable state graph (positions persist on `SMState.x/y`), armed click-click transition creation, condition/duration editors, inputs list (live controls during preview), listeners editor; ▶ preview drives the canvas via view's `setPoseSampler` hook + rAF, capture-phase pointer listeners map canvas hits (ancestor-inclusive) to listener actions; `window.__smPanel` debug hook with deterministic `tick(dtMs)` |
| `claude.ts` | Anthropic SDK calls (`claude-opus-4-8`): `animateWithClaude` (adaptive thinking, structured outputs guaranteeing a valid clip JSON, parent-aware system prompt, optional base64 pose snapshot for vision grounding) and `critiqueWithClaude` (plain-text animation review) |
| `main.ts` | Bootstrapping, toolbar (open SVG/project, sample, save project, undo/redo, Compose/Lottie export, Setup/Animate toggle, `?` help), autosave to `localStorage`, and the single global `keydown` handler: Tab mode toggle; Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y undo/redo; Ctrl+S/O save/open; Ctrl+A select-all (nodes in node mode, else parts); Ctrl+D duplicate parts (Setup, skips skinned); Ctrl+G / Ctrl+Shift+G group/ungroup; Ctrl+C/V keyframe copy-paste; V/T/R/I tool keys; `%` snapping toggle; Shift+H / Shift+V flips; `+`/`-` zoom; `?`/F1 help overlay; PageUp/PageDown z-order; Delete and arrows resolve by context (animate keys → nodes → setup parts → playhead scrub); Escape tiers (help overlay → bone placement → path → group/deselect); `F` fit-view; Space play (F/Space/letter keys fire only without ctrl/meta/alt) |

## Roadmap

Feature roadmap lives in `ROADMAP.md`: v1 through v2.11 are all implemented and
verified as of 2026-07-11; "v3 — Future" is the out-of-scope / next-up list.

## Conventions that must hold

- **Coordinates are SVG document space:** +y down, positive rotation = clockwise.
  Every part rotates around its own pivot; `root` is a synthetic target for whole-figure
  translate + scale (jumps, squash-and-stretch) around `rootPivot`.
- **Setup mode edits the character; Animate mode edits keyframes.** Setup is
  Inkscape-like: dragging a part MOVES it (`rest.tx/ty`), the selected part shows
  corner/side scale handles, and clicking it again swaps them for corner rotate
  handles (`rest.rotate`) plus side skew handles (`rest.kx/ky`); double-click
  "enters" a part and selects the path under the cursor
  (Escape backs out). In Animate, dragging a part rotates it around its pivot
  (Shift+drag moves) and calls `setKeyframe()` at the playhead. Pivots and node editing
  are Setup-only. Toggle with the top-right buttons or `Tab`.
- **Keyframed values are ABSOLUTE; the rest pose only fills unkeyed channels**
  (`model.channelValue`). Editing the rest pose in Setup must never shift keyed
  animation — this was an explicit bug fix, do not regress it. Both exporters mirror
  the rule: Lottie and .riv emit rest as the static value only when a channel has no
  keyframes.
- **Rest scale (`rest.sx/sy`) applies innermost — after the baked transform — around
  the pivot mapped into pre-baked local space**, so artwork resizes along its own axes
  and the joint never moves. Like baked transforms, it does NOT propagate to children.
  Both exporters bake it into the flattened geometry (layer/node-scale axes would be
  wrong for rotated art).
- **Part parenting composes like a bone hierarchy.** A part's rendered transform is its
  ancestors' pose transforms (outermost first) followed by its own; `ancestorChain()` is
  cycle-safe and `setParent()` refuses to create one. Effective pivots for gizmos/bone
  lines account for the whole chain (`view.ts`'s `effectivePivot`/`chainMatOf`).
- **Bones and groups are partless parts** (`part.kind: 'art'|'bone'|'group'`,
  `paths: []`). They pose/animate/parent like any part; the canvas draws them as
  interactive glyphs (diamond/square) carrying `data-part-id`. Lottie exports them
  as null layers (ty 3); .riv exports them as plain Nodes in the hierarchy. `ungroupPart()` dissolves a REST-POSED null exactly (angles
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
  sampling, Lottie (o/i handles), .riv (cubic interpolators). Presets stay the
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
  transform around the local pivot and composes tan-additively during drags. Both
  exporters bake skew into the flattened geometry (transform-level skew exists in
  neither Lottie layers nor Rive nodes).
- **Pivots are recovered from the composed transform matrix, not the transform-list
  syntax** — Inkscape freely rewrites `rotate(a,cx,cy)` as an equivalent `matrix(...)`,
  so `rotationPivotOf` in `transforms.ts` tests whether the *composed* matrix is a rigid
  rotation and solves for its fixed point either way. `inkscape:transform-center-x/y` is
  a fallback hint (bbox-center offset, +y flipped from Inkscape's legacy axis) resolved
  once the canvas can measure geometry.
- **Easing lives on the ARRIVING keyframe** in the model (`linear`/`easeIn`/`easeOut`/
  `easeInOut`); both exporters look one keyframe ahead to emit the correct easing on the
  segment leaving the previous key (Lottie `o`/`i` bezier handles, .riv interpolators).
- **`checkpoint()` before every mutation, once per gesture.** Drags defer the checkpoint
  to the first pointer movement (past a small pixel threshold) so plain clicks don't
  pollute history.
- **Snapping is an editor preference, not document data**: `state.snapEnabled`
  (persisted in localStorage, never serialized into projects), Setup-mode drags only
  (node/pivot/part translate — Animate posing stays free). Pure math lives in
  `snap.ts`; snapping adjusts drag deltas only (never adds checkpoints) and respects
  Ctrl axis-locks (corrects the free axis only). Threshold is ~8 SCREEN px through
  the zoom.
- **Structural node ops (join / join-segment / delete-segment) are pure functions in
  `paths.ts`** (`deleteSegment`/`closePath`/`joinPaths`/`reversePath`) operating on
  single subpaths; view.ts only wires eligibility + checkpoint + DOM sync
  (`syncPartPathDom`). They keep `nodeTypes` in exact lockstep (welded node → 'c';
  reversal flips arc sweep flags rather than converting to cubics) and refuse
  compound paths — buttons disable via `canJoinNodes`/`canDeleteSegment`.
- **`help.ts`'s `SHORTCUTS` list is the user-facing shortcut documentation** — any
  binding change in `main.ts` must update it in the same change.
- **State machines mirror Rive's semantics deliberately** (`model.ts` SM types →
  `exportRiv.ts` maps 1:1): inputs addressed by NAME at runtime, conditions AND,
  easing crossfades, any-state priority. **Every machine always has entry+any+EXIT**
  (a layer missing any of the three is rejected as "corrupt" by Rive's
  `state_machine_layer.cpp`): `newStateMachine` mints all three, normalizeDoc
  re-establishes them on load, the editor refuses to delete them, and the exporter
  keeps a defensive synthesis fallback. Deleting a clip must NOT destroy a graph:
  normalizeDoc keeps dangling-clipName states (evaluator samples rest), but the
  .riv export DROPS them (the runtime rejects unresolved animationIds).
- **SM preview is app-state, never doc-state**: `smPanel.ts` owns the instance and
  the rAF loop; the ONLY view.ts hook is `setPoseSampler(fn|null)` (renderPose
  samples through it when set). Canvas pointer events during preview are consumed
  by capture-phase listeners on `#canvas` — selection/drag never fire.
- **The `src/view/` layering is binding**: context ← coords/pose/focus ← skinRender
  ← overlay/snapping ← render ← partDom/nodeEditing/rigOps/camera ← interactions ←
  canvas. A `view/*` module NEVER imports `../view` (the facade) nor a higher layer;
  consumers import ONLY `./view` (no deep paths). The facade is permanent — new
  public symbols are added to their module AND re-exported there. Overlay render-time
  side effects (handleMode reset, stale node-selection pruning) belong inside the
  render functions — do not "clean them up" out.
- **Any change under `src/view/` must pass `npm run test:interaction`** (19 real-
  gesture tests, headless Chromium, ~1 s). New interaction features get a scenario
  there; the suite was mutation-checked (sabotaging a pipeline makes its scenario
  fail), keep it that trustworthy.
- **`public/PIP_MASTER.svg` is the bundled sample artwork** ("Load sample" button),
  used for demos and live verification. It is just an asset — nothing in the code may
  depend on its specific structure.

## Testing interactions (do not regress this)

Synthetic-event verification MUST simulate real input or it will pass while the app
is broken (this happened): dispatch to `document.elementFromPoint(x,y)` — the true
hit target — not a hand-picked element; simulate full gestures (double-click =
down/up ×2 + dblclick, re-resolving the target between clicks because overlays
appear); re-query elements after any render and re-read `state.doc` after undo;
assert numerically (px drift, cos angles) and on the DOM. Full checklist lives in
ROADMAP.md "Testing conventions". These rules are CODIFIED in the interaction
harness (`src/__tests__/interaction/harness.ts` — use its helpers rather than
hand-rolling gestures) and enforced by `npm run test:interaction`.

## Status

### Thirteenth wave (v2.11: interaction harness + view.ts modular split) — implemented and verified

Built 2026-07-11 in four audited chunks (harness, then B1–B5 / B6–B10 / B11–B13 of
the approved plan), each chunk gated on build + unit + interaction suites and
committed separately for bisectability. ZERO behavior change by mandate.

- **Interaction-test harness** (`npm run test:interaction`): Vitest Browser Mode on
  headless Chromium as a second vitest project (jsdom was assessed and rejected —
  no elementFromPoint/getScreenCTM/getBBox, mocking them would test the mocks).
  19 tests / 5 files, ~1 s wall clock, pinning the 12 hard-learned gesture
  invariants (setup drag-move, scale/rotate handle sets, pivot compensation ≤0.05 px,
  animate auto-key, node drag at zoom incl. 's'-mirror, closing-Z bend, marquee
  across dimmed art, drill-down + Escape tiers, snapping byte-equal + Ctrl
  axis-freeze, camera invariants, checkpoint deferral) plus the boot pivot
  assertion. Mutation-checked: sabotaging the pivot/translate/node pipelines makes
  the matching scenario fail (10.8 px vs 0.05 threshold, etc.).
- **view.ts split**: 3,089-line monolith → **33-line permanent re-export facade +
  13 layered modules** (3,349 lines total; see the architecture table). Facade
  export surface diff-verified identical to the pre-split monolith (31 names);
  consumers untouched. Only new symbol across the whole refactor:
  `invalidateSkinCache`. Shared mutable state consolidated in `view/context.ts`'s
  `ctx` object (371 occurrences converted by a string/comment-aware tokenizer).
  Cycle resolutions per plan: partDom below interactions / canvas above; skinRender
  (cache owner) below render / rigOps above.
- **Live manual pass** after the final chunk: boot pivot exact, setup drag writes
  rest only, animate drag keys rotate, node drag 0 px error, wheel-zoom ratio
  exact with ~0 cursor drift, undo rebuild works, and the state-machine preview
  still poses the canvas through `setPoseSampler`.

### Twelfth wave (v2.10: generic editor, Compose removal, SM editor pan/zoom) — implemented and verified

Built 2026-07-11; `npm run build` clean; **269 tests / 10 files passing** (−15 from
deleting the Compose exporter's suite).

- **Compose (.kt) exporter REMOVED** (user decision — Rive covers Android via
  rive-android; git history keeps the code): `exportCompose.ts` + its 15 tests, the
  toolbar button, help-overlay row, and `window.__rigStudio.exportCompose` all gone,
  along with the last Dosey-coupled logic (the hardcoded package-name default).
- **De-Dosey sweep**: app reframed as a generic editor (README rewritten from the
  flat-rig era; CLAUDE.md overview + conventions scrubbed of Dosey/Compose
  intentions); sample button relabeled "Load sample" (asset path and `btn-sample`
  id unchanged); AI prompts confirmed already-generic; stale Compose references in
  comments cleaned. `public/PIP_MASTER.svg` stays as the neutral bundled sample.
- **SM graph pan/zoom**: wheel-zoom-at-cursor (clamped 0.2×–5× of each machine's
  content-fit width), middle-drag pan, ⌂ fit button, auto-fit on first show;
  view state is per-machine session state that survives panel rebuilds and logic
  toggles (byte-identical viewBox), and is NOT doc state (no checkpoints). Box
  drags/armed transition clicks convert pointer→graph space through the viewBox
  (verified 0.013 px drift at 2.8× zoom); middle-click is guarded out of every
  left-click path. Fixed latent bugs found en route: a double-registered
  background-click listener, and stale view-rect entries leaking on machine delete.
- **Exit state now guaranteed in the editor** (Rive parity): `newStateMachine`
  mints entry+any+exit, normalizeDoc re-establishes exit on old files, the editor
  refuses to delete non-animation states (✕ hidden, Delete-key guarded, props
  delete hidden). The .riv exporter's synthesis remains as a defensive fallback.

### Eleventh wave (v2.9: Rive-style state machines) — implemented and verified

Built 2026-07-10 in three orchestrated waves (core → UI + .riv export in parallel,
disjoint files), each audited; `npm run build` clean; **284 tests / 11 files
passing**.

- **Core (`stateMachine.ts` + model types)**: inputs (bool/number/trigger with
  defaults), states (entry/any/exit/animation with clipName + loop), transitions
  (AND-ed conditions, ==/!=/</<=/>/>= ops, blend durationMs), listeners
  (part + down/up/enter/exit + setBool/setNumber/fireTrigger actions).
  `RigDoc.stateMachines` serializes for free; normalizeDoc defaults/prunes (keeps
  dangling-clipName states). Evaluator decisions documented in the file header:
  evaluate→consume-triggers→integrate ordering, one transition per advance
  (termination), blend retarget-from-incoming, exit-freeze, rest pseudo-state.
- **Editor UI (`smPanel.ts`, timeline `🔀 logic` toggle mirroring the curves
  pattern)**: machine CRUD, draggable graph (x/y persisted), click-click transition
  arming, condition/duration editors, inputs with live preview controls, listeners
  editor. ▶ preview: rAF-driven SMInstance poses the canvas through view's single
  `setPoseSampler` hook; canvas clicks dispatch to listeners (ancestor-inclusive
  hit matching) with selection suppressed. Verified live with realistic gestures:
  UI-built machine → 400ms blend passes exact midpoint (30 between 0/60), listener
  pointerdown fires a trigger transition without touching selection, undo/redo
  single-steps each graph edit.
- **.riv export**: StateMachine/Layer/inputs/states/transitions/conditions/listeners
  emitted with keys pinned from dev/defs + runtime source (nesting via the
  import-stack pattern; SM objects consume no component indices; op enum ordering
  is NON-OBVIOUS: eq 0, ne 1, le 2, ge 3, lt 4, gt 5; listener types enter 0 /
  exit 1 / down 2 / up 3; duration in ms with the percentage flag clear; bool
  conditions reduce (op,value) into opValue). TWO runtime-found traps encoded:
  a layer missing entry/any/EXIT is rejected as corrupt (exporter synthesizes a
  bare Exit), and dangling-clip states must be dropped (unresolved animationId
  fails import). Live-verified in @rive-app/canvas: stateMachineInputs enumerate,
  bool input drives A→B with exact 30° blend midpoint at 200ms/400ms, trigger
  drives B→A. Non-SM docs export byte-identically to before (pinned by test).
- Limitations (documented in-code): per-state loop can't map (looping is
  per-LinearAnimation); pointer listeners use the classic listenerTypeValue
  representation.

### Tenth wave (v2.8: Rive .riv export + project-format verification) — implemented and verified

Built 2026-07-10 by two parallel subagents (disjoint file ownership), orchestrator-
audited; `npm run build` clean; **235 tests / 10 files passing**.

- **Rive `.riv` exporter** (`exportRiv.ts`, "Export Rive (.riv)" toolbar button,
  `exportRiv` on the debug hook): whole doc, all clips as named animations, one
  binary. Schema derived from rive-runtime `dev/defs` (NOT from memory — table cited
  in-file); traps encoded there: LinearAnimation's name is propertyKey 55 (not the
  Component name 4), ToC backing-types pack 4 keys per uint32 word, parentId/
  objectId/interpolatorId index the artboard's component list (Artboard = 0,
  animation objects consume NO index, so interpolators emit before animations),
  rotation is radians, colors 0xAARRGGBB. Mapping mirrors exportLottie: node per
  part positioned at the effective pivot, geometry baked to docPoint−pivot incl.
  rest scale/skew, arcs→cubics with polar (rotation/distance) tangents, paint
  opacity folded into SolidColor alpha, stroke width scaled by baked-matrix norm,
  skinned parts rigid (Rive Skin/Tendon deferred), loop=1. Deterministic output.
  VERIFIED against the official `@rive-app/canvas` runtime (devDependency; harness
  page `public/riv-check.html`): file loads with zero errors, artboard/animation
  names correct, keyed rotations sample exactly (0→±45° with easing curvature),
  a custom cubic-bezier matches at 6 sampled points, unkeyed channels stay static.
  Pixel readback is impossible in the headless harness (official sample .riv files
  also read back 0 px), so in-session verification is at the transform level.
  DRAW-ORDER RULE (learned from the user's real rive.rip check, which caught an
  inverted-z bug the transform-level harness could not see): Rive draws the FIRST
  drawable in file order TOPMOST — `artboard.cpp` collects drawables in component
  order, sets `m_FirstDrawable = lastDrawable`, and `drawInternal()` iterates
  backward — the opposite of `doc.parts` paint order (last = topmost). The exporter
  therefore emits all Nodes first (only Shapes are Drawables), then shape clusters
  in fully REVERSED paint order (parts back-to-front, each part's paths
  back-to-front); `KeyedObject.objectId` wiring reads recorded node indices so
  reordering can't desync animation targets. Pinned by binary-order unit tests.
  Translucent fills fold opacity into SolidColor alpha (0.3 → 0x4D) — verified
  byte-exact.
- **Project save/load verified lossless** (no fix needed): `serializeDoc` is a blind
  JSON.stringify of the typed doc, all mutation sites stay within typed fields
  (grepped), autosave shares the exact serialize/deserialize pair. NEW coverage
  (was zero): a maximal-doc round trip (bones/boneTip, group, skin incl.
  restWorldInv/bindSeg, nodeTypes, skew + negative-scale flip, pivotHint, 2 clips,
  all easings + custom beziers, multi-path paints, draw order) asserting deep
  equality, byte-stable re-serialize, and identical sampleChannel output; plus
  normalizeDoc back-compat tests (missing kind/boneTip/skin/nodeTypes/bezier,
  dangling refs pruned, bezier clamping). Editor prefs (snap, playback speed,
  ping-pong, onion, selection, mode) intentionally NOT persisted — confirmed
  structural.

### Ninth wave (v2.7 vector-app parity: node ops, snapping, shortcuts, polish) — implemented and verified

All ROADMAP v2.7 items, built 2026-07-10 by parallel/sequential subagents with the
orchestrator auditing every diff; each feature live-verified with realistic gestures
(elementFromPoint hit targets, full pointer sequences, numeric assertions);
`npm run build` clean; **199 tests / 9 files passing**.

- **Segment delete / join (Inkscape node editing)**: pure single-subpath ops in
  `paths.ts` — `deleteSegment` (closed path opens at the break, rotating the seam and
  turning the old Z into a straight L; open path splits into two `RigPath`s, the
  second labeled `·2`; <2-node pieces discarded), `closePath` (weld to midpoint or
  close with the straight Z segment), `joinPaths` (cross-path merge, reversing one
  side as needed — cubic controls swap, arc sweep flags flip), `reversePath`.
  `nodeTypes` stays in exact lockstep everywhere; stale Inkscape strings normalize.
  Inspector gains join / join seg / del seg buttons that disable with requirement
  tooltips. Audit fix included: paths with an EXPLICIT closing segment + zero-length
  Z (what segment-bending creates) no longer grow a phantom zero-length L on delete.
  Verified live on Pip's left_leg: open→split→weld→close round trip, byte-identical
  undo per op.
- **Double-click off the shape escapes node editing**: a dblclick that resolves no
  artwork (blank or dimmed parts) clears entered path, node selection, entered
  groups, AND part selection; dblclick on the edited part still re-scopes among its
  paths. Verified: 19 node handles → 0, overlay emptied, all dimming cleared.
- **Toggleable snapping** (`snap.ts` + wiring): Setup-only — node↔node (same part),
  pivot↔nodes/other pivots, part translate pivot↔pivot + bbox features (9 points per
  box); nearest candidate within 8 screen px; Ctrl axis-locks respected (snap
  corrects the free axis only); one marker on the overlay while engaged
  (non-scaling-stroke). Magnet toggle in canvas-tools + `%` key, persisted in
  localStorage, default ON. Verified: node snap lands byte-equal coordinates; pivot
  snap keeps artwork fixed to 0.0005 px (the compensation invariant); marker present
  during snap, gone on pointerup; undo exact.
- **Standard shortcuts + help overlay**: Ctrl+S/O (preventDefault, shared code path
  with toolbar), Ctrl+A (nodes in node mode, else all parts), Ctrl+D duplicate
  (Setup; `model.duplicateParts` — fresh part+path ids, +12/+12 offset, " copy"
  label, tracks not copied, skinned skipped; canvas rebuilds via the undo path),
  `+`/`-` zoom 1.25× about the canvas center (`view.zoomBy` shares the wheel-zoom
  math), `?`/F1 help overlay (46 bindings in 7 groups, driven by `help.ts SHORTCUTS`,
  Escape-first tier). FIXED the audit finding: `F`/Space/letter shortcuts now ignore
  ctrl/meta/alt, so Ctrl+F no longer triggers fit-view alongside the browser find
  bar. Verified: all of (a)-(g) in the wave brief numerically, incl. zoom ratios
  exactly 0.8/1.25 with 0 px center drift.
- **Visual polish (CSS/HTML only)**: design tokens (spacing scale --sp-1..5, control
  heights --ctrl-h 28px/--ctrl-h-sm 24px, radii, layered borders replacing harsh
  #000, restrained shadows), coherent hover/active/disabled/focus-visible states
  (keyboard focus rings; disabled cursor not-allowed), tabular numerals on numeric
  readouts, themed thin scrollbars, subtler checkerboard, playhead grab-head +
  keyframe hover growth, toolbar grouped into labeled clusters with a gradient brand
  mark, prefers-reduced-motion killswitch. No selector renamed; overlay color
  language untouched. Verified: uniform 28 px controls, no overflow at 1100 px.

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
Anthropic API key, or a real Lottie consumer) or was only checked structurally.

- **Lottie exporter** (`exportLottie.ts`) — verified structurally in-browser (layer
  count, parent references, anchor points, animated-rotation keyframe times, shape
  command types all look right for the Pip sample), but **not** opened in an actual
  Lottie player (lottie-web / After Effects / a Lottie preview site). Do that before
  relying on it.
- **Claude assistant updates** — new 4-easing schema, parent-aware system prompt,
  optional pose-snapshot (vision) attachment via canvas rasterization, and a new
  "Critique this animation" text-mode call. Reviewed but not run against the live API
  in this session (needs a real key).
- Playback speed selector, ping-pong looping, and the fps readout — implemented and
  present in the DOM, but not exercised through an actual multi-second playback run in
  this session (only inspected statically).
- Drag-to-parent in the Layers panel — the underlying `setParent()`/cycle-rejection
  logic is verified, but the HTML5 drag-and-drop wiring itself wasn't exercised with
  synthetic `dragstart`/`drop` events (they're awkward to simulate outside a real
  browser drag gesture).

### Unit tests — done

`npm test`: **10 files, 269 tests, all passing** (2026-07-11). Covered:
`stateMachine` (entry/ops/trigger timing/any-priority/blend math/exit/reset),
`paths` (parse/serialize/arc→cubic/node insertion, segment delete/join/reverse/close
incl. explicit-closing-segment edge cases), `snap` (nearest/threshold/axis-lock/
box features), `exportRiv` (varuint/string/float/ToC writer primitives + a
standalone ToC-aware .riv decoder asserting header, object order, parentId
validity, per-clip keyframe counts/values, absolute-vs-rest semantics, bezier
interpolator wiring, determinism), serialization round-trip + `normalizeDoc`
back-compat (maximal doc, byte-stable), `transforms` (matrix ops, skew,
rotation fixed points from both rotate() and matrix() spellings), `model`
(channelValue absolute/rest-fallback semantics, sampling/easings, keyframe clipboard,
parenting/cycles, group/ungroup absorption, structural AI changes, part
duplication/select-all, `normalizeDoc` back-compat), `importSvg` (jsdom: layer unwrap, pivot seeding incl. transform-center
y-flip, shape conversion, sodipodi:nodetypes),
`align` (align/distribute math), `ik` (reach/clamp/bend-direction, plus `skin.ts`
weight math), `graph` (curve-editor bezier sampling). One bug found by the original
test pass was fixed in `model.ts`: `setKeyframeAt` now applies an explicitly passed
easing when replacing an existing key (paste carries the copied easing) while drags,
which omit it, still preserve a hand-set easing. Not covered: the DOM-heavy modules
(`view`/`timeline`/`panels`/`main`), `history.ts`, `exportLottie`, `claude.ts`.

### Not started

- No visual/screenshot regression proof exists (`preview_screenshot` reliably times
  out in this environment even though the page is responsive); verification relies on
  DOM inspection and scripted pointer/keyboard events through `window.__rigStudio`.
  Worth a manual look in a real browser before shipping.
- Mirror-flip by dragging a scale handle through zero is unimplemented (drag factors
  clamp positive; flips are Shift+H / Shift+V instead). Skew IS implemented (fifth
  wave) — see the rest-skew convention above.
- Per-part AI motion suggestions and richer critique-mode UI (currently a single
  scrollable text block) are unbuilt.

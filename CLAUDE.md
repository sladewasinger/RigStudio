# Rig Studio

A browser-based 2D rigging and animation editor for SVG artwork that exports Rive
`.riv` files and Lottie JSON. A generic tool for any character/app (it began life
animating an Android app's mascot; that coupling has been fully removed — keep it
that way: no app-specific code, naming, or export assumptions).

## What it does

Import an SVG (Inkscape/Illustrator) → every group at ANY depth becomes a rig **part**
(exact structure preserved; label = inkscape:label else the SVG id)
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
npx tsx src/headless/cli.ts <import|validate|export-riv|render-frames> ...  # headless CLI (H1)
                         # (also `npm run rig -- ...`, but Windows PowerShell can
                         # mangle flags through npm — prefer the direct tsx form)
```

Verify UI changes by loading `public/PIP_MASTER.svg` via the "Load sample" button.
A debug hook exists on `window.__rigStudio` (`state`, `exportLottie`, `exportRiv`,
`renderPose`, `serializeDoc`, `loadProjectText`, `setEditorMode`) for driving the app
from the console; `window.__smPanel` drives the state-machine editor deterministically.

## Code architecture

- **Self-documenting code**: names over comments. Comments exist only for
  constraints the code itself can't express (invariants, hard-learned traps,
  "why", cross-file coupling) — not to narrate what a line already says.
- **Spell names out — no abbreviations** (user ruling 2026-07-12, after a wave
  proposed `layersDnd.ts`): file, module, and exported-symbol names use full
  words in the repo's camelCase filename convention — `layersDragAndDrop.ts`,
  never `layersDnd.ts`/`Mgr`/`Util`/`Ctx`-style contractions in NAMES.
  (Established local variable idioms inside a file, like the `ctx` object,
  are fine — this rule is about names a reader encounters cold.)
- **Small, focused files**: ~200 lines is a smell threshold, not a hard limit.
  A file creeping past it is a prompt to ask whether it's doing two jobs.
  There are NO permanent "documented exceptions" anymore (user ruling
  2026-07-12): the former ones were redesigned via named patterns —
  `view/interactions.ts` became the `view/interactions/` gesture-pipeline
  package (see the table below); `view/nodeEditing.ts`'s chokepoint wave is
  queued in ROADMAP. A file that stays large must re-earn it with a structural
  argument every time a new seam appears.
  **ENFORCED (2026-07-11, after the standard was violated eight times during the
  feature blitz — exportRiv 1.1k lines, model 1.6k, smPanel 1.4k...):** a size-
  ratchet unit test (`architecture.test.ts`) pins every source file's **CODE-line
  count — comments and blank lines are FREE** (user ruling after an agent trimmed
  comment blocks to fit a ceiling: deleting documentation to pass the gate is
  cheating and prohibited; docs-heavy files are the goal). Grandfathered files may
  not grow — a wave that adds to one must split it in the same wave or shrink
  something else in it; NEW files fail the gate above ~300 code lines. The
  grandfather list burns down in the dedicated refactor pass (see ROADMAP). Do not
  raise a ceiling to make a test pass — that defeats the mechanism.
- **Feature-grouped folders**: `src/` is organized by responsibility, not left
  flat — `core/` (document model, undo/redo, state-machine evaluator), `geometry/`
  (pure math: paths, transforms, snapping, align, IK, skinning), `io/` (SVG
  import, Lottie/Rive export), `view/` (the editing canvas), `timeline/` (clip
  transport + curve editor), `panels/` (side panels + the state-machine editor
  UI), `ui/` (cross-cutting chrome like the shortcut overlay), `ai/` (Claude
  SDK calls). `main.ts` and `style.css` stay at `src/` root — they're the entry
  point index.html references, not a feature. New code follows this structure;
  a new concern gets its own folder rather than growing an existing one past
  its job.
- **The facade pattern for wide surfaces**: a module with many internal parts
  but one coherent public API (`view/`, `panels/`) splits into implementation
  modules plus a permanent `index.ts` that re-exports exactly the consumed
  surface. Consumers import ONLY the facade (`./view`, `./panels` — Node/bundler
  resolution treats a directory import as its `index.ts`), never a deep path;
  implementation modules never import the facade back. See "The `src/view/`
  layering is binding" below for the enforcement rule this implies.
- **Think in named patterns, not conventions** (user mandate 2026-07-12, from the
  interactions.ts design review): when code needs organizing, reach for an
  explicit structural pattern and NAME it in the module doc. Concretely:
  an if-cascade whose branch order is load-bearing becomes a
  Chain-of-Responsibility with a STATIC priority table (the order is data you
  can read at a glance, the branches become feature-complete modules); a
  multi-field invariant ("command count changed ⇒ splice `nodeTypes` + drop
  overrides") gets a CHOKEPOINT — one function every mutation must pass through,
  so the invariant is enforced by the only door rather than by neighboring code
  serving as the example to copy; repeated per-branch sniffing becomes one
  shared context resolved up front; registries/tables beat scattered branches,
  and a new feature REGISTERS into them instead of growing a cascade.
  Proximity-and-convention arguments ("all the call sites are in one file, so
  people will see the rule") are NOT an acceptable defense for a monolith: if a
  file stays large, the reason must be structural (it is one irreducible
  responsibility), and any "documented exception" must be re-argued when a new
  seam appears — the ikDrag.ts extraction is the precedent. Optimize for what a
  human developer reads first: explicit ordering, one obvious place per concern,
  patterns they already know by name.

## Architecture (src/)

| File | Responsibility |
|---|---|
| `core/model.ts` | **Pure re-export facade** — imported everywhere as `../core/model`; that path is permanent. Implementation modules: `core/docTypes.ts` (`RigDoc`/`RigPart`/`Clip`/`Track`/`Keyframe`/`Channel`/`Easing`/`Artboard`, `CHANNEL_DEFAULTS`), `core/smTypes.ts` (state-machine types), `core/appState.ts` (app-state singleton — `editorMode`: `setup`\|`animate`, multi-selection, tool/freeze/snap flags, playback speed/ping-pong/onion — plus pub/sub `subscribe`/`notify` and selection helpers), `core/channels.ts` (`channelValue` absolute-keys/rest-fallback, `sampleChannel` + 4 easings + stepped z, `setKeyframe*`/`keyAt`/`removeKeyAt`, AI protected-key guard, keyframe clipboard `copyKeys`/`pasteKeysAt`/`copyPoseAt`), `core/boneOps.ts` (`boneChain`, bone length/tip helpers), `core/partHierarchy.ts` (`ancestorChain`/`setParent` cycle-safe, group/ungroup), `core/structuralOps.ts` (`applyRigChanges`, delete/duplicate, draw order), `core/serialization.ts` (`serializeDoc`/`deserializeDoc`/`normalizeDoc`, `newBlankDoc`/`newStateMachine`, `sanitizeClipName`), `core/idGen.ts` (`freshId`) |
| `io/importSvg.ts` | SVG file → `RigDoc`. Unwraps Inkscape layers, then RECURSIVE: every `<g>` at any depth becomes a part (exact SVG structure; label = inkscape:label else id; kind 'art' iff it has direct paths), parented per the nesting; each part's baked `transform` is the FULL composed ancestor chain (doc-space invariant — render-time parenting composes pose only); ellipse/circle/rect → path data; pivots per part from the *composed matrix's fixed point* or `inkscape:transform-center-x/y` as a `pivotHint` |
| `view/index.ts` | **Pure re-export facade (33 lines)** over the `src/view/` modules — consumers import ONLY `./view`, never deep paths. The canvas responsibilities live in 22 layered modules: `view/context.ts` (shared mutable state `ctx`, DragState type, constants, micro-utils), `view/glyphs.ts` (pure SVG-fragment string builders: bone kite, joint dot), `view/coords.ts` (screen↔doc conversion from live CTM/transform strings), `view/pose.ts` (thin delegator over the shared `geometry/pose.ts` kernel — injects `ctx.poseSampler`, keeps `poseTime()` + the live-DOM box measurers `partRootBoxes`/`groupUnionBox`), `view/focus.ts` (drill-down/dimming, `artworkUnderPointer`), `view/skinRender.ts` (LBS deformation + private cache), the overlay cluster — `view/overlay.ts` (`renderOverlay` orchestration + gizmos/pivots/snap marker — render-time side effects live here on purpose), `view/overlayHandles.ts` (selection boxes + scale/rotate/skew handle sets), `view/overlayBones.ts` (bone glyphs, tip handles, chain origin, freeze joint markers, ik-active highlight), `view/overlayNodes.ts` (node-editing chrome) — `view/snapping.ts` (candidate collection wiring), `view/render.ts` (`renderPose`, onion skins, `setPoseSampler`), `view/partDom.ts` (part-group/path DOM registry), the `view/nodeEditing/` package (`structural.ts` owns `applyStructuralEdit` — THE chokepoint every command-count-changing node edit must pass through: writes d/nodeTypes, drops the path's skin overrides, invalidates the skin cache, syncs DOM, clears node selection; enforced by `nodeEditingChokepoint.test.ts` — nothing else may write `nodeTypes` or call the override drop; `dragMath.ts` node/handle drag + mirror rules + nudge, `typeOps.ts` one-shot smooth/symmetric/corner + line↔curve, `index.ts` facade), the rigOps cluster — `view/rigOps.ts` (17-line re-export), `view/rigOpsPlacement.ts` (pen-tool chain lifecycle + auto-bind), `view/rigOpsBind.ts` (LBS bind/unbind + the freeze bind-refresh cycle), `view/rigOpsEdit.ts` (flips/nudges/aimBoneAtTip/group scale), `view/rigOpsNodeBinding.ts` (per-node weight overrides) — `view/camera.ts` (viewBox zoom/pan/fit), `view/ikDrag.ts` (the full-chain IK drag pipeline: chain resolution, grab-point anchoring, FABRIK write-back), the `view/interactions/` gesture-pipeline package (Chain of Responsibility: `priority.ts` is THE ordered 11-row table — first `claim()` wins the gesture, each row commented with why it precedes the next; `hit.ts` resolves the press once into a shared HitContext; `lifecycle.ts` owns threshold/checkpoint-deferral/capture/snap mechanics; `dblclick.ts` drill-down; `pipelines/` = boneChain, gizmo, boneTip, blank(+pan), handles, node, pivot, nodesBendMarquee, artwork — each feature-complete claim+move+release; a new gesture = one pipeline file + one table row, never a cascade edit; priority is pinned by `gesturePriority.test.ts`), `view/canvas.ts` (`buildCanvas`, render-then-measure pivot seeding) |
| `timeline/timeline.ts` | **Pure re-export facade** over the timeline's internal modules: `timeline/tlState.ts` (shared `tlCtx` + rerender hook, fixed-height splitter, playhead-scrub util), `timeline/transport.ts` (play/pause/duplicate/rename/delete/duration, speed selector, ping-pong, onion toggle, fps readout, keys/curves/logic view picker), `timeline/lanes.ts` (scrubber ruler + keyframe lanes with click/shift-click/marquee selection, retime drag), `timeline/keyProps.ts` (key-property row — time/value/easing incl. the stepped-z easing disable — plus copy/paste/nudge/column-select), `timeline/panel.ts` (`buildTimeline`/`render` composition) |
| `panels/index.ts` | **Pure re-export facade** over `src/panels/`'s submodules — consumers import ONLY `./panels`, never deep paths. `panels/icons.ts` (the inline SVG icon set + `icon`/`iconButton` helpers), `panels/layers.ts` (Layers **tree** — parts nest under their parent, fold open to show child paths, drag-to-parent / drop-to-unparent), `panels/inspector.ts` (itself a pure facade over `panels/inspectorSections/` — shared field builders, transform incl. keyed z/opacity/sx-sy, bone, stacking, skinning, align & distribute, node-operations, object/style+artboard sections, `panel.ts` orchestration), `panels/ai/` (the Claude assistant panel package — panel/apply/preview/previewBar/fields/requests/state/threadStrip/threads/templates/polish behind its own index.ts, mounted at the bottom of the inspector), `panels/canvasTools.ts` (the tool switcher, snap toggle, and flip/group/ungroup/bind actions shown above the canvas). `panels/smPanel.ts` (state-machine editor) lives alongside these but is imported directly by its consumers (`main.ts`, `timeline/timeline.ts`), not re-exported by the facade |
| `core/history.ts` | Snapshot-based undo/redo; call `checkpoint()` BEFORE any doc mutation, one per user gesture |
| `geometry/paths.ts` | Path-data parser/serializer (normalizes to absolute M/L/C/A/Z), de Casteljau cubic split for node insertion, `arcToCubics`/`pathToCubics` (W3C endpoint→center parametrization) so arc segments can be split and exported as geometry |
| `geometry/pose.ts` | **The shared pose kernel** (H1b extraction from view/pose.ts, math moved verbatim): own/root pose transform strings, chain composition (`chainMatOf`/`fullPoseTransform`), effective pivot/tip/scale/z/opacity — pure over `state.doc` + an optional channel-`sampler` argument (the SM preview's override, injected by view/pose.ts; absent for headless callers). Consumed by BOTH the editor canvas and `headless/composePose.ts`, so editor and headless rendering cannot drift |
| `geometry/transforms.ts` | SVG transform-list parser plus a small affine `Mat` toolkit (`multiply`/`invertMat`/`applyMat`/`rotationMat`); `rotationPivotOf` finds a transform list's fixed point by testing the *composed matrix* for a rigid rotation, so it recovers pivots regardless of whether Inkscape wrote `rotate(...)` or an equivalent `matrix(...)` |
| `io/exportLottie.ts` | `RigDoc` + one clip → Lottie JSON (v5.7.0, 60fps): a root null layer for whole-figure translate/scale, one shape layer per part with Lottie-native `parent` layer references mirroring the bone hierarchy, geometry flattened through baked SVG transforms with arcs converted to cubics, easings converted to bezier handles |
| `io/riv/index.ts` | **Pure re-export facade** over `src/io/riv/` — `RigDoc` + ALL clips → Rive `.riv` binary (format major 7); consumers import ONLY `./io/riv`, never a deep path. Modules: `writer.ts` (varuint/ToC binary primitives + header assembly), `keys.ts` (typeKey/propertyKey table derived from rive-runtime `dev/defs`, cited in-file, + shared enums), `scene.ts` (the `exportRiv()` entry: Backboard→Artboard→Node-per-part-at-pivot — geometry baked to docPoint−pivot, rest scale/skew baked in, rotation in RADIANS — Shape/PointsPath/CubicDetachedVertex geometry, Fill/Stroke/SolidColor with opacity folded into alpha, draw-order-REVERSED shape emission), `animation.ts` (one LinearAnimation per clip with KeyedObject/KeyedProperty/KeyFrameDouble + CubicEaseInterpolators — interpolators emitted BEFORE animations, animation objects consume no component index), `stateMachine.ts` (the SM object tree). Deterministic bytes; playback-only (the Rive editor cannot import .riv). The standalone test decoder lives in `src/__tests__/rivDecoder.ts` |
| `geometry/ik.ts` | Analytic IK: `solveTwoBone` (law-of-cosines two-joint solve, bend-direction preserving, reach-clamped) and `solveAim`, both in degrees/root space |
| `geometry/skin.ts` | Skinning math: `distToSegment`, `skinWeights` (normalized inverse-square distance to bind-time bone segments) |
| `timeline/graph.ts` | Curve editor panel: value-vs-time plot per track, draggable keys, per-segment bezier handles writing `Keyframe.bezier` |
| `geometry/align.ts` | Align & distribute math (`alignDeltas`/`distributeDeltas`, pure functions over part bboxes with selection/first/last/canvas reference options); applied through parent-chain-aware rest translation from the inspector |
| `geometry/snap.ts` | Pure snapping math (`snapPoint`/`snapDelta`/`boxFeaturePoints`: nearest candidate within a threshold, axis-lock aware, box = center + corners + edge midpoints); view.ts collects candidates and applies it to Setup-mode node/pivot/part-translate drags |
| `ui/help.ts` | `SHORTCUTS` registry (single source of truth for documented bindings) and the `?`/F1 keyboard-shortcut overlay (`openHelp`/`closeHelp`/`toggleHelp`/`isHelpOpen`) |
| `core/stateMachine.ts` | Pure state-machine evaluator (`createSMInstance`): entry resolution, any-then-current transition evaluation (array order, at most one per advance), bool/number/trigger conditions (triggers arm until consumed at end of an advance's evaluation), crossfade blending running both clip clocks with the absolute-keys/rest-fallback rule, exit-freeze, rest pseudo-state (`SM_REST_STATE_ID`); deterministic — time flows only through `advance(dtMs)` |
| `panels/smPanel.ts` | **Pure re-export facade** over `src/panels/sm/` — the state-machine editor UI (the timeline's `🔀 logic` view). Modules: `sm/state.ts` (shared session ctx + rerender hook), `sm/graphCamera.ts` (state-box geometry, per-machine pan/zoom viewport), `sm/graphInteract.ts` (drag-to-move, click-click transition arming, create/delete gestures), `sm/graph.ts` (graph bar + node/edge drawing; positions persist on `SMState.x/y`), `sm/preview.ts` (▶ preview engine: SMInstance + rAF driving the canvas via view's `setPoseSampler`, capture-phase pointer listeners mapping canvas hits ancestor-inclusive to listener actions, `window.__smPanel` debug hook with deterministic `tick(dtMs)`), `sm/props.ts` (right column: state/transition property editors incl. conditions/duration/exit-time), `sm/header.ts` (machine CRUD + preview button), `sm/globals.ts` (left column: inputs with live preview controls, listeners editor), `sm/panel.ts` (`buildSMPanel` orchestration + Delete/Escape hooks) |
| `ai/claude.ts` | Anthropic SDK calls (`claude-opus-4-8`): `animateWithClaude` (adaptive thinking, structured outputs guaranteeing a valid clip JSON, parent-aware system prompt, optional base64 pose snapshot for vision grounding) and `critiqueWithClaude` (plain-text animation review) |
| `headless/index.ts` | **Pure re-export facade** — the DOM-free surface for scripts/agents (H1): all of `core/model`, `core/stateMachine`'s evaluator, both exporters, and `importSvgHeadless` (scoped jsdom `DOMParser`; the importer itself is untouched). `headless/cli.ts` + `bin.mjs` drive the `rig-studio` CLI (`import`/`validate`/`export-riv`/`render-frames` in `cliCommands.ts`); `headless/composePose.ts` builds a posed standalone SVG through the shared `geometry/pose.ts` kernel (z-sorted draw order, sampled opacity, hidden excluded, artboard frame; SKINNED PARTS RIGID like both exporters — stated in CLI output) and `headless/renderFrames.ts` rasterizes frames via `@resvg/resvg-js` (default times = the A3 cluster algorithm from `core/filmstripTimes.ts`). A module-graph test (`headlessBoundary.test.ts`) enforces that nothing here transitively imports `view/`/`panels/`/`timeline/`/`ui/`; `main.ts` never imports `headless/`, so jsdom/resvg stay out of the Vite bundle. NOTE: several core functions (`applyRigChanges`, the setKeyframe family) read/write the `state` singleton — headless scripts set `state.doc = doc` first (composePose does this scoped + restored) |
| `main.ts` | Bootstrapping, toolbar (open SVG/project, sample, save project, undo/redo, Lottie/Rive/PNG/SVG export, Edit/Animate toggle, `?` help), autosave to `localStorage`, and one `installShortcuts()` call. THE KEYBOARD SYSTEM lives in `src/ui/`: `shortcuts.ts` (the dispatch engine — 4 early ownership guards, then first-match over the registry), `shortcutBindings.ts` + `shortcutBindingsTools.ts` (the REGISTRY — every binding co-locates its `match`/`run` with its help metadata, so the overlay row cannot drift; incl. `B` = arm bone-chain placement, Setup-gated), `shortcutCascades.ts` (`DELETE_HANDLERS`/`ESCAPE_HANDLERS` — explicit Chain-of-Responsibility arrays, first `run()` returning true wins, per-tier why-comments), `shortcutActions.ts` (actions shared with toolbar buttons). Letter/F/Space keys fire only without ctrl/meta/alt; input-focus blocks everything |

## Roadmap

Feature roadmap lives in `ROADMAP.md`: v1 through v2.12 are all implemented and
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
- **Part scale (`sx`/`sy`) applies innermost — after the baked transform — around
  the pivot mapped into pre-baked local space**, so artwork resizes along its own axes
  and the joint never moves. Rest scale fills unkeyed frames; `sx`/`sy` are KEYABLE
  channels (absolute, rest-fallback) rendered in the same innermost slot
  (`effectiveScaleX/Y` in view/pose.ts — Edit mode always shows rest via the
  `poseTime()` null discriminator). Like baked transforms, part scale does NOT
  propagate to children in the editor. REST scale bakes into exported geometry;
  KEYED scale exports as .riv Node scaleX/scaleY anchored at the pivot — note the
  latent divergence: Rive Node scale DOES propagate to children at runtime, so
  keyed scale on a part with children may differ editor-vs-runtime (fine for leaf
  parts; revisit if it bites).
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
- **Freeze (origin-editing) mode gates all joint editing** (`state.freezeMode`): a
  MOMENTARY app-state flag — never serialized into a project, never persisted to
  localStorage (unlike `snapEnabled`). OUTSIDE freeze (the default), every pivot/origin
  handle and every shared-JOINT bone tip (a tip that has a child bone) is VISIBLE but
  INERT: the `interactions.ts` pointerdown branch returns without starting a drag — a
  hard no-op, NOT a fall-through that would translate the part underneath — and the
  cursor drops its move affordance (`#canvas.freeze-mode` scoping in `style.css`). LEAF
  bone tips are pure rotation/length edits and stay live regardless. INSIDE freeze,
  EVERY bone renders a joint marker (`overlay.ts` `.pivot-handle.other` via
  `glyphs.ts`'s shared `jointDotHtml`, screen-constant, `data-part-id` on each) and a
  press on ANY of them — selected or not — selects that bone AND starts the joint drag
  in the same gesture (post-A fix: the press used to resolve `selectedPart()` only, so
  an unselected bone's origin fell through to the body-rotate pipeline). Toggle with `Y`
  (guarded like the tool keys), the canvas-tools ❄ button, or Escape (its own early
  tier, ahead of bone-placement/group-exit). Freeze ON shows an UNMISSABLE banner +
  canvas tint, driven by the `.freeze-mode` class that `renderPose` toggles on `#canvas`.
  Interaction-tested (`freeze.test.ts`): the art-pivot and chain-joint drags are
  byte-level no-ops outside freeze and work inside; mutation-checked by removing the
  gate; F7–F9 pin the one-gesture select+drag, the all-bones markers, and their zoom
  stability.
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
  attribute). Binding bakes all static transforms (incl. the parent chain) into
  `path.d` so the rest geometry is ROOT-space, and zeroes the part's OWN pose
  (`rest`/`transform`) — but KEEPS `parentId` so a nested art stays under its group
  (render forces the skinned part's group `transform=''`, so the baked-in chain is
  never double-applied; the joint is stored in the art's local frame). The art's bones
  compose through the preserved chain, so the limb still follows a group move. Weights
  are runtime-derived from `bindSeg` distances. Skinned parts don't respond to pose
  drags and export rigidly. NEVER zero a skinned art's `parentId` (the "bones leave
  their parent object on assign" hoisting regression — bind used to detach nested art
  to root).
- **Tool semantics** (`state.tool`): 'select' keeps the classic mode-dependent drags;
  'translate'/'rotate' force that manipulation in both editor modes (Setup → rest,
  Animate → keys); 'ik' rotates the two nearest ancestor joints (`src/geometry/ik.ts`). Gizmo
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
- **The shortcut registry IS the shortcut documentation** — `ui/help.ts`'s keyboard
  rows are GENERATED from the binding registry (`ui/shortcutBindings*.ts`), so a
  binding and its overlay row cannot drift (the old hand-maintained SHORTCUTS array
  drifted twice before the redesign). A new binding = one registry entry with its
  `help` metadata; the two hand-authored overlay sections (Toolbar, Mouse & tools)
  document things that are NOT keydown bindings and must stay visibly separate.
- **Keyable channels must map to Rive runtime features** (user decision 2026-07-11:
  Rive is the target framework). Editor conveniences that Rive cannot animate
  (e.g. layer visibility) stay editor-only — never a channel, never keyed.
  Animated invisibility is OPACITY (Rive-native). The layers eye (`part.hidden`)
  is a workspace flag: hidden parts don't render and are EXCLUDED from exports
  entirely, but it is not animatable.
- **State machines mirror Rive's semantics deliberately** (`model.ts` SM types →
  `exportRiv.ts` maps 1:1): inputs addressed by NAME at runtime, conditions AND,
  easing crossfades, any-state priority, and **exit time**
  (`SMTransition.exitFraction`, 0..1 of the FROM clip — gates current-state
  transitions only; looping states re-arm each iteration, fraction ≥ 1 on a loop
  means first completion; exports as percentage exit time with
  EnableExitTime|ExitTimeIsPercentage flags). **Every machine always has entry+any+EXIT**
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
- **The `src/view/` layering is binding**: context/glyphs ← coords/pose/focus ←
  skinRender ← overlay cluster (overlay/overlayHandles/overlayBones/overlayNodes)/snapping
  ← render ← partDom/nodeEditing/rigOps cluster (rigOps/rigOpsPlacement/rigOpsBind/
  rigOpsEdit/rigOpsNodeBinding)/camera/ikDrag ←
  interactions ← canvas. A `view/*` module NEVER imports `../view` (the facade) nor a higher layer;
  consumers import ONLY `./view` (no deep paths). The facade is permanent — new
  public symbols are added to their module AND re-exported there. Overlay render-time
  side effects (handleMode reset, stale node-selection pruning) belong inside the
  render functions — do not "clean them up" out.
- **GOTCHA — every mode/state change must have a visible counterpart.** Recurring
  bug class (Animate's second-click rotate mode, group handle sets): internal
  toggles (handleMode, tool state, freeze) that render nothing different feel
  broken. Every selectable part KIND renders a handle set for each handleMode —
  if an operation doesn't apply to a kind, render the applicable subset, never
  nothing; verification of any mode toggle must assert a DOM difference.
- **GOTCHA — ALL canvas chrome must be screen-constant under zoom.** This bug has
  shipped repeatedly (pivot rings, gizmo halo, node glyphs, bone kites): any
  overlay/control visual whose GEOMETRY is in doc units grows/shrinks with zoom.
  The rule: sizes/radii/offsets derive from `handleSize()`/`screenScaleOf` (screen
  px through the zoom), strokes use `vector-effect: non-scaling-stroke`, text
  font-size divides by the screen scale. VERIFICATION of any new or touched chrome
  MUST include a zoom sweep (fit → ~8×) asserting the element's on-screen size is
  invariant.
- **Any change under `src/view/` must pass `npm run test:interaction`** (real-
  gesture tests, headless Chromium, ~1.5 s). New interaction features get a scenario
  there; the suite was mutation-checked (sabotaging a pipeline makes its scenario
  fail), keep it that trustworthy.
- **`public/PIP_MASTER.svg` is the bundled sample artwork** ("Load sample" button),
  used for demos and live verification. It is just an asset — nothing in the code may
  depend on its specific structure.

## Bone system

Bones 2.0 makes a limb bend from a hand-drawn shape with zero manual binding. The
design goal (verbatim): draw one arm, drop 3 bones (shoulder→elbow, elbow→wrist,
wrist→hand), and the art bends at the joints — no node editing, no bind step.

- **Placement — PEN-TOOL CHAINS.** Bones are `kind:'bone'` null parts placed by a
  click-click pen tool (press-drag-release is gone). The femur button (`icons.ts`
  `bone`) arms `startBonePlacement` (CHAIN mode). The FIRST click sets the chain's
  pending origin; each SUBSEQUENT click commits a bone origin→click and immediately
  starts the next at that new tip, so a chain grows joint-to-joint indefinitely. A live
  preview bone (`.null-glyph.bone.placing`) + an origin marker (`.chain-origin`) follow
  the cursor between clicks (screen-constant girth). ESCAPE / ENTER / DOUBLE-CLICK end
  the chain (`endBoneChain`): the in-progress preview is discarded, every committed bone
  stays. **Child anchoring / continuing a chain:** with a bone *selected* when the chain
  starts, the origin anchors at that bone's `effectiveTip` and the first bone parents to
  it; with an ART selected the first bone parents to it (hierarchy-as-assignment); with
  nothing selected it's a free-form root. Later bones parent to the previous committed
  bone. A click closer than `MIN_BONE_LENGTH_PX` to the pending origin commits nothing
  (mis-click / the second click of a finishing double-click). The whole chain is ONE
  checkpoint (deferred to the first commit) and ONE auto-bind (at the end), so a chain of
  N bones is a single undo. State lives in `ctx.boneChain` (context.ts); the click/preview
  wiring is `interactions.ts`'s `boneChainClick`/`commitBone`; the lifecycle
  (`startBonePlacement`/`endBoneChain`/`cancelBonePlacement`) is in `rigOps.ts`.
- **Chain resolution.** `model.ts`'s pure `boneChain(parts, boneId)` walks up
  bone-only parent links to the ROOT bone, then collects the root plus every
  descendant bone — the unit the auto-binder treats as one skeleton. It is cycle-safe
  and independent of what non-bone part a chain root happens to hang under.
- **Auto-bind on placement — GEOMETRIC + GROUP-LEVEL targeting.** After a placement
  completes, `rigOps.autoBindPlacedBone` resolves the chain and unions its art targets
  from every stage below (most predictable first; nothing already resolved is dropped):
  (1) any art already skinned by a bone in this chain — kept bound as the chain grows
  (later child bones extend the same limb, they never grab new parts); (2) the object
  the chain lives under (`chainAnchorPart` — the chain ROOT bone's parent, resolved from
  the chain itself, not current selection) plus whatever's selected when the chain
  finishes, each expanded via `expandBindTarget` (`geometry/skin.ts`, unit-tested): a
  GROUP, or an art part whose own descendants include further art (Pip's nested
  body-in-body — an outer "body" carrying its own path, with a nested "body" carrying
  several more), expands to its WHOLE art subtree (the user's "select the body, drop a
  chain, everything binds" case — a chain anchored on ANY object binds every piece of
  that object, not just one); a plain leaf art resolves to just itself; (3) else the
  geometric fallback — bind every art part whose actual FILLED geometry a meaningful
  fraction (`AUTO_BIND_COVERAGE`) of the chain runs through, sampled via the live DOM
  `isPointInFill` (`chainFillCoverage`), pool-restricted to a GROUP anchor's own
  descendants when one exists. This REPLACES the old segment↔bounding-box test
  (`segIntersectsBox`), which bound anything a joint's box grazed — a shoulder pivot
  sits inside the body's box, so an arm bone dragged the whole body in. `segIntersectsBox`
  stays a pure helper but is no longer wired into binding. `bindPartsToBones` bakes
  ANCESTOR-FIRST with every part's pre-bake transform snapshotted before any mutation
  (mirrors `groupScaleMembers`) so binding an art part together with its own descendant
  art in one call — a group-level bind's Pip's-body case — stays render-neutral for both.
  Binding runs under the SAME history checkpoint as the placement, so one undo reverts
  placement + every binding it made. Placing over empty/unmatched canvas binds nothing
  (silent). Re-binding an already-skinned part does NOT re-bake geometry (it is already
  in its bind pose); it refreshes the bone set in place and keeps overrides.
- **Bones stay PARENTED under the art (hierarchy-as-assignment).** A chain placed on a
  selected art part is parented to it (`art → bone1 → bone2 → …`), and that parenting is
  the assignment: the layers tree shows the chain under the limb, and code must keep it
  there. Bind must NOT re-parent the chain to root (an earlier overhaul did, to preserve
  the bone world, and broke the tree — do not regress it).
- **Bind is RENDER-NEUTRAL** (< 0.01px): the rendered geometry must be byte-stable
  before/after bind. Two traps, both fixed and both interaction-tested at the rendered
  level (`interaction/bones.test.ts` B7/B13): (a) `applyPathAttrs` MUST clear a stale DOM
  `transform` when the model's is empty — bind bakes `path.transform` into `d` and
  empties it, so a leftover DOM attribute double-applies (parts with an Inkscape
  `rotate(...)`/`matrix(...)` on their paths shifted; transform-less parts didn't); (b) a
  bone parented to an art RIDES that art's rest ownPose (rotate+translate) — baking bakes
  that rest into the geometry and zeroes it on the art, so the bone loses the ancestor
  pose it inherited. `bindPartsToBones` folds the (rigid) lost pose into the bone's OWN
  rest **while keeping its parentId** (`foldLostArtPoseIntoBoneRest`: solve
  `chainMat·ownPose == W`), so its world — hence the identity rest delta and the whole
  child sub-chain — is preserved exact without detaching the chain from the art. Otherwise
  the LBS rest delta un-does the art's rotation and shifts the baked art.
- **The pose model — freeze vs non-freeze (Edit mode).** A bone poses by ROTATION (about
  its origin) + LENGTH (its tip). It has NO free translation — a child bone's origin IS
  its parent's tip (one shared joint), so translating a bone alone would tear the chain.
  All bone edits run the same pipelines; the mode only decides whether the SKINNED ART
  follows or stays put:
  - **NON-freeze (posing the limb):** reshaping a bone deforms the bound art through the
    existing LBS delta-from-bind (`skinRender`). *Tip drag* (leaf or joint,
    `aimBoneAtTip`) aims the bone at the pointer (rotates its `rest.rotate`) AND stretches
    it (its length feeds a per-bone axis stretch in the LBS delta — the art actually
    stretches, not just rotates); child origins ride the new tip. *Body drag / rotate
    gizmo* rotates the bone about its origin (a bone's translate action is redirected to
    rotate; bones are filtered out of every translate pipeline). *Child origin drag* ==
    dragging the parent's tip (moves the shared joint, `aimBoneAtTip` on the parent), so
    the chain never disconnects. Root bone origins are freeze-gated (as art pivots are).
  - **FREEZE (`state.freezeMode`, editing the rig against static art):** the SAME gestures
    move the bones, but the art must NOT move. At the first move of a freeze bone gesture,
    `captureFrozenBaseline` snapshots the art's CURRENT rendered look into its rest
    geometry and re-binds every bone at its current pose (identity delta, unit stretch);
    each subsequent move calls `refreshBindForChain` (restWorldInv/bindSeg → identity
    delta) so the art holds that frozen look while the bone moves; gesture END calls
    `refreshFrozenSkinWeights` (rebuild auto weights from the new bind — parts with
    manual overrides keep them). A ROOT bone origin / full-chain translate is draggable
    ONLY in freeze. Inspector bone fields (rotation/length/position) route through the
    same rule (`rebindFrozenChain`). Everything happens under the ONE gesture checkpoint,
    so a freeze reshape + its bind refresh is a single undo.
- **Connected-chain invariant.** `|child origin − parent tip| == 0` after ANY gesture,
  in either mode. The selected bone's tip handle renders AFTER the glyph loop so a child
  glyph on the shared joint can't occlude it. Interaction-tested (`bones.test.ts` B14
  no-free-translation, `freeze.test.ts` F2; an `afterEach(assertNoGap)` re-checks it
  after every scenario in both files).
- **Weight model.** Auto weights are normalized inverse-distance-power to each bone's
  bind-time segment (`skinWeights`). The RENDER path passes a sharpened exponent
  (`skinRender.ts` `SKIN_WEIGHT_POWER = 4`, vs the unit-tested default 2) because
  inverse-square bends a long thin limb mushily — 4 localizes the joint folds. A bone's
  LENGTH change (vs its bind segment) applies a per-bone along-axis STRETCH to the LBS
  delta (clamped), so dragging a tip stretches the limb; unchanged length ⇒ factor 1 ⇒
  the plain rigid delta (backward-compatible). On top
  of auto weights sit **manual per-node overrides**: `skin.overrides[pathId][cmdIndex]`
  = `{a, b, t}` pins a node's weight to bone `a` at (1−t) blended with bone `b` at t
  (`b:null` = 100% a) — the origin↔tip lerp across the joint where a's tip meets b's
  origin. Overrides are keyed by the path COMMAND index (post-bind geometry is all
  M/L/C/Z, so a command index IS its node); overriding node i governs its endpoint,
  its incoming handle, and the next segment's outgoing handle so the corner stays
  rigid. `skinRender` bakes overrides into the cached weight rows (cache sig includes
  the overrides). The inspector's node-binding editor (node-editing mode, skinned
  part, nodes selected) drives `setNodeBinding`/`clearNodeBinding`; "recompute auto
  weights" is `recomputeAutoWeights` (drops overrides + rebuilds the weight cache),
  ENABLED whenever the part is skinned — not only when overrides exist (the old
  `resetNodeBindings`-gated button was permanently grayed out).
- **What drops overrides.** Structural node edits (insert/delete/join/split) shift
  command indexes, so `nodeEditing.ts` drops the affected path's overrides via
  `dropSkinOverridesForPath` + `invalidateSkinCache`. `normalizeDoc` prunes overrides
  with dangling bone refs or non-finite t and clamps t to [0,1]. Plain node drags and
  one-shot node ops (smooth/symmetric/corner) keep the index, so they keep overrides.
- **IK (full-chain FABRIK).** The IK tool solves the WHOLE bone chain with `ik.ts`
  `solveChainIK` — n-joint FABRIK over the chain's joint polyline (root..effector tip),
  so EVERY joint participates including the grabbed bone's own rotation (the old
  `solveTwoBone` rotated exactly two ancestors and left the grabbed bone rigid — the
  reported "only the immediate parent moves, nothing beyond two joints" bug).
  `solveChainIK` preserves segment lengths exactly, pins the root, starts from the
  CURRENT pose (bend bias — no flips for reachable targets), straightens toward
  unreachable targets, and is deterministic (fixed iterations, no randomness).
  `solveTwoBone`/`solveAim` stay exported only for the unit tests that pin them (and as
  the reference the 2-joint FABRIK path is validated against). The drag pipeline lives in
  `view/ikDrag.ts` (chain resolution, grab bookkeeping, write-back); `interactions.ts`
  only routes pointer events into it. **GRAB-POINT-RELATIVE** (post-A fix — the reported
  "tip snaps to my cursor" bug): the effector is wherever the user actually pressed.
  `startIkDrag` maps the press into the grabbed bone's own frame (`grabLocal`), so a tip
  grab is the classic tip-as-effector case, while a mid-body grab drives THAT material
  point to the pointer and the tip trails rigidly beyond it — the chain polyline's last
  segment is origin→grab-point, whatever its length. Three entry gestures: a BONE glyph
  press, a direct `.bone-tip-handle` press while the IK tool is active (previously that
  circle always ran the single-bone `aimBoneAtTip` reshape regardless of tool), and a
  SKINNED-ART press (the art's own `skin.bones`, deepest-in-chain = grabbed bone, same
  grab-point anchoring). Either way the chain is `[...bone ancestors (kind==='bone'
  only), effector]` (the art a chain roots on is filtered out, never mistaken for a
  joint). **Write-back math:** a bone's `rest.rotate` is RELATIVE (its parent's
  rotation reframes it), so bones are aimed ROOT-FIRST — each bone rotated so its solved
  segment direction matches, re-reading its CURRENT origin/axis (which already reflects
  the parents written earlier this pass) rather than a stale snapshot; because rotating a
  parent reframes its whole subtree, connectivity needs no per-bone carry; the per-bone
  angle step is `ik.ts`'s `chainStepDelta`, valid for OFF-AXIS grab points too (only the
  angle about the origin matters, never the axis length). ONLY
  `rest.rotate` (Edit) / a keyed rotate at the playhead (Animate) changes — never
  `pivot`/`boneTip` — so every bone length stays byte-exact and the shared-joint
  connection (child origin == parent tip) is untouched. Skinned parts are otherwise gated
  out of pose drags, so the IK branch is handled explicitly BEFORE that gate. The chain
  highlight (`.ik-active`) covers ALL participating bones; skin weights are cached, bone
  deltas recompute every `renderPose`. Per-bone rotation limits / pole targets are out of
  scope.
- **Skinned-part UX (user ruling 2026-07-12: rotate+translate ALLOWED).** A skinned
  part accepts the SAME rotate/translate pose drags as any part — its bones are
  parented under it, so those channels carry the whole chain and the LBS-deformed art
  follows (matching the .riv export's rigid Node transform); IK remains the
  articulation gesture (its own first-checked sub-branch in the artwork pipeline).
  SCALE and SKEW stay blocked: they don't propagate to children in the editor (the
  bones wouldn't ride) while Rive Node scale WOULD — a WYSIWYG divergence — so no
  scale/skew handles render (rotate corners DO, both modes), and the inspector locks
  rest sx/sy/kx/ky + keyed sx/sy with an explanatory title. The `.skin-hint` and the
  Skinning section explain the rule. The AI is taught the same model (bones-first
  articulation; part-level rotate/tx/ty as a layered accent; sx/sy tracks on skinned
  parts dropped by `clampRawClip`). Pinned by `interaction/skinnedPose.test.ts`.
- **Export limitation (unchanged).** Skinned parts export RIGIDLY — LBS is not
  representable in Lottie/Rive transform replay. `io/` is untouched by Bones 2.0.

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

### Sixteenth wave (AI Animate System v2: A0–A6) — implemented and verified

Built 2026-07-11/12 as seven audited waves (one subagent each, folder-scoped
ownership, per-wave commits); final gates: build clean, **492 unit / 19 files**,
**159 interaction / 24 files**. The program rebuilt the AI assistant around five
user-approved ideas plus groundwork:

- **A0 groundwork**: root demoted to "whatever group is selected" targeting
  (TARGETING_RULES — the model may never key `root`; the shadow no longer rides
  a jump), `buildScenePayload` (part tree + selection), the Animate-mode
  clean-preview toggle (`C`) hiding ALL editor chrome.
- **A1 session/intent UX**: prompt text persists until sent; TWO actions —
  [Create new animation] (returns a named clip, added + selected) and [Modify
  current] with a protect-playhead-keys checkbox (prompt instruction AND
  post-apply enforcement via `snapshotProtectedKeys`/`enforceProtectedKeys`);
  duration pinned by schema echo + clamp.
- **A2 preview-before-apply**: AI results NEVER mutate the doc — they enter a
  looping canvas preview (`setPoseSampler`, the SM-preview infrastructure) with
  an Apply / Retry / Discard bar; Apply is the existing atomic one-undo path.
- **A3 filmstrip vision**: keyframe-cluster frame selection (≤6 frames ≤320px,
  captioned image blocks) on animate AND critique calls; Retry re-renders the
  CANDIDATE clip so refinement reacts to what the model actually produced.
- **A4 clip-scoped refinement threads** (+ the `panels/ai/` folder split, first
  ratchet burn-down): per-clip conversation threads (localStorage,
  docName:clipName, 6-turn cap, record-on-APPLY-only), prompt box = thread
  composer, thread strip under the prompt.
- **A5 rig profile + motion templates** (rig-AGNOSTIC): `ai/rigProfile.ts` —
  pure heuristic analysis (bone chains + deformed art, left/right symmetry
  pairs with matrix-mirror detection, torso/head/limb/face/shadow/prop role
  guesses, figure group), memoized on a hierarchy signature; five archetype
  buttons (walk/breathe/jump/wave/gesture) FILL the prompt with beat-mapped,
  profile-resolved instructions (never auto-send); every request leads with a
  compact RIG PROFILE block (`ai/profileBlock.ts` leaf — `claude.ts` frozen at
  its ratchet ceiling). Rig-agnosticism is test-enforced: a source grep bans
  sample part names; the girl fixture drives the same buttons naming HER parts.
- **A6 one-click Polish**: `panels/ai/polish.ts` analyzes the active clip
  (biggest per-track moves → anticipation where there's lead-in room, the same
  arrivals → settle-with-overshoot, scale-relative fast-vertical test →
  optional squash-and-stretch, loop-clean check) + profile chain
  follow-through, wrapped in an explicit choreography-preservation contract,
  sent immediately through the Modify flow (`instructionOverride`) — safe
  because the A2 preview gates the apply; the user's own prompt draft is never
  touched (`ai.polishInstruction`). Found+fixed: buttons outside `AiFields`
  missed `setBusy`'s disable path.

Next per user sequencing: the two bone-feel fixes (freeze origin-drag on
unselected bones; grab-point-relative IK), then the architecture refactor pass
(burn the ratchet grandfather list), then H1/H2 headless, then Category B, D1/D2.

### Headless export pipeline + first Android-runtime playback verification (2026-07-12)

`scripts/exportPipTakePill.ts` (commit 3e799d8) authors a complete animation with no
GUI: importSvg → programmatic part/clip assembly → exportRiv, run via
`npm run export:take-pill`. Two verification firsts for the .riv encoder:

- **Official web runtime**: the exported file renders pixel-verified in
  `@rive-app/canvas` (scrubbed frame-by-frame; `out/preview.html` is the harness,
  including a rAF shim for throttled embedded panes).
- **rive-android 11.1.2 on a real device**: the same file plays correctly inside the
  Dosey app (user-confirmed on-device, 2026-07-12) — the first rig-studio export ever
  run on the Android runtime; all previously shipped .rivs there came from the Rive
  editor (different header fileId).

The wave also fixed a real exporter gap: per-part sx/sy keyed channels were silently
dropped (only root could key scale); output is byte-identical for docs that never key
part scale.

### Fifteenth wave (v2.13: bones-as-hierarchy program) — implemented and verified

Built 2026-07-11 across seven audited waves driven by the user's live testing
(each commit gated on build + unit + interaction suites): d1c26b5 (six
reproduce-then-fix bone bugs incl. point-in-fill auto-bind targeting and
render-neutral binding), 06320f8 (loop moved to clips — Rive parity — + SM
three-column layout), a374dbd (the freeze/non-freeze semantics matrix: freeze
edits the rig over static art via bind-refresh holding the CURRENT appearance;
non-freeze poses — tip drags aim+stretch with a per-bone LBS stretch term;
chains parented under their art part; the |child origin − parent tip| == 0
invariant asserted after every scenario), b7ae446 (freeze mode UI with banner +
tint, root-only bone positions — children are rotation+length, File→New,
skinned→deform language), a66884c (dirty-flag unsaved guard + PNG/SVG export),
f89d6dc (RECURSIVE nested-group import preserving exact SVG structure — the
girl fixture imports as 21 nested parts, and PIP_MASTER itself surfaced
authored body-in-body nesting the flat importer had been destroying — plus the
8-item batch: node-editing suspends deformation for the edited bound part,
bones visible in node mode, bind-to-bone dialog in node ops, canvas-tools
two-row layout, screen-constant bone glyphs + the generic assertScreenConstant
zoom-sweep helper, IK chain highlight + target line, tip drags preserve every
descendant's length/direction), and group handle sets (distributed rest-scale
on descendants about the group pivot — ancestor-first ordering with live chain
re-derivation to avoid double-shifting nested members — rotate corners on
second click, Animate parity; found+fixed a stale-overlay bug in Ctrl+G).
Two new GOTCHA conventions came out of this wave's recurring-bug analysis
(screen-constant chrome; visible mode-change counterparts). Final gates:
build clean, **332 unit / 11 files**, **72 interaction / 10 files**.
Deferred by user decision: swap the default sample to girl_example + pull the
commercial PIP_MASTER art from public distribution (the marked FINAL item).
[Update: CANCELLED later that day — Pip stays as the permanent public demo
sample; girl_example.svg remains a nested-import test fixture only.]

### Fourteenth wave (v2.12: UX overhaul program) — implemented and verified

Built 2026-07-11 as 8 phased subagent waves (P1 solo → P2a/b/c parallel → P3 →
P4 → P5a/b parallel), each audited and committed separately; final gates:
`npm run build` clean, **301 unit tests / 11 files**, **36 interaction tests /
7 files**. Locked decisions: Setup→**Edit** (UI only, enum stays `setup`);
bones **auto-bind on placement**; AI snapshot = current playhead pose; AI
schema targets the new bone system.

- **P1**: feature-folder reorg (core/geometry/io/view/timeline/panels/ui/ai),
  panels.ts split behind a facade, Code architecture section added.
- **P2a**: in-app dialog system (ui/dialogs.ts — zero browser alert/prompt/
  confirm remain), inline layer rename, right-click context menus (layers +
  canvas via ui/contextMenu.ts + ui/actions.ts), Edit rename.
- **P2b**: fixed the gray-triangle drag-label artifact (halo missing
  non-scaling-stroke), rotation drags record accumulated wrapped angles (the
  "wrong direction" playback bug), segment bends preserve smooth/symmetric
  mirrors, node glyphs screen-constant at any zoom, selected-node rings,
  zero-length handles hidden.
- **P2c**: optional artboard (`doc.artboard`, normalizeDoc-seeded from
  viewBox) rendered as a page rect; inspector section; both exporters use it
  as the reference frame when enabled (disabled = byte-identical, pinned).
- **P3**: Inkscape group dive-in (dblclick enters WITHOUT selecting; single
  clicks select children; Escape/blank steps out one level), layers Shift
  range + Ctrl toggle, canvas Ctrl+click joins selection, unified V gizmo
  (first click translate handles/body-drag translates; second click rotate
  handles/body-drag rotates about the pivot; pivot circle + center cross) —
  consistent across Edit and Animate (rest vs keys).
- **P4 Bones 2.0**: femur icon; child bones anchor origin at the parent tip;
  auto-bind on placement (chain resolution + overlap test, one undo);
  sharpened auto weights (power 4); per-node {a,b,t} overrides via the
  inspector node-binding editor; IK verified through a skinned 3-bone chain.
  See the "Bone system" section.
- **P5a**: fixed-height timeline + persisted resize splitter (creating a
  keyframe can no longer resize the canvas mid-drag — a P3-discovered CTM
  bug, now test-pinned); transport buttons; alternating lanes; marquee
  padding; curves/logic mode picker; curves pan/zoom (fixed an anchor-desync
  bug), value headroom + drag value-snap (Alt bypasses).
- **P5b**: per-property keyframe toggle circles in the Animate inspector
  (keyAt/removeKeyAt helpers, timeline-consistent semantics); AI panel
  Animate-only with busy overlay + Cancel (AbortSignal; canceling leaves the
  doc untouched); snapshot labeled current-playhead with a help tooltip;
  structural schema extended (addBones tips + bindParts, bound atomically
  with the clip in one undo step via the view facade at the ai.ts layer).

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
- **IK**: two-bone analytic solve in `src/geometry/ik.ts`; verified live on a placed bone
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
- **Curve editor** (`src/timeline/graph.ts` + timeline "curves" toggle): verified a preset
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
  selection/first/last/canvas): pure math in `src/geometry/align.ts`, applied through
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

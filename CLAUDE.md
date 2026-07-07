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
| `view.ts` | Canvas: renders the rig as live SVG, wheel-zoom-at-cursor + middle-drag pan, Setup-vs-Animate drag semantics (rest pose vs. keyframes), parent-chain-aware pose composition and effective pivots, bone lines, onion-skin ghost layers, multi-part selection/drag, node editing, overlay visuals |
| `timeline.ts` | Clip transport (play/pause/duplicate/rename/delete/duration, speed selector, ping-pong, onion toggle, fps readout), scrubber, keyframe lanes with click/shift-click/marquee selection, retime drag, a key-property row (time/value/easing) for the selection, copy/paste/nudge/column-select |
| `panels.ts` | Layers **tree** (parts nest under their parent, fold open to show child paths, drag-to-parent / drop-to-unparent), inspector (Setup: rest/pivot/parent fields; Animate: keyed channel fields), Claude assistant panel (prompt animate, critique, optional pose-snapshot attachment) |
| `history.ts` | Snapshot-based undo/redo; call `checkpoint()` BEFORE any doc mutation, one per user gesture |
| `paths.ts` | Path-data parser/serializer (normalizes to absolute M/L/C/A/Z), de Casteljau cubic split for node insertion, `arcToCubics`/`pathToCubics` (W3C endpoint→center parametrization) so arc segments can be split and exported as geometry |
| `transforms.ts` | SVG transform-list parser plus a small affine `Mat` toolkit (`multiply`/`invertMat`/`applyMat`/`rotationMat`); `rotationPivotOf` finds a transform list's fixed point by testing the *composed matrix* for a rigid rotation, so it recovers pivots regardless of whether Inkscape wrote `rotate(...)` or an equivalent `matrix(...)` |
| `exportCompose.ts` | `RigDoc` → Kotlin text (mood enum, keyframe choreography with all 4 easings mapped to Compose easings, rest-pose offsets folded into emitted channels, nested parent-chain `withTransform` calls, `DrawScope` replay of SVG transforms incl. `matrix(...)`) |
| `exportLottie.ts` | `RigDoc` + one clip → Lottie JSON (v5.7.0, 60fps): a root null layer for whole-figure translate/scale, one shape layer per part with Lottie-native `parent` layer references mirroring the bone hierarchy, geometry flattened through baked SVG transforms with arcs converted to cubics, easings converted to bezier handles |
| `claude.ts` | Anthropic SDK calls (`claude-opus-4-8`): `animateWithClaude` (adaptive thinking, structured outputs guaranteeing a valid clip JSON, parent-aware system prompt, optional base64 pose snapshot for vision grounding) and `critiqueWithClaude` (plain-text animation review) |
| `main.ts` | Bootstrapping, toolbar (open SVG/project, sample, save project, undo/redo, Compose/Lottie export, Setup/Animate toggle), autosave to `localStorage`, keyboard shortcuts (Tab mode toggle, Ctrl+C/V keyframe copy-paste, Delete, arrow-key nudge-or-scrub, `F` fit-view, Space play) |

## Conventions that must hold

- **Coordinates are SVG document space:** +y down, positive rotation = clockwise.
  Every part rotates around its own pivot; `root` is a synthetic target for whole-figure
  translate + scale (jumps, squash-and-stretch) around `rootPivot`.
- **Setup mode edits the character; Animate mode edits keyframes.** Rig drags in Setup
  write `part.rest` (rotate/tx/ty) and are never keyed; the same drags in Animate call
  `setKeyframe()` at the playhead. Pivots and node editing are Setup-only. Toggle with
  the top-right buttons or `Tab`.
- **Part parenting composes like a bone hierarchy.** A part's rendered transform is its
  ancestors' pose transforms (outermost first) followed by its own; `ancestorChain()` is
  cycle-safe and `setParent()` refuses to create one. Effective pivots for gizmos/bone
  lines account for the whole chain (`view.ts`'s `effectivePivot`/`chainMatOf`).
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

## Status

### Implemented and verified this session

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

Code is written and type-checks, but I either couldn't exercise it live (needs a real
Anthropic API key, or a real Lottie/Compose consumer) or only checked it structurally.

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

### In progress

- **Unit test suite** (`npm test`, Vitest) — a background subagent is adding coverage.
  So far: `src/__tests__/paths.test.ts` and `transforms.test.ts`, **40 tests, all
  passing**. Still to land: `model.ts` (channel sampling/easing curves, keyframe
  clipboard, parenting/cycle rules, `normalizeDoc` back-compat), `importSvg.ts`
  (pivot-from-matrix and `transform-center` regression tests, run under jsdom), and an
  `exportCompose.ts` smoke test. Run `npm test` to check current status before
  reporting this done.

### Not started

- No visual/screenshot regression proof was captured this session (the preview
  screenshot tool was flaky/unavailable in this environment); verification instead
  relied on DOM inspection and scripted pointer/keyboard events through
  `window.__rigStudio`. Worth a manual look in a real browser before shipping.
- Per-part AI motion suggestions and richer critique-mode UI (currently a single
  scrollable text block) are unbuilt.

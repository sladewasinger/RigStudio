# Rig Studio

A browser-based 2D rigging and animation editor for SVG characters that exports
Jetpack Compose rig code. Built originally inside the Dosey Android project
(`C:\Users\Austin\AndroidStudioProjects\Dosey`, branch `fable`) to animate its mascot
**Pip** — a pill with arms and legs — and now developed standalone in this repo.

## What it does

Import a labeled SVG (Inkscape layer groups) → each named group becomes a rig **part**
with a **pivot** (joint) → pose parts on a canvas and record **keyframes** on a timeline
→ organize animations as **clips** (one clip = one "mood") → export a Kotlin file that
replays the whole rig with Compose `InfiniteTransition` keyframes and `DrawScope`
transforms. There is also an AI assistant panel that sends the rig + active clip to the
Claude API and applies choreography from a natural-language prompt.

## Commands

```sh
npm install
npm run dev        # Vite dev server, http://localhost:5173
npm run build      # tsc --noEmit type-check, then vite build
```

No test suite yet. Verify changes by loading `public/PIP_MASTER.svg` via the
"Load Pip sample" button. A debug hook exists on `window.__rigStudio`
(`state`, `exportCompose`, `renderPose`) for driving the app from the console.

## Architecture (src/)

| File | Responsibility |
|---|---|
| `model.ts` | Document model (`RigDoc`/`RigPart`/`Clip`/`Track`/`Keyframe`), app state singleton, pub/sub (`subscribe`/`notify`), pose sampling (`sampleChannel`), auto-key (`setKeyframe`) |
| `importSvg.ts` | SVG file → `RigDoc`. Unwraps Inkscape layers; named groups → parts; ellipse/circle/rect → path data; `rotate(a,cx,cy)` group transforms seed pivots |
| `view.ts` | Canvas: renders the rig as live SVG, selection, rotate/translate drags (auto-keyed), pivot drag, node editing, overlay visuals (dashed transform box, ghost pivots, rotation arc gizmo) |
| `timeline.ts` | Clip transport (play/pause/duplicate/rename/delete/duration), scrubber, keyframe lanes with draggable diamonds |
| `panels.ts` | Layers list (select/rename), inspector (numeric pose/pivot fields), AI assistant panel |
| `history.ts` | Snapshot-based undo/redo; call `checkpoint()` BEFORE any doc mutation, one per user gesture |
| `paths.ts` | Path-data parser/serializer (normalizes to absolute M/L/C/A/Z), de Casteljau cubic split for node insertion |
| `transforms.ts` | SVG transform-list parser (shared by import pivot-seeding and export emission) |
| `exportCompose.ts` | `RigDoc` → Kotlin text (mood enum, keyframe choreography, DrawScope replay of SVG transforms incl. `matrix(...)`) |
| `claude.ts` | Anthropic SDK call (`claude-opus-4-8`, adaptive thinking, structured outputs guaranteeing a valid clip JSON) |
| `main.ts` | Bootstrapping, toolbar (open/sample/undo/redo/export), keyboard shortcuts |

## Conventions that must hold

- **Coordinates are SVG document space:** +y down, positive rotation = clockwise.
  Every part rotates around its own pivot; `root` is a synthetic target for whole-figure
  translate + scale (jumps, squash-and-stretch) around `rootPivot`.
- **Easing lives on the ARRIVING keyframe** in the model; Compose's `using` applies to
  the segment LEAVING a keyframe, so the exporter looks one keyframe ahead
  (`easeInOut` → `FastOutSlowInEasing`, `linear` → Compose default).
- **`checkpoint()` before every mutation, once per gesture.** Drags defer the checkpoint
  to the first pointer movement so plain clicks don't pollute history.
- **Exported Kotlin must compile against the Dosey app** (Compose BOM there). Known
  traps already handled: float `f` suffixes, `rememberInfiniteTransition` lives in
  `androidx.compose.animation.core`, scientific notation in path data gets expanded,
  `withTransform` brace balance. If the exporter changes, re-verify by dropping an
  export into the Dosey app (`app/src/main/java/com/austinwasinger/dosey/ui/components/`)
  and running `gradlew :app:compileDebugKotlin`. A previous export lives there as
  `PipStudioRig.kt` and shows on Dosey's debug Test tab.
- **The canonical Pip artwork** is `Dosey/media/PIP_MASTER.svg`; `public/PIP_MASTER.svg`
  here is a bundled sample copy — re-sync it when the master changes.

## Features implemented

- SVG import: named groups → parts, shape normalization, pivot seeding from authored
  `rotate(a,cx,cy)` transforms, bbox-center fallback pivots
- Layers panel with rename (names become Kotlin identifiers)
- Rig posing: drag-rotate around pivot (Ctrl = 15° snap), Shift+drag translate,
  draggable pivot crosshair, numeric inspector fields
- Overlay visuals: dashed transform box + corner handles tracking the live pose,
  ghost dots on every part's pivot, rotation gizmo (pivot line, swept arc, angle
  readout), translation delta readout
- Node editing: drag endpoints/cubic control handles, Alt+click insert node
  (exact cubic split), Ctrl+click delete
- Timeline: clips, auto-keying at the playhead, draggable/deletable keyframe diamonds,
  scrubbing, looped playback, clip duplicate/rename/delete/duration
- Undo/redo: snapshot history, toolbar buttons + Ctrl+Z/Shift+Z/Y, one step per gesture,
  covers all mutations including AI applies
- Keyboard: Space play/pause, arrow-key playhead stepping (Shift = ×10)
- Claude assistant: prompt → updated clip via structured outputs; API key in
  localStorage; system prompt teaches rig semantics + animation craft
- Compose export: mood enum per clip, `InfiniteTransition` keyframes per channel,
  SVG transforms replayed (translate/scale/rotate/matrix via `svgMatrix` helper),
  compile-verified against the Dosey app

## Features needed (roadmap, roughly prioritized)

1. **Project save/load** — serialize `RigDoc` to JSON (File System Access API or
   download/upload) so work survives a refresh; autosave to localStorage.
2. **Canvas zoom/pan** — scroll-wheel zoom around the cursor and middle-drag pan;
   overlay handle sizes already compensate via `handleSize()`.
3. **Part parenting / bone hierarchy** — parent a part to another so limbs chain
   (upper arm → forearm). Touches the model (parentId), pose evaluation (compose parent
   transforms), export (nested withTransform), and the drag math.
4. **Onion skinning** — ghost render of adjacent keyframe poses while posing.
5. **Easing editor** — per-keyframe easing selection in the UI (only the model +
   exporter know about `linear` today; no way to set it by hand), possibly cubic-bezier
   curves (exporter would emit `CubicBezierEasing`).
6. **Keyframe utilities** — copy/paste poses across time, select-all-at-time (column
   select), nudge keys with arrow keys, box-select diamonds.
7. **Arc segment splitting** in node editing (`A` commands currently move-only);
   consider arc→cubic conversion on demand.
8. **Multi-part selection** for posing groups together.
9. **AI upgrades** — send a rendered screenshot of the current pose (vision) for better
   spatial grounding; "critique this animation" mode; per-part motion suggestions.
10. **Rive/Lottie export** — the model is close to Lottie's (keyframed transforms on
    layers); a Lottie exporter would make clips portable beyond Compose.
11. **Playback polish** — playback speed control, ping-pong loop mode, frame-rate
    display.
12. **Tests** — the pure modules (`paths.ts`, `transforms.ts`, `model.ts` sampling,
    `exportCompose.ts`) are trivially unit-testable with Vitest; add it.

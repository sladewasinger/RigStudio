# Rig Studio

A browser-based 2D rigging and animation editor for SVG characters (like Pip) that
exports Jetpack Compose rig code matching the shape of `PipRig.kt`.

```sh
cd tools/rig-studio
npm install
npm run dev        # http://localhost:5173
```

## Workflow

1. **Import** — `Open SVG…` (or `Load Pip sample`). Each named top-level group
   (`inkscape:label`) becomes a layer/part. Ellipses, circles, and rects are converted
   to paths. A group transform of the form `rotate(a, cx, cy)` seeds the part's pivot at
   `(cx, cy)` — pre-rigged joints import for free; everything else gets its bbox center.
2. **Rig** — select a part (canvas or Layers panel; double-click a layer to rename).
   The selection shows a dashed transform box; every part's joint appears as a faint
   ghost dot, and the selected pivot is a ring-and-crosshair you drag to re-place (or
   type coordinates in the inspector). In **Node editing** mode, drag path
   endpoints/control handles to reshape; Alt+click inserts a node, Ctrl+click deletes.
3. **Animate** — scrub the timeline and pose parts: dragging on the canvas rotates the
   selected part around its pivot and auto-keys at the playhead, with a live gizmo
   (pivot line, swept arc, angle readout — hold **Ctrl to snap to 15°**). Shift+drag
   translates with a delta readout. The `root` target moves/scales the whole figure
   (jumps, squash-and-stretch around the root pivot). Drag diamonds to retime;
   double-click to delete. Clips = moods; `duplicate` clones one for variants.
4. **Animate with Claude** — enter an Anthropic API key (stored in localStorage, sent
   only to `api.anthropic.com`), describe the motion ("make him wave", "bend at the
   knees then jump"), and the assistant rewrites the active clip's keyframes. Uses
   `claude-opus-4-8` with structured outputs so the reply is always a valid clip.
5. **Export** — `Export Compose rig (.kt)` downloads a generated Kotlin file: one
   `<Name>Mood` enum entry per clip, `InfiniteTransition` keyframes per channel, and a
   draw function that replays the SVG transforms (including `matrix(...)`) in Compose.
   Drop it into `app/src/main/java/.../ui/components/`.

## Shortcuts

| Key | Action |
|---|---|
| `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` | Undo / redo (every gesture is one step, including AI edits) |
| `Space` | Play / pause the active clip |
| `←` / `→` (`Shift` = ×10) | Step the playhead 10 ms / 100 ms |
| `Ctrl` while rotating | Snap to 15° |
| `Shift` + drag part | Translate instead of rotate |

## Semantics

- Coordinates are SVG document space: +y is down, positive rotation is clockwise.
- Each part animates `rotate` (around its pivot), `tx`, `ty`; `root` adds `sx`/`sy`.
- Keyframe easing (`easeInOut`) is stored on the *arriving* keyframe and exported as
  Compose `FastOutSlowInEasing` on the segment.
- Clips loop; keep first == last keyframe values for clean cycles.

## Limitations (current)

- Flat rig: parts don't parent to each other (no two-bone arms yet — split limbs into
  separate labeled groups in the SVG if you need an elbow).
- Arc path segments (`A`) can be moved by endpoint but not split in node editing.

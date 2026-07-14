# Rig Studio Roadmap

A full-fledged 2D rigging/bones/animation tool with basic vector editing —
modeled loosely after Rive, but simple. Checkboxes track status. Start with the
**STATUS DASHBOARD** below for what's outstanding and who needs to weigh in;
completed work lives in **COMPLETED WORK — ARCHIVE** (newest first); **v3 —
Future** at the very bottom is the honest out-of-scope backlog new work should
be drawn from.

## STATUS DASHBOARD

### Austin's review list

*Shipped with flags — eyeball these when back.*

- **Node-editor seam unification design** (61ea081) — REVIEW IT: one merged
  glyph, M side is primary, del-seg opens the pair one-click (UI-only
  unification; the underlying data model is untouched). The design-sweep
  extras (insert-preview ghost, dblclick-insert, hover affordances, drag
  behavior when both seam nodes are selected) remain proposals only, not
  built — see WHAT'S NEXT below.
- **Group-like scale semantics** (63a2b67) — art-with-children's own paths
  scale along with descendants, pivot-anchored. If "own paths + descendants
  both scale" feels wrong in testing, it's a one-predicate-site change —
  flag it.
- **.riv keyed-z + opacity VISUALS** (7155013) — decoder+runtime verified,
  but on-screen stacking/fade blending needs a real player look (rive.rip).
  (The "pixel readback is impossible headless" premise is now FALSE — the
  skinned-export wave found the drawNow flush workaround in riv-check.html —
  so these could alternatively get automated pixel checks there.)
- **Skinned-part .riv export on a real rig** (this wave) — the two-bone-bar
  articulation is pixel-verified in @rive-app/canvas headlessly, but a real
  character (bind a limb in the app, export, rive.rip or the Android
  runtime) deserves one human look — same protocol as the 2026-07-12
  on-device verification.
- **Take-pill hash re-pin** (dbac402) — canonical order changed the bytes;
  verified visually via render-frames; the Dosey checkout's riv+rig.json
  outputs were rewritten with the canonical bytes (the generating script has
  since been deleted, 124bca2 — the byte-identity gate now lives in-repo as
  `src/__tests__/goldenRiv.test.ts`, pinned to SHA-256 `a1c6ff4b…`).
- **D1 real-disk round trip** (91ac929) — open a real .rig.json via the OS
  picker, Ctrl+S, confirm the file on disk changed, Save As, check the
  recents dropdown + the installed-PWA flow — only a human can drive the OS
  dialogs.

### Deferred decisions

*Decisions that are Austin's to make — nothing below gets built without his call.*

- **Keyed-z DrawRules vs childOrder slots** (U3, 3e4a71f): the .riv keyed-z
  planner keeps pre-U3 GLOBAL-order semantics; an INTERLEAVED doc that
  also keys z can diverge editor-vs-runtime in three narrow ways (scope,
  anchor granularity, mover granularity — full note in
  `io/riv/drawRules.ts`'s header). Byte-identical for every synthesized doc;
  NOW USER-REACHABLE (U4 landed 2026-07-14: fresh imports record true
  document order and the Layers panel interleaves freely — note PIP itself
  interleaves at body/face, so keying z on those parts touches the
  divergence). Decide: redesign the planner slot-aware (per-run targets +
  sibling-scoped neighbor ranking), or accept the documented divergence.
- **Bone-deletion cascade vs attachments** (7d4f662): deleting a bone
  cascades its same-chain subtree; `attachedRoot` children DETACH
  world-preserving instead of dying. Say if attachments should cascade too.
- **Keyable PATH-level paint channels** (per-path fill/stroke opacity/color
  animation): Rive supports it (our keyed-opacity export already targets
  per-paint SolidColor) and the model could grow path channels — real
  feature scope, his call whether the timeline should ever list paths.
- ~~Unified child ordering~~ — APPROVED BY USER 2026-07-13 AS PRIORITY #1
  ("YES. I want this to work exactly how you said… this is priority #1. So
  do it."). Moved to the U-program below; the auto-promote drag stopgap was
  CANCELLED pre-landing (superseded — its behavior would have been wrong
  post-surgery).

## U-program: unified child ordering (the full Inkscape model) — COMPLETE (U1–U4)

*User-approved priority #1, closed 2026-07-14. One ordered MIXED child list per
part (paths and child parts interleaved) — panel order = paint order for
EVERYTHING, the importer preserves SVG document order exactly, exporters
express it. The two-bucket model (own paths always below children) and its
import restacking fidelity bug are dead. Remaining non-goals: Lottie stays
paths-first (frozen exporter, documented) and renderOnion ghosts stay flat
per-part (editing aid); the keyed-z DrawRules divergence is a live deferred
decision (see the ledger above).*

- [x] **U1 — model + plumbing (zero behavior change)** (done 2026-07-13,
  03f7489): `RigPart.childOrder`
  (ordered slots `{kind:'path'|'part', id}`); normalizeDoc SYNTHESIZES
  paths-first-then-children for docs without it (≡ today's paint order — old
  files render identically) and repairs dangling/missing/duplicate slots; a
  slot CHOKEPOINT so every structural op (add/remove path or child, group/
  ungroup/delete/duplicate/reparent/movePathToPart/extract) maintains slots;
  serialization round-trip; per-op integrity tests. Renderer untouched.
- [x] **U2 — rendering honors slots** (done 2026-07-14, 7690d2f): canvas paint = per-parent slot order
  (a part's paths render as document-ordered RUNS interleaved with child
  part groups — flat sibling `<g>`s sharing the part's composed transform,
  no inheritance change); headless composePose same flatten; animate-time
  keyed `z` rule: PART slots stable-sort by z within their parent's slot
  list, PATH slots hold their rest positions (paths have no channels).
  Synthesized docs render byte-identically — pinned.
- [x] **U3 — exporters** (done 2026-07-14, 3e4a71f): .riv global drawable order = the slot flatten
  (synthesized docs byte-identical, golden pin holds; interleaved docs get
  correct stacking). Lottie: DOCUMENTED LIMITATION only (frozen — one layer
  per part can't interleave; keeps the paths-first approximation).
  Sequencing note: the skinned-.riv-export wave has LANDED (2026-07-13, see
  the archive) — the io/riv collision is cleared; U3 must keep skinned paths'
  Skin/Tendon emission intact through any drawable-order change.
- [x] **U4 — the user-visible layer** (done 2026-07-14): importer records TRUE
  SVG document order into slots (the restacking fidelity bug is dead — Pip's
  body shading finally paints on top, matching Inkscape); layers panel rows =
  slot order with full drag-reorder between ANY rows (paths ↔ parts as
  siblings; Inkscape edge-drop rule — a path dropped between two ROOT parts
  is refused with a visible reason, a part dropped between path rows becomes
  a slotted child of their owner); PageUp/Down + stacking row step one SLOT;
  e2e = the user's literal shadow gesture (model slots + panel rows + canvas
  DOM + undo, all asserted together). The main golden re-pinned per protocol
  (render-frames diff = exactly the body-shadow correction; AFTER matches a
  raw-SVG render pixel-exact in the body region; skinned pin held). Full
  entry in the archive below.
- **Unified skeleton Phase 2 — IK across attachments**: does grabbing a hand
  FABRIK through the spine? Default OFF (IK chain resolution stops at
  attached roots — safer, predictable); the full-body solve is a flag to
  discuss. Documented, not built.
- **Unified skeleton Phase 3 — placement sugar**: starting a pen chain with
  a bone selected but clicking far from its tip could create an attached
  root at the click instead of anchoring at the tip. Needs UX thought; not
  built.
- **D2 (Tauri desktop)**: requires installing the Rust/Tauri toolchain on
  this machine — not doing unattended. D1 (browser-native APIs) proceeds
  instead. Full spec (WebView2 parity, 3–10MB bundles, macOS WKWebView QA)
  is kept in the Desktop archive section below.
- **Lottie**: frozen per earlier ruling (may be deleted); the .riv-only
  export wave proceeds; ALL Lottie questions deferred.
- **Node editor design-sweep extras**: proposals only, not built — need a
  short design write-up and Austin's sign-off before implementing. Full list
  in the Node editor revamp archive section (also indexed in WHAT'S NEXT).
- **H2 MCP tool AUTH/packaging**: built as a local stdio npm package per the
  spec; publishing/naming decisions deferred.

### Standing design principles

**Parts and groups act the same — like Inkscape** (user direction
2026-07-13): parts stay in the MODEL (a part is the unit of animation/export
— the Rive Node; paths stay cheap geometry) but disappear from the MENTAL
MODEL: containers and leaves, uniform Inkscape-like behavior everywhere.
Group vs art-with-children vs plain art must never behave differently for
selection/drill/boxes/ordering; navigation works the same in both modes
(only EDITING ops are Edit-gated); "extract path → own part" is the
promotion path when geometry needs a timeline life. New UX should be checked
against this principle.

**Layer order IS z-order** (shipped 2026-07-13, dbac402): the Layers panel
shows REST structure, and its depth-first display order IS the rest paint
order (`doc.parts` array order = DFS of the hierarchy; sibling order is the
draggable freedom) — moving a subtree in the panel moves its whole paint
block. The keyed stepped `z` channel stays an ANIMATE-TIME-only override
that re-sorts the CANVAS; the panel never re-sorts during animation (panel =
structure you edit, canvas = animated result). Edit mode shows pure rest
order. Full audit history: see COMPLETED WORK ARCHIVE → Layer order IS
z-order.

### What's next

*Every remaining `- [ ]` in this file, indexed here with a pointer to its section.*

- ~~Keyframeable z-order / Opacity channel / Export wave contradiction~~ —
  RESOLVED (orchestrator, 2026-07-13): all three were shipped and verified
  during the run (editor bf05493/e8c1f8a; export 7155013); checkboxes now
  ticked in place with their commit trail. Only the on-screen VISUALS check
  remains, already on the review list above.
- **Unified skeleton Phase 2 — IK across attachments** (Unified skeleton
  archive section) — deferred decision, see STATUS DASHBOARD → Deferred
  decisions above.
- **Unified skeleton Phase 3 — placement sugar** (Unified skeleton archive
  section) — deferred decision, see STATUS DASHBOARD → Deferred decisions
  above.
- **Node editor design sweep** (hover affordances, insert-preview ghost,
  whether Inkscape's double-click-on-path-insert should coexist with
  Alt+click, drag behavior when both seam nodes are selected — Node editor
  revamp archive section) — needs a short proposal for Austin's sign-off
  before implementing.
- **D2. Tauri desktop wrapper** (Desktop / real file access archive section)
  — deferred decision, see STATUS DASHBOARD → Deferred decisions above.
- **H2 hygiene**: `applyClip.ts`/`bindHeadless.ts` are documented
  hand-synced ports of `panels/ai/apply.ts` and `view/rigOpsBind.ts` —
  extract shared pure cores so the ports can't drift (Headless engine + MCP
  server archive section).
- **Latent nodeTypes desync**: the bind bake's `pathToCubics` arc expansion
  is a latent nodeTypes desync on literal-arc paths (Pattern-driven redesign
  pass archive section, view/nodeEditing chokepoint item) — a task chip was
  already spawned for this.

See also **v3 — Future** at the bottom of this file for the longer-range
backlog that isn't scheduled into any wave yet.

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

## COMPLETED WORK — ARCHIVE

Newest first. Programs/waves below are ordered by their actual git-log
completion timestamps (not by topic), so this really is a changelog you can
trust; the long v1/v2.x version history at the very bottom keeps its original
internal order, formatting-fixed only.

### Headless group-pivot default (follow-up from the far-pivot Girl file)

*2026-07-14, b1fdf49 (worktree wave). Full creation-path map recorded in the
wave report: 8 paths audited; the one member-wrapping op reachable headlessly
is `groupParts`, whose pivot was REQUIRED (in-app Ctrl+G passed a DOM-measured
center; headless callers had nothing sane). Now optional: omitted ⇒ the outer
members' subtree geometry bbox center, computed PURE-DOC by the new
`geometry/pathBounds.ts` (first path-bbox walk in the repo — analytic cubic
extrema, affine-mapped before extrema; hidden excluded, skinned parts map
through identity since their geometry is baked root-space; bones-only
selections average member pivots). Explicit pivots always win; normalizeDoc
never "repairs" pivots on load (deliberate placements stay). 16 mutation-
checked tests; end-to-end on the user's file: wrapping RightArm+Body
headlessly lands (271.3, −856.1) — the exact union center — vs the shipped
(−0.5, 0). RESIDUAL HOLE (mapped, out of scope): headless IMPORT keeps
placeholder pivots — the canvas render-then-measure seeding only runs in-app,
and only for pivots EXACTLY (0,0) (the Girl file's root translate made its
placeholder (−0.529, 0), skipping even the in-app seed); fixing at the import
surface moves the MAIN golden pin (the golden doc imports PIP_MASTER
headlessly) — next wave, with the re-pin protocol. Gates: build clean, 827
unit / 322 interaction, both pins unmoved.*

### Pin-to-body tracking fix (the "pinned nodes frozen in place" report)

*2026-07-14, bcc5ac6 (worktree wave). Reproduced on the user's exact save:
pin=1 armpit nodes sat 94.5/98.1 px from their rigid-equivalent position at
t=500 of his dance clip — nailed to WORLD space, because the pin target was
the raw bind coordinate (a root-space constant). The target is now the
RIGID-EQUIVALENT pose: `fullPose(part,t) · skin.restWorldInv · bindPos`,
sampled per frame like bone deltas (gated by a cached hasPin flag — pin-less
parts run the byte-identical old path). `skin.restWorldInv` is a NEW optional
part-level bind record (the part analogue of each bone's): without it the
plain fullPose target double-applies after a freeze capture on a rest-posed
part (measured 21.2 px, PIN9 pins it); written at bind, mirrored in
mcp/bindHeadless.ts, refreshed by captureFrozenBaseline/refreshBindForChain,
normalizeDoc-validated, absent = identity (legacy docs exact, zero
migration). PARITY: the .riv pin-anchor RootBone is a child of the part's
Node, so the RUNTIME tracked all along — the editor now matches (rule pinned
in io/riv/skin.ts's header; no exporter change; both golden pins +
riv-check's pinnedSkinnedCheck unmoved). Live on his file: a 58.1 px group
drag carries pin=1 nodes 58.1 px with 0.000 px rigid-drift while an unpinned
node stays 129.5 px away (the arm still deforms). Mutation checks: plain-
bindPos revert fails exactly PIN5–8 + the user-file repro; record ignored
fails exactly PIN9. Gates: build clean, 811 unit / 322 interaction on
integrated main.*

### Group second-click rotate fix (the "can't rotate Girl" report)

*2026-07-14, 52ac4d3 (worktree wave). Reproduced on the user's exact save via
the REAL Layers rows — none of the three suspect branches was it: picking a
CHILD row calls `enterGroupsFor` (opens the group as context); picking the
GROUP row afterwards selected it but left it ENTERED, and that contradictory
state suppressed the artwork pipeline's group substitution, so every canvas
click stole the selection down to the child — the second-click rotate toggle
was unreachable. Fix: one predicate in `focus.ts`'s `repairEnteredGroups`
self-healing chokepoint — an entered id survives only as a STRICT ancestor of
a selected part, so selecting the whole group closes its own entry at the
next render. Drill-in dive, Escape ladder, Layers child pick, blank-click
deselect, EG/GL/G suites all pinned unchanged; far-pivot orbit semantics
untouched (GR3 pins rotation about a pivot 200 units away — correct, the
pivot is user-editable in freeze). Mutation check: restoring the old
predicate fails exactly the 3 recipe scenarios + the exact-file repro. Gates:
build clean, 810 unit / 317 interaction (+6), golden pins unmoved.*

### U4 — the user-visible layer (importer document order + slot-aware Layers)

*2026-07-14 (main-tree wave). Closes the U-program. The importer materializes an
explicit `childOrder` per part recording TRUE document order
(`core/childOrder.ts`'s `beginExplicitChildOrder` + one slotAdd per child in
walk order — the one documented exception to U1's LAZY rule; old saves stay
lazy). PIP_MASTER genuinely interleaves (body = [part body, path shadow],
face = [part eyes, path path3]) so the authored body shading now paints on
top — the originating complaint. `core/slotReorder.ts`'s `moveChildSlot` is
the single slot-space reorder op (slot moves first, then paths[]/doc.parts
re-derived to agree — the documented inversion of U1's mirror direction);
Layers rows render in slot order with edge-drop sibling insertion on every
row (`panels/layersDropRules.ts` pure resolver; root-level path drops refused
visibly); PageUp/PageDown + stacking arrows step one slot
(`refreshSelectedStackingDom` re-syncs paint runs); `movePathToPart` gained
`destSlotIndex` (old default slot-append was wrong on interleaved
destinations). Golden re-pin per protocol: before/after render-frames differ
ONLY by the shadow crescent; AFTER matches a raw-SVG resvg render pixel-exact
in the body region (0 vs 8062 mismatched px); skinned pin held. Four mutation
checks (slot write dropped → 7 unit + 4 e2e fail; doc.parts mirror dropped →
the part-swap test fails; importer recording dropped → 3 importer tests +
e2e sanity fail; run DOM sync dropped → the two-runs canvas assertion fails).
Live-verified on a dev server: real DragEvents on the actual rows; the same
screen pixel hit the shadow before and the pill after — visible restack;
undo restored. Gates: build clean, 810 unit / 42 files, 311 interaction /
43 files.*

### U3 — .riv drawable order expresses childOrder slots

*2026-07-14, 3e4a71f (main-tree wave). `io/riv/drawableOrder.ts`:
`drawableEmissionOrder` = the U2 slot flatten (`flattenPaintOrder`, rest z)
fully reversed at both levels into Rive's first-in-file = topmost convention;
scene.ts's shape loop walks it; skin-plan + pin-anchor resolution memoized
once per part at its first emitted run (per-run would mint duplicate anchor
RootBones — mutation-checked). Synthesized/legacy docs emit BYTE-IDENTICALLY:
the pre-change fixture SHA captured and pinned, both golden pins unmoved, and
the reversal-dropped mutation fails the main golden pin itself. Interleaved
docs get correct stacking — pixel-verified in `@rive-app/canvas`
(riv-check.html's `interleavedStackCheck` sandwich; all six harness checks
green). KeyedObject.objectId wiring confirmed order-independent. Keyed-z
DrawRules deliberately keeps global-order semantics — the three narrow
interleaved+keyed-z divergences (scope, anchor granularity, mover
granularity) are documented in drawRules.ts's header and deferred (see the
Deferred decisions ledger). Lottie: documented paths-first limitation only
(frozen). The inspector stacking UI stays on global drawOrder (U4-adjacent,
not in this wave). Gates: build clean, 797 unit / 306 interaction.*

### U2 — rendering honors childOrder (run-splitting)

*2026-07-14, 7690d2f (worktree wave; clean cherry-pick over the pin + deletion
waves). `core/paintOrder.ts` (`flattenPaintOrder`) is the pure childOrder →
paint-sequence kernel shared verbatim by the canvas and headless composePose
(the geometry/pose.ts shared-kernel precedent): contiguous own paths = one
RUN, runs interleave with recursively-flattened children, partless parts emit
one empty ANCHOR run (emitted FIRST — the paths-first synthesis position),
animate-time keyed z re-sorts PART slots only, stable, sibling-scoped (global
`drawOrder` untouched — still backs exporters/stacking UI until U3).
`ctx.partGroups` → id→`SVGGElement[]`; every consumer audited (10 files),
union-bbox/primary-group helpers homed in `view/context.ts` (layering) and
re-exported by partDom.ts; skinned-path DOM lookups go through ctx.rootGroup.
Synthesized docs render BYTE-IDENTICALLY (one run per part, no data-run —
pinned by a dedicated interaction test + all 287 pre-existing scenarios
pixel-stable). Two live mutation checks (always-synthesize; single-group bbox
revert → the hand-predicted −30px flip error). Known gap flagged: renderOnion
ghosts stay flat per-part (approximate editing aid). Gates on integrated
main: build clean, 785 unit / 306 interaction, both golden pins hold.*

### Bone deletion: unbind fold + chain cascade

*2026-07-14, 7d4f662 (worktree wave, cherry-picked over U1 + the pin wave; the
override-pruning it added is pin-aware). Both user reports fixed. (1) "doesn't
reset to rest / teleports off screen": deleting a skinned part's last skin
bones now truly UNBINDS — `deleteParts` folds the inverse ancestor chain into
the part's rest via the shared closed-form rigid fold
(`boneOps.foldRestWorldIntoOwnPose`), ancestor-first ordering (a detached bone
can land under a part being unbound in the same call; a reversed-sort mutation
check pins it). Reproduced at 34.7 px → 0 px; live verification surfaced a
SECOND bug (26.9 px residual): the stale LBS-deformed DOM `d` survives unbind
because renderPose's non-skinned branch never rewrites `d` — fixed at the sole
production call site (`ui/actions.ts` deleteSelectedParts → syncPartPathDom).
(2) "child bones stay alive": `boneDeletionCascade` expands deletion to the
full same-chain bone subtree; `attachedRoot` children DETACH world-preserving
onto the nearest surviving ancestor instead (flagged for Austin: tell us if
attachments should cascade too). Gates on integrated main: build clean, 770
unit / 298 interaction, both golden pins hold.*

### Pin-to-body node weights (the armpit-floats-away report)

*2026-07-14, b45f323. The user's report exposed a MODEL gap, not a bug: carry
overrides `{a,b,t}` only choose WHICH bone moves a node — nothing could say
"stay with the body". Reproduced on his girl_right_arm_limbed file first
(armpit nodes drift 25.47/4.16/1.50/19.78 px on a +40° shoulder rotate despite
100%-shoulder overrides). `SkinOverride.pin` (0..1) holds that fraction of the
node at its bind-pose position — `deformed = lerp(lbs, bindPos, pin)` in
skinRender, endpoint + both handles; `a` may now be null (pin-only entries);
setNodePin/clear independent of carry; "Pin to body" slider in the skin
section (carry controls relabeled "carried by"). .riv parity: pinned skins
emit one synthetic never-animated anchor RootBone+Tendon (bind = the part's
statically-composed world matrix) whose weight share is the pin; weakest-
eviction when a 4-influence row is full; zero pins ⇒ zero bytes — BOTH golden
pins asserted unmoved. Verified live on his file (pin=1 → 0.000 px on all four
nodes, pin=0.5 halves, control node still travels 57.65 px), pixel-verified in
@rive-app/canvas (pinnedSkinnedCheck via drawNow), 6-scenario interaction
suite driving the real inspector UI, mutation-checked (lerp disabled → 7.25 px
vs 0.5 threshold). Gates: build clean, 762 unit / 293 interaction.*

### Skinned-part .riv export (Skin/Tendon/CubicWeight)

*2026-07-13. The "skinned parts export rigidly" limitation is dead for .riv:
bone rotation keys now articulate skinned limbs in official Rive runtimes.*

- [x] **Bones export as RootBone (typeKey 41)** — same x/y/rotation transform
  semantics as the old Node emission (root_bone.cpp skips Bone's parent check),
  so the verified placement math is shared verbatim; keyed bone tx/ty map to
  RootBone's own x/y keys (90/91). Every schema fact pinned from rive-runtime
  dev/defs + src/bones/*.cpp, fetched and cited in io/riv/keys.ts — including
  the non-obvious xx,yx,xy,yy matrix key order and 1-based tendon slots.
- [x] **Skin + Tendon + CubicWeight emission** (`io/riv/skin.ts`; the shared
  path→vertex walk moved verbatim to `io/riv/geometry.ts` with per-vertex
  weight-source records): Skin bind = T(pivot − frame origin), tendon bind =
  invert(restWorldInv)·T(bone.pivot) — full frame-model derivation in skin.ts's
  header; weights are the editor's own rows (SKIN_WEIGHT_POWER now lives in
  geometry/skin.ts, shared by skinRender and the exporter) quantized to
  4-influence bytes summing exactly 255. Hidden/dangling skin bones fall back
  to the old rigid emission.
- [x] **Verified**: 705 unit / 37 files (exportRivSkin.test.ts, 3 mutation
  checks) + 287 interaction / 40 files + build clean; boneless golden hash
  UNMOVED (no-regression proof), second skinned golden pinned (92e04a34…);
  pixel-level articulation in @rive-app/canvas via riv-check.html's
  skinnedCheck (inner half holds, outer half rotates down 89°) — enabled by
  the drawNow flush discovery (pixel readback works headlessly after all).
- Still rigid: Lottie export and headless composePose/render-frames (their
  docs/CLI notes updated to say so explicitly).

### Post-run live fixes

*User-reported 2026-07-13, on his return — all landed.*

- [x] **First-paint chrome blowup on autosave boots** (da0aa44) — the layers
  splitter's grid column existed in CSS before its DOM did; the canvas got
  measured at 6px and chrome radii baked ~50× (the "black blob"/"red
  circles"). One idempotent buildLayersPanel call before any doc load; new
  bootLayout scenario asserts chrome size at zero-interaction first paint.
- [x] **Drill-down dead in Animate** (6f57e9f) — a stale Setup gate on the
  part→path dblclick branch (+ the path inspector/highlight gates), removed
  per the standing "navigation identical in both modes" ruling; GL5 pins the
  user recipe in BOTH modes, GL6 pins a 3-deep ladder.
- [x] **Origin press bends the outline in node-editing freeze** (725988a) —
  the node-editing overlay branch never rendered freeze joint markers, so
  origin presses fell to the segment-bend pipeline. All three initial
  hypotheses ruled out by live reproduction first; F10 + US6b pin it.
  NOTE: reproduced specifically in NODE-EDITING mode — if the user's own
  repro was in plain pose mode, reopen with exact steps (every non-node-mode
  combination was verified correct).

### AUTONOMOUS RUN

*User directive 2026-07-12: "get through as much of the roadmap as possible
without my input — defer + document decisions."*

Execution order (every arrow-item is now ✓ complete; commit hashes point at
the matching archive entry below): bug wave ✓ (63a2b67) → layers + AI branch
integrations ✓ → arc fix + polish guard ✓ → skinned-drags wave ✓ (617df49) →
shortcuts registry ✓ (a1cee54, parallel worktree) → ergonomics wave ✓
(e623d4a) → **unified-skeleton Phase 1** ✓ (064c521) → **layer-order-is-z
audit** ✓ (dbac402) (both added 2026-07-12 before Austin left) →
context-menu polish ✓ (8203345) → node editor items 1/2/4 ✓ (61ea081; item 3
— the design sweep — is still open, see WHAT'S NEXT) → shared pan/zoom
module ✓ (572566c) → .riv export items ✓ (7155013: keyed-z draw order via
DrawTarget/DrawRules, opacity keys, full hidden-part exclusion — verified
against the @rive-app/canvas harness) → H2 MCP server ✓ (c9c4ee8) → Category
B ✓ (918dd3e/eb79af2) → D1 ✓ (91ac929, File System Access + PWA). Every
wave: full gates + roadmap tick — the whole run plan is COMPLETE as of
2026-07-13.

Austin's review list, the deferred-decisions ledger, and the standing design
principles that came out of this run were promoted to the STATUS DASHBOARD at
the top of this file — everything is preserved there, nothing was dropped.

### Desktop / real file access

*Planned with Austin 2026-07-11 — after the A and H programs.*

- [x] **D1. File System Access API + PWA (browser, no packaging)** (91ac929) — behind a
  small storage interface (open/save/saveAs/recents): Chromium's
  showSaveFilePicker gives writable in-place Save (no more download-per-save);
  persisted IndexedDB file handles make RECENT FILES real (subsumes the
  Category-B item — don't build it twice); PWA manifest for installability.
  Interaction coverage round-trips through OPFS handles (the OS picker is
  undrivable by automation) — the REAL-DISK round trip is on the review list.
  Feature-detected; Firefox/Safari keep the download flow. Small (~day) —
  benefits the deployed Pages app immediately; may slot earlier if desired.
- [ ] **D2. Tauri desktop wrapper (NOT Electron — performance)** — native
  installable reusing D1's storage interface with a Tauri fs/dialog
  implementation: system WebView (WebView2=Chromium on Windows, so canvas
  behavior matches the dev browser), 3–10MB bundles vs Electron's 100MB+
  Chromium+Node, low memory, auto-updater, Win/macOS/Linux. macOS WKWebView
  needs a QA pass (Safari-engine quirks). Electron only if a Node-side need
  ever appears (none foreseen).

### Category B — table-stakes polish

*User-requested; queued after the A and H programs per user decision. Done
2026-07-13 (918dd3e + eb79af2), except recent files, which landed with D1.*

- [x] **Find/search parts** in the Layers tree (panels/layersSearch.ts —
  flattened non-matches, ancestors kept, fold state untouched).
- [x] **Project frame rate + frames/timecode display** — doc.fps seeded 60 by
  normalizeDoc, threaded through BOTH exporters (fps=60 byte-identity pinned;
  fps=30 decoder-pinned); timeline readout click-toggles ms↔frames (persisted).
- [x] **Quick-save vs Save As** — filename remembered per doc name; Ctrl+Shift+S
  Save As; found+fixed: save/selectAll bindings never checked shift. Browser
  filename-memory only; real overwrite lands with D1 file handles.
- [x] **Recent files** menu — landed WITH D1 (91ac929): localStorage ring +
  IndexedDB handle persistence, Open… dropdown.
- [x] **Invert selection (Ctrl+I) / Select None (Ctrl+Shift+A)** via the registry.
- [x] **Empty-state call-to-action** — CTAs proxy-click the real toolbar buttons
  so every existing guard applies.

(Already tracked — see v3 / v2.13: File→New, rulers/guides, zoom % + zoom-to-selection
+ 100% reset, copy/paste parts [note: Ctrl+C/V are keyframe-only, no-op in Edit mode],
marquee part-select, layers visibility/lock/opacity, playback range/work area,
key-pose + auto-key, SVG-import error surfacing.)

### Headless engine + MCP server

*Planned 2026-07-11. H1 complete; H2 complete 2026-07-13 (c9c4ee8) — see the
checklist below.*

Goal: agents (Claude Code, Codex, any MCP client) create and edit rigs/animations
in chat without the website, producing .rig.json the editor opens (and .riv
directly). Feasible because core/, geometry/, io/ are already DOM-free (the unit
suite runs in Node); the user's `scripts/exportPipTakePill.ts` pipeline was the
original proof-of-concept seed (deleted 2026-07-13, 124bca2, once H1's CLI and
H2's MCP tools matured into the real production path — the byte-identity gate
that pipeline used to provide now lives in-repo as
`src/__tests__/goldenRiv.test.ts`, pinned to SHA-256 `a1c6ff4b…`, run inside
`npm test` on any machine).

- [x] **H1. `rig-studio-core` headless package + CLI** — COMPLETE. Wave H1a (b2b0cb3):
  `src/headless/index.ts` package entry (pure facade over the DOM-free
  core/geometry/io surface + `importSvgHeadless` via scoped jsdom DOMParser,
  importer untouched); CLI (`rig-studio` bin / `npx tsx src/headless/cli.ts`):
  `rig import` (nested part tree summary + .rig.json), `rig validate`
  (normalization drift + round-trip byte-stability, exit 0/1), `rig export-riv`.
  Module-graph test enforces headless never reaches view/panels/timeline/ui.
  Wave H1b (4a3322f): `rig render-frames --clip X` — the pose math extracted
  VERBATIM to `geometry/pose.ts` (view/pose.ts is a thin delegator injecting
  ctx.poseSampler; one shared kernel, no editor/headless drift, pinned by
  poseSharedKernel.test.ts), `headless/composePose.ts` (posed standalone SVG:
  z-sorted draw order, sampled opacity, hidden excluded, artboard frame;
  skinned parts RIGID like both exporters, stated in CLI output),
  `headless/renderFrames.ts` (@resvg/resvg-js PNGs, A3-cluster default times
  via the extracted `core/filmstripTimes.ts`). E2E-proven by real subprocess +
  PNG centroid tracking that returns byte-identical at the loop point.
  Known caveats carried forward: geometric auto-bind uses DOM isPointInFill
  (headless binding = pure point-in-fill or explicit part targets), and much of
  core/channels + applyRigChanges read/write the `state` singleton — headless
  scripts set `state.doc = doc` first (H2's in-memory sessions will want a
  save/restore or pure-doc variant).
- [x] **H2. `rig-studio-mcp` server** (c9c4ee8 — 12 tools over stdio, in-memory
  sessions with whole-AppState scoped swap, one clip schema shared with the
  in-app assistant, e2e-proven via a real SDK client; packaging/naming
  deferred per the ledger. HYGIENE QUEUED: applyClip.ts/bindHeadless.ts are
  documented hand-synced ports of panels/ai/apply.ts and view/rigOpsBind.ts —
  extract shared pure cores so the ports can't drift) — LOCAL stdio transport (an npm package the
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

### Pattern-driven redesign pass

*User-approved 2026-07-12 — runs after H1b lands.*

Origin: the user rejected "documented exception" status for the two remaining
monoliths and mandated named design patterns over proximity/convention (now a
CLAUDE.md convention: "Think in named patterns, not conventions").

- [x] **view/interactions/ — gesture-pipeline redesign** (5ef6ae5) — done exactly
  per the approved design: 11-row static `GESTURE_PIPELINES` table (final order:
  boneChain, gizmo, boneTip, pan, non-primary-button guard, handles, node,
  pivot, nodesBendMarquee, artwork, blank — each row commented with why it
  precedes the next), shared `HitContext`, uniform `lifecycle.ts`, nine
  feature-complete pipeline modules (max 219 code lines). Converted one row at
  a time against a shrinking legacy scaffold, interaction suite green after
  every step. Priority pinned by `gesturePriority.test.ts` (mutation-checked:
  swapping pivot/artwork fails 9 scenarios across 4 files). Documented
  deviations: skinnedArt/boneGlyph are sub-cases inside artwork's claim (they
  share its once-only selection side effect); node vs nodesBendMarquee split
  because pivot sits between them in the real cascade order.
- [x] **view/nodeEditing chokepoint + split** (68f24fc): `applyStructuralEdit`
  in `nodeEditing/structural.ts` is the one door (d/nodeTypes write + override
  drop + cache invalidate + DOM sync + selection clear), enforced by
  `nodeEditingChokepoint.test.ts`; family split dragMath/structural/typeOps
  behind a facade. BONUS: found+fixed a real latent bug (the bend pipeline's
  implicit-Z split never dropped overrides) and pinned the previously-unpinned
  invariant with scenario B31 (mutation-verified). Flagged for later: the
  bind bake's pathToCubics arc expansion is a latent nodeTypes desync on
  literal-arc paths (task chip spawned).
- [x] **Pattern audit over the six pinned files** (done 2026-07-12, read-only).
  Verdicts, ranked by payoff:
  1. **main.ts — DONE** (a1cee54): registry + cascades in ui/shortcuts*.ts,
     help rows generated, B key added, main.ts 522→243 and off the list.
     Original spec follows: keydown handler (~60% of the file) → a binding
     Registry + two explicit Chain-of-Responsibility arrays (DELETE_HANDLERS /
     ESCAPE_HANDLERS) in a new `ui/shortcuts.ts`; help.ts's keyboard rows
     GENERATED from the registry (killing the sync convention, which the audit
     proved broken twice — both drifts fixed in 4ed4127); main.ts exits the
     grandfather list. Risk note: only 2 of ~30 bindings are tested through
     the real dispatcher — the wave needs a full manual binding pass.
     ALSO IN THIS WAVE (user request 2026-07-12): (a) verify EVERY help-overlay
     row is a real, correct binding while building the registry; (b) rows that
     document mouse/tool gestures rather than keys (e.g. "Bone tool
     (canvas-tools ⌂)") move to a clearly separated gestures section, never
     mixed in as pseudo-shortcuts; (c) give the bone tool a REAL key — `B`
     arms bone-chain placement (guarded like the other tool keys V/T/R/I,
     no ctrl/meta/alt), registered + documented via the registry itself.
  2. **ai/claude.ts — DONE** (b36b048, folded into the bones-awareness wave):
     ai/prompts.ts extracted; claude.ts 489→289, off the grandfather list.
  3. **timeline/graph.ts — DONE** (572566c): geometry/viewRect.ts shared
     kernel with old-formula oracle tests; graph.ts ceiling ratcheted down
     to 387; view/camera.ts exclusion documented in the module header.
  4. **io/exportLottie.ts — cohesive as-is, ZERO test coverage**: test wave
     CANCELLED by user (2026-07-12) — Lottie's usefulness in this project is
     in question and the exporter MAY BE DELETED later; leave the code as-is
     and do not invest in Lottie coverage or features without asking first.
  5. **geometry/paths.ts — cohesive as-is**: one representation throughout;
     its cross-file invariant already sits behind nodeEditing's chokepoint.
  6. **panels/layers.ts — cohesive as-is**: one tree widget; drag pipelines
     are coupled to the DOM they decorate; no reuse case.
  Items 1–3 fold into this redesign pass after the gesture-pipeline wave,
  in rank order.
- [x] **Size-ratchet test** (`architecture.test.ts`) landed 2026-07-11 —
  CODE-line counts (comments/blanks free per user ruling), grandfathered
  ceilings shrink-only, new files fail >300, stale-entry honesty check.

### Node editor revamp

*User-requested 2026-07-12 — "needs a pretty decent polish pass"; design pass
first, then implement; reproduce-first on the bugs.*

- [x] **Alt+click ON a segment inserts a node THERE** (61ea081; the old
  node-relative midpoint insert retired outright) — today insert requires
  selecting a node and Alt+clicking, splitting an adjacent segment at its
  midpoint ("a random segment adjacent"). Reuse the bend pipeline's geometric
  `segmentHit` (segment index + parameter t under the cursor) so Alt+click on
  any segment splits at exactly the clicked point (de Casteljau at t). Keep
  the old gesture working during transition or retire it deliberately.
- [x] **Symmetric/smooth nodes always get BOTH handles** (61ea081) — the type ops only
  mirror EXISTING handles; a node whose neighbor segment is a line (L) ends up
  "symmetric" with one arm. The op must synthesize the missing handle by
  converting the adjacent L→C (the bend's "handles grow" conversion, applied
  at type-set time). Symmetric = equal lengths both sides, always.
- [x] **Closing-seam stacked nodes** (61ea081 — SHIPPED WITH A REVIEW FLAG for
  Austin: UI-only unification, primary glyph = the M side, pair splits only
  via del-seg which now works one-click on the merged glyph; data model
  untouched) (the user's "new node underneath") —
  bending the implicit closing segment splices an explicit closing cubic whose
  endpoint coincides with the path's FIRST node (by design: shape stays
  closed, zero-length Z). The DATA is coherent; the UI presents two stacked,
  independently-draggable nodes. Fix at the editor level: render/hit-test the
  seam as ONE node (drag moves both coincident points; the pair splits only
  via an explicit "open path" op). Needs design care around nodeTypes and
  overrides indexing — route through the chokepoint.
- [x] **Type-button state highlight** (61ea081; also found+fixed applyNodeOp
  never notifying — stale inspector) — selecting node(s) subtly highlights the
  matching smooth/symmetric/corner button in the inspector node-ops section
  (mixed selection = no highlight or an indeterminate state), independent of
  the node glyph shapes. (Glyphs already encode type: diamond/square/circle.)
- [ ] **Design sweep for the rest of the polish pass** — hover affordances on
  segments/nodes, insert-preview ghost under Alt-hover, whether Inkscape's
  double-click-on-path-inserts should exist alongside Alt+click, drag behavior
  when both seam nodes are selected. Produce a short proposal for user
  sign-off before implementing.

### Context-menu polish

*User-requested 2026-07-12.*

- [x] **Suppress the native browser context menu app-wide** (8203345) — a document-level
  `contextmenu` preventDefault: where no in-app menu applies, NO menu appears
  (never the browser's). EXCEPTION: text-entry elements (inputs/textareas —
  the API-key field, rename editors, prompt box) keep the native menu, since
  suppressing it there kills right-click copy/paste.
- [x] **Right-click menus on PATHS, not just parts** (8203345 — incl. the
  extract-path op, absorbing the standalone roadmap item; skinned-part path
  deletion refused per the chokepoint rule) — path rows in the Layers
  panel and paths on canvas (entered-part/node-editing contexts) get an in-app
  context menu: rename (once the layers wave lands), delete path, raise/lower
  within the part, move to part… (the new cross-part move as a menu action),
  and "extract path → own part" (absorbs the existing standalone roadmap item
  as a menu entry).

### Layer order IS z-order

*User idea 2026-07-12 — fleshed out; the design is sound, not crazy; folded
into the autonomous run after the skeleton work.*

The design rule itself ("panel order = paint order") is now a STANDING DESIGN
PRINCIPLE — see STATUS DASHBOARD → Standing design principles for the current
wording. The audit that enforced it:

- [x] **Audit + enforce "panel order = paint order"** (dbac402 — seven real
  divergences found+fixed at the setParent/structural-op chokepoints; the
  then-current byte-identity fixture was re-pinned (hash 3754fc45) after
  visual verification via headless render-frames — that take-pill pipeline
  was later deleted (124bca2) in favor of the in-repo golden gate,
  `src/__tests__/goldenRiv.test.ts`, pinned to SHA-256 `a1c6ff4b…`; NOTE for
  Austin: the Dosey checkout's riv+rig.json outputs were rewritten with the
  canonical bytes, though the generating script has since been deleted):
  doc.parts array order and tree display order can diverge across subtree
  boundaries today; canonicalize (paint order = DFS of the hierarchy;
  sibling order = the draggable freedom), verify the importer already
  satisfies it (it walks the SVG depth-first), normalizeDoc repairs legacy
  docs, PageUp/Down + the stacking row + panel drag-reorder all preserve it.
  Exporters inherit (they read doc.parts order). Interaction tests: reorder
  right_arm above body in the panel → canvas + both exporters stack it
  above; keyed z still re-sorts the canvas in Animate while the panel holds
  still.

### Unified skeleton: cross-chain bone attachment

*User-requested 2026-07-12, in the autonomous run — "the entire pip could be
rigged so his body (spine) can affect the arm bones… moving relative to one
another by hierarchy."*

Why it's disjointed today: each limb chain parents under its own art
(hierarchy-as-assignment) and the spine chain under the pip group — FOUR
disconnected skeletons. Bone motion propagates through bone parent links only.
The LBS math already follows bone WORLD transforms, so connecting the chains
(arm root bone becomes a child of the spine bone) makes everything compose —
the feature is making that attachment first-class and safe.

- [x] **Phase 1 — attach via Layers drag** (064c521; follow-up: freeze
  origin-drag on an attached root, in flight): dragging a chain's
  ROOT bone onto a bone of ANOTHER chain parents it WORLD-PRESERVING (fold the
  chain-frame delta into the root's rest, the foldLostArtPoseIntoBoneRest
  precedent — zero visual jump, bind data untouched). The new link is an
  **ATTACHED ROOT** (`RigPart.attachedRoot: true`, set by cross-chain reparent):
  origin ≠ parent tip is LEGAL for it (a shoulder isn't at the spine's tip) —
  the connected-chain no-gap invariant is scoped to chain-INTERNAL links only
  (tests updated accordingly). `boneChain` (the auto-bind unit) STOPS at
  attached roots — extending an arm chain must never re-target the body's art —
  while POSE composition uses the full hierarchy (it already does: parentId).
  Overlay: draw a subtle dashed attachment link parent-bone→attached-root so
  the coupling is visible (GOTCHA: visible counterpart). Un-attach = drag the
  root elsewhere (same world-preserving fold). Acceptance = the user's Pip:
  spine bone rotates → both arm chains AND their deformed arms ride; arm IK
  still works locally; undo restores exactly.
- [ ] **Phase 2 — IK across attachments** — deferred decision, not built;
  full detail in STATUS DASHBOARD → Deferred decisions.
- [ ] **Phase 3 — placement sugar** — deferred, not built; full detail in
  STATUS DASHBOARD → Deferred decisions.

### Editing ergonomics wave

*User-requested 2026-07-12 — runs right after the layers-branch integration;
items 2–3 build on the integrated layers.ts.*

- [x] **Keyframe selection drives part selection** (e623d4a) — clicking a keyframe in the
  Animate timeline selects the track's TARGET part (layers highlights it +
  auto-expands ancestors, inspector shows it — "extremely hard to see what I'm
  editing" with unnamed bones otherwise). Multi-key/marquee selection selects
  the union of target parts (multi-selection exists). Tracks targeting the
  synthetic `root` skip part selection. Key retime drags don't re-fire
  selection churn beyond the initial click.
- [x] **Layers hover tooltips** (e623d4a) — part and path rows carry `title` = the full
  label, so truncated names reveal on hover.
- [x] **Layers panel horizontally resizable** (e623d4a, panels/layersResize.ts) — a draggable splitter on the
  layers/canvas boundary with persisted width (localStorage, like the
  timeline's height splitter in timeline/tlState.ts — same pattern, same
  persistence discipline: editor pref, never doc state), min/max clamped.

### Skinned-part posing decision

*User ruling 2026-07-12: "Allow rotate+translate."*

Code truth behind the ruling: a skinned part's keyed rotate/tx/ty WORKS — its
bones are parented under it, bone world placement composes through the chain
(which samples the part's keyed channels), and LBS recomputes from the bones —
and .riv exports the same rigid transform, so editor and runtime agree. Part
SCALE does not carry (editor scale never propagates to children) while Rive
Node scale would — scale stays blocked on skinned parts.

- [x] **Editor: re-enable rotate + translate pose drags on skinned parts** (617df49)
  (Animate keys / Edit rest) — remove the skinned gate in the artwork pipeline
  for those two manipulations only; IK stays the articulation gesture; scale
  handles stay off with the skin hint explaining why; inspector keyed sx/sy
  fields on a skinned part lock with the same hint (WYSIWYG: don't offer a
  channel the canvas won't show). Interaction scenarios + the hint counterpart.
  RUNS AFTER the live-bug wave (same pipeline files).
- [x] **AI bones-awareness** (b36b048, incl. the ai/prompts.ts extraction —
  claude.ts 489→289, grandfather entry gone — and the polish.ts
  squash-guard for bone-deformed targets): buildScenePayload marks
  skinned parts (skinned: true + their bone chain ids/labels); TARGETING_RULES
  teaches the model: articulate a skinned limb via its BONE rotate channels
  (root-first, follow-through); part-level rotate/tx/ty = whole-limb accent
  ON TOP (legitimate but never a substitute for joint articulation — the
  gesture-file failure mode: left_arm rotated as one slab, right_arm got bones
  AND a redundant −55° part rotation stacked); NEVER sx/sy on skinned parts.
  Combined with the queued ai/prompts.ts extraction (audit rank 2) so frozen
  claude.ts sheds its ceiling first.

### Live bug queue

*User-reported 2026-07-12, next main-tree wave after nodeEditing.*

- [x] **Group-like selection for art-with-children** (63a2b67) — every group behavior
  (click-selects-ancestor, dblclick drill-down, entered-group tracking, union
  selection box, group handle sets w/ descendant scale distribution) keys on
  `kind === 'group'`; an ART part carrying child parts (face→eyes, the
  recursive importer's normal shape) gets none of them. Fix: one `groupLike`
  predicate (group OR art-with-child-parts; bones excluded) applied at all
  sites (artwork pipeline, dblclick, focus, overlayHandles, handles pipeline).
  User's acceptance: click eyes on canvas → selects face w/ union box; dblclick
  eye → drills into face, selects eyes; Layers face click → union box.
- [x] **Ctrl+G leaves the canvas dimmed** (63a2b67 — repairEnteredGroups prunes
  inside every focusContext call; reproduced at 8-9 dimmed parts pre-fix) (user: "pip semi-transparent until
  refresh") — suspected stale `ctx.enteredGroups` app-state after structural
  edits: grouping while drilled in (or restructuring around an entered id)
  leaves focusContext dimming everything outside a stale subtree; refresh
  resets app-state, doc was never wrong. Fix: structural ops (group/ungroup/
  delete/reparent) must repair or clear entered-group state; reproduce first.

### Architecture refactor pass

*User-mandated — run after the A program + fixes, alongside/before H;
meanwhile the size-ratchet test stops NEW violations.*

The feature blitz outgrew the ~200-line standard in 8 files (audit 2026-07-11):
model.ts 1634, smPanel.ts 1404, exportRiv.ts 1116, inspector.ts 981, ai.ts 938,
timeline.ts 817, overlay.ts 801, rigOps.ts 769 (interactions/nodeEditing are the
two documented exceptions). Target shapes, each behind a facade per the view/
precedent, zero behavior change, gated on the full suites:

*(Every "take-pill .riv byte-identical" check below was run against the
since-deleted `scripts/exportPipTakePill.ts` pipeline — it was removed
2026-07-13 (124bca2) and its role is now filled by the in-repo golden gate,
`src/__tests__/goldenRiv.test.ts`, pinned to SHA-256 `a1c6ff4b…`. The
verification RESULTS recorded below still stand as history.)*

- [x] **io/riv/** (c180e36) — exportRiv.ts → writer/keys/scene/animation/
  stateMachine behind an index.ts facade (all < 300 code lines); test decoder
  promoted to `__tests__/rivDecoder.ts`. Verified BYTE-IDENTICAL output
  (take-pill .riv SHA-256 unchanged before/after).
- [x] **core/ split** (c6185ef) — model.ts → 9 modules (docTypes/smTypes/appState/
  channels/boneOps/partHierarchy/structuralOps/serialization/idGen) behind the
  permanent `model.ts` facade — zero consumer edits, export surface verified
  identical (68 names), take-pill .riv byte-identical.
- [x] **panels/sm/** (fef677c) — smPanel.ts → 9 modules (state/graphCamera/
  graphInteract/graph/preview/props/header/globals/panel) behind a 2-line
  facade; export surface identical (5 names); built in a parallel worktree,
  clean cherry-pick.
- [x] **panels/ai/** (f902260, done as part of A4) — ai.ts → panel/apply/preview/
  previewBar/fields/requests/state/threadStrip/threads behind an index.ts facade.
- [x] **inspector sections** (f5690b0) → 9 modules in `panels/inspectorSections/`
  (shared/transform/bone/stacking/skin/align/nodeOps/object/panel) behind a
  1-line facade; built in a parallel worktree, rebased with main's 146-line
  z/opacity/scale/A0 delta ported hunk-by-hunk.
- [x] **timeline/ internals** (f4bc4b0) → tlState/transport/lanes/keyProps/panel
  behind a 7-line facade (graph.ts untouched); parallel worktree, rebased with
  the stepped-z easing hunk ported.
- [x] **view/overlay.ts + view/rigOps.ts** (d6343dc) — overlay → orchestration
  (290 lines) + overlayHandles/overlayBones/overlayNodes; rigOps → 17-line
  re-export over rigOpsPlacement/rigOpsBind/rigOpsEdit/rigOpsNodeBinding.
  Both grandfather entries removed; take-pill .riv byte-identical.

**Refactor pass COMPLETE (2026-07-12):** every planned split landed — io/riv/,
core/ (9 modules), panels/ai/ (A4), panels/sm/, inspectorSections/, timeline
internals, overlay + rigOps clusters. Grandfather list is down to
view/interactions.ts + view/nodeEditing.ts (redesign QUEUED below — the old
"documented exception" status was retired by user decision 2026-07-12) plus six
small pinned files (ai/claude 489, main 522, paths 434, graph 395, layers 347,
exportLottie 327), audit queued below.

### Post-A bone feel fixes

*User-reported — build after the A program, before H.*

- [x] **Freeze origin-drag rotates unselected bones** (10c0ee9) — freeze mode now
  renders a joint marker for EVERY bone (visible counterpart, screen-constant,
  zoom-sweep-tested), each carrying `data-part-id`; the press resolves ITS bone,
  selects it, and starts the joint drag in the same gesture. Rotation stays on
  body/gizmo-ring drags; outside freeze behavior is byte-unchanged (regression
  pin F7c). Scenarios F7–F9.
- [x] **Grab-point-relative IK (no tip snap)** (10c0ee9) — `view/ikDrag.ts`
  (extracted pipeline; interactions.ts 958→915) maps the actual press position
  into the grabbed bone's frame: a tip grab is tip-as-effector, a mid-body grab
  drives THAT point (tip trails rigidly — first-move continuity asserted), a
  tip-handle press with the IK tool now solves the whole chain, and skinned-art
  grabs anchor at the grabbed surface point too. Same FABRIK; `chainStepDelta`
  in geometry/ik.ts handles the off-axis write-back. Scenarios IK1–IK4; B24
  tightened 8px→3px.

### AI Animate System v2

*Program planned 2026-07-11 with Austin — build in order.*

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
- [x] **A1. Session & intent UX** (e4f3ac6) — prompt text persists across view/mode switches
  until sent (module state, like the busy flag). TWO actions replace the single
  button: [Create new animation] → AI returns a clip + a NAME, added to the clips
  dropdown and selected; [Modify current] → edits the active clip, with a
  "protect playhead keys" checkbox (keys at the current playhead time are locked:
  prompt instructs it AND post-apply enforcement restores any protected key the
  model touched). Duration is pinned: the schema echoes the clip's set duration
  and validation rejects/clamps drift.
- [x] **A2. Preview-before-apply** (b547c4b/4797149) (idea 4) — AI results NEVER mutate the doc
  directly: the returned clip renders as a looping preview (pose-sampler
  playback, the SM-preview infrastructure) with an Apply / Retry / Discard bar.
  Apply = the existing atomic one-undo path; Retry = posts back into the thread
  (A4) with the preview visible; Discard = zero trace. Structural changes (new
  bones) preview as ghost overlays where feasible, else summarized in the bar.
- [x] **A3. Filmstrip vision** (9a49106) (idea 1) — replace the single playhead snapshot
  with a strip of rendered frames (t = 0/25/50/75/100% of the clip, or one per
  keyframe cluster when denser), downscaled, payload-capped. Sent on BOTH
  animate and critique calls so Claude sees motion arcs, clipping, dead holds —
  and on A2 Retry turns it re-renders the CANDIDATE clip so refinement reacts to
  what the model actually produced.
- [x] **A4. Clip-scoped refinement threads** (f902260, incl. the panels/ai
  folder split — first ratchet burn-down) (idea 2) — each clip keeps a
  conversation thread (app-state + localStorage keyed by doc name + clip name;
  last N turns): prior clip JSON, user instructions, model changes-summaries.
  The prompt box becomes the thread composer; A2's Retry is a thread turn;
  switching clips switches threads. Clearing/deleting a clip drops its thread.
- [x] **A5. Rig Profile + motion templates** (2faf597) (idea 5, rig-AGNOSTIC) —
  `ai/rigProfile.ts` builds a cached RigProfile from pure heuristics (bone
  chains with deformed art, left/right symmetry pairs incl. matrix-mirror
  detection, role guesses torso/head/limb/face/shadow/prop, figure group),
  memoized on a hierarchy signature. Five template quick-actions (walk cycle,
  idle breathing, jump, wave, emphatic gesture) are motion ARCHETYPES that
  FILL the prompt box (never auto-send) with profile-resolved targets and a
  beat map in absolute ms from the set duration; sending routes through the
  normal Create flow so A2 preview / A3 filmstrip / A4 threads apply for
  free. Every Create/Modify request leads with a compact RIG PROFILE block
  (`ai/profileBlock.ts` leaf — claude.ts stays at its ratchet ceiling).
  Rig-agnosticism is test-enforced: a source grep bans sample part names and
  the girl fixture drives the same buttons naming HER structure.
- [x] **A6. Principles polish pass** (593e3d8) (idea 3, LAST — integrates with
  everything) — the one-click "Polish" button (`panels/ai/polish.ts`, mounted
  beside Modify; disabled with an explanatory title when the clip has no keys):
  `buildPolishInstruction` analyzes the clip's own tracks (biggest per-track
  moves → anticipation candidates when there's ≥80ms lead-in, the same
  arrivals → settle-with-overshoot, a scale-relative fast-vertical test →
  optional subtle squash-and-stretch, a loop-clean check → "keep first/last
  matching") plus the A5 profile (follow-through cascades named per bone
  chain), opens with an explicit choreography-preservation contract, and
  sends IMMEDIATELY through the normal Modify flow via `runAnimate`'s
  `instructionOverride` — safe because A2's preview still gates the apply,
  and protect-playhead / duration pinning / RIG PROFILE block / A3
  filmstrips / A4 thread recording all apply for free. The user's own prompt
  draft is never touched (`ai.polishInstruction` carries the turn). Bonus fix
  found live: Polish now disables the instant ANY request starts (it lives
  outside `AiFields`, so `setBusy` had missed it) — regression-tested.

**A program COMPLETE (2026-07-12):** A0–A6 all landed and verified; final
gates 492 unit / 19 files, 159 interaction / 24 files, build clean.

(The former "swap default sample to girl_example" FINAL item was CANCELLED
2026-07-11 — user decision: Pip stays as the permanent public demo sample.
girl_example.svg remains a nested-import test fixture only.)

- [x] **Extract path → own part** (8203345, in the context-menu wave — pure
  reuse of addNullPart + movePathToPart) — a context-menu op wrapping a path in its own
  part with frame compensation (geometry stays put), so imported single-path
  details (e.g. a body's shadow path) become independently animatable/reorderable
  across parts. (Follow-on to the path-row select/reorder fix; cross-part path
  drags stay rejected until this exists.)

### Group-level auto-bind

*User-blocked — immediate, parallel with A0.*

- [x] **Chains on a group bind ALL its art descendants** (7742f8c) — completing the locked
  strict-hierarchy design ("multi-object cases group first"): when a chain's
  parent/selection is a group (or any part with child art), auto-bind expands to
  every art descendant — each part gets its own weights from its own geometry
  against the same chain (binding is already multi-part capable; only TARGETING
  stops at one part today). Render-neutral per part; per-node overrides stay
  per-part; undo = one step with the chain.

### Pre-A0 bones fixes

*User-reported; build before the AI program.*

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

### v1 — Vector editing basics

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

### v1 — Rigging

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

### v1 — AI assistant

- [x] **Structural edits (opt-in)** — an "allow rig changes" toggle lets Claude
  return, alongside the clip: new bones (label/pivot/parent), reparenting, and pivot
  moves. Applied atomically with the clip in one undo step, with cycle guards.
- [x] **Richer rig context** — the scene JSON sent to Claude marks part kinds
  (art/bone/group), includes the full hierarchy and rest pose, so choreography can
  target bone chains sensibly.

### v1 — Quality gates (define "complete")

- [x] Type-check + `npm run build` clean.
- [x] Unit tests for all new pure logic (align/distribute, flip math, group/ungroup
  absorption, bone creation, structural-change application).
- [x] Live browser verification of every v1 feature via the preview harness.
- [x] CLAUDE.md + this file updated; conventions section covers new invariants.

### v2 — first batch (done)

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

### v2 — second batch (done)

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

### v2.5 — editing focus & node UX (done)

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

### v2.6 — bug fixes & small improvements (done)

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

### v2.7 — vector-app parity & polish (done)

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

### v2.8 — Rive export & format confidence (done)

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

### v2.9 — Rive-style state machines (done)

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

### v2.10 — generic editor & SM editor polish (done)

- [x] **Compose (.kt) exporter removed** — Rive `.riv` (rive-android) replaces it on
  Android; the editor is now export-target generic (Rive + Lottie).
- [x] **De-Dosey/de-Pip sweep** — no app-specific code, naming, or intentions left;
  README rewritten; the bundled sample is just a neutral demo asset.
- [x] **State-machine graph pan/zoom** — wheel-zoom-at-cursor, middle-drag pan,
  ⌂ fit, per-machine view memory; correct pointer math at any zoom.
- [x] **Exit state always exists** — entry/any/exit minted together, re-established
  on load, undeletable in the editor (matches what Rive runtimes require).

### v2.11 — interaction harness + view.ts split (done)

- [x] **Headless interaction-test harness** — Vitest Browser Mode (headless
  Chromium), `npm run test:interaction`: 19 real-gesture tests pinning the 12
  hard-learned canvas invariants in ~1 s; mutation-checked before being trusted.
- [x] **view.ts modular split** — 3,089-line monolith → permanent 33-line facade +
  13 layered `src/view/` modules with a binding import-layering rule; zero behavior
  change (all gates green after every mechanical step; export surface
  diff-identical; live manual pass at the end).

### v2.12 — UX overhaul program (done 2026-07-11)

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

### v2.13 — bones-as-hierarchy, freeze mode, table stakes (planned 2026-07-11, in flight)

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

#### Table-stakes gap audit findings (2026-07-11)

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
- [x] **Keyframeable z-order** (editor bf05493; .riv DrawRules export 7155013;
  panel/paint-order unification dbac402) — paint order stays flat/hierarchy-independent (by
  design); add a keyable `z` offset channel per part (STEPPED sampling — no easing
  between stacking ranks), rendering sorts by (z, rest index); inspector shows
  stacking position + up/down in Edit and the keyable offset in Animate; AI schema
  learns the channel (the reach-behind-grab-pill use case). Phase 2 (blocked on
  the user's uncommitted exportRiv.ts WIP): .riv export via Rive DrawTarget/
  DrawRules keyed draw order; Lottie cannot animate layer order — documented
  limitation.
- [x] **Opacity channel + layers eye (revised per Rive-parity principle)**
  (editor e8c1f8a; .riv keyed opacity 7155013) —
  `opacity` becomes a keyable continuous channel (rest opacity in Edit, keyed in
  Animate; Rive-native, Lottie `o`). The layers EYE is editor-only and NEVER
  keyable (user decision — no visibility channel; animated invisibility = opacity
  0): `part.hidden` serializes, hidden parts don't render and are excluded from
  exports. New convention in CLAUDE.md: keyable channels must map to Rive runtime
  features.
- [x] **Export wave** (7155013): .riv keyed z draw order via DrawTarget/DrawRules;
  .riv opacity keys (Lottie frozen per the user's ruling); FULL hidden-subtree
  exclusion in .riv; verified against the official @rive-app/canvas runtime
  (on-screen visuals remain on Austin's review list).

*Contradiction resolved by the orchestrator 2026-07-13: these three were shipped
and verified during the autonomous run but their checkboxes were never ticked —
ticked above with their commit trail.*

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
- Skinning export parity for LOTTIE + headless frame renders (baked-frame
  export or per-frame vertex baking; the .riv half shipped 2026-07-13 as
  native Skin/Tendon — see the archive).

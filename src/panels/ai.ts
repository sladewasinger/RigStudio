/**
 * The Claude animation assistant panel: choreograph the active clip from a natural-
 * language prompt, or critique it, optionally attaching a rendered snapshot of the
 * current pose for spatial grounding. Animate-mode only (locked v2.12 P5b decision) —
 * posing/choreography against a clip makes no sense while editing the character itself.
 *
 * AI Animate System v2 A1 ("session & intent UX") lives here: a persistent prompt box,
 * two explicit actions (Create new animation / Modify current animation), and a
 * "protect playhead keys" option for Modify. See `AiPanelState`'s doc comment for the
 * prompt-persistence decision and `applyAiResult`'s doc comment for how the two modes
 * apply.
 *
 * AI Animate System v2 A2 ("preview-before-apply") also lives here: a successful
 * animate call no longer applies straight to the doc — it enters a canvas-only PREVIEW
 * (see the big comment block above `enterPreview` below) that the user reviews via an
 * Apply / Retry / Discard bar before anything touches the document.
 */

import {
  state, notify, activeClip, applyRigChanges, boneChain, sanitizeClipName,
  snapshotProtectedKeys, enforceProtectedKeys, setCleanPreview, CHANNEL_DEFAULTS,
  sampleKeyList, Track, Channel, RigPart, RigDoc, Clip, ProtectedKey,
} from '../core/model';
import { renderPose, registerPart, bindPartsToBones, setPoseSampler } from '../view';
import { animateWithClaude, critiqueWithClaude, AnimateResult } from '../ai/claude';
import { checkpoint, canUndo, canRedo } from '../core/history';
import {
  cloneArtworkSvg, rasterizeSvg, renderClipFilmstrip, captureFilmstripFrame,
  selectFilmstripTimes, FilmstripFrame,
} from '../ui/snapshot';

/**
 * Test-only seam (mirrors core/history.ts's `setRestoreHandler` pattern): production
 * code always calls the real `animateWithClaude`. Interaction tests swap this to
 * fabricate an `AnimateResult` without a real network call — see `__setAnimateCallForTest`.
 * Never touched outside `src/__tests__/**`.
 */
let animateCallImpl: typeof animateWithClaude = animateWithClaude;
export function __setAnimateCallForTest(fn: typeof animateWithClaude): void {
  animateCallImpl = fn;
}

/**
 * Rasterize the canvas at the CURRENT PLAYHEAD TIME (sans overlay/onion) to a PNG for
 * the vision-grounded assistant calls. The live `#rig-svg` already reflects whatever
 * pose is on screen, which in Animate mode is always the playhead's pose (renderPose
 * samples `state.currentTime`) — so cloning it verbatim is exactly "current playhead
 * pose", not e.g. a rest pose or an arbitrary frame. Returns base64 image data (no
 * data: prefix). Shares the clone/rasterize primitives with the toolbar's still-image
 * export (ui/snapshot.ts) — this call keeps the exact prior behavior (full-document
 * viewBox, artboard rect NOT stripped, 512px-wide white-background PNG).
 */
async function snapshotPose(): Promise<string | null> {
  const clone = cloneArtworkSvg();
  if (!clone) return null;
  const { w, h } = state.doc!.viewBox;
  const outW = 512;
  const outH = Math.round((512 * h) / w);
  const dataUrl = await rasterizeSvg(clone, outW, outH, '#ffffff');
  return dataUrl.split(',')[1] ?? null;
}

/**
 * Structural rig edits (bones, incl. Bones 2.0 auto-bind chains) shared by both apply
 * modes — factored out of `applyAiResult` since it's identical work regardless of
 * whether the clip itself is being created or modified. Returns the label→id map needed
 * to resolve track targets (new bones don't have ids until this runs) plus a list of
 * human-readable notes ("+2 bones", "bound 1 part") for the status line; NO checkpoint
 * here — the caller wraps the whole apply (rig + clip) in exactly one.
 */
function applyStructuralRigChanges(
  doc: RigDoc, result: AnimateResult,
): { labelToId: Map<string, string>; notes: string[] } {
  let labelToId = new Map(doc.parts.map((p) => [p.label, p.id]));
  const notes: string[] = [];
  if (!result.rig) return { labelToId, notes };

  labelToId = applyRigChanges(result.rig);
  doc.parts.forEach(registerPart); // canvas groups for any new bones
  const added = result.rig.addBones?.length ?? 0;
  if (added > 0) notes.push(`+${added} bone${added === 1 ? '' : 's'}`);

  // Bones 2.0: bind requested art parts to each new bone's full chain, inside the SAME
  // checkpoint as the placement + clip — one undo reverts all of it. Binding can't live
  // in model.applyRigChanges: it bakes geometry, which needs the live canvas
  // (bindPartsToBones), not just the doc.
  const boundChains = new Set<string>();
  let bound = 0;
  for (const b of result.rig.addBones ?? []) {
    if (!b.bindParts?.length) continue;
    const boneId = labelToId.get(b.label);
    if (!boneId) continue;
    const chain = boneChain(doc.parts, boneId);
    if (chain.length === 0) continue;
    const chainKey = chain.map((p) => p.id).sort().join(',');
    if (boundChains.has(chainKey)) continue;
    boundChains.add(chainKey);
    // Union bindParts across every new bone that belongs to this chain — matches
    // the real auto-bind behavior of binding to the WHOLE chain, not one joint.
    const wantLabels = new Set<string>();
    for (const bb of result.rig.addBones ?? []) {
      const bid = labelToId.get(bb.label);
      if (bid && chain.some((c) => c.id === bid)) {
        for (const l of bb.bindParts ?? []) wantLabels.add(l);
      }
    }
    const arts = [...wantLabels]
      .map((label) => doc.parts.find((p) => p.label === label))
      .filter((p): p is RigPart => !!p && p.kind === 'art' && p.paths.length > 0);
    if (arts.length > 0) {
      bindPartsToBones(arts, chain);
      bound += arts.length;
    }
  }
  if (bound > 0) notes.push(`bound ${bound} part${bound === 1 ? '' : 's'}`);

  return { labelToId, notes };
}

/**
 * Resolve an AnimateResult's label-targeted tracks into id-targeted `Track`s against a
 * label→id map. Shared by `applyAiResult` (called with the POST-structural map, so
 * newly added bones resolve) and A2's `enterPreview` (called with the doc's CURRENT,
 * pre-structural map — a track targeting a not-yet-created bone simply has no match
 * and is silently dropped, which is exactly right: structural changes cannot
 * pose-preview, see `enterPreview`'s doc comment). Unresolvable targets are dropped
 * rather than throwing, matching the pre-A2 inline behavior this replaces.
 */
function resolveTracks(result: AnimateResult, labelToId: Map<string, string>): Track[] {
  const tracks: Track[] = [];
  for (const t of result.clip.tracks) {
    const target = t.target === 'root' ? 'root' : labelToId.get(t.target);
    if (!target) continue;
    tracks.push({ target, channel: t.channel as Channel, keyframes: t.keyframes });
  }
  return tracks;
}

export interface ApplyAiOptions {
  /** mode 'modify' target clip; defaults to `activeClip()` when omitted. Ignored for
   *  'new' (a fresh clip is appended instead). */
  clip?: Clip | null;
  /** Model-proposed name for a NEW clip — sanitized/deduped against the doc's existing
   *  clip names inside this function. Ignored for 'modify'. */
  clipName?: string | null;
  /** Pre-request snapshot of playhead-protected keys (`snapshotProtectedKeys`) —
   *  restored onto the clip after its tracks are applied. Modify only. */
  protectedKeys?: ProtectedKey[];
}

export interface ApplyAiOutcome {
  clip: Clip;
  /** Human-readable summary of structural side effects (new bones/binds/restored
   *  protected keys) formatted for direct inclusion in a status string, e.g.
   *  " (+2 bones / bound 1 part)"; '' when nothing notable happened. */
  structural: string;
  /** How many protected keys actually needed correcting post-apply (0 = the model
   *  behaved and this was a no-op). Always 0 for mode 'new'. */
  restoredCount: number;
}

/**
 * Apply an AnimateResult to the doc: structural rig changes first (bones, auto-bind —
 * shared by both modes, see `applyStructuralRigChanges`), then either:
 *   - mode 'new': APPENDS a fresh clip (sanitized/deduped name via `sanitizeClipName`,
 *     e.g. "wave" → "wave 2") and switches the active clip to it — the same
 *     `doc.clips.push` + `state.activeClipIndex = doc.clips.length - 1` path the
 *     timeline's own "+ animation" button uses, so the clip dropdown picks it up for
 *     free. The clip passed as request CONTEXT is never touched.
 *   - mode 'modify': edits `opts.clip` (or the active clip) IN PLACE — duration pinned
 *     to the response's already-clamped value (never stretched), then any protected
 *     keys are restored (`enforceProtectedKeys`) as the belt-and-suspenders half of the
 *     "protect playhead keys" checkbox.
 * ONE checkpoint covers rig + clip, so a single undo reverts the whole AI edit. Returns
 * null only when there's no document (or, for 'modify' with no explicit `opts.clip`, no
 * active clip) to apply to — callers here always guard those cases before calling.
 *
 * AI Animate System v2 A2's Apply button calls this SAME function, unchanged, from
 * `applyPreviewNow` below — nothing about the apply path itself needed to change.
 */
export function applyAiResult(
  result: AnimateResult,
  mode: 'new' | 'modify',
  opts: ApplyAiOptions = {},
): ApplyAiOutcome | null {
  const doc = state.doc;
  if (!doc) return null;
  if (mode === 'modify' && !opts.clip && !activeClip()) return null;

  checkpoint(); // one undo step reverts the whole AI edit — rig changes included
  const { labelToId, notes } = applyStructuralRigChanges(doc, result);
  const tracks = resolveTracks(result, labelToId);

  let clip: Clip;
  let restoredCount = 0;

  if (mode === 'new') {
    const name = sanitizeClipName(
      opts.clipName ?? result.clip.clipName ?? null,
      doc.clips.map((c) => c.name),
    );
    clip = { name, duration: result.clip.duration, tracks };
    doc.clips.push(clip);
    state.activeClipIndex = doc.clips.length - 1;
    state.currentTime = 0;
  } else {
    clip = opts.clip ?? activeClip()!;
    clip.duration = result.clip.duration; // pinned — clampRawClip already forced this
    clip.tracks = tracks;
    if (opts.protectedKeys?.length) {
      restoredCount = enforceProtectedKeys(clip, opts.protectedKeys);
      if (restoredCount > 0) {
        notes.push(`restored ${restoredCount} protected key${restoredCount === 1 ? '' : 's'}`);
      }
    }
  }

  return { clip, structural: notes.length ? ` (${notes.join(' / ')})` : '', restoredCount };
}

/**
 * Back-compat wrapper for the pre-A1 single "Animate current clip" behavior: modifies
 * the given clip in place, no clip-name/protection options. Kept because it's the
 * smallest, most obvious entry point for console/smoke-testing a fabricated response
 * (see the P5b live-verification note this replaced) — production UI now calls
 * `applyAiResult` directly from the two action buttons below.
 */
export function applyAnimateResult(clip: Clip | null, result: AnimateResult): string {
  if (!clip) return '';
  return applyAiResult(result, 'modify', { clip })?.structural ?? '';
}

/**
 * Preview-only summary of an AnimateResult's structural rig edits (bones/binds/
 * reparents/pivot moves), for the preview bar's one-line readout. Pure — reads
 * `result.rig` by LABEL only and never applies anything (structural edits only ever
 * apply via `applyStructuralRigChanges`, on Apply). Deliberately a separate, simpler
 * pass from `applyStructuralRigChanges`'s post-apply notes: this runs BEFORE anything
 * exists in the doc, so it can't dedupe by real chain ids the way the applied version
 * does — a plain per-bone tally is good enough for a review summary.
 */
function describeStructuralChanges(rig: AnimateResult['rig']): string {
  if (!rig) return '';
  const notes: string[] = [];
  const added = rig.addBones?.length ?? 0;
  if (added > 0) notes.push(`+${added} bone${added === 1 ? '' : 's'}`);
  const boundLabels = new Set<string>();
  for (const b of rig.addBones ?? []) for (const l of b.bindParts ?? []) boundLabels.add(l);
  if (boundLabels.size > 0) notes.push(`binds ${[...boundLabels].join(', ')}`);
  if (rig.reparent?.length) notes.push(`reparents ${rig.reparent.length}`);
  if (rig.movePivots?.length) {
    notes.push(`moves ${rig.movePivots.length} pivot${rig.movePivots.length === 1 ? '' : 's'}`);
  }
  return notes.join(', ');
}

// =====================================================================================
// AI Animate System v2 A2: preview-before-apply
//
// A successful animate call (Create or Modify) no longer applies straight to the doc —
// it enters a PREVIEW: the candidate clip's tracks (resolved to part ids against the
// doc's CURRENT label→id map — see `resolveTracks`) loop on the canvas via view's
// `setPoseSampler` hook, exactly the mechanism smPanel.ts's state-machine preview uses
// (it is the ONLY hook the view facade offers for overriding rendered pose — see
// CLAUDE.md's "SM preview is app-state" convention). `previewSampler`/`restFallbackFor`
// below replicate model.channelValue's "keyed values are absolute, rest fills unkeyed
// channels" rule (mirroring core/stateMachine.ts's private `sampleClock`/
// `restFallback`) because the candidate is NOT `activeClip()` — it may not even exist
// in `doc.clips` yet (mode 'new'), or may be a wholesale replacement of the active
// clip's tracks (mode 'modify' — applyAiResult REPLACES `clip.tracks` outright, so
// previewing against the candidate's tracks with a rest fallback, never the doc clip's
// OLD tracks, is exactly what Apply will actually produce).
//
// The doc is NEVER mutated while previewing. The timeline keeps showing the REAL clip
// (state.currentTime/activeClipIndex/playing are untouched) — this is a canvas-only
// preview with its own internal looping clock (`preview.timeMs`), ticked either by a
// real rAF loop or the deterministic `__aiPreview.tick(dtMs)` debug hook for headless
// tests (mirrors `__smPanel.tick`).
//
// STRUCTURAL edits (addBones/bindParts/reparent/movePivots) cannot pose-preview: they
// don't exist in the doc yet, so any track targeting a new bone simply has no id to
// resolve to and is silently dropped by `resolveTracks` (same "unresolvable target is
// dropped" rule `applyAiResult` always used, just visible earlier now). They surface
// ONLY in the preview bar's summary line (`describeStructuralChanges`) and take effect
// on Apply, same as before A2.
//
// LIFECYCLE:
//  - Entering preview auto-enables clean-preview (state.cleanPreview, A0) so the
//    candidate loops with editor chrome hidden; exiting (Apply/Discard/Retry, all of
//    which funnel through `exitPreviewCommon`) restores whatever it was before.
//  - Starting a NEW request (Create/Modify) while already previewing discards the old
//    preview first (`runAnimate` below).
//  - Two triggers have no dedicated main.ts hook to call into — ai.ts's brief is
//    explicitly not to touch main.ts/view/**, unlike smPanel.ts's `stopPreview` call
//    from main.ts's `afterDocReplaced`. They are self-detected instead, polled from two
//    places (`shouldAutoDiscardPreview`): buildAiPanel's own rebuild (notify() already
//    fires synchronously at the end of both afterDocReplaced and setEditorMode, so the
//    very next render catches it — a SILENT discard, no extra notify()) and the
//    rAF/tick loop itself (a tick-guard, belt-and-suspenders for the deterministic test
//    hook, which never goes through a render):
//      1. A genuine doc REPLACE — mirrors render.ts's OWN cleanPreview reset exactly:
//         doc reference changed AND both history stacks are freshly empty
//         (resetHistory() is the unique signature of afterDocReplaced; an undo/redo
//         also swaps state.doc but always leaves a stack non-empty).
//      2. A switch away from Animate mode (buildAiPanel is Animate-only to begin with,
//         so a stale preview left ticking in the background while its own UI is
//         unmounted would silently keep overriding renderPose() forever otherwise).
//  - Escape-to-discard is NOT wired here (Escape is main.ts's keydown handler — see
//    smHandleEscape's precedent for how the SM preview does it). A future change that
//    touches main.ts could add an `aiHandleEscape()` alongside it; out of scope here.
// =====================================================================================

interface AiPreviewState {
  result: AnimateResult;
  mode: 'new' | 'modify';
  /** Threaded straight through to `applyAiResult` unchanged on Apply. */
  applyOpts: ApplyAiOptions;
  /** Candidate tracks, id-resolved against the doc as it stood when the request was
   *  made (pre-structural — see the module comment above). */
  tracks: Track[];
  duration: number;
  /** "wave" (mode 'new', sanitized/deduped exactly as Apply will name it) or
   *  "modified Idle" (mode 'modify'). */
  clipLabel: string;
  keyCount: number;
  /** '' when the response had no structural edits at all. */
  structuralSummary: string;
  /** state.cleanPreview's value before entering — restored on exit. */
  priorCleanPreview: boolean;
  /** Looping preview clock, 0..duration. */
  timeMs: number;
  rafId: number;
  last: number;
}
let preview: AiPreviewState | null = null;
/** The doc `enterPreview` was called against — see `shouldAutoDiscardPreview`. */
let previewDocRef: RigDoc | null = null;

/** Mirrors model.channelValue's rest half for a target that isn't `part`-typed at the
 *  call site (a candidate track's target is just a resolved part id or 'root'). */
function restFallbackFor(doc: RigDoc, target: string, channel: Channel): number {
  const part = doc.parts.find((p) => p.id === target);
  if (!part) return CHANNEL_DEFAULTS[channel]; // e.g. 'root', or a dangling id
  switch (channel) {
    case 'rotate': return part.rest.rotate;
    case 'tx': return part.rest.tx;
    case 'ty': return part.rest.ty;
    case 'sx': return part.rest.sx;
    case 'sy': return part.rest.sy;
    case 'z': return CHANNEL_DEFAULTS.z; // stacking offset has no RestPose field
    case 'opacity': return part.rest.opacity;
  }
}

/** The `setPoseSampler` callback while previewing: samples the CANDIDATE's tracks at
 *  the preview clock, rest-filling unkeyed channels — see the module comment above. */
function previewSampler(target: string, channel: Channel): number {
  const doc = state.doc;
  if (!preview || !doc) return CHANNEL_DEFAULTS[channel];
  const rest = restFallbackFor(doc, target, channel);
  const track = preview.tracks.find((t) => t.target === target && t.channel === channel);
  if (!track || track.keyframes.length === 0) return rest;
  return sampleKeyList(track.keyframes, preview.timeMs, rest, channel === 'z');
}

/** True once a running preview should be silently dropped — see the module comment's
 *  LIFECYCLE section for the two triggers this polls for. */
function shouldAutoDiscardPreview(): boolean {
  if (!preview) return false;
  if (state.editorMode !== 'animate') return true;
  if (state.doc !== previewDocRef && !canUndo() && !canRedo()) return true;
  return false;
}

/** Shared teardown for every exit path (Apply/Discard/Retry/auto-discard): stops the
 *  clock, restores normal canvas sampling (and repaints — `setPoseSampler(null)`
 *  always does), restores the prior clean-preview flag. Does NOT call notify() — most
 *  callers below need to do more doc work first, and the silent auto-discard paths
 *  are already inside a render pass. */
function exitPreviewCommon(): void {
  if (!preview) return;
  cancelAnimationFrame(preview.rafId);
  setCleanPreview(preview.priorCleanPreview);
  preview = null;
  previewDocRef = null;
  setPoseSampler(null);
}

function tickPreview(dtMs: number): void {
  if (!preview) return;
  preview.timeMs = preview.duration > 0 ? (preview.timeMs + dtMs) % preview.duration : 0;
  renderPose();
}

/**
 * Escape tier for main.ts: discard an active AI preview and report whether one was
 * consumed (mirrors smHandleEscape's contract — main.ts calls this ahead of the
 * focus/deselect tiers so Escape never both discards a preview AND deselects).
 */
export function aiHandleEscape(): boolean {
  if (!preview) return false;
  exitPreviewCommon();
  notify();
  return true;
}

function rafTick(now: number): void {
  if (!preview) return;
  if (shouldAutoDiscardPreview()) { exitPreviewCommon(); notify(); return; }
  const dt = now - preview.last;
  preview.last = now;
  tickPreview(dt);
  preview.rafId = requestAnimationFrame(rafTick);
}

/**
 * AI Animate System v2 A3×A2 synergy: render a filmstrip from the CANDIDATE preview
 * (not the doc) — used by the Retry button so refinement reacts to what the model
 * actually produced, not a stale doc pose. Stops the preview's own rAF loop for the
 * duration of the capture (each frame needs a synchronous, stable `preview.timeMs` at
 * the moment `captureFilmstripFrame` clones the live SVG — see `renderClipFilmstrip`'s
 * doc comment in ui/snapshot.ts for why the clone must happen before any await lets
 * another tick interleave) and restarts it afterward at the ORIGINAL timeMs, byte-exact,
 * even if a frame's rasterization throws partway through (try/finally). Returns [] if no
 * preview is active (defensive — the only caller already checks).
 */
async function renderCandidateFilmstrip(): Promise<FilmstripFrame[]> {
  if (!preview) return [];
  const times = selectFilmstripTimes({ duration: preview.duration, tracks: preview.tracks });
  cancelAnimationFrame(preview.rafId);
  const savedTimeMs = preview.timeMs;
  const frames: FilmstripFrame[] = [];
  try {
    for (const t of times) {
      preview.timeMs = t;
      renderPose();
      const frame = await captureFilmstripFrame(t);
      if (frame) frames.push(frame);
    }
  } finally {
    // Defensive: nothing in this module currently discards `preview` mid-await (the
    // sole caller disables the preview bar's own buttons for the duration — see the
    // Retry handler below), but restoring against a doc that moved on from under us
    // would be worse than skipping the restore.
    if (preview) {
      preview.timeMs = savedTimeMs;
      renderPose();
      preview.last = performance.now();
      preview.rafId = requestAnimationFrame(rafTick);
    }
  }
  return frames;
}

/** Enter a preview for a just-received AnimateResult. Discards any preview already
 *  running first (a new request always wins). No-ops if the doc vanished between the
 *  request starting and returning (defensive — callers already guard this). */
function enterPreview(
  result: AnimateResult, mode: 'new' | 'modify', applyOpts: ApplyAiOptions,
): void {
  const doc = state.doc;
  if (!doc) return;
  if (preview) exitPreviewCommon();

  const labelToId = new Map(doc.parts.map((p) => [p.label, p.id]));
  const tracks = resolveTracks(result, labelToId);
  const clipLabel = mode === 'new'
    ? sanitizeClipName(applyOpts.clipName ?? result.clip.clipName ?? null, doc.clips.map((c) => c.name))
    : `modified ${(applyOpts.clip ?? activeClip())?.name ?? 'clip'}`;

  preview = {
    result, mode, applyOpts, tracks,
    duration: result.clip.duration,
    clipLabel,
    keyCount: tracks.reduce((n, t) => n + t.keyframes.length, 0),
    structuralSummary: describeStructuralChanges(result.rig),
    priorCleanPreview: state.cleanPreview,
    timeMs: 0,
    rafId: 0,
    last: performance.now(),
  };
  previewDocRef = doc;
  setCleanPreview(true);
  setPoseSampler(previewSampler); // installs the override AND repaints the first frame
  preview.rafId = requestAnimationFrame(rafTick);
}

/** Apply button: exits preview, then applies EXACTLY like pre-A2 did (one checkpoint,
 *  protection enforcement included) — reproduces runAnimate's old post-apply tail. */
function applyPreviewNow(): void {
  if (!preview) return;
  const { result, mode, applyOpts } = preview;
  exitPreviewCommon();
  const outcome = applyAiResult(result, mode, applyOpts);
  if (!outcome) {
    ai.status = 'Failed to apply — no document loaded.';
    notify();
    return;
  }
  state.editorMode = 'animate';
  state.currentTime = 0;
  state.playing = true;
  const clampNote = result.clampedCount > 0
    ? ` (clamped ${result.clampedCount} out-of-range key time${result.clampedCount === 1 ? '' : 's'})`
    : '';
  ai.status = mode === 'new'
    ? `Done — created "${outcome.clip.name}" and switched to it${outcome.structural}${clampNote}.`
    : `Done — playing the result${outcome.structural}${clampNote}.`;
  // Clear the prompt only on a SUCCESSFUL apply — see AiPanelState's doc comment for
  // why errors/cancels/discards leave it alone.
  ai.promptText = '';
  renderPose();
  document.dispatchEvent(new CustomEvent('rig-play'));
  notify();
}

/** Discard button: exits preview, applies nothing — the doc never saw the candidate. */
function discardPreviewNow(): void {
  if (!preview) return;
  exitPreviewCommon();
  ai.status = '';
  notify();
}

// ---- Debug hook for headless verification (mirrors __smPanel's tick pattern) ----
if (typeof window !== 'undefined') {
  (window as unknown as { __aiPreview: unknown }).__aiPreview = {
    isActive: (): boolean => !!preview,
    status: () => (preview ? {
      mode: preview.mode,
      clipLabel: preview.clipLabel,
      keyCount: preview.keyCount,
      structuralSummary: preview.structuralSummary,
      timeMs: preview.timeMs,
      duration: preview.duration,
    } : null),
    /** Deterministic tick for headless verification (requestAnimationFrame is
     *  throttled/paused in an unfocused automation tab) — mirrors the rAF loop's
     *  per-frame work, tick-guard included. */
    tick: (dtMs: number) => {
      if (!preview) return null;
      if (shouldAutoDiscardPreview()) { exitPreviewCommon(); notify(); return null; }
      tickPreview(dtMs);
      return { timeMs: preview.timeMs };
    },
    apply: (): void => applyPreviewNow(),
    discard: (): void => discardPreviewNow(),
    busy: (): boolean => ai.busy,
    /** AI Animate System v2 A3: renders a filmstrip from the CANDIDATE preview via the
     *  exact function the Retry button uses (`renderCandidateFilmstrip`) — lets a
     *  headless test or live console session verify frame sampling/restoration without
     *  clicking Retry through a real (or fabricated) second request. Resolves `[]` when
     *  no preview is active. */
    renderFilmstrip: (): Promise<FilmstripFrame[]> => renderCandidateFilmstrip(),
    /** Console/live-verification convenience wrapping `__setAnimateCallForTest`: the
     *  NEXT Create/Modify click resolves with `result` instead of calling the network
     *  — lets a real browser session exercise the preview flow without an API key. */
    fabricateNext: (result: AnimateResult): void => {
      __setAnimateCallForTest(async () => result);
    },
  };
}

/** Toggle the whole-editor inert overlay (pointer-events + dim) while a request runs.
 * `.ai-panel` opts back into pointer events (see ui.css) so Cancel stays clickable. */
function setEditorInert(active: boolean): void {
  document.getElementById('layout')?.classList.toggle('ai-busy', active);
}

/**
 * Panel state kept at module scope, not per-render closure: an inspector rebuild
 * (notify(), e.g. from a keyboard-driven selection change) can happen while a request
 * is in flight, and the busy UI / Cancel button must survive that rebuild intact.
 *
 * `promptText` joins that pattern (AI Animate System v2 A1): the textarea's content
 * must survive inspector rebuilds, editor-mode round trips (buildAiPanel simply isn't
 * called in Edit mode — the module state persists regardless of whether the DOM element
 * exists), and timeline view switches (curves/logic), all of which can fire notify() and
 * rebuild this panel from a blank slate. DECISION: cleared ONLY on a successful apply
 * (Create or Modify) — the user's wording is the thing most worth keeping around after a
 * failed or cancelled request, so both those paths leave it untouched; only a completed
 * edit "consumes" it. Critique doesn't touch it at all (it isn't a directive).
 */
interface AiPanelState {
  busy: boolean;
  status: string;
  promptText: string;
  critiqueText: string | null;
  abort: AbortController | null;
}
const ai: AiPanelState = {
  busy: false, status: '', promptText: '', critiqueText: null, abort: null,
};

export function buildAiPanel(el: HTMLElement): void {
  // A2: reconcile the two preview-lifecycle triggers that have no dedicated main.ts
  // hook to call into — a genuine doc replace, or a mode switch away from Animate (see
  // shouldAutoDiscardPreview's doc comment). SILENT: notify() already fired to get us
  // into this render pass, so calling it again here would recurse.
  if (preview && shouldAutoDiscardPreview()) {
    exitPreviewCommon();
    ai.status = '';
  }

  // Locked decision (v2.12 P5b): the assistant panel is Animate-only — choreographing
  // or critiquing a clip makes no sense while editing the character itself.
  if (state.editorMode !== 'animate') return;

  const box = document.createElement('div');
  box.className = 'ai-panel';
  box.innerHTML = '<h3>Animate with Claude</h3>';

  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.placeholder = 'Anthropic API key (stored locally)';
  keyInput.value = localStorage.getItem('rig-studio-api-key') ?? '';
  keyInput.onchange = () => localStorage.setItem('rig-studio-api-key', keyInput.value.trim());
  box.appendChild(keyInput);

  const promptBox = document.createElement('textarea');
  promptBox.placeholder = 'e.g. "wave with the right arm", "bend at the knees then jump"';
  promptBox.rows = 3;
  promptBox.value = ai.promptText;
  promptBox.oninput = () => { ai.promptText = promptBox.value; };
  box.appendChild(promptBox);

  const shotLabel = document.createElement('label');
  shotLabel.className = 'field';
  const shotToggle = document.createElement('input');
  shotToggle.type = 'checkbox';
  shotToggle.checked = localStorage.getItem('rig-studio-attach-shot') !== '0';
  shotToggle.onchange = () =>
    localStorage.setItem('rig-studio-attach-shot', shotToggle.checked ? '1' : '0');
  const shotSpan = document.createElement('span');
  shotSpan.textContent = 'attach rendered frames (filmstrip)';
  const shotInfo = document.createElement('span');
  shotInfo.className = 'ai-info';
  shotInfo.textContent = 'ⓘ'; // circled "i"
  shotInfo.title =
    'Renders up to 6 frames across the clip (denser where its motion actually changes) ' +
    'and sends them to Claude so it sees the animation, not just one pose. On Retry with ' +
    'a candidate showing, the frames come from the CANDIDATE instead of the document. ' +
    'Falls back to a single current-pose snapshot if rendering fails.';
  shotSpan.appendChild(document.createTextNode(' '));
  shotSpan.appendChild(shotInfo);
  shotLabel.appendChild(shotSpan);
  shotLabel.appendChild(shotToggle);
  box.appendChild(shotLabel);

  const rigLabel = document.createElement('label');
  rigLabel.className = 'field';
  const rigToggle = document.createElement('input');
  rigToggle.type = 'checkbox';
  rigToggle.checked = localStorage.getItem('rig-studio-allow-rig-edits') === '1';
  rigToggle.onchange = () =>
    localStorage.setItem('rig-studio-allow-rig-edits', rigToggle.checked ? '1' : '0');
  const rigSpan = document.createElement('span');
  rigSpan.textContent = 'allow rig changes (bones / parenting / pivots / auto-bind)';
  rigLabel.appendChild(rigSpan);
  rigLabel.appendChild(rigToggle);
  box.appendChild(rigLabel);

  const protectLabel = document.createElement('label');
  protectLabel.className = 'field';
  const protectToggle = document.createElement('input');
  protectToggle.type = 'checkbox';
  protectToggle.checked = localStorage.getItem('rig-studio-protect-playhead') === '1';
  protectToggle.onchange = () =>
    localStorage.setItem('rig-studio-protect-playhead', protectToggle.checked ? '1' : '0');
  const protectSpan = document.createElement('span');
  protectSpan.textContent = 'protect playhead keyframes (Modify) ';
  const protectInfo = document.createElement('span');
  protectInfo.className = 'ai-info';
  protectInfo.textContent = 'ⓘ';
  protectInfo.title =
    'Modify only. Locks every keyframe already at the current playhead time (across all ' +
    'tracks of this clip) so Claude cannot move, re-value, or remove them — enforced both ' +
    'in the prompt and by restoring them after the response is applied.';
  protectSpan.appendChild(protectInfo);
  protectLabel.appendChild(protectSpan);
  protectLabel.appendChild(protectToggle);
  box.appendChild(protectLabel);

  const status = document.createElement('p');
  status.className = 'hint';
  status.textContent = ai.status;
  box.appendChild(status);

  const busyRow = document.createElement('p');
  busyRow.className = 'hint ai-busy-indicator';
  busyRow.hidden = !ai.busy;
  const busyDot = document.createElement('span');
  busyDot.className = 'ai-busy-dot';
  const busyText = document.createElement('span');
  busyText.textContent = 'Waiting on Claude…';
  busyRow.appendChild(busyDot);
  busyRow.appendChild(busyText);
  box.appendChild(busyRow);

  const critiqueOut = document.createElement('div');
  critiqueOut.className = 'critique-out';
  critiqueOut.hidden = ai.critiqueText === null;
  if (ai.critiqueText) critiqueOut.textContent = ai.critiqueText;

  const requireCtx = (): { doc: NonNullable<typeof state.doc>; apiKey: string } | null => {
    const doc = state.doc;
    const apiKey = keyInput.value.trim();
    if (!doc || !activeClip()) return null;
    if (!apiKey) {
      status.textContent = 'Enter an API key first.';
      return null;
    }
    return { doc, apiKey };
  };

  const createBtn = document.createElement('button');
  createBtn.textContent = 'Create new animation';
  createBtn.title =
    'Ask Claude for a brand-new clip realizing this direction. The current clip is sent ' +
    'as reference context only — it is never modified.';
  const modifyBtn = document.createElement('button');
  modifyBtn.textContent = 'Modify current animation';
  modifyBtn.title = 'Ask Claude to edit the active clip in place.';
  const critique = document.createElement('button');
  critique.textContent = 'Critique this animation';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.hidden = !ai.busy;

  const setBusy = (busy: boolean): void => {
    keyInput.disabled = busy;
    promptBox.disabled = busy;
    shotToggle.disabled = busy;
    rigToggle.disabled = busy;
    protectToggle.disabled = busy;
    createBtn.disabled = busy;
    modifyBtn.disabled = busy;
    critique.disabled = busy;
    cancelBtn.hidden = !busy;
    busyRow.hidden = !busy;
    setEditorInert(busy);
  };
  setBusy(ai.busy); // reflect an in-flight request across a mid-request rebuild

  cancelBtn.onclick = () => ai.abort?.abort();

  // A2: the preview bar's DOM element, if one is showing this render — a still-
  // in-flight Retry needs to yank it off-screen immediately (see below) without
  // waiting for the next notify()-driven rebuild.
  let previewBarEl: HTMLElement | null = null;

  const runAnimate = async (
    mode: 'new' | 'modify',
    /** A2×A3 synergy: on Retry with a preview active, the caller pre-renders the
     *  CANDIDATE's filmstrip before discarding the preview (see the Retry handler
     *  below) and passes it here, so this request reacts to what the model actually
     *  produced instead of the doc's stale pose. undefined = render the DOC's active
     *  clip fresh here (the normal Create/Modify path, and a Retry with the checkbox
     *  off at retry time). */
    retryFrames?: FilmstripFrame[],
  ): Promise<void> => {
    const ctxv = requireCtx();
    const clip = activeClip();
    if (!ctxv || !clip) return;
    if (!promptBox.value.trim()) {
      status.textContent = 'Describe the motion you want.';
      return;
    }
    // Starting a new request always discards whatever preview is currently showing
    // (A2 rule) — remove its DOM immediately rather than waiting for a rebuild, since
    // the busy state we're about to enter reuses THIS SAME render pass's elements.
    if (preview) {
      exitPreviewCommon();
      previewBarEl?.remove();
      previewBarEl = null;
    }
    const controller = new AbortController();
    ai.abort = controller;
    ai.busy = true;
    ai.status = mode === 'new'
      ? 'Creating a new animation… (this can take a minute)'
      : 'Choreographing… (this can take a minute)';
    status.textContent = ai.status;
    setBusy(true);
    try {
      // A3 filmstrip: prefer N rendered frames across the clip over a single pose
      // snapshot — replaces it entirely when frames are available (never both).
      // Failure-soft: any rasterization error degrades to the old single-snapshot
      // fallback (never both empty when the checkbox is on and a canvas exists), and
      // never blocks the request either way.
      let frames: FilmstripFrame[] = [];
      let image: string | null = null;
      let framesFailed = false;
      if (shotToggle.checked) {
        if (retryFrames !== undefined) {
          frames = retryFrames; // A2×A3: candidate frames, already rendered by Retry
        } else {
          try {
            frames = await renderClipFilmstrip(clip);
          } catch {
            frames = [];
          }
        }
        if (frames.length === 0) {
          framesFailed = true;
          image = await snapshotPose().catch(() => null);
        }
      }

      // "protect playhead keys" (Modify only): snapshot the current-frame keys BEFORE
      // the request — by part id (idProtected, for post-apply enforcement) and by
      // label (promptProtected, for the prompt text Claude actually reads).
      const idProtected: ProtectedKey[] =
        mode === 'modify' && protectToggle.checked
          ? snapshotProtectedKeys(clip, state.currentTime)
          : [];
      const labelOf = (id: string) => ctxv.doc.parts.find((p) => p.id === id)?.label ?? id;
      const promptProtected = idProtected.map((pk) => ({
        target: pk.target === 'root' ? 'root' : labelOf(pk.target),
        channel: pk.channel,
        time: pk.time,
        value: pk.value,
      }));

      const result = await animateCallImpl(
        ctxv.apiKey, ctxv.doc, clip, promptBox.value.trim(), state.selectedPartIds,
        {
          imageBase64: image,
          frames: frames.length > 0 ? frames : undefined,
          allowRigChanges: rigToggle.checked,
          mode,
          protectedKeys: promptProtected,
          signal: controller.signal,
        },
      );
      // The doc is untouched up to this point — an abort before this line leaves no
      // trace. A2: a SUCCESSFUL response no longer applies here either — it enters a
      // canvas-only PREVIEW (enterPreview) that the user reviews via Apply / Retry /
      // Discard, so the doc stays untouched until an explicit Apply click.
      enterPreview(result, mode, {
        clip: mode === 'modify' ? clip : undefined,
        clipName: result.clip.clipName,
        protectedKeys: idProtected,
      });
      const clampNote = result.clampedCount > 0
        ? ` (clamped ${result.clampedCount} out-of-range key time${result.clampedCount === 1 ? '' : 's'})`
        : '';
      const frameNote = framesFailed
        ? image ? ' (frames unavailable — sent a single snapshot instead)' : ' (frames unavailable)'
        : '';
      ai.status = `Candidate ready — review it below.${clampNote}${frameNote}`;
      // promptText is intentionally left alone here — see AiPanelState's doc comment;
      // it now clears on a successful APPLY (applyPreviewNow), not on a successful
      // generate, since the candidate hasn't been committed to anything yet.
    } catch (err) {
      ai.status = controller.signal.aborted
        ? 'Cancelled.'
        : `Failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      ai.busy = false;
      ai.abort = null;
      // Clear the inert overlay directly rather than only through setBusy(): the
      // toolbar's mode toggle lives outside #layout and stays clickable even while
      // inert, so the user could switch to Edit mode mid-request — buildAiPanel then
      // returns early (Animate-only) and never re-runs setBusy(false) to undo it.
      setEditorInert(false);
      // notify() rebuilds every panel (picks up ai.status + the idle control state,
      // and — A2 — the preview bar if enterPreview just ran). It does not itself call
      // renderPose(): the success path already repainted above (enterPreview's
      // setPoseSampler call does), and the failure/cancel/discard paths change no doc
      // state, so no repaint is needed there either.
      notify();
    }
  };

  createBtn.onclick = () => runAnimate('new');
  modifyBtn.onclick = () => runAnimate('modify');

  // A2: the preview bar — shown in place of an immediate apply once a Create/Modify
  // request succeeds. Sits between the busy readout and the action buttons so it reads
  // as the natural next step. Structural edits (bones/binds) never move the canvas
  // pose (see the module comment above `enterPreview`), so a second line calls that
  // out explicitly rather than leaving the user to wonder why nothing moved.
  if (preview) {
    const bar = document.createElement('div');
    bar.className = 'ai-preview-bar';

    const summaryParts = [
      `Previewing: ${preview.clipLabel}`,
      `${preview.keyCount} key${preview.keyCount === 1 ? '' : 's'}`,
    ];
    if (preview.structuralSummary) summaryParts.push(preview.structuralSummary);
    const summary = document.createElement('p');
    summary.className = 'ai-preview-summary';
    summary.textContent = summaryParts.join(' · ');
    bar.appendChild(summary);

    if (preview.structuralSummary) {
      const note = document.createElement('p');
      note.className = 'hint ai-preview-note';
      note.textContent =
        'Structural changes (bones/binds) apply on Apply — they cannot be shown in this canvas preview.';
      bar.appendChild(note);
    }

    const actions = document.createElement('div');
    actions.className = 'ai-preview-actions';

    const applyBtn = document.createElement('button');
    applyBtn.textContent = 'Apply';
    applyBtn.className = 'ai-preview-apply';
    applyBtn.dataset.aiAction = 'apply';
    applyBtn.title = 'Commit this candidate to the document (one undo reverts it).';
    applyBtn.onclick = () => applyPreviewNow();
    actions.appendChild(applyBtn);

    const retryBtn = document.createElement('button');
    retryBtn.textContent = 'Retry';
    retryBtn.dataset.aiAction = 'retry';
    retryBtn.title = 'Discard this candidate and ask Claude again with the same prompt.';
    retryBtn.onclick = async () => {
      if (!preview) return;
      const mode = preview.mode;
      // A3 synergy: capture the CANDIDATE's filmstrip BEFORE discarding the preview —
      // once exitPreviewCommon() runs, preview.tracks/timeMs are gone, so this has to
      // happen first. Lock the whole action row for the (short, local, no-network)
      // render so a double-click can't race exitPreviewCommon against a still-running
      // capture (renderCandidateFilmstrip guards `preview` defensively too, but this
      // avoids the race outright rather than relying on that guard).
      applyBtn.disabled = true;
      retryBtn.disabled = true;
      discardBtn.disabled = true;
      const candidateFrames = shotToggle.checked ? await renderCandidateFilmstrip() : undefined;
      if (!preview) return; // discarded from elsewhere while we were rendering — bail
      exitPreviewCommon();
      bar.remove();
      previewBarEl = null;
      void runAnimate(mode, candidateFrames); // same closure/DOM — keeps the busy UI visible mid-request
    };
    actions.appendChild(retryBtn);

    const discardBtn = document.createElement('button');
    discardBtn.textContent = 'Discard';
    discardBtn.dataset.aiAction = 'discard';
    discardBtn.title = 'Throw this candidate away. (Future: Escape will do this too — not wired yet.)';
    discardBtn.onclick = () => discardPreviewNow();
    actions.appendChild(discardBtn);

    bar.appendChild(actions);
    previewBarEl = bar;
    box.appendChild(bar);
  }

  box.appendChild(createBtn);
  box.appendChild(modifyBtn);

  critique.onclick = async () => {
    const ctxv = requireCtx();
    const clip = activeClip();
    if (!ctxv || !clip) return;
    const controller = new AbortController();
    ai.abort = controller;
    ai.busy = true;
    ai.status = 'Reviewing the clip…';
    ai.critiqueText = null;
    status.textContent = ai.status;
    critiqueOut.hidden = true;
    setBusy(true);
    try {
      // A3 filmstrip, offered on Critique too (same checkbox, same failure-soft
      // fallback to a single snapshot as the animate path above).
      let frames: FilmstripFrame[] = [];
      let image: string | null = null;
      if (shotToggle.checked) {
        try {
          frames = await renderClipFilmstrip(clip);
        } catch {
          frames = [];
        }
        if (frames.length === 0) image = await snapshotPose().catch(() => null);
      }
      const text = await critiqueWithClaude(
        ctxv.apiKey, ctxv.doc, clip, state.selectedPartIds,
        { imageBase64: image, frames: frames.length > 0 ? frames : undefined, signal: controller.signal },
      );
      ai.critiqueText = text;
      ai.status = '';
    } catch (err) {
      ai.status = controller.signal.aborted
        ? 'Cancelled.'
        : `Failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      ai.busy = false;
      ai.abort = null;
      setEditorInert(false); // see runAnimate's finally block for why this is unconditional
      notify();
    }
  };
  box.appendChild(critique);
  box.appendChild(cancelBtn);
  box.appendChild(critiqueOut);

  el.appendChild(box);
}

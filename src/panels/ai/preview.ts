/**
 * AI Animate System v2 A2: preview-before-apply — plus the A3 candidate-filmstrip
 * synergy. Split out of the former `panels/ai.ts` monolith (A4 split): `./panel.ts`
 * (DOM/build/busy UI) and `./previewBar.ts` (the review card) call into this file's
 * engine; `./index.ts` re-exports `aiHandleEscape` for main.ts.
 *
 * A successful animate call (Create or Modify) no longer applies straight to the doc —
 * it enters a PREVIEW: the candidate clip's tracks (resolved to part ids against the
 * doc's CURRENT label→id map — see `./apply.ts`'s `resolveTracks`) loop on the canvas
 * via view's `setPoseSampler` hook, exactly the mechanism smPanel.ts's state-machine
 * preview uses (it is the ONLY hook the view facade offers for overriding rendered pose
 * — see CLAUDE.md's "SM preview is app-state" convention). `previewSampler`/
 * `restFallbackFor` below replicate model.channelValue's "keyed values are absolute,
 * rest fills unkeyed channels" rule (mirroring core/stateMachine.ts's private
 * `sampleClock`/`restFallback`) because the candidate is NOT `activeClip()` — it may not
 * even exist in `doc.clips` yet (mode 'new'), or may be a wholesale replacement of the
 * active clip's tracks (mode 'modify' — applyAiResult REPLACES `clip.tracks` outright,
 * so previewing against the candidate's tracks with a rest fallback, never the doc
 * clip's OLD tracks, is exactly what Apply will actually produce).
 *
 * The doc is NEVER mutated while previewing. The timeline keeps showing the REAL clip
 * (state.currentTime/activeClipIndex/playing are untouched) — this is a canvas-only
 * preview with its own internal looping clock (`preview.timeMs`), ticked either by a
 * real rAF loop or the deterministic `debugTick` hook `./panel.ts` exposes as
 * `window.__aiPreview.tick` for headless tests (mirrors `__smPanel.tick`).
 *
 * STRUCTURAL edits (addBones/bindParts/reparent/movePivots) cannot pose-preview: they
 * don't exist in the doc yet, so any track targeting a new bone simply has no id to
 * resolve to and is silently dropped by `resolveTracks` (same "unresolvable target is
 * dropped" rule `applyAiResult` always used, just visible earlier now). They surface
 * ONLY in the preview bar's summary line (`describeStructuralChanges`) and take effect
 * on Apply, same as before A2.
 *
 * LIFECYCLE:
 *  - Entering preview auto-enables clean-preview (state.cleanPreview, A0) so the
 *    candidate loops with editor chrome hidden; exiting (Apply/Discard/Retry, all of
 *    which funnel through `exitPreviewCommon`) restores whatever it was before.
 *  - Starting a NEW request (Create/Modify) while already previewing discards the old
 *    preview first (`./requests.ts`'s `runAnimate`).
 *  - Two triggers have no dedicated main.ts hook to call into — this module's brief is
 *    explicitly not to touch main.ts/view/**, unlike smPanel.ts's `stopPreview` call
 *    from main.ts's `afterDocReplaced`. They are self-detected instead, polled from two
 *    places (`shouldAutoDiscardPreview`): `./panel.ts`'s own rebuild via
 *    `reconcilePreviewLifecycle` (notify() already fires synchronously at the end of
 *    both afterDocReplaced and setEditorMode, so the very next render catches it — a
 *    SILENT discard, no extra notify()) and the rAF/tick loop itself (a tick-guard,
 *    belt-and-suspenders for the deterministic test hook, which never goes through a
 *    render):
 *      1. A genuine doc REPLACE — mirrors render.ts's OWN cleanPreview reset exactly:
 *         doc reference changed AND both history stacks are freshly empty
 *         (resetHistory() is the unique signature of afterDocReplaced; an undo/redo
 *         also swaps state.doc but always leaves a stack non-empty).
 *      2. A switch away from Animate mode (the panel is Animate-only to begin with, so
 *         a stale preview left ticking in the background while its own UI is unmounted
 *         would silently keep overriding renderPose() forever otherwise).
 *  - Escape-to-discard is `aiHandleEscape` below (main.ts's keydown handler calls it
 *    alongside smHandleEscape's precedent).
 */

import {
  state, notify, activeClip, sanitizeClipName, setCleanPreview, CHANNEL_DEFAULTS,
  sampleKeyList, Track, Channel, RigDoc,
} from '../../core/model';
import { renderPose, setPoseSampler } from '../../view';
import { AnimateResult } from '../../ai/claude';
import { canUndo, canRedo } from '../../core/history';
import {
  captureFilmstripFrame, selectFilmstripTimes, FilmstripFrame,
} from '../../ui/snapshot';
import { ApplyAiOptions, ApplyAiOutcome, applyAiResult, resolveTracks } from './apply';

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
export async function renderCandidateFilmstrip(): Promise<FilmstripFrame[]> {
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
    // sole caller disables the preview bar's own buttons for the duration — see
    // ./previewBar.ts's Retry handler), but restoring against a doc that moved on from
    // under us would be worse than skipping the restore.
    if (preview) {
      preview.timeMs = savedTimeMs;
      renderPose();
      preview.last = performance.now();
      preview.rafId = requestAnimationFrame(rafTick);
    }
  }
  return frames;
}

/**
 * Preview-only summary of an AnimateResult's structural rig edits (bones/binds/
 * reparents/pivot moves), for the preview bar's one-line readout. Pure — reads
 * `result.rig` by LABEL only and never applies anything (structural edits only ever
 * apply via `./apply.ts`'s `applyStructuralRigChanges`, on Apply). Deliberately a
 * separate, simpler pass from that function's post-apply notes: this runs BEFORE
 * anything exists in the doc, so it can't dedupe by real chain ids the way the applied
 * version does — a plain per-bone tally is good enough for a review summary.
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

/** Enter a preview for a just-received AnimateResult. Discards any preview already
 *  running first (a new request always wins). No-ops if the doc vanished between the
 *  request starting and returning (defensive — callers already guard this). */
export function enterPreview(
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

export interface CommitPreviewResult {
  outcome: ApplyAiOutcome | null;
  mode: 'new' | 'modify';
  clampedCount: number;
}

/**
 * Mechanical half of the Apply button: exits preview, then applies EXACTLY like pre-A2
 * did (one checkpoint, protection enforcement included — see `./apply.ts`'s
 * `applyAiResult`). Status-string building, promptText clearing, the post-apply
 * notify()/render/'rig-play' dispatch, and AI Animate System v2 A4's thread-turn
 * recording are all `./panel.ts`'s job (its `handleApply`) — this function stays pure
 * UI-free so it's usable from both the real Apply button and the
 * `window.__aiPreview.apply()` debug hook.
 */
export function commitPreview(): CommitPreviewResult | null {
  if (!preview) return null;
  const { result, mode, applyOpts } = preview;
  exitPreviewCommon();
  const outcome = applyAiResult(result, mode, applyOpts);
  return { outcome, mode, clampedCount: result.clampedCount };
}

/** Mechanical half of the Discard button: exits preview, applies nothing — the doc
 *  never saw the candidate. Returns false (no-op) if nothing was previewing. */
export function discardPreview(): boolean {
  if (!preview) return false;
  exitPreviewCommon();
  return true;
}

/**
 * Reconciles the two auto-discard triggers with no dedicated main.ts hook to call into
 * (see the module comment's LIFECYCLE section) — called at the top of every
 * `buildAiPanel` render. Returns true iff a preview was silently discarded (the caller
 * clears its own status text in that case; this never calls notify() itself, matching
 * the original "already inside a render pass" contract).
 */
export function reconcilePreviewLifecycle(): boolean {
  if (preview && shouldAutoDiscardPreview()) {
    exitPreviewCommon();
    return true;
  }
  return false;
}

export function isPreviewActive(): boolean {
  return !!preview;
}

export interface PreviewSummary {
  mode: 'new' | 'modify';
  clipLabel: string;
  keyCount: number;
  structuralSummary: string;
}

/** Read-only snapshot for the preview bar (`./previewBar.ts`) and the debug hook. */
export function previewSummary(): PreviewSummary | null {
  if (!preview) return null;
  const { mode, clipLabel, keyCount, structuralSummary } = preview;
  return { mode, clipLabel, keyCount, structuralSummary };
}

export interface PreviewDebugStatus extends PreviewSummary {
  timeMs: number;
  duration: number;
}

/** Full snapshot incl. the preview clock — backs `window.__aiPreview.status()`. */
export function debugStatus(): PreviewDebugStatus | null {
  const summary = previewSummary();
  if (!summary || !preview) return null;
  return { ...summary, timeMs: preview.timeMs, duration: preview.duration };
}

/**
 * Deterministic tick for headless verification (requestAnimationFrame is throttled/
 * paused in an unfocused automation tab) — mirrors the rAF loop's per-frame work,
 * tick-guard included. Backs `window.__aiPreview.tick`.
 */
export function debugTick(dtMs: number): { timeMs: number } | null {
  if (!preview) return null;
  if (shouldAutoDiscardPreview()) { exitPreviewCommon(); notify(); return null; }
  tickPreview(dtMs);
  return { timeMs: preview.timeMs };
}

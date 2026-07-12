/**
 * Applying an `AnimateResult` to the doc: structural rig changes (bones/auto-bind) plus
 * either creating a new clip or modifying one in place. Split out of the former
 * `panels/ai.ts` monolith (AI Animate System v2 A4 split) — see `./index.ts` for the
 * facade this feeds and `./preview.ts` for the A2 preview engine that calls
 * `applyAiResult`/`resolveTracks` on Apply / while entering a candidate.
 */

import {
  state, activeClip, applyRigChanges, boneChain, sanitizeClipName,
  enforceProtectedKeys, Track, Channel, RigPart, RigDoc, Clip, ProtectedKey,
} from '../../core/model';
import { registerPart, bindPartsToBones } from '../../view';
import { AnimateResult } from '../../ai/claude';
import { checkpoint } from '../../core/history';

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
 * newly added bones resolve) and A2's `enterPreview` in `./preview.ts` (called with the
 * doc's CURRENT, pre-structural map — a track targeting a not-yet-created bone simply
 * has no match and is silently dropped, which is exactly right: structural changes
 * cannot pose-preview). Unresolvable targets are dropped rather than throwing, matching
 * the pre-A2 inline behavior this replaces.
 */
export function resolveTracks(result: AnimateResult, labelToId: Map<string, string>): Track[] {
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
 * `./preview.ts`'s `commitPreview` — nothing about the apply path itself needed to
 * change across the A2 or A4 waves.
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
 * smallest, most obvious entry point for console/smoke-testing a fabricated response —
 * production UI now calls `applyAiResult` directly from the two action buttons.
 */
export function applyAnimateResult(clip: Clip | null, result: AnimateResult): string {
  if (!clip) return '';
  return applyAiResult(result, 'modify', { clip })?.structural ?? '';
}

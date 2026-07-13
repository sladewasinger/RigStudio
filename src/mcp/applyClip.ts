/**
 * Applying a structured clip (+ optional structural rig edits) to a session doc —
 * headless mirror of `panels/ai/apply.ts`'s `applyAiResult`, which is off-limits here
 * (`panels/` is forbidden territory for `src/mcp/`, same as for `src/headless/` — see
 * `headlessBoundary.test.ts`). "One brain, two mouths" (ROADMAP H2): the in-app assistant
 * and MCP's `apply_clip` tool consume the exact same `RawClip`/`AnimateResult` shape from
 * `ai/claude.ts` (including `clampRawClip`'s duration-pin + skinned sx/sy drop), they just
 * apply it through two different, hand-kept-in-sync functions.
 *
 * DUPLICATION RISK (accepted, per ROADMAP H2's own instruction rather than moving
 * `panels/` code): `applyStructuralRigChanges`/`resolveTracks`/the apply body below are a
 * close port of `panels/ai/apply.ts`. The only real divergence is bind/registration:
 * the editor calls `view`'s `registerPart` (canvas DOM group bookkeeping — nothing to
 * register headlessly, so it's simply omitted) and `bindPartsToBones` (DOM-coupled); this
 * file calls `./bindHeadless`'s `bindPartsToBonesHeadless` instead. A change to either
 * apply path's SEMANTICS (not just its DOM plumbing) must be ported to both by hand.
 */
import {
  activeClip, applyRigChanges, boneChain, Channel, Clip, enforceProtectedKeys, ProtectedKey,
  RigChanges, RigDoc, RigPart, sanitizeClipName, Track,
} from '../core/model';
import { AnimateResult } from '../ai/claude';
import { bindPartsToBonesHeadless } from './bindHeadless';
import { McpToolError } from './errors';

function applyStructuralRigChanges(
  doc: RigDoc, changes: RigChanges | null,
): { labelToId: Map<string, string>; notes: string[] } {
  let labelToId = new Map(doc.parts.map((p) => [p.label, p.id]));
  const notes: string[] = [];
  if (!changes) return { labelToId, notes };

  labelToId = applyRigChanges(changes);
  const added = changes.addBones?.length ?? 0;
  if (added > 0) notes.push(`+${added} bone${added === 1 ? '' : 's'}`);

  const boundChains = new Set<string>();
  let bound = 0;
  for (const b of changes.addBones ?? []) {
    if (!b.bindParts?.length) continue;
    const boneId = labelToId.get(b.label);
    if (!boneId) continue;
    const chain = boneChain(doc.parts, boneId);
    if (chain.length === 0) continue;
    const chainKey = chain.map((p) => p.id).sort().join(',');
    if (boundChains.has(chainKey)) continue;
    boundChains.add(chainKey);
    const wantLabels = new Set<string>();
    for (const bb of changes.addBones ?? []) {
      const bid = labelToId.get(bb.label);
      if (bid && chain.some((c) => c.id === bid)) {
        for (const l of bb.bindParts ?? []) wantLabels.add(l);
      }
    }
    const missing = [...wantLabels].filter(
      (label) => !doc.parts.some((p) => p.label === label && p.kind === 'art' && p.paths.length > 0),
    );
    if (missing.length > 0) {
      throw new McpToolError(
        `bindParts references label(s) that don't resolve to an existing art part with ` +
          `geometry (no geometric auto-bind headlessly — labels must be explicit): ${missing.join(', ')}`,
      );
    }
    const arts = [...wantLabels]
      .map((label) => doc.parts.find((p) => p.label === label))
      .filter((p): p is RigPart => !!p);
    if (arts.length > 0) {
      bindPartsToBonesHeadless(arts, chain);
      bound += arts.length;
    }
  }
  if (bound > 0) notes.push(`bound ${bound} part${bound === 1 ? '' : 's'}`);

  return { labelToId, notes };
}

export function resolveTracks(result: AnimateResult, labelToId: Map<string, string>): Track[] {
  const tracks: Track[] = [];
  for (const t of result.clip.tracks) {
    const target = t.target === 'root' ? 'root' : labelToId.get(t.target);
    if (!target) continue;
    tracks.push({ target, channel: t.channel as Channel, keyframes: t.keyframes });
  }
  return tracks;
}

export interface ApplyClipOptions {
  clip?: Clip | null;
  clipName?: string | null;
  protectedKeys?: ProtectedKey[];
}

export interface ApplyClipOutcome {
  clip: Clip;
  structural: string;
  restoredCount: number;
}

/**
 * Apply an `AnimateResult` (a clip plus optional structural rig changes) to `doc`, which
 * MUST already be installed as `state.doc` by the caller (`mcp/sessions.ts`'s
 * `withSessionMutation`) — `applyRigChanges`/`activeClip` read/write that singleton, same
 * as the editor's own call sites.
 */
export function applyClipHeadless(
  doc: RigDoc,
  result: AnimateResult,
  mode: 'new' | 'modify',
  opts: ApplyClipOptions = {},
): ApplyClipOutcome {
  const { labelToId, notes } = applyStructuralRigChanges(doc, result.rig);
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
  } else {
    const target = opts.clip ?? activeClip();
    if (!target) throw new McpToolError('No clip to modify — the session doc has no clips.');
    clip = target;
    clip.duration = result.clip.duration;
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

/**
 * apply_clip: validate a structured clip with the SAME clamp path the in-app AI
 * assistant uses (`ai/claude.ts`'s `clampRawClip` — duration pin + the skinned sx/sy
 * drop), then apply it via `../applyClip`'s headless mirror of `panels/ai/apply.ts`.
 */
import { Clip, ProtectedKey, RigChanges, RigDoc } from '../../core/model';
import { AnimateResult, clampRawClip, RawClip } from '../../ai/claude';
import { applyClipHeadless } from '../applyClip';
import { McpToolError } from '../errors';
import { withSessionMutation } from '../sessions';

const DEFAULT_SESSION = 'default';

export interface ApplyClipInput {
  name: string;
  duration: number;
  clipName?: string;
  tracks: { target: string; channel: string; keyframes: { time: number; value: number; easing: string; bezier?: [number, number, number, number] | null }[] }[];
  rig?: RigChanges;
}

export interface ApplyClipParams {
  clip: ApplyClipInput;
  mode: 'new' | 'replace';
  targetClipName?: string;
  protectedKeys?: ProtectedKey[];
  session?: string;
}

function skinnedLabelsOf(doc: RigDoc): Set<string> {
  return new Set(doc.parts.filter((p) => p.skin && p.skin.bones.length > 0).map((p) => p.label));
}

export function handleApplyClip(params: ApplyClipParams) {
  const session = params.session ?? DEFAULT_SESSION;
  return withSessionMutation(session, (doc) => {
    const raw = params.clip as RawClip & { rig?: RigChanges | null };
    // clampRawClip is the SAME clamp the in-app assistant's apply path runs before
    // resolveTracks ever sees the response — see ai/claude.ts's animateWithClaude.
    const { clip: clamped, clampedCount } = clampRawClip(raw, params.clip.duration, skinnedLabelsOf(doc));
    const result: AnimateResult = {
      clip: clamped,
      rig: params.clip.rig ?? null,
      clampedCount,
    };

    let targetClip: Clip | null = null;
    if (params.mode === 'replace') {
      const wanted = params.targetClipName ?? doc.clips[0]?.name;
      targetClip = doc.clips.find((c) => c.name === wanted) ?? null;
      if (!targetClip) {
        throw new McpToolError(
          `mode "replace" needs an existing clip — targetClipName ` +
            `${params.targetClipName ? `"${params.targetClipName}"` : '(defaulted to the first clip)'} ` +
            `did not match any of: ${doc.clips.map((c) => c.name).join(', ') || '(none)'}`,
        );
      }
    }

    const outcome = applyClipHeadless(
      doc,
      result,
      params.mode === 'new' ? 'new' : 'modify',
      { clip: targetClip, clipName: params.clip.clipName, protectedKeys: params.protectedKeys },
    );

    return {
      session,
      clipName: outcome.clip.name,
      duration: outcome.clip.duration,
      trackCount: outcome.clip.tracks.length,
      clampedCount,
      structural: outcome.structural,
      restoredProtectedKeys: outcome.restoredCount,
    };
  });
}

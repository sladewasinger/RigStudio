/**
 * AI Animate System v2 A5: the pure RIG PROFILE request-block builder — the second
 * leaf sibling of `ai/claude.ts` following `ai/threads.ts`'s pattern (claude.ts is
 * grandfathered at its size-ratchet ceiling and may not grow; per-request text
 * assembly lives in leaf modules that `panels/ai/requests.ts` prepends to the user's
 * instruction, so the frozen request contract needs zero changes).
 *
 * The block is deliberately COMPACT (a handful of lines, labels only — no ids, no
 * coordinates; the scene JSON already carries exact data) and self-deprecating: it
 * announces itself as heuristic so the model treats the scene JSON/tree as ground
 * truth when they disagree. Empty profile (no parts) returns '' — the caller skips
 * prepending anything, mirroring `buildThreadContextBlock`.
 */
import { PartRole, RigProfile } from './rigProfile';

/** Roles worth telling the model about — 'part' is the "no guess" fallback and would
 *  only add noise. */
const NAMED_ROLES: PartRole[] = ['torso', 'head', 'face', 'limb', 'shadow', 'prop'];

export function buildRigProfileBlock(profile: RigProfile): string {
  const lines: string[] = [];
  // Chain-deformed (skinned) parts get a "bone-driven" tag on their role line and their
  // chain spelled as the POSING HANDLES (2026-07-12 skinned-pose ruling): the model must
  // read a deformed part as posed via its bones, never as a free-standing rigid part.
  const deformedIds = new Set(profile.chains.flatMap((c) => c.deforms.map((d) => d.id)));
  if (profile.figureGroup) {
    lines.push(`- figure group (whole-figure target): ${profile.figureGroup.label}`);
  }
  for (const role of NAMED_ROLES) {
    const labels = profile.roles
      .filter((r) => r.role === role)
      .map((r) => (deformedIds.has(r.id) ? `${r.label} (bone-driven)` : r.label));
    if (labels.length > 0) lines.push(`- ${role}: ${labels.join(', ')}`);
  }
  for (const pair of profile.symmetryPairs) {
    lines.push(
      `- symmetry pair: ${pair.left.label} <-> ${pair.right.label}` +
        `${pair.mirrored ? ' (mirrored transforms)' : ''}`,
    );
  }
  for (const ch of profile.chains) {
    const spine = ch.bones.map((b) => b.label).join(' -> ');
    const deformLabels = ch.deforms.map((d) => d.label).join(', ');
    const deforming = ch.deforms.length > 0 ? `, deforming ${deformLabels}` : '';
    const handles = ch.deforms.length > 0
      ? ` — the POSING HANDLES for ${deformLabels}: key rotate on these bones, root-first, to bend ${
        ch.deforms.length === 1 ? 'it' : 'them'}`
      : '';
    lines.push(
      `- bone chain: ${spine} (${ch.bones.length} bone${ch.bones.length === 1 ? '' : 's'}, ` +
        `total length ${ch.totalLength}${deforming})${handles}`,
    );
  }
  if (lines.length === 0) return '';
  return [
    'RIG PROFILE (auto-derived, heuristic — trust the scene JSON/tree when they disagree):',
    ...lines,
    'Use the roles to resolve vague direction, symmetry pairs for coordinated or ' +
      'counter-phase limb motion, and bone chains for bending and follow-through targets.',
  ].join('\n');
}

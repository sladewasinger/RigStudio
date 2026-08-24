import { checkpoint } from '../core/history';
import {
  notify, RigPart, SkinBone, SkinInfluenceProfile, state, selectPart,
} from '../core/model';
import {
  autoInfluenceProfile, expandBindTarget, normalizeInfluenceProfile,
} from '../geometry/skin';
import { ctx, syncBonePlacementSurface } from './context';
import { invalidateSkinCache } from './skinRender';
import { renderPose } from './render';

export interface InfluenceTarget {
  target: RigPart;
  arts: RigPart[];
  bones: SkinBone[];
  profile: SkinInfluenceProfile;
  selectedBand?: number;
}

export function influenceTargetFor(part: RigPart | null): InfluenceTarget | null {
  const doc = state.doc;
  if (!doc || !part) return null;
  const arts = expandBindTarget(doc.parts, part).filter((candidate) => candidate.skin);
  const first = arts[0]?.skin;
  if (!first) return null;
  const signature = first.bones.map((bone) => bone.id).join('|');
  const coordinated = arts.filter((candidate) =>
    candidate.skin?.bones.map((bone) => bone.id).join('|') === signature,
  );
  if (coordinated.length === 0) return null;
  const profile = normalizeInfluenceProfile(part.influenceProfile, first.bones);
  if (profile.bands.length === 0) return null;
  return { target: part, arts: coordinated, bones: first.bones, profile };
}

export function activeInfluenceTarget(): InfluenceTarget | null {
  const doc = state.doc;
  const session = ctx.influenceSession;
  if (!doc || !session) return null;
  const target = doc.parts.find((part) => part.id === session.targetId) ?? null;
  const resolved = influenceTargetFor(target);
  return resolved ? { ...resolved, profile: session.draft, selectedBand: session.selectedBand } : null;
}

function invalidateTarget(targetId: string): void {
  const doc = state.doc;
  const target = doc?.parts.find((part) => part.id === targetId);
  if (!doc || !target) return;
  for (const art of expandBindTarget(doc.parts, target)) invalidateSkinCache(art.id);
}

export function beginInfluenceEditing(part: RigPart): boolean {
  const target = influenceTargetFor(part);
  if (!target || state.editorMode !== 'setup') return false;
  ctx.placingBone = false;
  ctx.boneChain = null;
  syncBonePlacementSurface();
  ctx.drag = null;
  state.mode = 'rig';
  state.tool = 'select';
  state.freezeMode = false;
  ctx.influenceSession = {
    targetId: part.id,
    draft: structuredClone(target.profile),
    selectedBand: 0,
  };
  invalidateTarget(part.id);
  notify();
  renderPose();
  return true;
}

export function applyInfluenceEditing(): boolean {
  const session = ctx.influenceSession;
  const doc = state.doc;
  const target = doc?.parts.find((part) => part.id === session?.targetId);
  if (!session || !target) return false;
  const next = normalizeInfluenceProfile(session.draft, influenceTargetFor(target)?.bones ?? []);
  const prior = target.influenceProfile ?? null;
  const changed = JSON.stringify(prior) !== JSON.stringify(next);
  if (changed) {
    checkpoint();
    target.influenceProfile = structuredClone(next);
  }
  ctx.influenceSession = null;
  invalidateTarget(target.id);
  notify();
  renderPose();
  return changed;
}

export function cancelInfluenceEditing(): void {
  const id = ctx.influenceSession?.targetId;
  if (!id) return;
  ctx.influenceSession = null;
  invalidateTarget(id);
  notify();
  renderPose();
}

export function resetInfluenceEditing(): void {
  const active = activeInfluenceTarget();
  if (!active || !ctx.influenceSession) return;
  ctx.influenceSession.draft = autoInfluenceProfile(active.bones);
  ctx.influenceSession.selectedBand = 0;
  invalidateTarget(active.target.id);
  notify();
  renderPose();
}

export function updateInfluenceBand(
  index: number, patch: Partial<{ center: number; width: number }>,
): void {
  const active = activeInfluenceTarget();
  const session = ctx.influenceSession;
  const band = session?.draft.bands[index];
  if (!active || !session || !band) return;
  Object.assign(band, patch);
  session.draft = normalizeInfluenceProfile(session.draft, active.bones);
  session.selectedBand = Math.min(index, session.draft.bands.length - 1);
  invalidateTarget(active.target.id);
  renderPose();
}

export function refineInfluenceNodes(): void {
  const active = activeInfluenceTarget();
  if (!active) return;
  applyInfluenceEditing();
  const art = active.arts[0];
  selectPart(art.id);
  state.mode = 'nodes';
  notify();
  renderPose();
}

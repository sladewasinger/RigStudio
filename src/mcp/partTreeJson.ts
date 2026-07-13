/**
 * A nested, JSON-friendly part tree for `import_svg`'s/`list_parts`'s tool results — the
 * MCP-shaped counterpart to `headless/partTree.ts`'s indented-text `partTreeSummary`
 * (that one is CLI stdout, not reused here so a client gets structured data instead of a
 * string to re-parse).
 */
import { boneChain, boneLength, RigDoc, RigPart } from '../core/model';

export interface PartTreeNode {
  id: string;
  label: string;
  kind: RigPart['kind'];
  pathCount: number;
  skinned: boolean;
  hidden: boolean;
  children: PartTreeNode[];
}

export function buildPartTree(doc: RigDoc): PartTreeNode[] {
  const byParent = new Map<string | null, RigPart[]>();
  for (const part of doc.parts) {
    const siblings = byParent.get(part.parentId) ?? [];
    siblings.push(part);
    byParent.set(part.parentId, siblings);
  }
  const nodeOf = (part: RigPart): PartTreeNode => ({
    id: part.id,
    label: part.label,
    kind: part.kind,
    pathCount: part.paths.length,
    skinned: !!part.skin && part.skin.bones.length > 0,
    hidden: !!part.hidden,
    children: (byParent.get(part.id) ?? []).map(nodeOf),
  });
  return (byParent.get(null) ?? []).map(nodeOf);
}

export interface SkinnedPartSummary {
  id: string;
  label: string;
  bones: { id: string; label: string }[];
}

/** Every skinned part plus its controlling bone chain (root-first), for `list_parts`'
 *  posing-handles summary — mirrors `ai/claude.ts`'s `controllingBones`. */
export function buildSkinnedPartSummaries(doc: RigDoc): SkinnedPartSummary[] {
  const out: SkinnedPartSummary[] = [];
  for (const part of doc.parts) {
    if (!part.skin || part.skin.bones.length === 0) continue;
    const inChain = new Set<string>();
    for (const sb of part.skin.bones) {
      for (const b of boneChain(doc.parts, sb.id)) inChain.add(b.id);
    }
    const bones = doc.parts.filter((p) => inChain.has(p.id)).map((p) => ({ id: p.id, label: p.label }));
    out.push({ id: part.id, label: part.label, bones });
  }
  return out;
}

export interface BoneChainSummary {
  rootId: string;
  rootLabel: string;
  bones: { id: string; label: string; length: number }[];
}

/** Every distinct bone chain in the doc (one entry per root bone), for `list_parts`. */
export function buildBoneChainSummaries(doc: RigDoc): BoneChainSummary[] {
  const isBone = (p: RigPart | undefined): p is RigPart => !!p && p.kind === 'bone';
  const byId = new Map(doc.parts.map((p) => [p.id, p]));
  const roots = doc.parts.filter((p) => isBone(p) && !isBone(p.parentId ? byId.get(p.parentId) : undefined));
  return roots.map((root) => ({
    rootId: root.id,
    rootLabel: root.label,
    bones: boneChain(doc.parts, root.id).map((b) => ({ id: b.id, label: b.label, length: boneLength(b) })),
  }));
}

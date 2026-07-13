import { RigDoc, RigPart } from '../core/model';

/**
 * Indented label/kind/path-count tree, root parts first, children nested under their
 * parent (mirroring the Layers panel's own nesting rule) — used by `rig import`'s
 * stdout summary so a human/agent can sanity-check the imported hierarchy without
 * opening the editor.
 */
export function partTreeSummary(doc: RigDoc): string {
  const byParent = new Map<string | null, RigPart[]>();
  for (const part of doc.parts) {
    const siblings = byParent.get(part.parentId) ?? [];
    siblings.push(part);
    byParent.set(part.parentId, siblings);
  }
  const lines: string[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const part of byParent.get(parentId) ?? []) {
      const paths = part.paths.length;
      const pathNote = paths > 0 ? ` (${paths} path${paths === 1 ? '' : 's'})` : '';
      lines.push(`${'  '.repeat(depth)}${part.label} [${part.kind}]${pathNote}`);
      walk(part.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join('\n');
}

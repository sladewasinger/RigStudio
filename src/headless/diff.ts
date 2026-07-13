/**
 * Minimal structural diff over JSON-compatible values. Used by `rig validate` to
 * summarize what `normalizeDoc` changed between a project file's raw parsed JSON and
 * the normalized doc — deliberately generic (no RigDoc-specific knowledge): plain
 * object/array recursion, leaf comparison by value (via JSON.stringify, so it treats
 * e.g. `undefined` and a missing key the same way normalizeDoc's own back-compat
 * filling would want reported: "this field now has a value").
 */
export interface DiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function diffJson(before: unknown, after: unknown, path = '$'): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk(before, after, path, out);
  return out;
}

function walk(before: unknown, after: unknown, path: string, out: DiffEntry[]): void {
  if (before === after) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const len = Math.max(before.length, after.length);
    for (let i = 0; i < len; i++) walk(before[i], after[i], `${path}[${i}]`, out);
    return;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) walk(before[k], after[k], `${path}.${k}`, out);
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ path, before, after });
}

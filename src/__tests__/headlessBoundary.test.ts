/**
 * H1a/H2 boundary test: neither `src/headless/`'s nor `src/mcp/`'s module graph may ever
 * reach `src/view`, `src/panels`, `src/timeline`, or `src/ui` — those folders are
 * DOM/canvas-coupled, and both the headless package and the MCP server exist precisely so
 * agents/scripts can use the rig model and exporters without dragging the editor along
 * (see `src/headless/index.ts`'s and `src/mcp/createServer.ts`'s headers). Walks real
 * import specifiers from every file under each root, resolving relative imports on disk
 * (same spirit as `architecture.test.ts`'s filesystem-only approach — no bundler/type
 * info needed for this check). The walk is ROOT-SCOPED (each root's reachable set is
 * checked independently, starting only from that root's own files) so a violation in one
 * root's graph can't be masked by the other root happening to already be clean.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const SRC = join(__dirname, '..');
const ROOTS = [join(SRC, 'headless'), join(SRC, 'mcp')];
const FORBIDDEN = new Set(['view', 'panels', 'timeline', 'ui']);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every bare `from '...'` / `import '...'` / `require('...')` specifier in a file. */
function importSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const re = /\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  const specs = new Set<string>();
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(text))) specs.add(m[1] ?? m[2] ?? m[3]);
  return [...specs];
}

/** Resolve a relative specifier to a source file on disk, or null for a package import
 *  (bare specifiers like 'jsdom'/'node:fs' are external — nothing under those names
 *  could ever be src/view etc., so they don't need traversing). */
function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && !statSync(candidate).isDirectory()) return candidate;
  }
  return null;
}

describe('headless boundary: never reaches view/panels/timeline/ui', () => {
  for (const root of ROOTS) {
    const rootName = relative(SRC, root).split(sep).join('/');

    it(`the whole reachable module graph from src/${rootName}/ stays out of the editor folders`, () => {
      const visited = new Set<string>();
      const queue = listTsFiles(root);
      const violations: string[] = [];

      while (queue.length > 0) {
        const file = queue.pop()!;
        if (visited.has(file)) continue;
        visited.add(file);

        const rel = relative(SRC, file).split(sep).join('/');
        const topFolder = rel.split('/')[0];
        if (FORBIDDEN.has(topFolder)) {
          violations.push(rel);
          continue;
        }
        for (const spec of importSpecifiers(file)) {
          const resolved = resolveRelative(file, spec);
          if (resolved && !visited.has(resolved)) queue.push(resolved);
        }
      }

      expect(violations, violations.join('\n')).toEqual([]);
      // Sanity: the walk actually left the root and pulled in core/geometry/io — an
      // empty or root-only visited set would make the assertion above vacuous.
      const reachedOutside = [...visited].some((f) => !f.startsWith(root));
      expect(reachedOutside).toBe(true);
      expect(visited.size).toBeGreaterThan(15);
    });
  }
});

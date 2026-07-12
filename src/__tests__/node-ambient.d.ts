/**
 * Minimal ambient types for the handful of Node builtins `architecture.test.ts` uses
 * (`node:fs`/`node:path`/`__dirname`). The project has no `@types/node` dependency
 * (package.json is off-limits to this wave — "never touch" per the task brief), so
 * `tsc --noEmit` can't resolve these without a local declaration. Vitest's own runtime
 * (Node) provides the real implementations; this file only satisfies the type-checker.
 * Scoped to exactly what's used — not a general-purpose `@types/node` replacement.
 */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function statSync(path: string): { isDirectory(): boolean };
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function relative(from: string, to: string): string;
  export const sep: string;
}

declare const __dirname: string;

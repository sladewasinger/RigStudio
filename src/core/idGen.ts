/**
 * Fresh id minting, shared by every module that creates parts/paths/state-machine
 * objects. Kept dependency-free (no imports) so it sits at the bottom of the
 * `core/` module graph — everything else may import it without risking a cycle.
 */

let idCounter = 0;
export function freshId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

/** Keep freshId ahead of ids present in a loaded document. */
export function bumpIdCounter(min: number): void {
  if (min > idCounter) idCounter = min;
}

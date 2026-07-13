/**
 * Headless SVG import. `io/importSvg.ts` calls the global `DOMParser` unchanged — it
 * needs a real DOM tree (`documentElement`/`children`/`getAttribute[NS]`), not a fork
 * of its parsing logic. That global exists in a browser and in the unit suite's jsdom
 * environment; a bare Node process (this package's real runtime) has none, so this
 * module constructs a throwaway jsdom window and installs its `DOMParser` onto
 * `globalThis` for the duration of the call only, restoring whatever was there before.
 *
 * This mirrors `scripts/exportPipTakePill.ts`'s `ensureDomParser`, but scoped rather
 * than a permanent process-wide polyfill: `importSvgHeadless` may be called repeatedly
 * inside a longer-lived process (an agent's shell session), not just a one-shot script,
 * so leaving a stray global mutation around — or clobbering a real DOMParser a host
 * process already set up — would be an avoidable side effect.
 */
import { JSDOM } from 'jsdom';
import { RigDoc } from '../core/model';
import { importSvg } from '../io/importSvg';

export function importSvgHeadless(svgText: string, name: string): RigDoc {
  const target = globalThis as { DOMParser?: unknown };
  const previous = target.DOMParser;
  target.DOMParser = new JSDOM().window.DOMParser;
  try {
    return importSvg(svgText, name);
  } finally {
    target.DOMParser = previous;
  }
}

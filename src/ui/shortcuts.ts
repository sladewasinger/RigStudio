/**
 * The keyboard-shortcut ENGINE: the early ownership guards (unchanged from the
 * pre-redesign main.ts, ported verbatim) plus the dispatch loop that walks `REGISTRY`
 * (concatenated from `shortcutBindings.ts` + `shortcutBindingsTools.ts`) and runs the
 * first matching entry. `installShortcuts()` is main.ts's ENTIRE keyboard wiring —
 * main.ts just calls it once at bootstrap.
 *
 * See `shortcutBindings.ts` for the registry's design (data), `shortcutCascades.ts` for
 * the two Chain-of-Responsibility tier lists the Delete/Escape entries walk, and
 * `shortcutActions.ts` for the two actions shared with toolbar buttons.
 */

import { state } from '../core/model';
import { isMenuOpen, closeMenu } from './contextMenu';
import { isDialogOpen, closeActiveDialog } from './dialogs';
import { isHelpOpen, closeHelp } from './help';
import { FILE_EDIT_BINDINGS, KeyPattern, ShortcutBinding } from './shortcutBindings';
import { TOOLS_VIEW_BINDINGS } from './shortcutBindingsTools';

export const REGISTRY: ShortcutBinding[] = [...FILE_EDIT_BINDINGS, ...TOOLS_VIEW_BINDINGS];

export { setEditorMode, saveProject } from './shortcutActions';
export { DELETE_HANDLERS, ESCAPE_HANDLERS } from './shortcutCascades';
export type { ShortcutBinding, KeyPattern, ShortcutHelp, ModReq } from './shortcutBindings';

function matchesPattern(p: KeyPattern, ev: KeyboardEvent): boolean {
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  if (k !== p.key) return false;
  if (p.ctrl !== undefined && (ev.ctrlKey || ev.metaKey) !== p.ctrl) return false;
  if (p.shift !== undefined && ev.shiftKey !== p.shift) return false;
  if (p.alt !== undefined && ev.altKey !== p.alt) return false;
  return true;
}

function matchesBinding(b: ShortcutBinding, ev: KeyboardEvent): boolean {
  if (b.mode && state.editorMode !== b.mode) return false;
  return b.patterns.some((p) => matchesPattern(p, ev));
}

/** Wires the single global keydown listener. Idempotent guard is unnecessary — main.ts
 *  calls this exactly once at bootstrap, same as the pre-redesign code's one listener. */
export function installShortcuts(): void {
  document.addEventListener('keydown', (ev) => {
    const target = ev.target as HTMLElement;

    // ---- Early ownership guards (order matters; each is documented) ----

    // 1. A context menu or dialog owns Escape first — this must win over every other
    //    tier below, INCLUDING the input-focus guard right after it, so Escape closes a
    //    dialog even while its own text field has focus (mirrors the help-overlay
    //    precedence, one level higher since a dialog can itself contain an input).
    if (ev.key === 'Escape' && (isMenuOpen() || isDialogOpen())) {
      ev.preventDefault();
      closeMenu();
      closeActiveDialog();
      return;
    }
    // 2. While a menu or dialog is open, no other shortcut should leak through to the
    //    app underneath (e.g. Ctrl+S while the save-filename dialog itself is showing).
    if (isMenuOpen() || isDialogOpen()) return;
    // 3. Typing in a form field blocks every shortcut below.
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    // 4. Help overlay owns Escape while it's open — this must win over every registry
    //    entry below (incl. the Escape cascade) so closing it never also fires a tier.
    if (isHelpOpen() && ev.key === 'Escape') {
      ev.preventDefault();
      closeHelp();
      return;
    }

    // ---- The registry ----
    for (const binding of REGISTRY) {
      if (matchesBinding(binding, ev)) {
        binding.run(ev);
        return;
      }
    }
  });
}

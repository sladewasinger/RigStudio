/**
 * Positioned right-click context menu — shared by the Layers panel (layer/path rows) and
 * the canvas (artwork/path hit-testing), each of which builds its own item list and calls
 * `showContextMenu`. Only one menu is open at a time; opening a second closes the first
 * ("Move to part…" reuses this for its destination picker, opened ON TOP of the menu it
 * was clicked from — the same one-at-a-time rule closes the first automatically).
 *
 * Closes on Escape, a click/pointerdown anywhere outside the menu, or scrolling any
 * ancestor (capture-phase 'scroll' — scrollable panels like #layers don't bubble their
 * scroll events, so this is the only way to catch it generically). Does NOT import
 * './ui.css' itself — dialogs.ts already pulls it in, and every page that can open a
 * context menu also has main.ts (which imports dialogs.ts) on the page.
 *
 * SUPPRESSION CHOKEPOINT (Context-menu polish, 2026-07-13): a single capture-phase
 * `contextmenu` listener on `document`, installed as a MODULE SIDE EFFECT below, is the
 * ONLY place `preventDefault()` is called for the native browser menu. Capture-phase on
 * `document` fires before any element's own `contextmenu` handler (capture travels
 * document → target, target/bubble phases come after), so canvas/layer-row/path-row
 * listeners built on top of `showContextMenu` never need to (and must not) call
 * `preventDefault()` themselves — this is the one door. Where no in-app menu claims the
 * event, nothing else runs, so the native menu simply never appears (rather than a plain
 * blank space where it used to). EXCEPTION: text-entry elements (input/textarea/
 * contenteditable — the AI prompt box, the API-key field, layer/path inline-rename
 * inputs, every ui/dialogs.ts field) are left alone, so right-click copy/paste keeps
 * working there.
 */
function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return true;
  return el.isContentEditable === true;
}

document.addEventListener('contextmenu', (ev) => {
  if (isTextEntry(ev.target)) return;
  ev.preventDefault();
}, true);

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Draw a divider above this item. */
  separatorBefore?: boolean;
}

let menuEl: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

export function isMenuOpen(): boolean {
  return menuEl !== null;
}

export function closeMenu(): void {
  cleanup?.();
}

export function showContextMenu(items: ContextMenuItem[], clientX: number, clientY: number): void {
  closeMenu();
  if (items.length === 0) return;

  const menu = document.createElement('div');
  menu.className = 'ui-context-menu';
  menu.setAttribute('role', 'menu');

  for (const item of items) {
    if (item.separatorBefore) {
      const sep = document.createElement('div');
      sep.className = 'ui-context-menu-sep';
      menu.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ui-context-menu-item';
    btn.textContent = item.label;
    btn.disabled = !!item.disabled;
    btn.setAttribute('role', 'menuitem');
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeMenu();
      item.onSelect();
    });
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  menuEl = menu;

  // Position, then clamp so it stays fully on screen (measured after layout).
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  const rect = menu.getBoundingClientRect();
  const overflowX = rect.right - window.innerWidth;
  const overflowY = rect.bottom - window.innerHeight;
  if (overflowX > 0) menu.style.left = `${Math.max(0, clientX - overflowX)}px`;
  if (overflowY > 0) menu.style.top = `${Math.max(0, clientY - overflowY)}px`;

  const onPointerDown = (ev: PointerEvent) => {
    if (!menu.contains(ev.target as Node)) closeMenu();
  };
  const onKeydown = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeMenu();
    }
  };
  const onScroll = () => closeMenu();

  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll);

  cleanup = () => {
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    menu.remove();
    menuEl = null;
    cleanup = null;
  };
}

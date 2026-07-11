/**
 * Positioned right-click context menu — shared by the Layers panel (layer rows) and the
 * canvas (artwork hit-testing), each of which builds its own item list and calls
 * `showContextMenu`. Only one menu is open at a time; opening a second closes the first.
 *
 * Closes on Escape, a click/pointerdown anywhere outside the menu, or scrolling any
 * ancestor (capture-phase 'scroll' — scrollable panels like #layers don't bubble their
 * scroll events, so this is the only way to catch it generically). Does NOT import
 * './ui.css' itself — dialogs.ts already pulls it in, and every page that can open a
 * context menu also has main.ts (which imports dialogs.ts) on the page.
 */

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

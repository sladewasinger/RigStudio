/**
 * Inline SVG icon set (stroke = currentColor) shared by the canvas-tools bar and the
 * inspector's align/distribute grid.
 */

// ---- Icons (inline SVG, stroke = currentColor) ----

export const ICON_PATHS: Record<string, string> = {
  select: '<path d="M4 2 L12.5 8 L8.7 8.9 L10.6 13.4 L8.7 14.2 L6.8 9.7 L4 12 Z" fill="currentColor" stroke="none"/>',
  translate: '<path d="M8 1.5v13M1.5 8h13M8 1.5l-2 2M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2"/>',
  rotate: '<path d="M13.5 8a5.5 5.5 0 1 1-2-4.2"/><path d="M11.2 1.6l0.4 2.5-2.5 0.3" />',
  ik: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3"/>',
  flipH: '<path d="M8 1.5v13" stroke-dasharray="2 1.6"/><path d="M6 4.5L2 8l4 3.5zM10 4.5L14 8l-4 3.5z" fill="currentColor" stroke="none"/>',
  flipV: '<path d="M1.5 8h13" stroke-dasharray="2 1.6"/><path d="M4.5 6L8 2l3.5 4zM4.5 10L8 14l-3.5-4z" fill="currentColor" stroke="none"/>',
  group: '<rect x="2" y="2" width="8" height="8" rx="1"/><rect x="6" y="6" width="8" height="8" rx="1"/>',
  ungroup: '<rect x="2" y="2" width="7" height="7" rx="1"/><rect x="7" y="7" width="7" height="7" rx="1" stroke-dasharray="2 1.6"/><path d="M12 2l2 2M14 2l-2 2"/>',
  bone: '<path d="M3.4 3.4 L11 6.6 L12.6 12.6 L6.6 11 Z M3.4 3.4a1.6 1.6 0 1 0 .1.1" fill="currentColor" stroke="none" fill-opacity="0.85"/>',
  bind: '<path d="M3 13c2-5 3-8 5-11M8 13c1.5-3.5 2.5-6 4-9" /><path d="M2.5 6h11M4 10h9" stroke-dasharray="1.6 1.4"/>',
  alignL: '<path d="M2 2v12"/><rect x="4" y="3.5" width="8" height="3" fill="currentColor" stroke="none"/><rect x="4" y="9.5" width="5" height="3" fill="currentColor" stroke="none"/>',
  alignCH: '<path d="M8 2v12"/><rect x="3" y="3.5" width="10" height="3" fill="currentColor" stroke="none"/><rect x="5" y="9.5" width="6" height="3" fill="currentColor" stroke="none"/>',
  alignR: '<path d="M14 2v12"/><rect x="4" y="3.5" width="8" height="3" fill="currentColor" stroke="none"/><rect x="7" y="9.5" width="5" height="3" fill="currentColor" stroke="none"/>',
  alignT: '<path d="M2 2h12"/><rect x="3.5" y="4" width="3" height="8" fill="currentColor" stroke="none"/><rect x="9.5" y="4" width="3" height="5" fill="currentColor" stroke="none"/>',
  alignM: '<path d="M2 8h12"/><rect x="3.5" y="3" width="3" height="10" fill="currentColor" stroke="none"/><rect x="9.5" y="5" width="3" height="6" fill="currentColor" stroke="none"/>',
  alignB: '<path d="M2 14h12"/><rect x="3.5" y="4" width="3" height="8" fill="currentColor" stroke="none"/><rect x="9.5" y="7" width="3" height="5" fill="currentColor" stroke="none"/>',
  distH: '<path d="M2 2v12M14 2v12"/><rect x="6" y="5" width="4" height="6" fill="currentColor" stroke="none"/>',
  distV: '<path d="M2 2h12M2 14h12"/><rect x="5" y="6" width="6" height="4" fill="currentColor" stroke="none"/>',
  snap: '<path d="M4 2.5v4.5a4 4 0 0 0 8 0V2.5"/><path d="M2.4 2.5h3.2M10.4 2.5h3.2"/>',
};

/** An inline 16×16 line icon; falls back to the raw name for unknown keys. */
export function icon(name: keyof typeof ICON_PATHS): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML =
    `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" ` +
    `stroke="currentColor" stroke-width="1.4" stroke-linecap="round" ` +
    `stroke-linejoin="round">${ICON_PATHS[name] ?? ''}</svg>`;
  return span;
}

export function iconButton(
  name: keyof typeof ICON_PATHS, label: string, title: string, onClick: () => void,
): HTMLButtonElement {
  const b = document.createElement('button');
  b.appendChild(icon(name));
  if (label) {
    const t = document.createElement('span');
    t.textContent = label;
    b.appendChild(t);
  }
  b.title = title;
  b.onclick = onClick;
  b.classList.add('icon-btn');
  return b;
}

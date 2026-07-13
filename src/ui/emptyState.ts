/**
 * Empty-state call-to-action (Category B item 5): shown by the Layers/Inspector panels
 * and the canvas when `state.doc` is null. Proxy-clicks the REAL toolbar buttons
 * (`btn-open`/`btn-sample`/`btn-new`) rather than duplicating their logic (the unsaved-
 * changes guard, file-picker wiring, etc. all live in main.ts) — this module owns no
 * doc-loading behavior of its own, just a friendly hint + three buttons wired to
 * whatever the toolbar already does. A no-op if a button id isn't present (e.g. a
 * stripped-down test shell).
 */

function proxyClick(targetId: string): void {
  (document.getElementById(targetId) as HTMLButtonElement | null)?.click();
}

/** Appends the empty-state block to `el` (does not clear existing content — callers
 *  keep owning their own header). */
export function buildEmptyState(el: HTMLElement, message: string): void {
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';

  const p = document.createElement('p');
  p.className = 'hint';
  p.textContent = message;
  wrap.appendChild(p);

  const actions = document.createElement('div');
  actions.className = 'empty-state-actions';
  const buttons: [string, string][] = [
    ['Open…', 'btn-open'],
    ['Load sample', 'btn-sample'],
    ['New project', 'btn-new'],
  ];
  for (const [label, targetId] of buttons) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.onclick = () => proxyClick(targetId);
    actions.appendChild(b);
  }
  wrap.appendChild(actions);

  el.appendChild(wrap);
}

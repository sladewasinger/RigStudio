/**
 * In-app modal dialogs — a promise-based replacement for window.alert/confirm/prompt.
 *
 * One dialog is on screen at a time; calls made while another is open queue and open in
 * order once it resolves. Every dialog closes the same three ways — Escape, a backdrop
 * click, or the ✕ button — and all three resolve the SAME "cancelled" value (null at the
 * primitive level; the typed wrappers below map that to false for confirm() and null for
 * prompt()/form()). Enter submits (from any field, not just the last one) unless focus is
 * on a multi-line textarea. Focus is trapped inside the card and restored to whatever had
 * it beforehand on close.
 *
 * This module never reads `state.doc` — it's a generic UI primitive usable regardless of
 * whether a document is loaded, so callers (main.ts) are free to open it from any code
 * path without a null-doc guard.
 */

import './ui.css';

let openCard: HTMLElement | null = null;
let activeCancel: (() => void) | null = null;

/** Whether a dialog is currently on screen — main.ts's keydown handler checks this so
 *  Escape closes the dialog instead of falling through to another tier (bone placement /
 *  group exit / deselect), the same way it already special-cases the help overlay. */
export function isDialogOpen(): boolean {
  return openCard !== null;
}

/** Cancel whatever dialog is open (same effect as the user pressing Escape). No-op if
 *  none is open. Exposed so main.ts's central Escape arbitration can close a dialog even
 *  when the event was dispatched straight at `document` (bypassing the card's own
 *  bubbling Escape handler — synthetic test events sometimes do this). */
export function closeActiveDialog(): void {
  activeCancel?.();
}

function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'input, textarea, select, button, [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
}

let queue: Promise<void> = Promise.resolve();

/** Serialize dialog opens so a second call made while one is showing waits its turn
 *  instead of stacking backdrops. */
function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

interface ShellHandle {
  card: HTMLElement;
  body: HTMLElement;
  footer: HTMLElement;
  /** Resolve the dialog with `value` and tear down (idempotent). */
  finish: (value: unknown) => void;
  /** Register the element Enter should activate (defaults to the last footer button). */
  setPrimary: (el: HTMLElement) => void;
}

function openShell<T>(title: string, resolve: (value: T) => void): ShellHandle {
  const prevFocus = document.activeElement as HTMLElement | null;
  const backdrop = document.createElement('div');
  backdrop.className = 'ui-dialog-backdrop';

  const card = document.createElement('div');
  card.className = 'ui-dialog';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-label', title);
  backdrop.appendChild(card);

  const header = document.createElement('div');
  header.className = 'ui-dialog-header';
  const titleEl = document.createElement('h2');
  titleEl.textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'ui-dialog-close';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close (Esc)';
  header.append(titleEl, closeBtn);
  card.appendChild(header);

  const body = document.createElement('div');
  body.className = 'ui-dialog-body';
  card.appendChild(body);

  const footer = document.createElement('div');
  footer.className = 'ui-dialog-footer';
  card.appendChild(footer);

  let settled = false;
  let primaryEl: HTMLElement | null = null;
  const finish = (value: unknown) => {
    if (settled) return;
    settled = true;
    document.removeEventListener('keydown', onKeydown, true);
    backdrop.remove();
    openCard = null;
    activeCancel = null;
    prevFocus?.focus?.();
    resolve(value as T);
  };

  const onKeydown = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      finish(null);
      return;
    }
    if (ev.key === 'Enter' && (ev.target as HTMLElement)?.tagName !== 'TEXTAREA') {
      ev.preventDefault();
      ev.stopPropagation();
      (primaryEl ?? footer.lastElementChild as HTMLElement | null)?.click();
      return;
    }
    if (ev.key === 'Tab') {
      const focusables = getFocusable(card);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  };
  // Capture phase: this dialog's own Escape/Enter/Tab handling wins before the event can
  // reach main.ts's global keydown listener (which additionally guards on isDialogOpen()
  // for the rare case something dispatches straight at `document`, e.g. tests).
  document.addEventListener('keydown', onKeydown, true);

  backdrop.addEventListener('mousedown', (ev) => {
    if (ev.target === backdrop) finish(null);
  });
  closeBtn.addEventListener('click', () => finish(null));

  document.body.appendChild(backdrop);
  openCard = card;
  activeCancel = () => finish(null);

  queueMicrotask(() => {
    const focusables = getFocusable(card);
    (focusables[0] ?? card).focus();
  });

  return {
    card, body, footer, finish,
    setPrimary: (el) => { primaryEl = el; },
  };
}

function button(text: string, variant: 'default' | 'primary' = 'default'): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  if (variant === 'primary') b.classList.add('ui-dialog-primary');
  return b;
}

function paragraph(message: string): HTMLParagraphElement {
  const p = document.createElement('p');
  p.className = 'ui-dialog-message';
  p.textContent = message;
  return p;
}

// ---- Public API ----

function alertDialog(message: string, opts: { title?: string; okText?: string } = {}): Promise<void> {
  return runExclusive(() => new Promise<void>((resolve) => {
    const shell = openShell<void>(opts.title ?? 'Notice', () => resolve());
    shell.body.appendChild(paragraph(message));
    const ok = button(opts.okText ?? 'OK', 'primary');
    ok.addEventListener('click', () => shell.finish(undefined));
    shell.footer.appendChild(ok);
    shell.setPrimary(ok);
  }));
}

function confirmDialog(
  message: string,
  opts: { title?: string; okText?: string; cancelText?: string; danger?: boolean } = {},
): Promise<boolean> {
  return runExclusive(() => new Promise<boolean>((resolve) => {
    const shell = openShell<boolean | null>(opts.title ?? 'Confirm', (v) => resolve(v === true));
    shell.body.appendChild(paragraph(message));
    const cancel = button(opts.cancelText ?? 'Cancel');
    cancel.addEventListener('click', () => shell.finish(false));
    const ok = button(opts.okText ?? 'OK', 'primary');
    if (opts.danger) ok.classList.add('ui-dialog-danger');
    ok.addEventListener('click', () => shell.finish(true));
    shell.footer.append(cancel, ok);
    shell.setPrimary(ok);
  }));
}

function promptDialog(
  label: string,
  initial = '',
  opts: { title?: string; okText?: string; placeholder?: string } = {},
): Promise<string | null> {
  return runExclusive(() => new Promise<string | null>((resolve) => {
    const shell = openShell<string | null>(opts.title ?? label, (v) => resolve(v as string | null));
    const labelEl = document.createElement('label');
    labelEl.className = 'ui-dialog-field-label';
    labelEl.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = initial;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    labelEl.appendChild(input);
    shell.body.appendChild(labelEl);

    const cancel = button('Cancel');
    cancel.addEventListener('click', () => shell.finish(null));
    const ok = button(opts.okText ?? 'OK', 'primary');
    const submit = () => {
      const val = input.value.trim();
      shell.finish(val || null);
    };
    ok.addEventListener('click', submit);
    shell.footer.append(cancel, ok);
    shell.setPrimary(ok);

    queueMicrotask(() => { input.focus(); input.select(); });
  }));
}

export interface DialogFormField {
  name: string;
  label: string;
  value?: string;
  placeholder?: string;
}

function formDialog(
  title: string,
  fields: DialogFormField[],
  opts: { okText?: string } = {},
): Promise<Record<string, string> | null> {
  return runExclusive(() => new Promise<Record<string, string> | null>((resolve) => {
    const shell = openShell<Record<string, string> | null>(title, (v) => resolve(v as Record<string, string> | null));
    const inputs = new Map<string, HTMLInputElement>();
    for (const field of fields) {
      const labelEl = document.createElement('label');
      labelEl.className = 'ui-dialog-field-label';
      labelEl.textContent = field.label;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = field.value ?? '';
      if (field.placeholder) input.placeholder = field.placeholder;
      labelEl.appendChild(input);
      shell.body.appendChild(labelEl);
      inputs.set(field.name, input);
    }

    const cancel = button('Cancel');
    cancel.addEventListener('click', () => shell.finish(null));
    const ok = button(opts.okText ?? 'OK', 'primary');
    const submit = () => {
      const out: Record<string, string> = {};
      for (const [name, input] of inputs) out[name] = input.value.trim();
      shell.finish(out);
    };
    ok.addEventListener('click', submit);
    shell.footer.append(cancel, ok);
    shell.setPrimary(ok);

    queueMicrotask(() => { const first = [...inputs.values()][0]; first?.focus(); first?.select(); });
  }));
}

export const dialog = {
  alert: alertDialog,
  confirm: confirmDialog,
  prompt: promptDialog,
  form: formDialog,
};

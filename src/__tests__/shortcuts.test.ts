// @vitest-environment jsdom
/**
 * Registry-integrity tests for the keyboard-shortcut redesign (Pattern-driven redesign
 * pass, ROADMAP.md item 1): `ui/shortcutBindings.ts` + `ui/shortcutBindingsTools.ts`
 * hold the REGISTRY, `ui/shortcutCascades.ts` holds the two Chain-of-Responsibility
 * tier lists, `ui/help.ts` generates the "?" overlay's keyboard rows from them. These
 * tests pin the structural invariants the design depends on — jsdom (not plain node)
 * because the registry transitively imports view/panels/timeline, which touch `document`.
 */

import { describe, it, expect } from 'vitest';
import { FILE_EDIT_BINDINGS, KeyPattern, ShortcutBinding } from '../ui/shortcutBindings';
import { TOOLS_VIEW_BINDINGS } from '../ui/shortcutBindingsTools';
import { DELETE_HANDLERS, ESCAPE_HANDLERS } from '../ui/shortcutCascades';
import { groupedShortcuts } from '../ui/help';

const REGISTRY: ShortcutBinding[] = [...FILE_EDIT_BINDINGS, ...TOOLS_VIEW_BINDINGS];

function patternSignature(p: KeyPattern, mode: string | undefined): string {
  const f = (v: boolean | undefined) => (v === undefined ? 'x' : String(v));
  return `${p.key}|ctrl:${f(p.ctrl)}|shift:${f(p.shift)}|alt:${f(p.alt)}|mode:${mode ?? '-'}`;
}

describe('shortcut registry integrity', () => {
  it('finds a non-trivial registry (sanity)', () => {
    expect(REGISTRY.length).toBeGreaterThanOrEqual(25);
  });

  it('every entry has a unique id', () => {
    const ids = REGISTRY.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry has non-empty help metadata (keys/description/context)', () => {
    for (const b of REGISTRY) {
      expect(b.help.keys, `${b.id}.help.keys`).toBeTruthy();
      expect(b.help.description, `${b.id}.help.description`).toBeTruthy();
      expect(b.help.context, `${b.id}.help.context`).toBeTruthy();
    }
  });

  it('every entry has at least one pattern, and every pattern has a key', () => {
    for (const b of REGISTRY) {
      expect(b.patterns.length, `${b.id}.patterns`).toBeGreaterThan(0);
      for (const p of b.patterns) expect(p.key, `${b.id} pattern key`).toBeTruthy();
    }
  });

  it('no two entries share an identical key+modifier+mode signature', () => {
    const seen = new Map<string, string>(); // signature -> owning entry id
    const dupes: string[] = [];
    for (const b of REGISTRY) {
      for (const p of b.patterns) {
        const sig = patternSignature(p, b.mode);
        const owner = seen.get(sig);
        if (owner && owner !== b.id) dupes.push(`${sig} claimed by both "${owner}" and "${b.id}"`);
        else seen.set(sig, b.id);
      }
    }
    expect(dupes, dupes.join('\n')).toEqual([]);
  });

  it('DELETE_HANDLERS and ESCAPE_HANDLERS are non-empty with unique tier names', () => {
    for (const cascade of [DELETE_HANDLERS, ESCAPE_HANDLERS]) {
      expect(cascade.length).toBeGreaterThan(0);
      const names = cascade.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('the Delete cascade\'s generated help description mentions every tier, in order', () => {
    const entry = REGISTRY.find((b) => b.id === 'deleteCascade')!;
    expect(entry).toBeTruthy();
    let cursor = -1;
    for (const tier of DELETE_HANDLERS) {
      const idx = entry.help.description.indexOf(tier.short);
      expect(idx, `"${tier.short}" present in the deleteCascade help row`).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it('the Escape cascade\'s generated help description mentions every tier, in order', () => {
    const entry = REGISTRY.find((b) => b.id === 'escapeCascade')!;
    expect(entry).toBeTruthy();
    let cursor = -1;
    for (const tier of ESCAPE_HANDLERS) {
      const idx = entry.help.description.indexOf(tier.short);
      expect(idx, `"${tier.short}" present in the escapeCascade help row`).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it('the NEW B binding exists, is Setup-gated, and has no ctrl/shift/alt', () => {
    const b = REGISTRY.find((r) => r.id === 'toolBone')!;
    expect(b).toBeTruthy();
    expect(b.mode).toBe('setup');
    expect(b.patterns).toEqual([{ key: 'b', ctrl: false, shift: false, alt: false }]);
    expect(b.help.context).toBe('Tools');
  });
});

describe('help.ts generation matches the registry (no drift possible)', () => {
  it('every REGISTRY entry produces exactly one row with identical keys/description/context', () => {
    const rows = groupedShortcuts().flatMap((g) => g.entries);
    for (const b of REGISTRY) {
      const matches = rows.filter(
        (r) => r.keys === b.help.keys && r.description === b.help.description && r.context === b.help.context,
      );
      expect(matches.length, `exactly one generated row for "${b.id}"`).toBe(1);
    }
  });

  it('every generated keyboard row traces back to a real registry entry (no orphans)', () => {
    const keyboardContexts = new Set(['File', 'Edit', 'Tools', 'View', 'Timeline']);
    const rows = groupedShortcuts().flatMap((g) => g.entries).filter((r) => keyboardContexts.has(r.context));
    for (const row of rows) {
      const owner = REGISTRY.find(
        (b) => b.help.keys === row.keys && b.help.description === row.description && b.help.context === row.context,
      );
      expect(owner, `row "${row.keys}: ${row.description}" traces to a registry entry`).toBeTruthy();
    }
  });

  it('the hand-authored Toolbar / Mouse & tools sections are visibly separate from the generated ones', () => {
    const groups = groupedShortcuts();
    const titles = groups.map((g) => g.title);
    expect(titles).toContain('Toolbar');
    expect(titles).toContain('Mouse & tools');
    // None of the generated (registry-backed) contexts leak a "toolbar only"/gesture-style
    // key label — the tell-tale sign of a pseudo-shortcut mixed into a real section.
    const generatedContexts = ['File', 'Edit', 'Tools', 'View', 'Timeline'];
    for (const g of groups.filter((gr) => generatedContexts.includes(gr.title))) {
      for (const entry of g.entries) {
        expect(entry.keys, `"${entry.keys}" in generated section "${g.title}"`).not.toBe('toolbar only');
      }
    }
  });
});

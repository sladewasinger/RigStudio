// @vitest-environment jsdom
/**
 * Unit coverage for D1's PURE storage logic (ROADMAP.md "Desktop / real file access"):
 * the recents ring (`io/storage/recents.ts` — add/dedupe/cap/order, entirely localStorage-
 * backed, no IndexedDB or picker involved) and the download-fallback's pure File-read
 * helper (`io/storage/downloadFallback.ts`'s `readFile`). Everything else in `io/storage/`
 * (the two `ProjectStorage` implementations' picker-driving methods, IndexedDB handle
 * persistence) is browser-native-API-heavy and covered instead by the interaction suite
 * (`src/__tests__/interaction/fileStorage.test.ts`), per the wave brief's split.
 *
 * jsdom (not plain node) is required for `localStorage`/`File` — confirmed absent from
 * this project's default 'node' unit-test environment, matching `core/appState.ts`'s
 * `readSnapEnabled` guard comment.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  pushRecent, listRecents, markRecentHasHandle, clearRecents, MAX_RECENTS, RecentEntry,
} from '../io/storage/recents';
import { readFile } from '../io/storage/downloadFallback';

beforeEach(() => {
  localStorage.clear();
});

describe('io/storage/recents: the recent-files ring', () => {
  it('starts empty', () => {
    expect(listRecents()).toEqual([]);
  });

  it('pushRecent adds an entry, newest first', () => {
    const a = pushRecent('a.rig.json');
    const b = pushRecent('b.rig.json');
    expect(listRecents().map((e) => e.name)).toEqual(['b.rig.json', 'a.rig.json']);
    expect(a.hasHandle).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  it('re-pushing the same name dedupes and moves it to the front with a fresh id', () => {
    const first = pushRecent('proj.rig.json');
    pushRecent('other.rig.json');
    const second = pushRecent('proj.rig.json');

    const names = listRecents().map((e) => e.name);
    expect(names).toEqual(['proj.rig.json', 'other.rig.json']); // no duplicate row
    expect(second.id).not.toBe(first.id); // a fresh entry, not the stale one mutated in place
  });

  it('caps at MAX_RECENTS, dropping the oldest', () => {
    for (let i = 0; i < MAX_RECENTS + 3; i++) pushRecent(`file-${i}.rig.json`);
    const names = listRecents().map((e) => e.name);
    expect(names.length).toBe(MAX_RECENTS);
    // newest first; the oldest 3 (file-0..file-2) fell off the ring.
    expect(names[0]).toBe(`file-${MAX_RECENTS + 2}.rig.json`);
    expect(names).not.toContain('file-0.rig.json');
    expect(names).not.toContain('file-2.rig.json');
    expect(names).toContain('file-3.rig.json');
  });

  it('markRecentHasHandle flips hasHandle on the matching entry only', () => {
    const a = pushRecent('a.rig.json');
    const b = pushRecent('b.rig.json');
    markRecentHasHandle(a.id);
    const byId = (id: string): RecentEntry => listRecents().find((e) => e.id === id)!;
    expect(byId(a.id).hasHandle).toBe(true);
    expect(byId(b.id).hasHandle).toBe(false);
  });

  it('markRecentHasHandle on an unknown id is a silent no-op', () => {
    pushRecent('a.rig.json');
    expect(() => markRecentHasHandle('does-not-exist')).not.toThrow();
    expect(listRecents().every((e) => !e.hasHandle)).toBe(true);
  });

  it('clearRecents empties the ring', () => {
    pushRecent('a.rig.json');
    pushRecent('b.rig.json');
    clearRecents();
    expect(listRecents()).toEqual([]);
  });

  it('survives a corrupted localStorage value by degrading to an empty list', () => {
    localStorage.setItem('rig-studio-recent-files', 'not json');
    expect(listRecents()).toEqual([]);
    // pushRecent must still work after a corrupt read (readAll degrades, doesn't throw).
    pushRecent('recovered.rig.json');
    expect(listRecents().map((e) => e.name)).toEqual(['recovered.rig.json']);
  });
});

describe('io/storage/downloadFallback: readFile (pure)', () => {
  it('resolves the File name and its text content', async () => {
    const file = new File(['{"hello":"world"}'], 'demo.rig.json', { type: 'application/json' });
    const result = await readFile(file);
    expect(result).toEqual({ name: 'demo.rig.json', text: '{"hello":"world"}' });
  });

  it('round-trips an empty file', async () => {
    const file = new File([], 'empty.svg', { type: 'image/svg+xml' });
    const result = await readFile(file);
    expect(result).toEqual({ name: 'empty.svg', text: '' });
  });
});

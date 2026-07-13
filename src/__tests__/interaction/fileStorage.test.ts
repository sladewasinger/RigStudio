/**
 * D1 (ROADMAP.md "Desktop / real file access") interaction coverage: the storage-
 * interface seam itself. Headless Chromium EXPOSES `showOpenFilePicker`/
 * `showSaveFilePicker` but can never dismiss the native dialog they open, so no test
 * here ever lets `getProjectStorage()` resolve the real `fileSystemAccessStorage` —
 * every scenario injects a `ProjectStorage` via `setProjectStorageForTest` instead
 * (mirrors `core/history.ts`'s `setRestoreHandler` / `panels/ai/requests.ts`'s
 * `__setAnimateCallForTest`).
 *
 * Handles are backed by the Origin Private File System (`navigator.storage.getDirectory`)
 * rather than a hand-rolled plain-object double: OPFS handles are REAL, spec-compliant
 * `FileSystemFileHandle`s (genuine `getFile`/`createWritable`, and — critically —
 * structured-clone-safe, unlike a plain object with function properties), so the SAME
 * IndexedDB handle-persistence path production code uses (`io/storage/handleStore.ts`)
 * round-trips them for real. This is the closest a fully headless test can get to the
 * real File System Access flow without a driveable native OS dialog; the genuine local-
 * disk round trip (a real file picker, a real path on disk) is documented as a live-sweep-
 * only smoke test — see the wave report.
 *
 * Category B's pre-D1 fallback scenarios (`categoryB.test.ts`'s "quick-save vs Save As")
 * are intentionally NOT duplicated here — they already run against the REAL
 * `downloadFallbackStorage` (the harness's default for every test file) and continuing
 * to pass unmodified IS this wave's "fallback mode preserves Category B behavior" proof.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { serializeDoc } from '../../core/model';
import { checkpoint } from '../../core/history';
import {
  getProjectStorage, setProjectStorageForTest, downloadFallbackStorage, listRecents,
  clearRecents, ProjectStorage, SaveResult, StorageFile,
} from '../../io/storage';
import {
  bootRig, resetRig, state, notify, partByLabel, pressKey, waitFor,
} from './harness';

beforeAll(bootRig);
beforeEach(() => {
  resetRig();
  // The recents ring is localStorage-backed (survives resetRig's doc-swap, same as the
  // real app) — clear it per test so an earlier scenario's save/open in THIS file can't
  // leave stray entries that change whether a later test's Open click shows a dropdown.
  clearRecents();
});
afterEach(() => setProjectStorageForTest(downloadFallbackStorage));

async function opfsHandle(name: string): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getFileHandle(name, { create: true });
}

async function readHandleText(handle: FileSystemFileHandle): Promise<string> {
  const file = await handle.getFile();
  return file.text();
}

/** A ProjectStorage that records every call and writes real bytes through OPFS handles —
 *  `openProject` is overridable per test (defaults to "cancelled"). */
function makeRecordingStorage(): { storage: ProjectStorage; calls: string[] } {
  const calls: string[] = [];
  const storage: ProjectStorage = {
    supportsFileHandles: true,
    async openProject(): Promise<StorageFile | null> { calls.push('openProject'); return null; },
    async openSvg(): Promise<StorageFile | null> { calls.push('openSvg'); return null; },
    async saveProject(text, handle): Promise<SaveResult | null> {
      calls.push('saveProject');
      if (!handle) return null;
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return { name: handle.name, handle };
    },
    async saveProjectAs(text, suggestedName): Promise<SaveResult> {
      calls.push('saveProjectAs');
      const handle = await opfsHandle(suggestedName);
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return { name: suggestedName, handle };
    },
  };
  return { storage, calls };
}

describe('scenario — D1: getProjectStorage defaults to the fallback outside a test override', () => {
  it('the harness boots every file into downloadFallbackStorage (pre-D1 behavior)', () => {
    expect(getProjectStorage()).toBe(downloadFallbackStorage);
  });
});

describe('scenario — D1: Ctrl+S writes through a live handle in place, no dialog', () => {
  it('quick-save with a held handle calls saveProject (not saveProjectAs), no .ui-dialog, dirty clears', async () => {
    const { storage, calls } = makeRecordingStorage();
    setProjectStorageForTest(storage);

    const handle = await opfsHandle('quicksave.rig.json');
    state.projectFileHandle = handle;

    const part = partByLabel('left_arm');
    checkpoint();
    part.rest.rotate = (part.rest.rotate ?? 0) + 7;
    notify();
    expect(state.dirty, 'sanity: the edit dirtied the doc').toBe(true);

    pressKey('s', { ctrlKey: true });
    await waitFor(() => !state.dirty, { message: 'quick-save completes and clears dirty' });

    expect(calls).toEqual(['saveProject']);
    expect(document.querySelector('.ui-dialog'), 'no in-app dialog for an in-place write').toBeNull();

    // serializeDoc's on-disk shape is an envelope ({format, version, doc: {...}}), not
    // the RigDoc directly — see core/serialization.ts.
    const written = JSON.parse(await readHandleText(handle));
    const writtenPart = written.doc.parts.find((p: { id: string }) => p.id === part.id);
    expect(writtenPart.rest.rotate).toBeCloseTo(part.rest.rotate as number, 5);
  });
});

describe('scenario — D1: Save As always shows a fresh picker, even with a live handle', () => {
  it('Ctrl+Shift+S calls saveProjectAs (not saveProject) and swaps the held handle', async () => {
    const { storage, calls } = makeRecordingStorage();
    setProjectStorageForTest(storage);
    state.projectFileHandle = await opfsHandle('original.rig.json');

    pressKey('s', { ctrlKey: true, shiftKey: true });
    // Wait for the FULL async chain (storage.saveProjectAs resolving AND
    // shortcutActions.ts's doSave re-assigning state.projectFileHandle afterward), not
    // just the fake's synchronous calls.push — that fires before the handle swap lands.
    await waitFor(
      () => state.projectFileHandle?.name === 'pip.rig.json',
      { message: 'Save As completes and swaps the held handle' },
    );

    expect(calls).toEqual(['saveProjectAs']);
    expect(document.querySelector('.ui-dialog'), 'the (fake) native picker handles naming').toBeNull();
    // ui/shortcutActions.ts suggests `${doc.name}.rig.json`; the pristine fixture's doc name is 'pip'.
    expect(state.projectFileHandle?.name).not.toBe('original.rig.json');

    const written = JSON.parse(await readHandleText(state.projectFileHandle!));
    expect(written.doc.name).toBe('pip');
  });
});

describe('scenario — D1: recents ring lists an opened project and reopens it via its handle', () => {
  it('opening a .json through a live handle populates the Open dropdown; clicking the entry reopens without a fresh pick', async () => {
    const seedText = serializeDoc(state.doc!);
    const openedHandle = await opfsHandle('recent-demo.rig.json');
    const w = await openedHandle.createWritable();
    await w.write(seedText);
    await w.close();

    const { storage } = makeRecordingStorage();
    storage.openProject = async () => ({ name: 'recent-demo.rig.json', text: seedText, handle: openedHandle });
    setProjectStorageForTest(storage);

    expect(listRecents().some((r) => r.name === 'recent-demo.rig.json'), 'sanity: not recent yet').toBe(false);

    (document.getElementById('btn-open') as HTMLButtonElement).click(); // no recents yet -> opens directly
    await waitFor(() => state.projectFileHandle?.name === 'recent-demo.rig.json', { message: 'open completes' });
    await waitFor(() => listRecents().some((r) => r.name === 'recent-demo.rig.json'), { message: 'recents ring updates' });

    // A second click now shows the dropdown (Browse… + the recent entry).
    (document.getElementById('btn-open') as HTMLButtonElement).click();
    await waitFor(() => document.querySelector('.ui-context-menu'), { message: 'recents menu opens' });
    const itemLabels = Array.from(document.querySelectorAll('.ui-context-menu-item')).map((b) => b.textContent);
    expect(itemLabels[0]).toBe('Browse for file…');
    expect(itemLabels).toContain('recent-demo.rig.json');

    // Load a DIFFERENT doc so the reopen below is provably re-reading from the handle,
    // not just leaving the already-open doc alone.
    const otherHandle = await opfsHandle('other.rig.json');
    state.projectFileHandle = otherHandle;

    const recentBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.ui-context-menu-item'))
      .find((b) => b.textContent === 'recent-demo.rig.json')!;
    recentBtn.click();

    await waitFor(
      () => state.projectFileHandle?.name === 'recent-demo.rig.json',
      { message: 'reopen restores the recent entry\'s handle, no fresh picker' },
    );
    expect(document.querySelector('.ui-context-menu'), 'menu closed').toBeNull();
    expect(document.querySelector('.ui-dialog'), 'no picker/dialog — reopened straight from the handle').toBeNull();
  });
});

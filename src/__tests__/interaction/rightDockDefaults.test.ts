import { beforeAll, describe, expect, it } from 'vitest';
import { notify, selectPart, state } from '../../core/model';
import { createWarpTriangleSquareSample } from '../../samples/warpTriangleSquare';
import { currentRightDockTab, openSelectedWarp } from '../../panels';
import { bootRig, setEditorMode, waitFor } from './harness';

beforeAll(bootRig);

const api = () => (window as unknown as {
  __rigStudio: { loadProjectText: (text: string) => boolean };
}).__rigStudio;

function loadShowcase() {
  api().loadProjectText(JSON.stringify({ format: 'rig-studio', version: 3, doc: createWarpTriangleSquareSample() }));
}

function expectOnly(panel: 'inspector' | 'warps' | 'claude') {
  expect(currentRightDockTab()).toBe(panel);
  expect(document.querySelector('[aria-selected="true"]')?.id).toBe(`right-dock-tab-${panel}`);
  expect(document.querySelectorAll('#right-dock > .right-dock-content')).toHaveLength(1);
  expect(document.querySelectorAll('#right-dock .ai-panel')).toHaveLength(panel === 'claude' ? 1 : 0);
  expect(document.querySelectorAll('#right-dock .warps-panel')).toHaveLength(panel === 'warps' ? 1 : 0);
}

describe('Animate right-dock defaults', () => {
  it('opens Inspector on the first Animate entry and ignores an obsolete persisted Claude value', () => {
    localStorage.setItem('rig-studio-right-dock-tab', 'claude');
    loadShowcase();
    state.editorMode = 'setup'; notify();
    setEditorMode('animate');
    expectOnly('inspector');
  });

  it('preserves an explicit tab across Edit↔Animate in the same document only', () => {
    document.getElementById('right-dock-tab-claude')!.click();
    expectOnly('claude');
    setEditorMode('setup');
    expect(document.querySelector('.right-dock-tabs')).toBeNull();
    setEditorMode('animate');
    expectOnly('claude');
  });

  it('resets to Inspector on project replacement and repeated replacements never duplicate panels', () => {
    loadShowcase();
    expectOnly('inspector');
    document.getElementById('right-dock-tab-claude')!.click();
    loadShowcase();
    loadShowcase();
    expectOnly('inspector');
  });

  it('resets New to Inspector for its next Animate entry', async () => {
    state.dirty = false;
    document.getElementById('btn-new')!.click();
    await waitFor(() => state.doc?.name === 'untitled' ? state.doc : null);
    expect(state.editorMode).toBe('setup');
    setEditorMode('animate');
    expectOnly('inspector');
  });

  it('opens Warps only from an explicit Warp action, then replacement returns to Inspector', () => {
    loadShowcase(); state.editorMode = 'animate'; notify();
    expectOnly('inspector');
    selectPart('triangle_group');
    expect(openSelectedWarp()).toBe(true);
    expectOnly('warps');
    loadShowcase();
    expectOnly('inspector');
  });
});

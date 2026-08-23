import { beforeAll, describe, expect, it } from 'vitest';
import { notify, selectPart, state } from '../../core/model';
import { createWarpTriangleSquareSample } from '../../samples/warpTriangleSquare';
import { bootRig, waitFor } from './harness';
import { renderPose } from '../../view';

beforeAll(bootRig);
const load = () => {
  const api = (window as unknown as { __rigStudio: { loadProjectText: (text: string) => boolean } }).__rigStudio;
  api.loadProjectText(JSON.stringify({ format: 'rig-studio', version: 3, doc: createWarpTriangleSquareSample() }));
};

describe('Warp dock workflow', () => {
  it('is Animate-only and stays discoverable without selection', async () => {
    load(); state.doc!.warps = []; state.doc!.clips[0].tracks = [];
    state.editorMode = 'setup'; notify(); renderPose();
    expect(Array.from(document.querySelectorAll('#canvas-tools button')).some((item) => item.textContent === 'Create Warp')).toBe(false);
    state.editorMode = 'animate'; selectPart('triangle_group'); selectPart('square_group', true); notify();
    const create = Array.from(document.querySelectorAll<HTMLButtonElement>('#canvas-tools button')).find((item) => item.textContent === 'Create Warp')!;
    expect(create.disabled).toBe(false); create.click();
    const prompt = await waitFor(() => document.querySelector<HTMLElement>('.ui-dialog'));
    (prompt.querySelector('input') as HTMLInputElement).value = 'Hand turn';
    (prompt.querySelector('.ui-dialog-primary') as HTMLButtonElement).click();
    const panel = await waitFor(() => document.querySelector<HTMLElement>('.warps-panel'));
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toBe('Warps');
    expect(panel.textContent).toContain('Hand turn'); expect(panel.querySelectorAll('.warp-pair')).toHaveLength(2);
    state.selectedPartIds = []; state.selectedPartId = null; notify();
    expect(document.querySelector('.warps-panel')?.textContent).toContain('Hand turn');
  });

  it('keys exact percent and synchronizes the lane', () => {
    const exact = document.querySelector<HTMLInputElement>('[aria-label="Warp percent exact value"]')!;
    exact.value = '37.5'; exact.dispatchEvent(new Event('input', { bubbles: true }));
    Array.from(document.querySelectorAll<HTMLButtonElement>('.warps-panel button')).find((item) => item.textContent === '◆ Set key')!.click();
    const warp = state.doc!.warps![0];
    expect(state.doc!.clips[0].tracks.find((track) => track.target === warp.id)?.keyframes[0].value).toBe(.375);
    const lane = document.querySelector<HTMLElement>(`[data-warp-lane="${warp.id}"]`)!;
    expect(lane.textContent).toContain('Warp · Hand turn');
    lane.querySelector<HTMLElement>('.tl-lane-label')!.click();
    expect(document.querySelector('[aria-selected="true"]')?.textContent).toBe('Warps');
  });

  it('isolates Claude and gives the opaque dock an accessible splitter', () => {
    document.getElementById('right-dock-tab-claude')!.click();
    expect(document.querySelector('.ai-panel')).not.toBeNull(); expect(document.querySelector('.warps-panel')).toBeNull();
    document.getElementById('right-dock-tab-warps')!.click();
    const panel = document.querySelector<HTMLElement>('.warps-panel')!;
    expect(getComputedStyle(panel).backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    document.getElementById('right-dock-splitter')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.getElementById('layout')!.style.getPropertyValue('--right-dock-width')).toBe('260px');
  });

  it('keeps both endpoints normal in Edit and suppresses target only in Animate', () => {
    state.editorMode = 'setup'; notify(); renderPose();
    const target = document.querySelector<SVGPathElement>('[data-path-id="square_shape_path"]')!;
    expect(target.getAttribute('visibility')).not.toBe('hidden');
    selectPart('square_group'); notify(); expect(state.selectedPartId).toBe('square_group');
    state.editorMode = 'animate'; notify(); renderPose(); expect(target.getAttribute('visibility')).toBe('hidden');
    state.editorMode = 'setup'; notify(); renderPose(); expect(target.getAttribute('visibility')).not.toBe('hidden');
  });
});

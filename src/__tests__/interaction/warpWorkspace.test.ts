import { beforeAll, describe, expect, it } from 'vitest';
import { notify, selectPart, state } from '../../core/model';
import { createWarpTriangleSquareSample } from '../../samples/warpTriangleSquare';
import { bootRig, waitFor } from './harness';

beforeAll(bootRig);

describe('Warp Setup workflow', () => {
  it('creates from ordered selection, exposes every match, scrubs, keys, and closes with Escape', async () => {
    const hook = (window as unknown as { __rigStudio: { loadProjectText: (text: string) => boolean } }).__rigStudio;
    expect(hook.loadProjectText(JSON.stringify({ format: 'rig-studio', version: 3, doc: createWarpTriangleSquareSample() }))).toBe(true);
    state.doc!.warps = [];
    state.doc!.clips[0].tracks = [];
    state.editorMode = 'setup';
    selectPart('triangle_group');
    selectPart('square_group', true);
    notify();
    const warpButton = Array.from(document.querySelectorAll<HTMLButtonElement>('#canvas-tools button'))
      .find((button) => button.textContent === 'Warp')!;
    expect(warpButton.disabled).toBe(false);
    warpButton.click();
    const dialog = await waitFor(() => document.querySelector<HTMLElement>('.ui-dialog'));
    (dialog.querySelector('input') as HTMLInputElement).value = 'Hand turn';
    (dialog.querySelector('button.ui-dialog-primary') as HTMLButtonElement).click();
    const workspace = await waitFor(() => document.querySelector<HTMLElement>('#warp-workspace.open'));
    expect(workspace.textContent).toContain('Carrier: Triangle');
    expect(workspace.textContent).toContain('Reference: Square');
    expect(workspace.querySelectorAll('.warp-pair:not(.warning)')).toHaveLength(2);
    expect(workspace.textContent).toContain('Exact name · confirmed');
    const slider = workspace.querySelector<HTMLInputElement>('input[type="range"]')!;
    slider.value = '50';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(workspace.querySelector('output')!.textContent).toBe('50%');
    expect(state.warpPreviewAmount).toBe(.5);
    const animate = Array.from(workspace.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Open in Animate')!;
    animate.click();
    expect(state.doc!.clips[0].tracks.find((track) => track.channel === 'warp')?.keyframes[0].value).toBe(.5);
    expect(document.querySelector('.tl-lane-label')?.textContent).toBe('Warp · Hand turn');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('#warp-workspace.open')).toBeNull();
  });
});

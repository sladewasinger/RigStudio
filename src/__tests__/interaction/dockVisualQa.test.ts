import { beforeAll, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { notify, state } from '../../core/model';
import { renderPose } from '../../view';
import { createWarpTriangleSquareSample } from '../../samples/warpTriangleSquare';
import { bootRig, setEditorMode } from './harness';

beforeAll(bootRig);

describe('right dock visual QA artifacts', () => {
  it('captures every exclusive dock state at the reported desktop viewport', async () => {
    await page.viewport(1230, 830);
    const api = (window as unknown as { __rigStudio: { loadProjectText: (text: string) => boolean } }).__rigStudio;
    api.loadProjectText(JSON.stringify({ format: 'rig-studio', version: 3, doc: createWarpTriangleSquareSample() }));
    state.editorMode = 'setup'; notify(); renderPose();
    await page.screenshot({ path: '../../../docs/qa/warp-dock/edit-inspector.png' });

    setEditorMode('animate');
    document.getElementById('right-dock-tab-inspector')!.click();
    await page.screenshot({ path: '../../../docs/qa/warp-dock/animate-inspector.png' });

    document.getElementById('right-dock-tab-warps')!.click();
    await page.screenshot({ path: '../../../docs/qa/warp-dock/animate-warps.png' });

    document.getElementById('right-dock-tab-claude')!.click();
    await page.screenshot({ path: '../../../docs/qa/warp-dock/animate-claude.png' });

    document.getElementById('layout')!.style.setProperty('--right-dock-width', '260px');
    await page.screenshot({ path: '../../../docs/qa/warp-dock/resized-narrow-dock.png' });
    expect(document.querySelectorAll('#right-dock .ai-panel')).toHaveLength(1);

    document.getElementById('layout')!.style.setProperty('--right-dock-width', '340px');
    state.activeClipIndex = 1;
    document.getElementById('right-dock-tab-warps')!.click();
    for (const [label, time] of [['posed-source', 500], ['midpoint', 1000], ['exact-target', 1500], ['reverse-source', 2500]] as const) {
      state.currentTime = time; notify(); renderPose();
      await page.screenshot({ path: `../../../docs/qa/warp-transform/${label}.png` });
    }

    state.activeClipIndex = 2;
    for (const [label, time] of [['initial', 0], ['bone-pose', 700], ['both-midpoints', 1100], ['exact-targets', 1700], ['wave-left', 2200], ['wave-right', 2700], ['return', 4000]] as const) {
      state.currentTime = time; notify(); renderPose();
      await page.screenshot({ path: `../../../docs/qa/warp-showcase/${label}.png` });
    }
  });
});

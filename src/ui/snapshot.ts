/**
 * Shared SVG-clone rasterizer for the canvas's live artwork — used by the AI
 * assistant's pose-snapshot attachment (panels/ai.ts's snapshotPose) and the
 * toolbar's still-image export (ui/imageExport.ts). Clones the live `#rig-svg`
 * (never touches the original — callers get a disposable detached element), strips
 * overlay/onion chrome always, and the artboard highlight rect optionally, then
 * either serializes the clone to SVG text or rasterizes it to a PNG data URL via an
 * off-screen `<canvas>`.
 */
import { state } from '../core/model';

export interface CloneOptions {
  /** Also strip #rig-artboard-rect (the faint page-bounds highlight). The AI
   *  snapshot's pre-existing behavior keeps it — omit this option to preserve that
   *  exactly; still-image export passes true. */
  stripArtboard?: boolean;
  /** ViewBox to frame the clone with, in doc space. Defaults to the whole
   *  document's viewBox — full-document framing regardless of the user's current
   *  pan/zoom (the live SVG's own viewBox reflects the current viewport, not the
   *  document). */
  box?: { x: number; y: number; w: number; h: number };
}

/** Clone the live canvas SVG with overlay/onion (and optionally artboard) chrome
 *  stripped and the viewBox reframed. Returns null if there's no live canvas/doc. */
export function cloneArtworkSvg(opts: CloneOptions = {}): SVGSVGElement | null {
  const live = document.getElementById('rig-svg') as SVGSVGElement | null;
  const doc = state.doc;
  if (!live || !doc) return null;
  const clone = live.cloneNode(true) as SVGSVGElement;
  clone.querySelector('#overlay')?.remove();
  clone.querySelector('#onion')?.remove();
  if (opts.stripArtboard) clone.querySelector('#rig-artboard-rect')?.remove();
  const box = opts.box ?? doc.viewBox;
  clone.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
  return clone;
}

/** Serialize a (typically cloned, detached) SVG element to a standalone XML string. */
export function serializeArtworkSvg(svg: SVGSVGElement): string {
  return new XMLSerializer().serializeToString(svg);
}

/**
 * Rasterize an SVG element to a PNG data URL at exactly outW x outH pixels. Mutates
 * the passed element's width/height attributes — pass a disposable clone, not a live
 * DOM node. `background` fills the canvas first when given; omit it for a
 * transparent PNG.
 */
export async function rasterizeSvg(
  svg: SVGSVGElement, outW: number, outH: number, background?: string,
): Promise<string> {
  svg.setAttribute('width', String(outW));
  svg.setAttribute('height', String(outH));
  const svgText = serializeArtworkSvg(svg);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('rasterize failed'));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const c = canvas.getContext('2d')!;
  if (background) {
    c.fillStyle = background;
    c.fillRect(0, 0, outW, outH);
  }
  c.drawImage(img, 0, 0, outW, outH);
  return canvas.toDataURL('image/png');
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import { createWarpTriangleSquareSample } from '../src/samples/warpTriangleSquare';
import { evaluateWarpPath } from '../src/geometry/warp';

const doc = createWarpTriangleSquareSample();
const warp = doc.warps![0];
const output = 'docs/qa/warp';
mkdirSync(output, { recursive: true });

const color = (left: string, right: string, amount: number) => {
  const channel = (offset: number) => Math.round(parseInt(left.slice(offset, offset + 2), 16) +
    (parseInt(right.slice(offset, offset + 2), 16) - parseInt(left.slice(offset, offset + 2), 16)) * amount);
  return `#${[1, 3, 5].map((offset) => channel(offset).toString(16).padStart(2, '0')).join('')}`;
};

for (const [label, amount] of [['0-source', 0], ['50-midpoint', .5], ['100-target', 1], ['return-0', 0]] as const) {
  const paths = warp.pairs.map((pair) => {
    const sourcePart = doc.parts.find((part) => part.id === pair.sourcePartId)!;
    const targetPart = doc.parts.find((part) => part.id === pair.targetPartId)!;
    const sourcePath = sourcePart.paths.find((path) => path.id === pair.sourcePathId)!;
    const targetPath = targetPart.paths.find((path) => path.id === pair.targetPathId)!;
    const stroke = sourcePath.stroke && targetPath.stroke ? color(sourcePath.stroke, targetPath.stroke, amount) : sourcePath.stroke;
    return `<path d="${evaluateWarpPath(doc, pair, amount)}" fill="${color(sourcePath.fill!, targetPath.fill!, amount)}" stroke="${stroke ?? 'none'}" stroke-width="${sourcePath.strokeWidth}" stroke-linejoin="round"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="512" height="512"><rect width="256" height="256" fill="#27272f"/>${paths}<text x="12" y="24" fill="white" font-family="sans-serif" font-size="11">${label.replace('-', ' · ')}</text></svg>`;
  writeFileSync(`${output}/${label}.svg`, svg);
  writeFileSync(`${output}/${label}.png`, new Resvg(svg).render().asPng());
}

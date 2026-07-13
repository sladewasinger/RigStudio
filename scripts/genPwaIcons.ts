/**
 * ONE-OFF scratch script (D1: PWA manifest icons) — NOT wired into the build (CLAUDE.md:
 * "do it once with a scratch script, don't wire codegen into the build"). Renders the
 * bundled Pip sample's REST pose (headless: importSvgHeadless + composePose, the same
 * pure kernel `rig render-frames` uses) into a square, padded, dark-background frame,
 * then rasterizes it to 192x192 and 512x512 PNGs via @resvg/resvg-js — the same native
 * dependency headless/renderFrames.ts already uses (CLI-only; never reaches the Vite
 * bundle). Run manually and re-run only if the placeholder needs to change:
 *
 *   npx tsx scripts/genPwaIcons.ts
 *
 * Writes public/icon-192.png and public/icon-512.png, committed as ordinary assets.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

import { importSvgHeadless } from '../src/headless/importSvgHeadless';
import { composePose } from '../src/headless/composePose';
import { artboardFrame } from '../src/core/model';

const here = path.dirname(fileURLToPath(import.meta.url));
const SVG_SOURCE = path.resolve(here, '../public/PIP_MASTER.svg');
const OUT_DIR = path.resolve(here, '../public');
const BG = '#1e1e24'; // --bg from src/style.css — matches the app's own dark theme
const PAD = 1.18; // 18% margin around the artwork inside the square

function squareSvg(inner: string, frame: { x: number; y: number; w: number; h: number }): string {
  const side = Math.max(frame.w, frame.h) * PAD;
  const cx = frame.x + frame.w / 2;
  const cy = frame.y + frame.h / 2;
  const x = cx - side / 2;
  const y = cy - side / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${side} ${side}">` +
    `<rect x="${x}" y="${y}" width="${side}" height="${side}" fill="${BG}"/>` +
    `${inner}</svg>`
  );
}

function main(): void {
  const svgText = fs.readFileSync(SVG_SOURCE, 'utf8');
  const doc = importSvgHeadless(svgText, 'pip');
  const clip = doc.clips[0];
  const rendered = composePose(doc, clip, 0);
  const inner = rendered.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const square = squareSvg(inner, artboardFrame(doc));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const size of [192, 512]) {
    const resvg = new Resvg(square, { fitTo: { mode: 'width', value: size } });
    const png = resvg.render().asPng();
    const outPath = path.join(OUT_DIR, `icon-${size}.png`);
    fs.writeFileSync(outPath, png);
    console.log(`wrote ${outPath} (${png.length} bytes)`);
  }
}

main();

// App icons (P12.T1) drawn from the type-set logo (Docs/carpal-design-system README "Logo": the name "CarPal" in
// Atkinson Hyperlegible Next 800, White on Metal_black) with Playwright's Chromium, written to public/icons/:
//   icon-192.png, icon-512.png    manifest icons ("any"): the word mark on a rounded Metal_black square
//   maskable-512.png              full-bleed ground, the mark inside the 80 % safe zone (maskable)
//   apple-touch-icon.png (180)    iOS home screen (square; iOS rounds it)
//   badge-96.png                  notification badge: white mark on transparent (Android tints it)
// Run `pnpm icons:build` after a logo change and commit the files (CARPAL_E2E_CHROMIUM may name a Chromium binary).
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const pwaDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = join(pwaDir, '..');
const out = join(pwaDir, 'public', 'icons');
const font = readFileSync(join(repoDir, 'Docs', 'carpal-design-system', 'fonts', 'AtkinsonHyperlegibleNext-Latin-Variable.woff2')).toString(
  'base64',
);
const tokens = JSON.parse(readFileSync(join(repoDir, 'Docs', 'carpal-design-system', 'tokens.json'), 'utf8'));
const find = (o, key) => {
  if (!o || typeof o !== 'object') return undefined;
  if (key in o) return typeof o[key] === 'object' ? (o[key].value ?? o[key].$value) : o[key];
  for (const v of Object.values(o)) {
    const hit = find(v, key);
    if (hit) return hit;
  }
  return undefined;
};
const INK = find(tokens, 'Metal_black') ?? '#0c1136';
const WHITE = find(tokens, 'White') ?? '#ffffff';

const ICONS = [
  { file: 'icon-192.png', size: 192, radius: 0.22, safe: 0.86, ground: INK, ink: WHITE },
  { file: 'icon-512.png', size: 512, radius: 0.22, safe: 0.86, ground: INK, ink: WHITE },
  { file: 'maskable-512.png', size: 512, radius: 0, safe: 0.66, ground: INK, ink: WHITE },
  { file: 'apple-touch-icon.png', size: 180, radius: 0, safe: 0.8, ground: INK, ink: WHITE },
  { file: 'badge-96.png', size: 96, radius: 0, safe: 0.9, ground: 'transparent', ink: WHITE, short: true },
];

function html(i) {
  const word = i.short ? 'CP' : 'CarPal';
  return `<!doctype html><html><head><style>
@font-face { font-family: Atkinson; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 200 800; }
html, body { margin: 0; background: transparent; }
.ground { width: ${i.size}px; height: ${i.size}px; border-radius: ${i.radius * i.size}px; background: ${i.ground};
  display: flex; align-items: center; justify-content: center; }
.mark { font-family: Atkinson; font-weight: 800; color: ${i.ink}; white-space: nowrap; line-height: 1; letter-spacing: -0.01em; }
</style></head><body><div class="ground"><span class="mark" id="m">${word}</span></div></body></html>`;
}

mkdirSync(out, { recursive: true });
const browser = await chromium.launch(process.env.CARPAL_E2E_CHROMIUM ? { executablePath: process.env.CARPAL_E2E_CHROMIUM } : {});
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const i of ICONS) {
    await page.setViewportSize({ width: i.size, height: i.size });
    await page.setContent(html(i));
    await page.evaluate(async (o) => {
      await document.fonts.ready;
      const m = document.getElementById('m');
      // Fit the word into the safe width.
      let px = o.size;
      m.style.fontSize = `${px}px`;
      while (m.getBoundingClientRect().width > o.size * o.safe && px > 4) m.style.fontSize = `${--px}px`;
    }, i);
    await page.locator('.ground').screenshot({ path: join(out, i.file), omitBackground: i.ground === 'transparent' });
    console.log(`wrote public/icons/${i.file}`);
  }
} finally {
  await browser.close();
}

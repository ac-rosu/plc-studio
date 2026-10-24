// Renders images/icon-source.svg to images/icon.png in Chromium (transparent outside the tile).
// Needs `npx playwright install chromium` once. Usage: node scripts/icon.mts [size] [out.png]
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const size = Number(process.argv[2] ?? 256);
const out = process.argv[3] ?? 'images/icon.png';
const svg = readFileSync('images/icon-source.svg', 'utf8').replace(
  'width="256" height="256"',
  `width="${size}" height="${size}"`,
);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  await page.locator('svg').screenshot({ path: out, omitBackground: true });
} finally {
  await browser.close();
}

// Rasterize the icon masters into the manifest's PNGs:
//   master.svg    -> icon128.png, icon48.png   (squircle scene)
//   simple16.svg  -> icon16.png                (simplified toolbar glyph)
// Run from anywhere: node icons/render.mjs  (playwright lives with the e2e
// suite — cd test/e2e && npm install if missing).
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(here, '..', 'test', 'e2e', 'package.json'));
const { chromium } = require('playwright');

const jobs = [
  { svg: resolve(here, 'master.svg'), size: 128, out: resolve(here, 'icon128.png') },
  { svg: resolve(here, 'master.svg'), size: 48, out: resolve(here, 'icon48.png') },
  { svg: resolve(here, 'simple16.svg'), size: 16, out: resolve(here, 'icon16.png') },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 128, height: 128 }, deviceScaleFactor: 1 });
  for (const job of jobs) {
    await page.setViewportSize({ width: job.size, height: job.size });
    await page.goto('file://' + job.svg);
    await page.waitForLoadState('load');
    await page.screenshot({ path: job.out, omitBackground: true, clip: { x: 0, y: 0, width: job.size, height: job.size } });
    console.log('wrote', job.out);
  }
} finally {
  await browser.close();
}

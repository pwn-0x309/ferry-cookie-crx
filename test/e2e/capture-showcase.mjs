// Showcase regenerator: drives the real extension UI through the full loop
// (seeded production stand-in on 127.0.0.1, local dev server on localhost)
// and rewrites docs/screenshots/*.png used by docs/showcase.md and README.
// Run from this directory: node capture-showcase.mjs (headed Chromium).
import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(here, '..', '..');
const outDir = resolve(extDir, 'docs', 'screenshots');
const profile = mkdtempSync(resolve(tmpdir(), 'fc-shot-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pageHtml = (title, note) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;padding:32px;max-width:620px;margin:auto;color:#222}h1{font-size:20px}pre{background:#f4f4f6;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:13px}code{background:#f4f4f6;padding:1px 5px;border-radius:4px}</style>
<h1>${title}</h1><p>${note}</p><pre id="jar"></pre>
<script>function draw(){const c=document.cookie?document.cookie.split('; ').sort():[];document.getElementById('jar').textContent=c.length?('document.cookie — '+c.length+' visible:\\n'+c.join('\\n')):'document.cookie — (empty: no cookies readable from JS)';}draw();addEventListener('focus',draw);</script>`;

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: { width: 1000, height: 700 },
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run'],
});
const servers = [];
const serve = (host, port, html) =>
  new Promise((r) => {
    const s = http.createServer((q, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
    servers.push(s);
    s.listen(port, host, r);
  });
try {
  await serve('127.0.0.1', 8788, pageHtml('acme.example — production stand-in (127.0.0.1:8788)', 'Logged in as <strong>jinsoon</strong>. The browser jar holds 4 cookies here: <code>session</code> (httpOnly+Secure), <code>theme</code>, <code>cart_id</code>, and a partitioned tracker.'));
  await serve('127.0.0.1', 8787, pageHtml('localhost:8787 — local dev server', 'The local app. <code>document.cookie</code> below fills in after <strong>Land</strong>, and empties again after <strong>Undo</strong>.'));
  const sw = ctx.serviceWorkers()[0] ?? (await new Promise((r) => ctx.on('serviceworker', r)));
  await sw.evaluate(async () => { await chrome.storage.session.clear(); });
  const extensionId = new URL(sw.url()).host;

  // Local jar pre-seed: one overlapping name (theme) so the copy preview and
  // the landing diff both have an overwrite story to show.
  await sw.evaluate(async () => {
    await chrome.cookies.set({ url: 'http://localhost/', name: 'theme', value: 'old-light', path: '/' });
  });

  const source = await ctx.newPage();
  await source.goto('http://127.0.0.1:8788/');
  const cdp = await ctx.newCDPSession(source);
  for (const c of [
    { name: 'session', value: 's%3Djinsoon.abc123', httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'theme', value: 'dark', sameSite: 'Lax' },
    { name: 'cart_id', value: '9f2c-11', sameSite: 'Lax' },
  ]) {
    await cdp.send('Network.setCookie', { ...c, url: 'http://127.0.0.1:8788/', path: '/' });
  }
  // one partitioned (CHIPS) cookie -> the popup flags line; CDP sanitizes
  // this on 127.0.0.1, so set it through the extension's own API and fall
  // back silently if this Chromium refuses
  await sw.evaluate(async () => {
    await chrome.cookies.set({
      url: 'http://127.0.0.1:8788/',
      name: 'piwik',
      value: 'p1',
      path: '/',
      partitionKey: { topLevelSite: 'https://other.example', hasCrossSiteAncestor: false },
    }).catch(() => {});
  });

  const local = await ctx.newPage();
  await local.goto('http://localhost:8787/');
  await local.screenshot({ path: resolve(outDir, '07-local-before.png') });

  const popup = async () => { const p = await ctx.newPage(); await p.setViewportSize({ width: 400, height: 760 }); await p.goto(`chrome-extension://${extensionId}/src/popup/popup.html`); return p; };

  // 01 — copy view: receipt, flags, protect list (expanded for the shot)
  await source.bringToFront();
  let p = await popup();
  try {
    await p.waitForFunction(() => document.getElementById('copy')?.disabled === false, null, { timeout: 10000 });
  } catch {
    console.log('DEBUG popup state: ' + (await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 400))));
    throw new Error('copy never enabled');
  }
  await p.click('#preview-details summary');
  await sleep(400);
  await p.screenshot({ path: resolve(outDir, '01-copy-grab.png'), fullPage: true });

  // 02 — after Copy: credential state + clear
  await p.click('#copy');
  await p.waitForFunction(() => !document.getElementById('cred-state').hidden, null, { timeout: 5000 });
  await sleep(300);
  await p.screenshot({ path: resolve(outDir, '02-copy-done.png'), fullPage: true });
  await p.close();

  // 03 — land setup (dock / localhost / fill-gaps defaults)
  await local.bringToFront();
  p = await popup();
  await p.waitForFunction(() => !document.getElementById('land-setup').hidden, null, { timeout: 5000 });
  await p.evaluate(() => document.getElementById('land').scrollIntoView());
  await sleep(300);
  await p.screenshot({ path: resolve(outDir, '03-land-setup.png'), fullPage: true });

  // 04 — land diff via dock, merge mode: freshness + adds/overwrites math
  await p.click('#land-options summary'); // the power controls live collapsed
  await p.selectOption('#land-mode', 'merge');
  await p.click('#land-read');
  await p.waitForFunction(() => !document.getElementById('land-diff').hidden, null, { timeout: 10000 });
  await sleep(300);
  await p.screenshot({ path: resolve(outDir, '04-land-diff.png'), fullPage: true });

  // 05 — report
  await p.click('#land-confirm');
  await p.waitForFunction(() => !document.getElementById('land-report').hidden, null, { timeout: 10000 });
  await sleep(300);
  await p.screenshot({ path: resolve(outDir, '05-land-report.png'), fullPage: true });
  await p.close();

  // 08 — local dev page now holds the ferried cookies
  await local.reload();
  await sleep(400);
  await local.screenshot({ path: resolve(outDir, '08-local-after.png') });

  // 06 — undo: snapshot list + restore diff
  p = await popup();
  await p.waitForFunction(() => !document.getElementById('land-snapshots').hidden, null, { timeout: 5000 });
  await p.click('#land-snapshot-list li button');
  await p.waitForFunction(() => !document.getElementById('land-restore').hidden, null, { timeout: 5000 });
  await sleep(300);
  await p.screenshot({ path: resolve(outDir, '06-undo-restore.png'), fullPage: true });
  await p.close();

  // 09 — foreign input refusal (clipboard lane, textarea for visibility)
  await local.bringToFront();
  p = await popup();
  await p.click('#land-options summary'); // the power controls live collapsed
  await p.selectOption('#land-lane', 'textarea');
  const foreignJson = JSON.stringify([
    { domain: '.internal.corp', hostOnly: false, name: 'toss-seed', path: '/', sameSite: 'unspecified', secure: false, session: true, storeId: '0', value: 'evil' },
    { domain: 'example.com', hostOnly: true, name: 'realworld', path: '/', sameSite: 'lax', secure: false, session: true, storeId: '0', value: 'x' },
  ], null, 2);
  await p.fill('#land-textarea', foreignJson);
  await p.click('#land-read');
  await p.waitForFunction(() => !document.getElementById('land-reason').hidden, null, { timeout: 10000 });
  await sleep(300);
  await p.screenshot({ path: resolve(outDir, '09-foreign-refused.png'), fullPage: true });

  // 10 — replace gate: typed-LAND confirmation
  await p.selectOption('#land-lane', 'dock');
  await p.selectOption('#land-mode', 'replace');
  await p.click('#land-read');
  await p.waitForFunction(() => !document.getElementById('land-diff').hidden, null, { timeout: 10000 });
  await p.fill('#land-type-land', 'L');
  await sleep(200);
  await p.screenshot({ path: resolve(outDir, '10-replace-gate.png'), fullPage: true });

  // 11 — zero-cookie guard: a real page whose jar is empty (the chrome://
  // guard never manifests here — Chrome hides chrome:// URLs from extensions
  // without "tabs", so the popup falls back to the last regular page)
  await p.close();
  await serve('::1', 8790, pageHtml('fresh-site.example — not logged in ([::1]:8790)', 'No cookies here at all ([::1] is its own jar). Opening the popup shows the named disable instead of a dead button.'));
  const emptyPage = await ctx.newPage();
  await emptyPage.goto('http://[::1]:8790/');
  await emptyPage.bringToFront();
  p = await popup();
  await p.waitForFunction(() => !document.getElementById('guard').hidden, null, { timeout: 5000 });
  await sleep(300);
  await p.screenshot({ path: resolve(outDir, '11-guard-empty-jar.png'), fullPage: true });
  await p.close();
  await emptyPage.close();

  console.log('captured: 01..11 in ' + outDir);
} finally {
  // Close every server — an open listen socket would keep the event loop
  // alive and hang the run after "captured".
  for (const s of servers) s.close();
  await ctx.close().catch(() => {});
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}

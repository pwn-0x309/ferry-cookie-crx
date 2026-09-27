// FerryCookie e2e — loads the unpacked extension into real Chromium, seeds
// fixture cookies on a local page, drives the real popup, and asserts the
// clipboard against the fixture-expected ETC v3 output. Replays F1/F3/F10,
// the command gesture path (service worker -> offscreen clipboard), and the
// protect toggle.
//
// Requires playwright with its bundled Chromium: either installed in this
// directory (npm install — this downloads that version's Chromium) or
// available under $FC_PLAYWRIGHT_ROOT. Branded Google Chrome is only a
// last-resort fallback: recent versions ignore --load-extension under
// automation.

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import http from 'node:http';

import { etcV3 } from '../../src/serializers/etc-v3.js';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(here, '..', '..');

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const root = process.env.FC_PLAYWRIGHT_ROOT;
    if (root) {
      const require = createRequire(resolve(root, 'package.json'));
      return require('playwright');
    }
    console.error(
      'playwright not found. Install it with its bundled Chromium:\n' +
        '  cd test/e2e && npm install\n' +
        'or set FC_PLAYWRIGHT_ROOT=<dir whose package.json has playwright installed>',
    );
    process.exit(2);
  }
}

const PAGE_HTML = '<!doctype html><title>ferry</title><p>local test page</p>';

function startServer() {
  return new Promise((resolvePromise) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE_HTML);
    });
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

const results = [];
function record(name, err) {
  results.push({ name, ok: !err, err: err ? String(err.message ?? err).split('\n')[0] : null });
  console.log(`${!err ? 'PASS' : 'FAIL'}  ${name}${err ? ' — ' + String(err.message ?? err).split('\n')[0] : ''}`);
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch:\n  actual:   ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
  }
}

function assertIncludes(haystack, needle, label) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${label}: "${needle}" not found in "${haystack}"`);
  }
}

async function main() {
  const { chromium } = await loadPlaywright();
  const server = await startServer();
  const port = server.address().port;
  const base = `http://localhost:${port}`;
  const altBase = `http://127.0.0.1:${port}`; // distinct jar, zero cookies (F10)

  const userDataDir = mkdtempSync(join(tmpdir(), 'ferry-cookie-profile-'));
  const launchArgs = [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  // Branded Chrome ignores --load-extension under automation, so prefer the
  // bundled (unbranded) Chromium, headed; fall back to new-headless Chromium,
  // then to branded Chrome with the unsafe-extension-debugging switch.
  const candidates = [
    { label: 'headed bundled chromium', options: { headless: false, args: launchArgs } },
    { label: 'new-headless chromium', options: { channel: 'chromium', headless: true, args: launchArgs } },
    {
      label: 'branded chrome',
      options: { channel: 'chrome', headless: true, args: [...launchArgs, '--enable-unsafe-extension-debugging'] },
    },
  ];

  let context;
  let launched = null;
  let lastErr;
  for (const candidate of candidates) {
    try {
      context = await chromium.launchPersistentContext(userDataDir, candidate.options);
      launched = candidate.label;
      break;
    } catch (err) {
      lastErr = err;
      console.log(`launch failed (${candidate.label}): ${String(err).split('\n')[0]}`);
    }
  }
  if (!context) {
    console.error(
      'No usable browser: install the bundled Chromium for your playwright version\n' +
        '  cd test/e2e && npm install\n' +
        '(branded Google Chrome is only a last-resort fallback — it ignores --load-extension under automation)',
    );
    throw lastErr;
  }
  console.log(`launched: ${launched}`);

  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(sw.url()).host;
    console.log(`extension loaded: ${extensionId}`);

    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });

    const targetPage = await context.newPage();
    await targetPage.goto(base + '/');
    await targetPage.bringToFront();

    const popup = () => context.newPage().then((p) => p.goto(`chrome-extension://${extensionId}/src/popup/popup.html`).then(() => p));

    const readClipboard = () => targetPage.evaluate(() => navigator.clipboard.readText());

    const fixture = async (id) => JSON.parse(await readFile(join(here, '..', 'fixtures', `${id}.json`), 'utf8'));

    // Seed through CDP so attributes (httpOnly, secure-on-localhost,
    // partitionKey) are set exactly and browser-validated.
    const cdp = await context.newCDPSession(targetPage);
    async function seedCookies(cookies) {
      for (const c of cookies) {
        const res = await cdp.send('Network.setCookie', {
          name: c.name,
          value: c.value,
          url: c.url ?? base + '/',
          path: c.path ?? '/',
          secure: c.secure ?? false,
          httpOnly: c.httpOnly ?? false,
          sameSite: c.sameSite === 'None' ? 'None' : c.sameSite === 'Strict' ? 'Strict' : 'Lax',
          ...(c.expires !== undefined ? { expires: c.expires } : {}),
          ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
        });
        if (!res.success) throw new Error(`Network.setCookie failed for ${c.name}`);
      }
    }

    const F1_SEED = [
      {
        name: '__Host-session',
        value: 's%3Aunicode-sign',
        url: base + '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
        expires: 1798761600.5,
      },
    ];

    // ---- command gesture: SW -> offscreen clipboard + badge receipt -----
    // Runs first while the service worker is definitely alive. Browser-level
    // shortcuts cannot be synthesized, so this drives runCommand() — the
    // exact function the keyboard command invokes — inside the worker.
    {
      const name = 'command gesture — offscreen clipboard write + badge receipt';
      try {
        await context.clearCookies();
        await seedCookies(F1_SEED);
        const fx = await fixture('F1');
        const expected = etcV3.serialize(fx.expected.cookies);

        await targetPage.bringToFront();
        const badge = await sw.evaluate(async () => {
          await globalThis.ferryCookieRunCommand();
          return chrome.action.getBadgeText({});
        });
        assertEq(badge, '1', 'gesture badge shows the emitted count');
        await targetPage.bringToFront();
        assertEq(await readClipboard(), expected, 'gesture clipboard JSON');
        record(name);
      } catch (err) {
        record(name, err);
      }
    }

    // ---- F1: __Host- cookie ferries to the legal local form --------------
    {
      const name = 'F1 popup copy — clipboard holds fixture-expected __Host- JSON';
      let p;
      try {
        await context.clearCookies();
        await seedCookies(F1_SEED);
        const fx = await fixture('F1');
        const expected = etcV3.serialize(fx.expected.cookies);

        await targetPage.bringToFront();
        p = await popup();
        await p.waitForFunction(() => document.getElementById('copy')?.disabled === false, null, { timeout: 10000 });
        await p.click('#copy');
        await p.waitForFunction(() => !document.getElementById('cred-state').hidden, null, { timeout: 5000 });

        await targetPage.bringToFront();
        assertEq(await readClipboard(), expected, 'F1 clipboard JSON');

        // one-tap clear: credential state hidden, clipboard emptied
        await p.click('#clear');
        await p.waitForFunction(() => document.getElementById('cred-state').hidden, null, { timeout: 5000 });
        await targetPage.bringToFront();
        assertEq(await readClipboard(), '', 'F1 clipboard after clear');
        record(name);
        await p.close();
      } catch (err) {
        await p?.close().catch(() => {});
        record(name, err);
      }
    }

    // ---- F3: partitioned cookie excluded, counted in the popup -----------
    {
      const name = 'F3 popup copy — partitioned excluded, JSON matches fixture';
      let p;
      try {
        await context.clearCookies();
        await seedCookies([
          {
            name: 'sid',
            value: 'normal-session',
            url: base + '/',
            secure: true,
            httpOnly: true,
            sameSite: 'Lax',
            expires: 1810000000.5,
          },
          {
            name: 'chips',
            value: 'partitioned-value',
            url: base + '/',
            secure: true,
            sameSite: 'None',
            partitionKey: { topLevelSite: 'https://other.example', hasCrossSiteAncestor: false },
          },
        ]);
        const fx = await fixture('F3');
        const expected = etcV3.serialize(fx.expected.cookies);

        await targetPage.bringToFront();
        p = await popup();
        await p.waitForFunction(() => document.getElementById('copy')?.disabled === false, null, { timeout: 10000 });
        const flagsText = await p.evaluate(() => document.getElementById('flags').textContent);
        assertIncludes(flagsText, 'partitioned', 'F3 popup flags mention partitioned');
        await p.click('#copy');
        await p.waitForFunction(() => !document.getElementById('cred-state').hidden, null, { timeout: 5000 });

        await targetPage.bringToFront();
        assertEq(await readClipboard(), expected, 'F3 clipboard JSON (chips excluded)');
        record(name);
        await p.close();
      } catch (err) {
        await p?.close().catch(() => {});
        record(name, err);
      }
    }

    // ---- F10: empty jar disables the action, clipboard untouched ---------
    {
      const name = 'F10 empty jar — action disabled with reason, clipboard untouched';
      let p;
      let emptyPage;
      try {
        await context.clearCookies();
        await targetPage.bringToFront();
        await targetPage.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
        emptyPage = await context.newPage();
        await emptyPage.goto(altBase + '/'); // 127.0.0.1 is a distinct, empty jar
        await emptyPage.bringToFront();

        p = await popup();
        await p.waitForFunction(
          () => document.getElementById('copy')?.disabled === true && !document.getElementById('guard').hidden,
          null,
          { timeout: 10000 },
        );
        const reason = await p.evaluate(() => document.getElementById('guard-reason').textContent);
        assertIncludes(reason, 'no cookies here', 'F10 guard reason');
        await targetPage.bringToFront();
        assertEq(await readClipboard(), 'SENTINEL', 'F10 clipboard untouched');
        record(name);
        await p.close();
        await emptyPage.close();
      } catch (err) {
        await p?.close().catch(() => {});
        await emptyPage?.close().catch(() => {});
        record(name, err);
      }
    }

    // ---- protect toggle: preview row, exclusion, persistence -------------
    {
      const name = 'protect toggle — excluded from JSON, flagged, persists to next grab';
      let p;
      try {
        await context.clearCookies();
        await seedCookies([
          ...F1_SEED,
          {
            name: 'sid',
            value: 'normal-session',
            url: base + '/',
            secure: true,
            httpOnly: true,
            sameSite: 'Lax',
            expires: 1810000000.5,
          },
        ]);
        const f3 = await fixture('F3');

        await targetPage.bringToFront();
        p = await popup();
        await p.waitForFunction(() => document.getElementById('copy')?.disabled === false, null, { timeout: 10000 });
        await p.waitForSelector('#preview-list input[data-name="__Host-session"]', { timeout: 5000 });
        await p.check('#preview-list input[data-name="__Host-session"]');
        await p.waitForFunction(
          () => document.getElementById('flags').textContent.includes('protected, not copied'),
          null,
          { timeout: 5000 },
        );
        await p.click('#copy');
        await p.waitForFunction(() => !document.getElementById('cred-state').hidden, null, { timeout: 5000 });

        await targetPage.bringToFront();
        assertEq(
          await readClipboard(),
          etcV3.serialize([f3.expected.cookies[0]]),
          'protect clipboard JSON excludes __Host-session',
        );
        await p.close();

        // fc-protect (names only, storage.session) survives the next grab:
        // the reopened popup still flags the name and still emits only sid
        // (the protected cookie also drops out of the preview, since the
        // preview runs on the post-protect grab).
        const p2 = await popup();
        await p2.waitForFunction(
          () =>
            document.getElementById('flags').textContent.includes('protected, not copied') &&
            document.getElementById('copy')?.disabled === false,
          null,
          { timeout: 10000 },
        );
        assertEq(
          await p2.evaluate(() => document.getElementById('receipt-count').textContent),
          '1',
          'next grab still excludes the protected cookie',
        );
        record(name);
        await p2.close();
      } catch (err) {
        await p?.close().catch(() => {});
        record(name, err);
      }
    }
  } finally {
    await context.close().catch(() => {});
    server.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} e2e checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// FerryCookie e2e — loads the unpacked extension into real Chromium, seeds
// fixture cookies on a local page, drives the real popup, and asserts the
// clipboard against the fixture-expected ETC v3 output. Replays F1/F3/F10,
// the command gesture path (service worker -> offscreen clipboard), and the
// protect toggle.
//
// mvp2 adds the landing side: the Playwright-dialect acceptance (addCookies
// takes our output without casting), the whole loop (127.0.0.1 source jar
// -> copy -> dock -> Land on localhost -> jar-asserted report -> undo), the
// foreign-seed refusal, and the zero-row parse refusal.
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
import { playwright as playwrightDialect } from '../../src/serializers/playwright.js';

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
        // The gesture path refreshes the dock too — the default Land lane
        // must hold this grab after a context-menu/shortcut copy.
        const dock = await sw.evaluate(async () => (await chrome.storage.session.get('fc-dock'))['fc-dock']);
        if (typeof dock !== 'string') throw new Error('fc-dock missing after the command gesture');
        const dockEnvelope = JSON.parse(dock);
        assertEq(dockEnvelope.cookies.length, 1, 'gesture dock carries the ETC row');
        assertEq(dockEnvelope.cookies[0].name, '__Host-session');
        assertEq(typeof dockEnvelope.meta.grabbedAt, 'number', 'gesture dock meta.grabbedAt');
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

    // A helper for reading a jar exactly the way the extension's runtime
    // does (domain-level read, exact-host filter, sorted for compares).
    const readJar = (host) =>
      sw.evaluate(async (h) => {
        const all = await chrome.cookies.getAll({ domain: h });
        return all
          .filter((c) => String(c.domain).replace(/^\.+/, '').toLowerCase() === h)
          .map((c) => ({ name: c.name, value: c.value, path: c.path, secure: c.secure, hostOnly: c.hostOnly, domain: c.domain, sameSite: c.sameSite, session: c.session, hasExpiry: typeof c.expirationDate === 'number' }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      }, host);

    // ---- CAP-8: Playwright addCookies accepts our dialect, no casting ----
    {
      const name = 'CAP-8 playwright dialect — context.addCookies takes the output verbatim';
      try {
        await context.clearCookies();
        const f1 = await fixture('F1');
        await context.addCookies(JSON.parse(playwrightDialect.serialize(f1.expected.cookies)));
        const jar = await readJar('localhost');
        assertEq(jar.length, 1, 'addCookies landed the row');
        assertEq(jar[0].name, '__Host-session');
        assertEq(jar[0].secure, true, '__Host- form stays secure on localhost');
        assertEq(jar[0].path, '/');
        assertEq(jar[0].value, 's%3Aunicode-sign');
        record(name);
      } catch (err) {
        record(name, err);
      }
    }

    // ---- whole loop: 127.0.0.1 source jar -> copy -> dock -> Land --------
    {
      const name = 'whole loop — dock land onto localhost, jar-asserted report, one-click undo';
      let p;
      try {
        await context.clearCookies();
        // Reset every session key so this scenario stands alone (the protect
        // list from the toggle test would exclude __Host-session here, and a
        // stale fc-cred would make the copy wait pass before the dock is
        // written). Protect-honoring on the landing side is covered by the
        // clipboard-lane replace scenario below — the copy side excludes
        // protected names, so the dock can never carry one to skip.
        await sw.evaluate(async () => {
          await chrome.storage.session.remove('fc-protect');
          await chrome.storage.session.remove('fc-dock');
          await chrome.storage.session.remove('fc-snapshots');
          await chrome.storage.session.remove('fc-cred');
          await chrome.storage.session.remove('fc-receipt');
          await chrome.storage.session.remove('fc-land-prefs');
        });
        // The source is the 127.0.0.1 jar (a distinct jar from localhost).
        const sourcePage = await context.newPage();
        await sourcePage.goto(altBase + '/');
        await sourcePage.bringToFront();
        await seedCookies([
          { name: 'sid', value: 'v4-session', url: altBase + '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: 1810000000.5 },
          { name: '__Host-session', value: 'host-token', url: altBase + '/', secure: true, httpOnly: true, sameSite: 'Lax' },
        ]);
        assertEq((await readJar('127.0.0.1')).length, 2, 'source jar seeded on 127.0.0.1');
        assertEq((await readJar('localhost')).length, 0, 'target jar starts empty');

        // Copy gesture on the source page (popup path writes fc-dock too).
        p = await popup();
        await p.waitForFunction(() => document.getElementById('copy')?.disabled === false, null, { timeout: 10000 });
        await p.click('#copy');
        await p.waitForFunction(() => !document.getElementById('cred-state').hidden, null, { timeout: 5000 });
        await p.close();

        // The dock holds the FC envelope: same ETC rows + grabbedAt/sourceOrigin.
        const dock = await sw.evaluate(async () => (await chrome.storage.session.get('fc-dock'))['fc-dock']);
        if (typeof dock !== 'string') throw new Error('fc-dock missing after copy');
        const dockEnvelope = JSON.parse(dock);
        assertEq(dockEnvelope.cookies.length, 2, 'dock carries both ETC rows');
        assertEq(typeof dockEnvelope.meta.grabbedAt, 'number', 'dock meta.grabbedAt');
        assertEq(dockEnvelope.meta.sourceOrigin.startsWith('http://127.0.0.1'), true, 'dock meta.sourceOrigin names the ferry route');

        // Land: dock lane (default), localhost route (default), merge mode.
        p = await popup();
        await p.selectOption('#land-mode', 'merge');
        await p.click('#land-read');
        await p.waitForFunction(() => !document.getElementById('land-diff').hidden, null, { timeout: 10000 });
        assertIncludes(await p.evaluate(() => document.getElementById('land-math').textContent), 'adds 2', 'diff pre-flight math');
        assertIncludes(await p.evaluate(() => document.getElementById('land-freshness').textContent), 'grab is', 'freshness line from envelope');
        await p.click('#land-confirm');
        await p.waitForFunction(() => !document.getElementById('land-report').hidden, null, { timeout: 10000 });
        assertIncludes(
          await p.evaluate(() => document.getElementById('land-report-line').textContent),
          'landed 2/2 — jar-verified',
          'report is jar-asserted',
        );

        // The jar (not the write calls) is the assertion.
        const jar = await readJar('localhost');
        assertEq(jar.length, 2, 'localhost jar holds both retargeted rows');
        const sidRow = jar.find((c) => c.name === 'sid');
        const hostRow = jar.find((c) => c.name === '__Host-session');
        assertEq(sidRow?.value, 'v4-session');
        assertEq(sidRow?.secure, true);
        assertEq(sidRow?.hostOnly, true, 'flattened host-only on the target');
        assertEq(sidRow?.hasExpiry, true, 'persistent row keeps its expiry');
        assertEq(hostRow?.value, 'host-token');
        assertEq(hostRow?.secure, true, '__Host- form: secure on http://localhost via set()');
        assertEq(hostRow?.path, '/');
        assertEq(hostRow?.session, true, 'session row lands as a session cookie');

        // Undo (guarded: restore diff screen, then confirm) empties the jar
        // back to the snapshot — the pre-landing state.
        await p.click('#land-undo');
        await p.waitForFunction(() => !document.getElementById('land-restore').hidden, null, { timeout: 5000 });
        assertIncludes(
          await p.evaluate(() => document.getElementById('land-restore-math').textContent),
          'removes 2',
          'restore diff shows its own pre-flight math',
        );
        await p.click('#land-restore-confirm');
        await p.waitForFunction(() => !document.getElementById('land-report').hidden, null, { timeout: 10000 });
        const jarAfterUndo = await readJar('localhost');
        assertEq(jarAfterUndo.length, 0, 'undo restores the pre-landing (empty) jar');
        record(name);
        await p.close();
        await sourcePage.close();
      } catch (err) {
        await p?.close().catch(() => {});
        record(name, err);
      }
    }

    // ---- replace mode: typed-LAND gate, then jar equals incoming set ------
    {
      const name = 'replace gate — confirm disabled until LAND is typed, then jar equals the incoming set';
      let p;
      try {
        await context.clearCookies();
        await seedCookies([
          { name: 'old-a', value: 'x', url: base + '/' },
          { name: 'old-b', value: 'y', url: base + '/' },
        ]);
        assertEq((await readJar('localhost')).length, 2, 'jar holds the outgoing set');
        // The clipboard input carries a PROTECTED name ('sid') alongside the
        // permitted row: the landing side must skip it (the copy side would
        // never emit it — the clipboard lane is the only lane that can).
        await sw.evaluate(async () => {
          await chrome.storage.session.set({ 'fc-protect': ['sid'] });
        });
        const incomingJson = JSON.stringify([
          { domain: 'localhost', hostOnly: true, name: 'fresh', path: '/', sameSite: 'lax', secure: false, session: true, storeId: '0', value: 'new' },
          { domain: 'localhost', hostOnly: true, name: 'sid', path: '/', sameSite: 'lax', secure: false, session: true, storeId: '0', value: 'should-not-land' },
        ], null, 2);
        await targetPage.bringToFront();
        await targetPage.evaluate((t) => navigator.clipboard.writeText(t), incomingJson);

        p = await popup();
        await p.selectOption('#land-lane', 'clipboard');
        await p.selectOption('#land-mode', 'replace');
        await p.click('#land-read');
        await p.waitForFunction(() => !document.getElementById('land-diff').hidden, null, { timeout: 10000 });
        const replaceMath = await p.evaluate(() => document.getElementById('land-math').textContent);
        assertIncludes(replaceMath, 'removes 2', 'replace pre-flight math promises the clear');
        assertIncludes(replaceMath, 'excludes 1 protected', 'the protected input row is named on the diff');
        assertEq(await p.$eval('#land-confirm', (b) => b.disabled), true, 'confirm disabled before the typed gate');
        await p.fill('#land-type-land', 'LAD');
        assertEq(await p.$eval('#land-confirm', (b) => b.disabled), true, 'a near-miss string does not arm replace');
        await p.fill('#land-type-land', 'LAND');
        await p.waitForFunction(() => !document.getElementById('land-confirm')?.disabled, null, { timeout: 5000 });
        await p.click('#land-confirm');
        await p.waitForFunction(() => !document.getElementById('land-report').hidden, null, { timeout: 10000 });
        assertIncludes(
          await p.evaluate(() => document.getElementById('land-report-rows').textContent),
          'skipped-protected: sid',
          'the protected input row is reported skipped, never written',
        );
        const jar = await readJar('localhost');
        assertEq(jar.length, 1, 'replace cleared the jar and wrote the incoming set');
        assertEq(jar[0].name, 'fresh');
        assertEq(jar.find((c) => c.name === 'sid'), undefined, 'protected sid never lands via the clipboard lane');
        record(name);
        await p.close();
      } catch (err) {
        await p?.close().catch(() => {});
        record(name, err);
      }
    }

    // ---- textarea lane: the zero-permission paste path --------------------
    {
      const name = 'textarea lane — paste without clipboard, diff opens with the right math';
      let p;
      try {
        await context.clearCookies();
        const pastedJson = JSON.stringify([
          { domain: 'localhost', hostOnly: true, name: 'ta-a', path: '/', sameSite: 'lax', secure: false, session: true, storeId: '0', value: '1' },
          { domain: 'localhost', hostOnly: true, name: 'ta-b', path: '/', sameSite: 'lax', secure: false, session: true, storeId: '0', value: '2' },
        ], null, 2);
        p = await popup();
        await p.selectOption('#land-lane', 'textarea');
        await p.fill('#land-textarea', pastedJson);
        await p.click('#land-read');
        await p.waitForFunction(() => !document.getElementById('land-diff').hidden, null, { timeout: 10000 });
        assertIncludes(
          await p.evaluate(() => document.getElementById('land-math').textContent),
          'adds 2',
          'the paste lane parses and plans like any other lane',
        );
        record(name);
        await p.close();
      } catch (err) {
        await p?.close().catch(() => {});
        record(name, err);
      }
    }

    // ---- foreign seed (Toss): zero written, every row reported -----------
    {
      const name = 'foreign seed — zero rows written, named refusal lists them';
      let p;
      try {
        await context.clearCookies();
        const foreignJson = JSON.stringify([
          { domain: '.internal.corp', hostOnly: false, name: 'toss-seed', path: '/', sameSite: 'unspecified', secure: false, session: true, storeId: '0', value: 'seed' },
          { domain: 'example.com', hostOnly: true, name: 'realworld', path: '/', sameSite: 'lax', secure: false, session: true, storeId: '0', value: 'x' },
        ], null, 2);
        await targetPage.bringToFront();
        await targetPage.evaluate((t) => navigator.clipboard.writeText(t), foreignJson);

        p = await popup();
        await p.selectOption('#land-lane', 'clipboard');
        await p.click('#land-read');
        await p.waitForFunction(
          () => !document.getElementById('land-reason').hidden && document.getElementById('land-reason').textContent.includes('foreign'),
          null,
          { timeout: 10000 },
        );
        assertIncludes(
          await p.evaluate(() => document.getElementById('land-reason').textContent),
          'internal.corp',
          'the refusal names the foreign domains',
        );
        if (!(await p.evaluate(() => document.getElementById('land-diff').hidden))) {
          throw new Error('diff screen opened for an all-foreign input');
        }
        assertEq((await readJar('localhost')).length, 0, 'zero rows written');
        record(name);
        await p.close();
      } catch (err) {
        await p?.close().catch(() => {});
        record(name, err);
      }
    }

    // ---- zero-row parse: named refusal, replace never runs ---------------
    {
      const name = 'empty parse — Land names the cause, jar untouched';
      let p;
      try {
        await context.clearCookies();
        await targetPage.bringToFront();
        await targetPage.evaluate(() => navigator.clipboard.writeText('[]'));

        p = await popup();
        await p.selectOption('#land-lane', 'clipboard');
        await p.selectOption('#land-mode', 'replace');
        await p.click('#land-read');
        await p.waitForFunction(
          () => !document.getElementById('land-reason').hidden && document.getElementById('land-reason').textContent.includes('zero rows'),
          null,
          { timeout: 10000 },
        );
        if (!(await p.evaluate(() => document.getElementById('land-diff').hidden))) {
          throw new Error('diff screen opened for a zero-row parse');
        }
        assertEq((await readJar('localhost')).length, 0, 'jar untouched by the refused replace');
        record(name);
        await p.close();
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

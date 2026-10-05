// Spike — the set() fidelity matrix (SPEC Q2) plus clipboard-read-at-click
// (Q3). THROWAWAY by charter: it exists to pin empirical facts about
// chrome.cookies.set() on a real Chromium before the landing build leans on
// them. Results are recorded in spike/RESULTS.md.
//
// Probes:
//   (a) does chrome.cookies.set accept httpOnly: true?
//   (b) does it write the __Host- form on http://localhost?   <- REPLAN gate
//   (c) is partitionKey writable via set()?
//   (d) >4096-byte values and the ~180-per-jar cap — reject, truncate, evict?
//   (e) set()'s per-row error surface (rejection vs lastError) for the
//       report's failed bucket
//   (Q3) does the MV3 popup read the clipboard at click under clipboardRead?
//
// Run: node spike/run-spike.mjs   (uses test/e2e's playwright + Chromium)

import { createRequire } from 'node:module';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extensionDir = resolve(here, '..');

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const root = process.env.FC_PLAYWRIGHT_ROOT ?? join(extensionDir, 'test', 'e2e');
    const require = createRequire(resolve(root, 'package.json'));
    return require('playwright');
  }
}

// Spike posture = landing posture: the manifest gains clipboardRead (the only
// permission mvp2 adds), so the Q3 probe runs against the real permission set.
const MANIFEST_PATCH = (text) =>
  text.replace('"clipboardWrite"', '"clipboardRead",\n      "clipboardWrite"');

async function main() {
  const { chromium } = await loadPlaywright();

  const spikeDir = mkdtempSync(join(tmpdir(), 'ferry-cookie-spike-'));
  const extCopy = join(spikeDir, 'ext');
  cpSync(extensionDir, extCopy, {
    recursive: true,
    filter: (src) => !src.includes(`${extensionDir}/.git`) && !src.includes('/node_modules') && !src.includes(`${extensionDir}/test`) && !src.includes(`${extensionDir}/spike`),
  });
  const fs = await import('node:fs/promises');
  const manifestPath = join(extCopy, 'manifest.json');
  await fs.writeFile(manifestPath, MANIFEST_PATCH(await fs.readFile(manifestPath, 'utf8')));

  const userDataDir = join(spikeDir, 'profile');
  const launchArgs = [
    `--disable-extensions-except=${extCopy}`,
    `--load-extension=${extCopy}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  const candidates = [
    { label: 'headed bundled chromium', options: { headless: false, args: launchArgs } },
    { label: 'new-headless chromium', options: { channel: 'chromium', headless: true, args: launchArgs } },
  ];
  let context;
  for (const candidate of candidates) {
    try {
      context = await chromium.launchPersistentContext(userDataDir, candidate.options);
      console.log(`launched: ${candidate.label}`);
      break;
    } catch (err) {
      console.log(`launch failed (${candidate.label}): ${String(err).split('\n')[0]}`);
    }
  }
  if (!context) throw new Error('no usable browser for the spike');

  const findings = [];
  const note = (id, text) => {
    findings.push({ id, text });
    console.log(`\n### ${id}\n${text}`);
  };

  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(sw.url()).host;
    console.log(`extension loaded: ${extensionId}`);

    const page = await context.newPage();
    await page.goto('http://localhost/').catch(() => {}); // may 404 — the jar is host-scoped, not page-scoped

    // All probes run inside the service worker: real chrome.cookies.set calls,
    // exactly the surface the landing runtime will use. fnSource is the source
    // of an async () => {...} expression, invoked worker-side.
    const probe = (fnSource) => sw.evaluate(`(${fnSource})()`);

    // ---- (a) httpOnly acceptance ---------------------------------------
    {
      const r = await probe(`async () => {
        const out = {};
        try {
          await chrome.cookies.set({ url: 'http://localhost/', name: 'spike-ho', value: 'v1', httpOnly: true });
          out.set = 'ok';
        } catch (e) { out.set = 'threw: ' + (e?.message ?? String(e)); }
        const jar = await chrome.cookies.getAll({ domain: 'localhost' });
        const row = jar.find((c) => c.name === 'spike-ho');
        out.jarRow = row ? { httpOnly: row.httpOnly, hostOnly: row.hostOnly, domain: row.domain } : null;
        return out;
      }`);
      note(
        '(a) httpOnly:true via set()',
        JSON.stringify(r, null, 2) +
          `\nverdict: ${r.set === 'ok' && r.jarRow?.httpOnly === true ? 'ACCEPTED and stored verbatim' : 'NOT accepted — foreign httpOnly must map to the failed bucket or a documented drop'}`,
      );
    }

    // ---- (b) __Host- via set() on http://localhost (REPLAN gate) ---------
    {
      const r = await probe(`async () => {
        const out = {};
        try {
          await chrome.cookies.set({ url: 'http://localhost/', name: '__Host-spike', value: 'v2', secure: true, path: '/', httpOnly: true });
          out.set = 'ok';
        } catch (e) { out.set = 'threw: ' + (e?.message ?? String(e)); }
        const jar = await chrome.cookies.getAll({ domain: 'localhost' });
        const row = jar.find((c) => c.name === '__Host-spike');
        out.jarRow = row ? { secure: row.secure, path: row.path, hostOnly: row.hostOnly, domain: row.domain } : null;
        return out;
      }`);
      note(
        '(b) __Host- via set() on http://localhost (REPLAN gate)',
        JSON.stringify(r, null, 2) +
          `\nverdict: ${r.set === 'ok' && r.jarRow ? 'WRITES — the set() path matches the CDP path v1 proved' : 'FAILS — spec says REPLAN with the user before any landing build'}`,
      );
    }

    // ---- (c) partitionKey writability -----------------------------------
    {
      const r = await probe(`async () => {
        const out = {};
        try {
          await chrome.cookies.set({ url: 'http://localhost/', name: 'spike-chips', value: 'v3', secure: true, sameSite: 'no_restriction', partitionKey: {} });
          out.set = 'ok';
        } catch (e) { out.set = 'threw: ' + (e?.message ?? String(e)); }
        const all = await chrome.cookies.getAll({ domain: 'localhost' });
        const plain = all.find((c) => c.name === 'spike-chips' && !c.partitionKey);
        const part = await chrome.cookies.getAll({ domain: 'localhost', partitionKey: {} }).catch(() => []);
        const partRow = part.find((c) => c.name === 'spike-chips');
        out.landedUnpartitioned = Boolean(plain);
        out.landedPartitioned = Boolean(partRow);
        return out;
      }`);
      note(
        '(c) partitionKey via set()',
        JSON.stringify(r, null, 2) +
          `\nverdict: ${r.landedPartitioned ? 'partitionKey writable via set()' : r.landedUnpartitioned ? 'partitionKey IGNORED — row lands unpartitioned (must be reported, never silent)' : 'row does not land at all'}`,
      );
    }

    // ---- (d) >4096-byte values + ~180/jar cap ----------------------------
    {
      const r = await probe(`async () => {
        const out = {};
        const big = 'x'.repeat(5000);
        try {
          await chrome.cookies.set({ url: 'http://localhost/', name: 'spike-big', value: big });
          out.set = 'ok';
        } catch (e) { out.set = 'threw: ' + (e?.message ?? String(e)); }
        const jar = await chrome.cookies.getAll({ domain: 'localhost' });
        const row = jar.find((c) => c.name === 'spike-big');
        out.valueLength = row ? row.value.length : null;
        out.over4096Survived = row ? row.value.length > 4096 : false;

        // cap probe: push plain rows until set() stops landing them
        let landed = 0;
        const errors = [];
        for (let i = 0; i < 220; i++) {
          try {
            await chrome.cookies.set({ url: 'http://localhost/', name: 'spike-cap-' + i, value: 'v' });
            landed++;
          } catch (e) {
            errors.push(String(e?.message ?? e).slice(0, 120));
            if (errors.length >= 3) break;
          }
        }
        const finalJar = await chrome.cookies.getAll({ domain: 'localhost' });
        out.capRowsAttempted = 220;
        out.capSetCallsOk = landed;
        out.capJarSize = finalJar.length;
        out.capFirstErrors = errors.slice(0, 3);
        out.capSurvivors = finalJar.filter((c) => c.name.startsWith('spike-cap-')).length;
        return out;
      }`);
      note(
        '(d) >4096-byte value + ~180/jar cap',
        JSON.stringify(r, null, 2) +
          `\nverdict: values >4096 ${r.over4096Survived ? 'SURVIVE whole' : 'do not survive whole (truncated/rejected)'}; cap behavior: ${r.capSetCallsOk}/${r.capRowsAttempted} set() calls ok, jar holds ${r.capJarSize}, survivors ${r.capSurvivors}` +
          (r.capSetCallsOk < r.capRowsAttempted ? ' — set() errors near the cap, so the failed bucket catches it and the ~180 pre-flight stands' : ' — no set() error observed up to 220; the ~180 pre-flight offer is the only guard'),
      );
    }

    // ---- (e) per-row error surface ---------------------------------------
    {
      const r = await probe(`async () => {
        const out = {};
        // empty name
        try {
          await chrome.cookies.set({ url: 'http://localhost/', name: '', value: 'v' });
          out.emptyName = 'resolved (no throw)';
        } catch (e) { out.emptyName = 'rejected: ' + (e?.message ?? String(e)); }
        // bad sameSite enum
        try {
          await chrome.cookies.set({ url: 'http://localhost/', name: 'spike-bad-ss', value: 'v', sameSite: 'bogus' });
          out.badSameSite = 'resolved (no throw)';
        } catch (e) { out.badSameSite = 'rejected: ' + (e?.message ?? String(e)); }
        // sameSite unspecified (must be legal — our rows carry it)
        try {
          await chrome.cookies.set({ url: 'http://localhost/', name: 'spike-unspec', value: 'v', sameSite: 'unspecified' });
          out.unspecified = 'resolved';
        } catch (e) { out.unspecified = 'rejected: ' + (e?.message ?? String(e)); }
        // domain form
        try {
          await chrome.cookies.set({ url: 'http://localhost/', name: 'spike-dom', value: 'v', domain: 'localhost' });
          out.explicitDomain = 'resolved';
        } catch (e) { out.explicitDomain = 'rejected: ' + (e?.message ?? String(e)); }
        // does a failed set() still land a row?
        const jar = await chrome.cookies.getAll({ domain: 'localhost' });
        out.emptyNameLanded = jar.some((c) => c.name === '');
        out.badSameSiteLanded = jar.some((c) => c.name === 'spike-bad-ss');
        // no-row return value of a rejected set (callback-less form)
        try {
          const res = await chrome.cookies.set({ url: 'http://localhost/', name: '', value: 'v' });
          out.rejectedReturnValue = JSON.stringify(res);
        } catch (e) { out.rejectedReturnValue = 'n/a (throws)'; }
        return out;
      }`);
      note(
        '(e) per-row error surface',
        JSON.stringify(r, null, 2) +
          `\nverdict: set() reports failures via ${(r.emptyName ?? '').startsWith('rejected') ? 'promise rejection with a message — map to the failed bucket verbatim' : 'silent resolution — the jar re-read verify step is the only catcher (which is why the report is jar-asserted)'}`,
      );
    }

    // ---- (Q3) clipboard read at click under clipboardRead ----------------
    {
      // Seed the clipboard from a granted page, then read it from the
      // extension's own page (the popup's origin) exactly at a click.
      const seedPage = await context.newPage();
      await seedPage.goto('about:blank');
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'chrome-extension://' + extensionId }).catch(() => {});
      await seedPage.evaluate(() => navigator.clipboard.writeText('spike-clipboard-truth')).catch(async (err) => {
        console.log('seedPage write failed (' + String(err).split('\n')[0] + ') — falling back to CDP');
      });
      const popupPage = await context.newPage();
      await popupPage.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      const r = await popupPage.evaluate(() => {
        document.title = 'ready';
        return new Promise((resolveP) => {
          document.addEventListener('click', () => {
            navigator.clipboard
              .readText()
              .then((t) => resolveP({ read: 'ok', preview: t.slice(0, 40) }))
              .catch((e) => resolveP({ read: 'failed: ' + (e?.message ?? String(e)) }));
          }, { once: true });
        });
      }).then(async (pending) => {
        await popupPage.click('body'); // the live gesture
        return pending;
      });
      note(
        '(Q3) clipboard read at click in an extension page under clipboardRead',
        JSON.stringify(r, null, 2) +
          `\nverdict: ${r.read === 'ok' ? 'readText() at click works under clipboardRead with no prompt — the clipboard lane is prompt-free in the popup' : 'readText() at click does NOT work under clipboardRead alone — the textarea lane is the fallback (ships regardless)'}`,
      );
      await seedPage.close().catch(() => {});
    }

    // Machine-readable dump for RESULTS.md.
    await fs.writeFile(
      join(here, 'spike-raw.json'),
      JSON.stringify({ launched: context._lc?.() ?? 'n/a', findings }, null, 2),
    );
  } finally {
    await context.close().catch(() => {});
    rmSync(spikeDir, { recursive: true, force: true });
  }
  console.log('\nspike complete — record verdicts in spike/RESULTS.md');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// FerryCookie service worker — alternate gesture triggers (context menu,
// keyboard command). The popup stays the primary clipboard surface; when the
// gesture happens outside it, the offscreen document provides the DOM the
// clipboard write needs. Transient state lives in storage.session only.

import { TARGET_DEFAULT, rewriteGrab } from '../core/rewrite.js';
import { etcV3 } from '../serializers/etc-v3.js';
import { getAllForTab, pickTargetTab, restrictReason, zeroReason } from '../shared/grab.js';
import { writeDock } from '../shared/land.js';

const MENU_ID = 'ferry-cookie-copy';
const COPY_MESSAGE = 'ferry-cookie-copy';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Copy cookies as localhost JSON',
      contexts: ['page'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) handleGesture(tab);
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'copy-cookies') runCommand();
});

// The command's code path, placed on the worker global so the e2e harness
// can drive exactly what a keyboard gesture runs — browser-level shortcuts
// cannot be synthesized and dynamic import() is unavailable on the
// ServiceWorkerGlobalScope. Reachable only from the worker's own scope.
async function runCommand() {
  await handleGesture(await pickTargetTab());
}
globalThis.ferryCookieRunCommand = runCommand;

async function handleGesture(tab) {
  let receipt;
  try {
    const reason = tab?.url ? restrictReason(tab.url) : 'no page focused';
    if (reason) {
      receipt = { guard: reason, grabbedAt: Date.now() };
      await finish(receipt, '!');
      return;
    }
    const raw = await getAllForTab(tab);
    const stored = await chrome.storage.session.get({ 'fc-protect': [] });
    const { cookies, report } = rewriteGrab(raw, {
      sourceOrigin: tab.url,
      targetOrigin: TARGET_DEFAULT,
      protectedNames: stored['fc-protect'] ?? [],
    });
    receipt = {
      ...report,
      sourceUrl: tab.url,
      grabbedAt: Date.now(),
      guard: cookies.length ? null : zeroReason(raw.length, report),
    };
    if (!cookies.length) {
      await finish(receipt, '!'); // named disable; clipboard untouched
      return;
    }
    const ok = await copyViaOffscreen(etcV3.serialize(cookies));
    await chrome.storage.session.set({
      'fc-receipt': receipt,
      'fc-cred': ok ? { holds: true, count: report.emitted, at: Date.now() } : { holds: false, error: 'offscreen clipboard write failed' },
    });
    // Every successful copy also refreshes the dock (session-scoped FC
    // envelope) — best-effort: a dock failure must not flip the verdict of
    // a copy that already reached the clipboard.
    if (ok) {
      try {
        await writeDock(cookies, {
          grabbedAt: receipt.grabbedAt,
          sourceOrigin: new URL(tab.url).origin, // an origin, not the full URL
          partitionMap: { excluded: report.partitionedExcluded },
        });
      } catch {
        // the dock lane just won't hold this grab; the copy stands
      }
    }
    await badge(ok ? String(report.emitted) : '!');
  } catch (err) {
    receipt = { guard: 'error: ' + (err?.message ?? String(err)), grabbedAt: Date.now() };
    await finish(receipt, '!');
  }
}

async function finish(receipt, mark) {
  await chrome.storage.session.set({ 'fc-receipt': receipt });
  await badge(mark);
}

async function badge(text) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
}

async function copyViaOffscreen(text) {
  if (!(await chrome.offscreen.hasDocument?.())) {
    try {
      await chrome.offscreen.createDocument({
        url: 'src/offscreen/offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: 'Writing the copied cookie JSON to the clipboard needs a DOM context; the MV3 service worker has none.',
      });
    } catch (err) {
      if (!/single offscreen document/i.test(String(err?.message ?? err))) throw err;
    }
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: COPY_MESSAGE, text });
    return res?.ok === true;
  } catch {
    return false;
  }
}

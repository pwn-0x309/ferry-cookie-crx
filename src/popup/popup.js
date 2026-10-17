// FerryCookie popup — the primary clipboard surface (DOM + user gesture).
// Renders via textContent only; cookie values never enter the DOM.

import { TARGET_DEFAULT, jarKey, previewOverlap, rewriteGrab } from '../core/rewrite.js';
import { etcV3 } from '../serializers/etc-v3.js';
import { getAllForTab, getLocalJarCookies, pickTargetTab, restrictReason, zeroReason } from '../shared/grab.js';
import { writeDock } from '../shared/land.js';
import { initLandFlow } from './land-flow.js';

const $ = (id) => document.getElementById(id);

// Fast mode is a pure UI preference (which surface to lead with) — the only
// persistent state the extension keeps; every cookie-derived state stays
// session-scoped.
const FAST_KEY = 'fc-fast-mode';

const state = {
  tab: null,
  raw: [],
  grab: null,
  overlap: [],
  protect: [],
  guard: null,
  cred: null,
  grabbedAt: null,
  fast: false,
  fastGrab: null, // the grab made through the fast button, this popup only — never stale session history
};

let landFlowApi = null;

init();

async function init() {
  wireEvents();
  chrome.action.setBadgeText({ text: '' }); // the popup shows the full receipt
  try {
    const storedFast = await chrome.storage.local.get(FAST_KEY);
    state.fast = storedFast[FAST_KEY] === true;
    // The protect list is session state shared by copy and landing; load it
    // even on guarded pages so the Land flow can honor it anywhere.
    const storedProtect = await chrome.storage.session.get({ 'fc-protect': [] });
    state.protect = storedProtect['fc-protect'] ?? [];
    const tab = await pickTargetTab();
    if (!tab?.url) throw new Error('no active page found');
    state.tab = tab;
    state.guard = restrictReason(tab.url);
    if (!state.guard) await refreshGrab();
    const stored = await chrome.storage.session.get('fc-cred');
    state.cred = stored['fc-cred'] ?? null;
  } catch (err) {
    state.guard = 'error: ' + (err?.message ?? String(err));
  }
  landFlowApi = initLandFlow({
    getProtect: () => state.protect,
    getActiveTabUrl: () => state.tab?.url ?? null,
    getActiveTab: () => state.tab, // for Land & Reload — the page, never the popup
  });
  applyFastMode();
  render();
  // One-time, on popup open: if a protected row is in the preview, expand it
  // so the checkbox — the only way back out of the protect list — is not
  // buried in a collapsed section. Later renders never force it either way.
  if (state.overlap.some((row) => state.protect.includes(row.name))) {
    $('preview-details').open = true;
  }
}

function wireEvents() {
  $('copy').addEventListener('click', onCopy);
  $('clear').addEventListener('click', onClear);
  $('preview-list').addEventListener('change', onProtectToggle);
  $('fast-toggle').addEventListener('change', onFastToggle);
  $('fast-grab').addEventListener('click', onCopy); // the same grab gesture, one-button surface
  $('fast-land').addEventListener('click', onFastLand);
  $('fast-reset').addEventListener('click', onFastReset);
}

async function refreshGrab() {
  const stored = await chrome.storage.session.get({ 'fc-protect': [] });
  state.protect = stored['fc-protect'] ?? [];
  state.raw = await getAllForTab(state.tab);
  state.grabbedAt = Date.now();
  state.grab = rewriteGrab(state.raw, {
    sourceOrigin: state.tab.url,
    targetOrigin: TARGET_DEFAULT,
    protectedNames: state.protect,
  });
  // The preview runs on the same grab WITHOUT the protect list: protected
  // rows must stay visible (checked) or their checkbox — the only way to
  // un-protect a name — would vanish the moment it is ticked.
  const unguarded = rewriteGrab(state.raw, {
    sourceOrigin: state.tab.url,
    targetOrigin: TARGET_DEFAULT,
    protectedNames: [],
  });
  const local = await getLocalJarCookies(TARGET_DEFAULT);
  state.overlap = previewOverlap(unguarded.cookies, local);
}

async function onCopy() {
  if (!state.grab?.cookies.length) return; // an empty array never reaches the clipboard
  const text = etcV3.serialize(state.grab.cookies);
  try {
    await navigator.clipboard.writeText(text); // the popup click is the user gesture
    state.cred = { holds: true, count: state.grab.cookies.length, at: Date.now(), site: jarKey(state.tab.url) };
    if (state.fast) state.fastGrab = state.cred;
    await chrome.storage.session.set({ 'fc-cred': state.cred, 'fc-receipt': receiptOf() });
  } catch (err) {
    state.cred = { holds: false, error: err?.message ?? String(err) };
    if (state.fast) state.fastGrab = state.cred;
    render();
    return;
  }
  // Every successful copy also refreshes the dock (the session-scoped FC
  // envelope) — best-effort: a dock failure must not flip the verdict of a
  // copy that already reached the clipboard.
  if (state.cred.holds) {
    try {
        await writeDock(state.grab.cookies, {
          grabbedAt: state.grabbedAt,
          sourceOrigin: new URL(state.tab.url).origin, // an origin, not the full URL
          partitionMap: { excluded: state.grab.report.partitionedExcluded },
        });
    } catch {
      // the dock lane just won't hold this grab; the copy stands
    }
  }
  render();
}

async function onClear() {
  try {
    await navigator.clipboard.writeText(''); // one-tap clear, same gesture surface
    state.cred = null;
    await chrome.storage.session.set({ 'fc-cred': null });
  } catch (err) {
    // clipboard still holds the cookies — keep the credential state and say so
    state.cred = { ...(state.cred ?? { holds: true, count: 0 }), error: err?.message ?? String(err) };
  }
  render();
}

async function onProtectToggle(event) {
  if (!event.target.matches('input[type="checkbox"]')) return;
  const next = new Set(state.protect);
  if (event.target.checked) next.add(event.target.dataset.name);
  else next.delete(event.target.dataset.name);
  state.protect = [...next];
  try {
    await chrome.storage.session.set({ 'fc-protect': state.protect }); // names only, session only
    await refreshGrab();
  } catch (err) {
    state.guard = 'error: ' + (err?.message ?? String(err));
  }
  render();
}

function receiptOf() {
  return {
    ...state.grab.report,
    guard: state.guard,
    sourceUrl: state.tab?.url ?? null,
    grabbedAt: state.grabbedAt,
  };
}

// Fast mode: the popup is one button. The destination side is the localhost
// family (the grab's rewrite target); everything else — real sites, and the
// alternate loopback jars 127.0.0.1/[::1] used as production stand-ins — is
// a grab side.
function isDestSide() {
  if (!state.tab?.url) return false;
  const host = jarKey(state.tab.url);
  return host === 'localhost' || host.endsWith('.localhost');
}

function applyFastMode() {
  document.body.classList.toggle('fast', state.fast);
  $('fast-toggle').checked = state.fast;
  // Details (receipt, flags, protect list, land controls) reads like today's
  // UI in full mode; fast mode keeps it closed until asked for. Manual opens
  // survive — this runs only on init and on the toggle, never on render.
  $('fast-details').open = !state.fast;
}

async function onFastToggle() {
  state.fast = $('fast-toggle').checked;
  try {
    await chrome.storage.local.set({ [FAST_KEY]: state.fast });
  } catch {
    // a missed preference persistence must not break the surface switch
  }
  applyFastMode();
  render();
}

function onFastLand() {
  if (!isDestSide() || !landFlowApi) return;
  landFlowApi.quickLandTo(jarKey(state.tab.url)); // pinned: dock, fill-gaps, this host
}

// Reset clears the ferry itself: the docked grab, the credential state,
// the fast result, and (best-effort) the clipboard. It never touches the
// protect list — a standing protection — nor the undo snapshots.
async function onFastReset() {
  const note = $('land-reason');
  try {
    await chrome.storage.session.remove('fc-dock');
    await chrome.storage.session.remove('fc-cred');
    state.cred = null;
    state.fastGrab = null;
    try {
      await navigator.clipboard.writeText(''); // same one-tap clear as full mode
    } catch {
      // the dock is the deed; a refused clipboard clear must not undo it
    }
    note.textContent = 'ferry reset — dock and clipboard cleared';
  } catch (err) {
    note.textContent = 'reset failed: ' + (err?.message ?? String(err));
  }
  note.hidden = false;
  render();
}

function timeOf(ts) {
  return ts ? new Date(ts).toLocaleTimeString() : '';
}

function render() {
  const emitted = state.grab?.cookies.length ?? 0;
  const zero = !state.guard && state.grab && emitted === 0;

  $('source-line').textContent = state.tab?.url ? jarKey(state.tab.url) : '—';

  const guardEl = $('guard');
  const guardHint = $('guard-hint');
  if (state.guard) {
    $('guard-reason').textContent = `Copy disabled — ${state.guard}.`;
    // A guard states the fact; the hint gives the way out.
    guardHint.textContent =
      state.guard.startsWith('error:')
        ? 'Reopen the popup — if it persists, reload the page and try again.'
        : 'FerryCookie works on normal http(s) pages — open one and click the icon again.';
    guardEl.hidden = false;
  } else if (zero) {
    $('guard-reason').textContent = `Copy disabled — ${zeroReason(state.raw.length, state.grab.report)}.`;
    guardHint.textContent = 'Nothing to ferry from this site. Grab from a site you are logged into instead.';
    guardEl.hidden = false;
  } else {
    guardEl.hidden = true;
  }

  const receiptEl = $('receipt');
  if (!state.guard && state.grab && emitted > 0) {
    $('receipt-count').textContent = String(emitted);
    $('receipt-cookies-label').textContent = emitted === 1 ? 'cookie' : 'cookies';
    $('receipt-time').textContent = timeOf(state.grabbedAt);
    receiptEl.hidden = false;
  } else {
    receiptEl.hidden = true;
  }

  renderCred();
  renderFlags();
  renderPreview();
  renderFast(emitted);

  $('copy').disabled = Boolean(state.guard) || emitted === 0;
}

function renderFast(emitted) {
  if (!state.fast) {
    $('fast-view').hidden = true;
    return;
  }
  const dest = isDestSide();
  $('fast-view').hidden = false;
  $('fast-grab').hidden = dest;
  $('fast-land').hidden = !dest;
  $('fast-land-row').hidden = !dest;
  $('fast-land-meta').hidden = !dest;
  $('fast-grab').disabled = Boolean(state.guard) || emitted === 0; // same gate as Copy

  const res = $('fast-result');
  const grab = state.fastGrab;
  if (!dest && grab?.holds) {
    res.textContent = `Collected ${grab.count} cookie${grab.count === 1 ? '' : 's'} from ${grab.site}`;
    res.classList.remove('error');
    res.hidden = false;
  } else if (!dest && grab && !grab.holds) {
    res.textContent = `Grab failed — ${grab.error}`;
    res.classList.add('error');
    res.hidden = false;
  } else {
    res.hidden = true;
  }
}

function renderCred() {
  const el = $('cred-state');
  const clear = $('clear');
  const parts = [];
  if (state.cred?.holds) parts.push(`Clipboard holds ${state.cred.count} cookie${state.cred.count === 1 ? '' : 's'} (copied ${timeOf(state.cred.at)}).`);
  if (state.cred?.error) parts.push(`Clipboard write failed: ${state.cred.error}`);
  el.textContent = parts.join(' ');
  el.hidden = parts.length === 0;
  clear.hidden = !state.cred?.holds;
}

function renderFlags() {
  const ul = $('flags');
  ul.replaceChildren();
  const report = state.grab?.report;
  if (!report) return;
  const lines = [];
  if (report.partitionedExcluded > 0) {
    lines.push(`${report.partitionedExcluded} partitioned excluded — they would not behave locally anyway`);
  }
  if (report.duplicatesCollapsed > 0) {
    lines.push(`${report.duplicatesCollapsed} duplicate collapsed (last write wins)`);
  }
  if (report.hostPrefixCoercedNames.length) {
    lines.push(`normalized to the legal __Host- form: ${report.hostPrefixCoercedNames.join(', ')}`);
  }
  if (report.brokenPairNames.length) {
    lines.push(`sameSite None without Secure (copied as-is): ${report.brokenPairNames.join(', ')}`);
  }
  if (report.protectedNames.length) {
    lines.push(`protected, not copied: ${report.protectedNames.join(', ')}`);
  }
  for (const line of lines) {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  }
}

function renderPreview() {
  const section = $('preview');
  const ul = $('preview-list');
  if (!state.overlap.length) {
    section.hidden = true;
    ul.replaceChildren();
    return;
  }
  section.hidden = false;
  $('preview-count').textContent = String(state.overlap.length);
  ul.replaceChildren();
  for (const row of state.overlap) {
    const li = document.createElement('li');

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = state.protect.includes(row.name);
    box.dataset.name = row.name;
    box.id = `protect-${CSS.escape(row.name)}-${CSS.escape(row.domain)}-${CSS.escape(row.path)}`;
    box.setAttribute('aria-label', `protect ${row.name} ${row.domain} ${row.path} from being grabbed`);

    const label = document.createElement('label');
    label.htmlFor = box.id;
    const name = document.createElement('span');
    name.textContent = row.name;
    const path = document.createElement('span');
    path.className = 'path';
    path.textContent = row.path;
    const domain = document.createElement('span');
    domain.className = 'path';
    domain.textContent = row.domain;
    label.append(name, path, domain);

    li.append(box, label);
    ul.appendChild(li);
  }
}

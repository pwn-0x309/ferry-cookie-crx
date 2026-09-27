// FerryCookie popup — the primary clipboard surface (DOM + user gesture).
// Renders via textContent only; cookie values never enter the DOM.

import { TARGET_DEFAULT, jarKey, previewOverlap, rewriteGrab } from '../core/rewrite.js';
import { etcV3 } from '../serializers/etc-v3.js';
import { getAllForTab, getLocalJarCookies, pickTargetTab, restrictReason, zeroReason } from '../shared/grab.js';

const $ = (id) => document.getElementById(id);

const state = {
  tab: null,
  raw: [],
  grab: null,
  overlap: [],
  protect: [],
  guard: null,
  cred: null,
  grabbedAt: null,
};

init();

async function init() {
  wireEvents();
  chrome.action.setBadgeText({ text: '' }); // the popup shows the full receipt
  try {
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
  render();
}

function wireEvents() {
  $('copy').addEventListener('click', onCopy);
  $('clear').addEventListener('click', onClear);
  $('preview-list').addEventListener('change', onProtectToggle);
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
  const local = await getLocalJarCookies(TARGET_DEFAULT);
  state.overlap = previewOverlap(state.grab.cookies, local);
}

async function onCopy() {
  if (!state.grab?.cookies.length) return; // an empty array never reaches the clipboard
  const text = etcV3.serialize(state.grab.cookies);
  try {
    await navigator.clipboard.writeText(text); // the popup click is the user gesture
    state.cred = { holds: true, count: state.grab.cookies.length, at: Date.now() };
    await chrome.storage.session.set({ 'fc-cred': state.cred, 'fc-receipt': receiptOf() });
  } catch (err) {
    state.cred = { holds: false, error: err?.message ?? String(err) };
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

function timeOf(ts) {
  return ts ? new Date(ts).toLocaleTimeString() : '';
}

function render() {
  const emitted = state.grab?.cookies.length ?? 0;
  const zero = !state.guard && state.grab && emitted === 0;

  $('source-line').textContent = state.tab?.url ? jarKey(state.tab.url) : '—';

  const guardEl = $('guard');
  if (state.guard) {
    $('guard-reason').textContent = `Copy disabled — ${state.guard}.`;
    guardEl.hidden = false;
  } else if (zero) {
    $('guard-reason').textContent = `Copy disabled — ${zeroReason(state.raw.length, state.grab.report)}.`;
    guardEl.hidden = false;
  } else {
    guardEl.hidden = true;
  }

  const receiptEl = $('receipt');
  if (!state.guard && state.grab && emitted > 0) {
    $('receipt-count').textContent = String(emitted);
    $('receipt-time').textContent = timeOf(state.grabbedAt);
    receiptEl.hidden = false;
  } else {
    receiptEl.hidden = true;
  }

  renderCred();
  renderFlags();
  renderPreview();

  $('copy').disabled = Boolean(state.guard) || emitted === 0;
}

function renderCred() {
  const el = $('cred-state');
  const clear = $('clear');
  const parts = [];
  if (state.cred?.holds) parts.push(`Clipboard holds ${state.cred.count} cookies (copied ${timeOf(state.cred.at)}).`);
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
  ul.replaceChildren();
  for (const row of state.overlap) {
    const li = document.createElement('li');

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = state.protect.includes(row.name);
    box.dataset.name = row.name;
    box.id = `protect-${CSS.escape(row.name)}-${CSS.escape(row.domain)}-${CSS.escape(row.path)}`;
    box.setAttribute('aria-label', `protect ${row.name} ${row.domain} ${row.path} from being overwritten`);

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

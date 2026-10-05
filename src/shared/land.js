// Landing runtime — chrome.* calls for the write side, so
// src/core/landing.js stays pure and fixture-pinned. Lanes (dock,
// clipboard, textarea), chrome.cookies.set/remove writes, session-scoped
// snapshots with eviction, and the jar re-read that owns the report's
// counts (spike (d)/(e): set() lies silently near the cap — never trust a
// write call over the jar).

import { jarEntryKey, jarKey } from '../core/rewrite.js';
import { assembleReport, evictSnapshots, isLoopbackHost, planLanding, recomputeRemoves } from '../core/landing.js';
import { envelope } from '../serializers/envelope.js';
import { getLocalJarCookies } from './grab.js';

export const DOCK_KEY = 'fc-dock';
export const SNAPSHOTS_KEY = 'fc-snapshots';
export const MAX_SNAPSHOTS = 3;

// Loopback targets write over http:// (spike-pinned: Chrome accepts Secure
// and __Host- cookies on http://localhost). Remote advanced targets need
// https:// — Chrome rejects Secure rows over plain http off-loopback.
function originOf(targetHost) {
  return (isLoopbackHost(targetHost) ? 'http://' : 'https://') + targetHost;
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

// Dock lane: the extension's last successful grab, held session-scoped as
// the serialized FC envelope (written by the copy gestures). Values at rest
// live only in storage.session — dying with the browser is the retention
// policy.
export async function readDock() {
  const stored = await chrome.storage.session.get(DOCK_KEY);
  return typeof stored[DOCK_KEY] === 'string' ? stored[DOCK_KEY] : null;
}

export async function writeDock(coreCookies, meta) {
  await chrome.storage.session.set({ [DOCK_KEY]: envelope.serialize(coreCookies, meta) });
}

// Clipboard lane: read at click (the popup's live gesture), never at
// popup-open — the MV3 clipboard law, inbound. The spike (Q3) proved
// readText() works prompt-free under clipboardRead.
export async function readClipboard() {
  return navigator.clipboard.readText();
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// The writer is monastic: it writes only the confirmed route target host,
// and passes the row's truth — host-only intent via `url` alone, domain
// intent via an explicit `domain` key — never a mix.
export async function writeCookie(row, targetHost) {
  const details = {
    url: originOf(targetHost) + row.path,
    name: row.name,
    value: row.value,
    path: row.path,
    secure: row.secure === true,
    sameSite: row.sameSite ?? 'unspecified',
  };
  if (row.hostOnly === false) {
    details.domain = row.domain; // domain-scoped intent: jar derives scope from domain
  }
  // host-only intent: minted from url alone — no domain key at all
  if (row.httpOnly === true) details.httpOnly = true; // foreign exports, verbatim
  if (row.session !== true && typeof row.expirationDate === 'number') {
    details.expirationDate = row.expirationDate;
  }
  try {
    await chrome.cookies.set(details);
    return null; // resolution is NOT success — the jar re-read decides
  } catch (err) {
    return String(err?.message ?? err);
  }
}

async function removeCookie(ref, targetHost) {
  try {
    await chrome.cookies.remove({ url: originOf(targetHost) + ref.path, name: ref.name });
    return null;
  } catch (err) {
    return String(err?.message ?? err);
  }
}

// ---------------------------------------------------------------------------
// Snapshots — storage.session only, ≤3, grab-time labels, oldest evicted
// ---------------------------------------------------------------------------

export async function listSnapshots() {
  const stored = await chrome.storage.session.get(SNAPSHOTS_KEY);
  return Array.isArray(stored[SNAPSHOTS_KEY]) ? stored[SNAPSHOTS_KEY] : [];
}

export async function saveSnapshot(targetHost, jar, label) {
  const list = await listSnapshots();
  const next = evictSnapshots([
    ...list,
    {
      id: 'snap-' + jar.length + '-' + Date.now(),
      at: Date.now(),
      label,
      targetHost,
      jar,
    },
  ]);
  await chrome.storage.session.set({ [SNAPSHOTS_KEY]: next });
  return next[0];
}

// ---------------------------------------------------------------------------
// The landing itself
// ---------------------------------------------------------------------------

// executeLanding runs the confirmed plan against the target jar:
//   1. read the jar (the caller may pass its pre-read jarBefore so the
//      snapshot and the report baseline cannot diverge),
//   2. removes recomputed from that FRESH jar (a cookie added between the
//      diff screen and the confirm must not survive a replace that promised
//      "removes N"), then writes in the plan's specificity order,
//   3. re-read the jar and assemble the report from the jars, not the calls.
//      If that re-read itself fails, degrade honestly: the writes have
//      already happened, so the report says writes-issued / could-not-verify
//      instead of a plain "landing failed".
export async function executeLanding({ plan, targetHost, foreign = [], invalid = [], duplicatesCollapsed = 0, label = '', jarBefore = null }) {
  const before = jarBefore ?? (await getLocalJarCookies(originOf(targetHost)));

  const removes = recomputeRemoves(plan, before);
  const writeErrors = new Map();
  const removeErrors = new Map();

  for (const ref of removes) {
    const error = await removeCookie(ref, targetHost);
    if (error) removeErrors.set(jarEntryKey(ref), error);
  }
  for (const row of plan.writes) {
    const error = await writeCookie(row, targetHost);
    if (error) writeErrors.set(jarEntryKey(row), error);
  }

  let jarAfter;
  try {
    jarAfter = await getLocalJarCookies(originOf(targetHost));
  } catch (err) {
    return {
      report: {
        landed: [],
        overwritten: [],
        removed: [],
        failed: [],
        foreignNames: foreign.map((row) => row.name).filter((name, i, all) => all.indexOf(name) === i),
        invalid,
        duplicatesCollapsed,
        counts: {
          landed: 0,
          overwritten: 0,
          removed: 0,
          skippedForeign: foreign.length,
          skippedProtected: (plan.skippedProtected ?? []).length,
          invalid: invalid.length,
          failed: 0,
          keptExisting: (plan.keptExisting ?? []).length,
          duplicatesCollapsed,
          issued: plan.writes.length,
        },
        partial: true,
        verifiedFrom: 'unavailable',
        unverified: true,
        issued: plan.writes.length,
        verifyError: String(err?.message ?? err),
      },
      jarBefore: before,
      jarAfter: null,
    };
  }

  const report = assembleReport({
    plan: { ...plan, removes },
    jarBefore: before,
    jarAfter,
    writeErrors,
    removeErrors,
    foreign,
    invalid,
    duplicatesCollapsed,
  });
  return { report, jarBefore: before, jarAfter };
}

// With-snapshot wrapper: what the popup's confirmed Land click runs.
export async function landWithSnapshot({ plan, targetHost, foreign, invalid, duplicatesCollapsed = 0, label }) {
  // One read feeds both the snapshot and the report baseline.
  const jarBefore = await getLocalJarCookies(originOf(targetHost));
  const snapshot = await saveSnapshot(targetHost, jarBefore, label || `before landing → ${targetHost}`);
  const { report, jarAfter } = await executeLanding({
    plan,
    targetHost,
    foreign,
    invalid,
    duplicatesCollapsed,
    label,
    jarBefore,
  });
  return { report, snapshot, jarBefore, jarAfter };
}

// Restore is itself a guarded landing: the snapshot's jar becomes a
// replace-mode plan against the current jar, shown diff-then-confirm by
// the popup before this runs. A snapshot with zero rows is a legitimate
// restore (it removes everything) — the Empty Jar refusal is a *parse*
// guard, so it is bypassed here. Protected names are not special either —
// the snapshot is the whole truth of the jar at grab time.
export function planRestore(snapshot, currentJar) {
  const rows = snapshot.jar.map((row) => ({ ...row }));
  return planLanding(rows, currentJar, 'replace', [], { allowZeroRowReplace: true });
}

export async function restoreSnapshot(snapshot) {
  const currentJar = await getLocalJarCookies(originOf(snapshot.targetHost));
  // Restores are landings too — snapshot the current jar first, so a
  // restore is itself reversible within the session (guarded, one click).
  const preRestore = await saveSnapshot(
    snapshot.targetHost,
    currentJar,
    `before restore — ${snapshot.label}`,
  );
  const plan = planRestore(snapshot, currentJar);
  const { report } = await executeLanding({ plan, targetHost: snapshot.targetHost, label: 'restore' });
  return { report, snapshot: preRestore };
}

export { jarKey };

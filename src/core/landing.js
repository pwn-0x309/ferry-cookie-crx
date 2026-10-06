// Pure landing core for FerryCookie mvp2 — the contract of
// _bmad-output/specs/spec-ferry-cookie-apply/ (SPEC.md + landing-policy.md
// + inbound-dialects.md).
//
// No chrome.* calls, no DOM, no clock, no randomness: sniff → validate →
// retarget → planLanding → report buckets, all deterministic and pinned by
// test/fixtures/F11–F14. The popup, clipboard, dock, snapshots, and the
// jar re-read are furniture around this module.
//
// The law this core enforces: the parser is liberal, the validator is
// paranoid, the writer is monastic — parse anything, validate strictly,
// write only the confirmed target host.

import { jarEntryKey, jarKey } from './rewrite.js';
import { etcV3 } from '../serializers/etc-v3.js';
import { envelope } from '../serializers/envelope.js';
import { playwright } from '../serializers/playwright.js';

export const DEFAULT_ROUTES = ['localhost', '127.0.0.1', '[::1]'];
export const JAR_CAPACITY = 180;
export const AUTH_CLASS_FILTER = 'session|auth|token|jwt|^sid';

const AUTH_CLASS_RE = new RegExp(AUTH_CLASS_FILTER, 'i');

// ---------------------------------------------------------------------------
// Loopback shape and routes
// ---------------------------------------------------------------------------

// Loopback-shaped host (dot-insensitive): localhost itself, 127.0.0.1, the
// IPv6 loopback (bracketed and bare), and *.localhost subdomains. These are
// the "ferry-shaped" rows that retarget onto the route target; anything
// else is foreign to every legal route and can only be reported.
export function isLoopbackHost(host) {
  const h = String(host).replace(/^\.+/, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost');
}

function isValidHostShape(host) {
  const h = String(host).trim().toLowerCase();
  if (h === '') return false;
  if (/^\[[0-9a-f:]+\]$/.test(h)) return true; // bracketed IPv6
  if (/^[0-9a-f:]+$/i.test(h) && h.includes(':')) return false // bare IPv6 needs brackets in a route
  const labels = h.split('.');
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l));
}

// CAP-7 gate: with the advanced toggle off, no code path may write a
// non-local target. Returns null when the host is writable, or the named
// reason it is not.
export function routeGate(host, { advanced = false } = {}) {
  if (!isValidHostShape(host)) return `"${host}" is not a valid host name`;
  if (isLoopbackHost(host)) return null;
  if (!advanced) return `remote target "${host}" is locked — enable the advanced toggle (it acts as you against that backend)`;
  return null;
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

export function freshnessLine(grabbedAt, now = Date.now()) {
  if (typeof grabbedAt !== 'number' || !Number.isFinite(grabbedAt)) return 'age unknown';
  // Sanity: a plausible ms-epoch (nothing pre-2001, nothing in the future
  // beyond clock skew). A seconds-epoch or negative value is not a real
  // grab time — say unknown rather than print an absurd age.
  const PLAUSIBLE_MIN_MS = 1e12; // 2001-09 in ms
  if (grabbedAt < PLAUSIBLE_MIN_MS || grabbedAt > now + 60_000) return 'age unknown';
  const seconds = Math.max(0, Math.round((now - grabbedAt) / 1000));
  if (seconds < 60) return 'grab is <1m old';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `grab is ${minutes}m old`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `grab is ${hours}h old`;
  return `grab is ${Math.round(hours / 24)}d old`;
}

// ---------------------------------------------------------------------------
// Sniffing (pinned order: ETC v3 → FC envelope → Playwright)
// ---------------------------------------------------------------------------

function jsonErrorFirstLine(err) {
  return String(err?.message ?? err).split('\n')[0];
}

// sniff(text) →
//   { ok: true, ambiguous: false, dialect, parse }        single dialect
//   { ok: true, ambiguous: true, candidates: [...] }       user must pick
//   { ok: false, reason }                                  named refusal
// A dialect is a candidate when its validator accepts at least one row; a
// parse where every row is invalid counts as unparseable (the inbound law).
export function sniff(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, reason: 'input is empty' };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `not valid JSON (${jsonErrorFirstLine(err)})` };
  }

  const candidates = [];
  const etcParse = etcV3.parse(value);
  if (etcParse.ok && etcParse.rows.length > 0) candidates.push({ dialect: etcV3.id, parse: etcParse });
  const envParse = envelope.parse(value);
  if (envParse.ok && envParse.rows.length > 0) candidates.push({ dialect: envelope.id, parse: envParse });
  const pwParse = playwright.parse(value);
  if (pwParse.ok && pwParse.rows.length > 0) candidates.push({ dialect: playwright.id, parse: pwParse });

  if (candidates.length === 0) {
    // Name the most specific cause we can see.
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'meta' in value && 'cookies' in value) {
      return { ok: false, reason: envParse.ok ? 'zero rows parsed' : `not a valid FC envelope (${envParse.reason})` };
    }
    const invalid = [etcParse, envParse, pwParse].find((p) => p.ok && p.invalid?.length > 0 && p.rows.length === 0);
    if (invalid) {
      return { ok: false, reason: `no valid rows (${invalid.invalid.length} invalid — first: ${invalid.invalid[0].reason})` };
    }
    if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
      return { ok: false, reason: 'zero rows parsed' };
    }
    return { ok: false, reason: 'not a cookie JSON shape' };
  }
  if (candidates.length > 1) {
    return { ok: true, ambiguous: true, candidates };
  }
  return { ok: true, ambiguous: false, ...candidates[0] };
}

// ---------------------------------------------------------------------------
// Retarget — CAP-5's absolute exclusion without a hostile UX
// ---------------------------------------------------------------------------

// retargetRows(rows, targetHost): loopback-shaped rows move onto the route
// target (flattened to the host-only target form, the v1 amendment's
// standing authority); every other domain is foreign — reported, never
// written. This is also the reverse-ferry guard: a real-world export
// (example.com rows) is all-foreign and refuses with a reason.
//
// Rows that flatten to the same jar entry — a `localhost` host-only row and
// a `.localhost` domain row of the same name/path, or a plain duplicate —
// collapse last-write-wins with a counted duplicate total, mirroring
// rewriteGrab: without this, both would write and both would count (adds
// inflated, "landed 2" while the jar holds 1).
export function retargetRows(rows, targetHost) {
  const host = jarKey(targetHost);
  const byKey = new Map();
  const foreign = [];
  let duplicatesCollapsed = 0;
  for (const row of rows) {
    if (isLoopbackHost(row.domain)) {
      const retargeted = { ...row, domain: host, hostOnly: true };
      const key = jarEntryKey(retargeted);
      if (byKey.has(key)) duplicatesCollapsed += 1;
      byKey.set(key, retargeted); // last write wins
    } else {
      foreign.push({ ...row });
    }
  }
  return { rows: [...byKey.values()], foreign, duplicatesCollapsed };
}

// ---------------------------------------------------------------------------
// Plan — mode semantics and pre-flight math
// ---------------------------------------------------------------------------

function rowRef(row) {
  return { name: row.name, path: row.path, domain: row.domain };
}

// Removal refs carry hostOnly: jar-entry identity includes the host-only
// form, and a surviving `.localhost` domain row must not be misreported as
// removed (or left undetected) because its ref lost the flag.
function removeRef(row) {
  return { ...rowRef(row), hostOnly: row.hostOnly !== false };
}

// Ascending specificity for writes: domain-scoped before host-only, shorter
// path before longer — the most-specific write lands last and wins
// (landing-policy "Write rules").
function specificityAsc(a, b) {
  const aScoped = a.hostOnly === false ? 0 : 1;
  const bScoped = b.hostOnly === false ? 0 : 1;
  if (aScoped !== bScoped) return aScoped - bScoped;
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  return 0;
}

// planLanding(rows, localJar, mode, protect, options):
//   rows      retargeted rows (all target-host shaped) — see retargetRows
//   localJar  chrome.cookies.getAll rows of the target jar (pre-flight)
//   mode      'fill-gaps' (default) | 'merge' | 'replace' | 'curated'
//   protect   protected names (v1's fc-protect list)
//   options.allowZeroRowReplace — restores may legitimately carry zero rows
//     (restoring an empty jar means "remove everything"); the Empty Jar
//     refusal belongs to parsed input, not to a snapshot.
// Curated mode lands only the rows the caller passes (the diff screen's
// checked rows) and behaves as merge on that subset; protected names stay
// locked in every mode.
export function planLanding(rows, localJar, mode = 'fill-gaps', protect = [], options = {}) {
  if (!['fill-gaps', 'merge', 'replace', 'curated'].includes(mode)) {
    throw new Error(`unknown landing mode "${mode}"`);
  }
  if (mode === 'replace' && rows.length === 0 && !options.allowZeroRowReplace) {
    return { refused: 'replace refuses to run on a zero-row parse — the Empty Jar incident' };
  }

  const protectSet = new Set(protect);
  const localKeys = new Set(localJar.map(jarEntryKey));
  const incomingKeys = new Set(rows.filter((r) => !protectSet.has(r.name)).map(jarEntryKey));

  const writes = [];
  const adds = [];
  const overwrites = [];
  const keptExisting = [];
  const skippedProtected = []; // deduped names, for display
  let skippedProtectedCount = 0; // row-exact, matching skippedForeign's counting
  for (const row of rows) {
    if (protectSet.has(row.name)) {
      skippedProtectedCount += 1;
      if (!skippedProtected.includes(row.name)) skippedProtected.push(row.name);
      continue;
    }
    const exists = localKeys.has(jarEntryKey(row));
    if (exists && mode === 'fill-gaps') {
      keptExisting.push(rowRef(row));
      continue;
    }
    writes.push(row);
    if (exists) overwrites.push(rowRef(row));
    else adds.push(rowRef(row));
  }
  writes.sort(specificityAsc); // stable in V8 for small arrays; specificity only

  // Replace clears the jar first: every local entry not in the incoming set
  // goes — except protected names, which replace must never touch.
  const removes = [];
  if (mode === 'replace') {
    for (const local of localJar) {
      if (protectSet.has(local.name)) continue;
      if (!incomingKeys.has(jarEntryKey(local))) removes.push(removeRef(local));
    }
  }

  const math = {
    adds: adds.length,
    overwrites: overwrites.length,
    removes: removes.length,
    keptExisting: keptExisting.length,
    excludesProtected: skippedProtectedCount,
  };
  const projectedJarSize = localJar.length - removes.length + adds.length;
  return {
    mode,
    protect, // full protect list — removes recomputation needs jar-side names too
    writes,
    adds,
    overwrites,
    removes,
    keptExisting,
    skippedProtected, // deduped names, display only
    skippedProtectedCount, // row-exact — counts and skippedForeign agree
    math,
    capacity: {
      projectedJarSize,
      over: projectedJarSize > JAR_CAPACITY,
      offer: 'auth-class only',
    },
  };
}

// Write origin for a target host: loopback writes over http:// (spike-pinned:
// Chrome accepts Secure and __Host- cookies on http://localhost); anything
// remote needs https:// — Chrome rejects Secure rows over plain http
// off-loopback. Pinned by unit test beside the routeGate cases.
export function originFor(targetHost) {
  return (isLoopbackHost(targetHost) ? 'http://' : 'https://') + targetHost;
}

// ---------------------------------------------------------------------------
// Report — every row lands in exactly one bucket; the jar is the truth
// ---------------------------------------------------------------------------

function pushRef(list, ref) {
  if (!list.some((r) => r.name === ref.name && r.path === ref.path && r.domain === ref.domain)) list.push(ref);
}

// Replace-mode removes are recomputed at execution time against the fresh
// jar read there: cookies added between the diff screen and the confirm
// must not survive a replace that promised "removes N" (same for restores).
// Protected names stay untouchable in the recomputation — the plan carries
// the full protect list, because skippedProtected only names protected rows
// that appeared in the incoming set (a jar-side protected name never does).
export function recomputeRemoves(plan, freshJar) {
  if (plan.mode !== 'replace') return plan.removes ?? [];
  const protect = new Set([...(plan.protect ?? []), ...(plan.skippedProtected ?? [])]);
  const incoming = new Set(plan.writes.map(jarEntryKey));
  return freshJar
    .filter((local) => !protect.has(local.name) && !incoming.has(jarEntryKey(local)))
    .map(removeRef);
}

// assembleReport computes the report buckets from the jars, never from the
// write calls (the spike proved set() lies silently near the jar cap).
//   jarBefore / jarAfter  the target jar rows read immediately before the
//                         first write and after the last one
//   writeErrors           Map<jarEntryKey(row), message> from set() rejections
//   removeErrors          same shape for failed chrome.cookies.remove calls
//   foreign / invalid     carried in from retarget + dialect validation
//   duplicatesCollapsed   retarget-level collapses (counted, reported)
export function assembleReport({ plan, jarBefore = [], jarAfter = [], writeErrors = new Map(), removeErrors = new Map(), foreign = [], invalid = [], duplicatesCollapsed = 0 }) {
  const before = new Set(jarBefore.map(jarEntryKey));
  const after = new Set(jarAfter.map(jarEntryKey));

  const landed = [];
  const overwritten = [];
  const failed = [];
  for (const row of plan.writes) {
    const key = jarEntryKey(row);
    const error = writeErrors.get(key);
    if (error !== undefined) {
      failed.push({ ...rowRef(row), reason: error });
      continue;
    }
    if (!after.has(key)) {
      failed.push({ ...rowRef(row), reason: 'not present in the jar after the write (rejected or evicted)' });
      continue;
    }
    if (before.has(key)) pushRef(overwritten, rowRef(row));
    else pushRef(landed, rowRef(row));
  }

  const removed = [];
  for (const ref of plan.removes) {
    const key = jarEntryKey(ref);
    const error = removeErrors.get(key);
    if (error !== undefined) {
      failed.push({ ...ref, reason: error });
      continue;
    }
    if (after.has(key)) failed.push({ ...ref, reason: 'still present in the jar after replace' });
    else removed.push(ref);
  }

  const foreignNames = [];
  for (const row of foreign) {
    if (!foreignNames.includes(row.name)) foreignNames.push(row.name);
  }

  const counts = {
    landed: landed.length,
    overwritten: overwritten.length,
    removed: removed.length,
    // Row count, matching the diff screen's "excludes N foreign" — the
    // name list below stays deduped for display. skippedProtected counts
    // rows too (plan.skippedProtectedCount), so the two skip buckets agree.
    skippedForeign: foreign.length,
    skippedProtected: plan.skippedProtectedCount ?? plan.skippedProtected.length,
    invalid: invalid.length,
    failed: failed.length,
    keptExisting: plan.keptExisting.length,
    duplicatesCollapsed,
  };
  return {
    landed,
    overwritten,
    removed,
    failed,
    foreignNames,
    invalid,
    counts,
    duplicatesCollapsed,
    // Partial success is loudly partial — but by-design skips (foreign,
    // protected, kept) are complete success with reported exclusions, not
    // partial failure. Only rows that tried and didn't make it are partial.
    partial: failed.length > 0 || invalid.length > 0,
    verifiedFrom: 'jar',
  };
}

// ---------------------------------------------------------------------------
// Capacity and snapshots
// ---------------------------------------------------------------------------

export function isAuthClassName(name) {
  return AUTH_CLASS_RE.test(name);
}

export function authClassRows(rows) {
  return rows.filter((row) => isAuthClassName(row.name));
}

// Up to 3 snapshots per session, oldest evicted. Pure list policy; the
// storage.session write lives in the runtime.
export function evictSnapshots(list) {
  return [...list].sort((a, b) => b.at - a.at).slice(0, 3);
}

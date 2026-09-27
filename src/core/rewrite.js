// Pure rewrite core for FerryCookie — the contract of
// _bmad-output/specs/spec-cookie-ferry/rewrite-policy.md.
//
// No chrome.* calls, no DOM, no clock, no randomness: everything here is
// deterministic and pinned by test/fixtures/F1–F10. The popup, clipboard,
// and badge are furniture around this module.

export const TARGET_DEFAULT = 'http://localhost';

const SAME_SITE_ENUM = ['no_restriction', 'lax', 'strict', 'unspecified'];

function toUrl(origin) {
  return origin.includes('://') ? origin : 'http://' + origin;
}

// Jar identity: hostname, lowercased, port-free. localhost:3000 and
// localhost:5173 share one jar; localhost, 127.0.0.1 and [::1] are distinct.
export function jarKey(origin) {
  return new URL(toUrl(origin)).hostname.toLowerCase();
}

function sameSiteOf(cookie) {
  if (SAME_SITE_ENUM.includes(cookie.sameSite)) return cookie.sameSite;
  return cookie.sameSite ?? 'unspecified';
}

function isPartitioned(cookie) {
  return cookie.partitionKey !== undefined && cookie.partitionKey !== null;
}

function normalizeDomain(domain) {
  return String(domain).replace(/^\.+/, '').toLowerCase();
}

// Cookie identity inside one grab: (name, path, domain), domain compared at
// jar level (dot/case-insensitive). A source host-only cookie and a source
// domain cookie with the same name and path flatten to the identical
// host-only target form, so they collapse last-write-wins (counted), the
// same way a double import would end up.
function dedupeKey(cookie) {
  return `${cookie.name}\n${cookie.path}\n${normalizeDomain(cookie.domain)}`;
}

// Report name lists carry a name once even when several cookies share it.
function pushName(list, name) {
  if (!list.includes(name)) list.push(name);
}

// rewrite(sourceOrigin, targetOrigin) -> pure single-cookie mapper.
// Per-attribute policy: every output cookie is host-only on the target host
// (`domain: localhost`, never a leading dot) — source domain-ness is
// flattened, since subdomain ferrying is a non-goal (human decision
// 2026-09-27). Path untouched, secure/httpOnly/value/storeId/expirationDate
// verbatim, session derived, sameSite enum passed through with no implicit
// conversion.
export function rewrite(sourceOrigin, targetOrigin = TARGET_DEFAULT) {
  const targetHost = jarKey(targetOrigin);
  return function rewriteCookie(cookie) {
    const session = typeof cookie.expirationDate !== 'number' || !Number.isFinite(cookie.expirationDate);
    const out = {
      domain: targetHost,
      hostOnly: true,
      httpOnly: cookie.httpOnly === true,
      name: cookie.name,
      path: cookie.path,
      sameSite: sameSiteOf(cookie),
      secure: cookie.secure === true,
      session,
      storeId: cookie.storeId === undefined ? '0' : String(cookie.storeId),
      value: cookie.value,
    };
    if (!session) out.expirationDate = cookie.expirationDate;
    // `__Host-` has exactly one legal local form: secure, path "/", host-only.
    // Host-only and bare domain are already guaranteed by the flatten; the
    // secure flag and root path are still enforced here, never renamed.
    if (cookie.name.startsWith('__Host-')) {
      out.secure = true;
      out.path = '/';
    }
    return out;
  };
}

// Batch pipeline, in order:
//   1. partitioned (CHIPS) cookies are excluded and counted — they have no
//      localhost context;
//   2. duplicate (name, path, domain) rows collapse last-write-wins with a
//      count (domain compared at jar level: dot/case-insensitive);
//   3. protected names drop out of the output and are reported;
//   4. rewrite + flags (sameSite None without Secure is flagged, never
//      silently edited; a coerced `__Host-` shape is reported).
export function rewriteGrab(rawCookies, { sourceOrigin, targetOrigin = TARGET_DEFAULT, protectedNames = [] } = {}) {
  const rewriteCookie = rewrite(sourceOrigin, targetOrigin);
  const report = {
    sourceHost: jarKey(sourceOrigin),
    targetHost: jarKey(targetOrigin),
    emitted: 0,
    duplicatesCollapsed: 0,
    partitionedExcluded: 0,
    brokenPairNames: [],
    hostPrefixCoercedNames: [],
    protectedNames: [],
  };

  const kept = [];
  for (const cookie of rawCookies) {
    if (isPartitioned(cookie)) report.partitionedExcluded += 1;
    else kept.push(cookie);
  }

  const byKey = new Map();
  for (const cookie of kept) {
    const key = dedupeKey(cookie);
    if (byKey.has(key)) report.duplicatesCollapsed += 1;
    byKey.set(key, cookie); // last write wins
  }

  const protect = new Set(protectedNames);
  const cookies = [];
  for (const cookie of byKey.values()) {
    if (protect.has(cookie.name)) {
      pushName(report.protectedNames, cookie.name);
      continue;
    }
    if (
      cookie.name.startsWith('__Host-') &&
      !(cookie.secure === true && cookie.path === '/' && cookie.hostOnly !== false)
    ) {
      pushName(report.hostPrefixCoercedNames, cookie.name);
    }
    const rewritten = rewriteCookie(cookie);
    if (rewritten.sameSite === 'no_restriction' && rewritten.secure !== true) {
      pushName(report.brokenPairNames, rewritten.name);
    }
    cookies.push(rewritten);
  }
  report.emitted = cookies.length;
  return { cookies, report };
}

// Jar-entry identity for preview matching: (name, path, domain, host-only
// form). Chrome keeps a host-only "localhost" cookie and a ".localhost"
// domain cookie as distinct jar entries, and importing one does not
// overwrite the other — the preview must not claim an overwrite that cannot
// happen. The grab side is always host-only, so only a local host-only
// cookie of the same name and path matches.
function jarEntryKey(cookie) {
  return `${cookie.name}\n${cookie.path}\n${normalizeDomain(cookie.domain)}\n${cookie.hostOnly !== false}`;
}

// Jar-level preview: cookies present on both the (rewritten) grab and the
// local target jar, matched on jar-entry identity. Ports share one jar.
// Cookie values never enter the preview.
export function previewOverlap(coreCookies, localJarCookies) {
  const localKeys = new Set(localJarCookies.map(jarEntryKey));
  return coreCookies
    .filter((c) => localKeys.has(jarEntryKey(c)))
    .map((c) => ({ name: c.name, domain: c.domain, path: c.path }))
    .sort((a, b) => rowKey(a) < rowKey(b) ? -1 : rowKey(a) > rowKey(b) ? 1 : 0);
}

function rowKey(row) {
  return row.name + '\n' + row.domain + '\n' + row.path;
}

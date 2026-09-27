// Runtime grab helpers shared by the popup and the service worker.
// chrome.* calls live here so src/core/rewrite.js stays pure and fixture-pinned.

const WEBSTORE_HOST = 'chromewebstore.google.com';
const LEGACY_WEBSTORE_HOST = 'chrome.google.com';

// Named guard for pages the cookies API cannot (or must not) read.
export function restrictReason(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'an unreadable page URL';
  }
  switch (parsed.protocol) {
    case 'chrome:':
      return 'a chrome:// page';
    case 'chrome-extension:':
      return 'an extension page';
    case 'chrome-untrusted:':
      return 'a chrome-untrusted page';
    case 'devtools:':
      return 'a DevTools page';
    case 'view-source:':
      return 'a view-source page';
    case 'about:':
      return 'an about: page';
    case 'file:':
      return 'a local file or PDF viewer page';
    case 'blob:':
      return 'a blob URL page';
    case 'data:':
      return 'a data: URL page';
    case 'chrome-error:':
      return 'a Chrome error page';
  }
  if (parsed.hostname === WEBSTORE_HOST) return 'the Chrome Web Store';
  if (parsed.hostname === LEGACY_WEBSTORE_HOST && parsed.pathname.startsWith('/webstore')) {
    return 'the Chrome Web Store';
  }
  return null;
}

// The tab to ferry: the active tab of the current window when that is a
// regular page. Falls back to the most recently accessed regular page —
// that covers a popup opened as a tab (its own tab is skipped), which is
// also how the e2e harness drives the popup.
export async function pickTargetTab() {
  let own = null;
  try {
    own = await chrome.tabs.getCurrent(); // undefined in a real action popup
  } catch {
    // no tab identity in this context
  }
  const isPage = (t) => t.url && !t.url.startsWith('chrome-extension://') && t.id !== own?.id;

  const active = await chrome.tabs.query({ active: true, currentWindow: true });
  const activePage = active.find(isPage);
  if (activePage) return activePage;

  const all = (await chrome.tabs.query({})).filter(isPage);
  all.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
  return all[0] ?? null;
}

// All cookies visible to the tab's URL scope in the tab's own cookie store:
// the unpartitioned jar plus the partitioned (CHIPS) sweep so the core can
// exclude and count partitioned cookies.
export async function getAllForTab(tab) {
  if (!tab?.url) return [];
  const store = (await chrome.cookies.getAllCookieStores()).find((s) => s.tabIds.includes(tab.id));
  if (!store) {
    throw new Error(`no cookie store found for this tab; refusing to read the default store's jar`);
  }
  const base = { url: tab.url, storeId: store.id };
  const [plain, partitionedRaw] = await Promise.all([
    chrome.cookies.getAll(base),
    chrome.cookies.getAll({ ...base, partitionKey: {} }).catch(() => []),
  ]);
  const partitioned = partitionedRaw.filter((c) => c.partitionKey);
  return [...partitioned, ...plain];
}

// The local target jar, read at domain level (scheme-free): ports and
// http/https share one jar on localhost. getAll({domain}) is a suffix
// match, so keep only cookies whose domain is exactly this jar's host.
export async function getLocalJarCookies(targetOrigin) {
  const host = new URL(targetOrigin).hostname.toLowerCase();
  const all = await chrome.cookies.getAll({ domain: host });
  return all.filter((c) => String(c.domain).replace(/^\.+/, '').toLowerCase() === host);
}

// Why the copy action is disabled when nothing would be emitted.
export function zeroReason(rawCount, report) {
  if (rawCount === 0) return 'no cookies here';
  if (report.partitionedExcluded > 0) {
    return `all cookies excluded (${report.partitionedExcluded} partitioned)`;
  }
  if (report.protectedNames.length) {
    return `all cookies protected (${report.protectedNames.join(', ')})`;
  }
  return 'no cookies here';
}

// Dialect #2: Playwright `addCookies` — the CI/e2e lingua franca (absorbs
// v1's deferred ticket). Mapping verified against current Playwright docs
// (playwright.dev, browserContext.addCookies):
//   name/value/path ...... direct
//   expirationDate ...... expires (Unix seconds; OMITTED for session — the
//                          docs make expires optional; omission = session)
//   sameSite enum-string . TitleCase: no_restriction→"None", lax→"Lax",
//                          strict→"Strict"; unspecified has NO Playwright
//                          equivalent ("Strict" | "Lax" | "None") → omitted,
//                          letting the browser default apply
//   hostOnly ............. domain without a leading dot; hostOnly:false →
//                          leading dot (".localhost" covers subdomains — the
//                          docs' only stated dot semantics)
//   storeId/session ...... no equivalent — dropped in this dialect
//   httpOnly ............. never emitted by our dialects (human ruling
//                          2026-09-28: all lanes carry identical
//                          ETC-projected rows); inbound Playwright rows
//                          carrying httpOnly are accepted and landed verbatim
//
// Inbound also accepts `url`-form rows ({ name, value, url }) and maps them
// to host/path extraction, and `expires: -1` (the CDP session convention)
// as a session cookie.

const SAME_SITE_OUT = { no_restriction: 'None', lax: 'Lax', strict: 'Strict' };
const SAME_SITE_IN = { None: 'no_restriction', Lax: 'lax', Strict: 'strict' };

// Fields only the ETC v3 dialect carries; a Playwright row sporting one of
// these is not a Playwright row (sniffing aid).
const ETC_ONLY_FIELDS = ['expirationDate', 'hostOnly', 'session', 'storeId'];

function boolOrUndef(value) {
  return value === undefined || typeof value === 'boolean' ? value : 'bad-type';
}

function parseUrlForm(raw, { sameSite, secure, httpOnly, session }) {
  let url;
  try {
    url = new URL(raw.url);
  } catch {
    return { reason: `url "${raw.url}" is not parseable` };
  }
  if (raw.path !== undefined && (typeof raw.path !== 'string' || !raw.path.startsWith('/'))) {
    return { reason: 'path does not start with "/"' };
  }
  const path = raw.path ?? (url.pathname !== '' && url.pathname.startsWith('/') ? url.pathname : '/');
  const row = {
    domain: url.hostname.toLowerCase(),
    hostOnly: true, // url-form rows address one origin
    name: raw.name,
    path,
    sameSite,
    // an explicit secure flag wins; otherwise the url's scheme is the truth
    secure: secure ?? url.protocol === 'https:',
    session,
    storeId: '0',
    value: raw.value,
  };
  if (!session) row.expirationDate = raw.expires;
  if (httpOnly === true) row.httpOnly = true;
  return { row };
}

function validatePlaywrightRow(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { reason: 'row is not an object' };
  }
  for (const field of ETC_ONLY_FIELDS) {
    if (raw[field] !== undefined) {
      return { reason: `field "${field}" belongs to the ETC v3 dialect, not Playwright` };
    }
  }
  if (typeof raw.name !== 'string' || raw.name === '') return { reason: 'name is missing or empty' };
  if (typeof raw.value !== 'string') return { reason: 'value is missing or not a string' };
  if (raw.path !== undefined && (typeof raw.path !== 'string' || !raw.path.startsWith('/'))) {
    return { reason: 'path does not start with "/"' };
  }

  // Shared field validation runs before the url/domain split so url-form
  // rows honor expires / sameSite / httpOnly / secure exactly like
  // domain-form rows instead of silently dropping them.
  const secure = boolOrUndef(raw.secure);
  if (secure === 'bad-type') return { reason: 'secure is not a boolean' };
  const httpOnly = boolOrUndef(raw.httpOnly);
  if (httpOnly === 'bad-type') return { reason: 'httpOnly is not a boolean' };

  let sameSite = 'unspecified';
  if (raw.sameSite !== undefined) {
    if (typeof raw.sameSite !== 'string' || SAME_SITE_IN[raw.sameSite] === undefined) {
      return { reason: `sameSite "${raw.sameSite}" is not a Playwright enum value` };
    }
    sameSite = SAME_SITE_IN[raw.sameSite];
  }

  if (raw.expires !== undefined && (typeof raw.expires !== 'number' || !Number.isFinite(raw.expires))) {
    return { reason: 'expires is not a finite number' };
  }
  const session = raw.expires === undefined || raw.expires === -1;

  if (raw.url !== undefined) {
    if (raw.domain !== undefined) return { reason: 'row carries both url and domain' };
    return parseUrlForm(raw, { sameSite, secure, httpOnly, session });
  }
  if (typeof raw.domain !== 'string' || raw.domain === '') {
    return { reason: 'domain is missing or empty' };
  }

  const domain = raw.domain.replace(/^\.+/, '').toLowerCase();
  const hostOnly = !raw.domain.startsWith('.');
  const row = {
    domain,
    hostOnly,
    name: raw.name,
    path: raw.path ?? '/',
    sameSite,
    secure: secure ?? false,
    session,
    storeId: '0',
    value: raw.value,
  };
  if (!session) row.expirationDate = raw.expires;
  if (httpOnly === true) row.httpOnly = true;
  return { row };
}

export const playwright = {
  id: 'playwright',

  // Outbound: consumes ETC-projected core rows (the same row set
  // etcV3.serialize consumes — identical lanes, no hidden fidelity).
  serialize(coreCookies) {
    return JSON.stringify(
      coreCookies.map((cookie) => {
        const out = {
          domain: cookie.hostOnly === false ? '.' + cookie.domain : cookie.domain,
          name: cookie.name,
          path: cookie.path,
          secure: cookie.secure === true,
          value: cookie.value,
        };
        if (cookie.session !== true && typeof cookie.expirationDate === 'number') {
          out.expires = cookie.expirationDate;
        }
        const mapped = SAME_SITE_OUT[cookie.sameSite];
        if (mapped) out.sameSite = mapped;
        return out;
      }),
      null,
      2,
    );
  },

  // Inbound: array of Playwright rows; url-form accepted; malformed rows
  // rejected individually.
  parse(value) {
    if (!Array.isArray(value)) return { ok: false, reason: 'Playwright cookies are a JSON array' };
    const rows = [];
    const invalid = [];
    for (let i = 0; i < value.length; i++) {
      const res = validatePlaywrightRow(value[i]);
      if (res.row) rows.push(res.row);
      else invalid.push({ index: i, reason: res.reason });
    }
    return { ok: true, rows, invalid };
  },
};

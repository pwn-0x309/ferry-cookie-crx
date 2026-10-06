// Dialect #1: EditThisCookie v3 — the serializer interface's first
// implementation. The serializer owns the encoding: field whitelist, field
// order, pretty-printing, and escaping live here, never in the core.
//
// Interface every dialect implements: { id, fields, serialize(coreCookies) }
// mvp2 grows the interface with `parse`: inbound ETC v3 (real EditThisCookie
// exports, the FC dock/clipboard payload) is validated here row by row —
// the parser is liberal, the validator is paranoid. Inbound `httpOnly` is
// accepted and carried verbatim (human ruling 2026-09-28); our own output
// never emits it (the frozen field list stands, `serialize` byte-identical).

export const ETC_V3_FIELDS = [
  'domain',
  'expirationDate',
  'hostOnly',
  'name',
  'path',
  'sameSite',
  'secure',
  'session',
  'storeId',
  'value',
];

export const SAME_SITE_ENUMS = ['no_restriction', 'lax', 'strict', 'unspecified'];

// Fields only the Playwright dialect carries. An ETC row sporting one of
// these is not an ETC row — sniffing uses this to avoid guessing dialects.
export const PLAYWRIGHT_ONLY_FIELDS = ['expires', 'url'];

// Project a core cookie onto the pinned ETC v3 field list. Core keeps
// httpOnly (later dialects need it); the pinned v3 field list does not
// carry it, so it is dropped here.
export function projectToEtcV3(cookie) {
  const out = {};
  for (const field of ETC_V3_FIELDS) {
    if (cookie[field] !== undefined) out[field] = cookie[field];
  }
  return out;
}

const BAD_TYPE = Symbol('bad-type');

function boolOrUndef(value) {
  if (value === undefined || typeof value === 'boolean') return value;
  return BAD_TYPE;
}

// The paranoid per-row validator. Returns { row } on success or
// { reason } naming the malformation. A valid row is normalized to the
// canonical internal shape: ETC fields (httpOnly kept only when === true,
// storeId stringified) with derived session semantics.
export function validateEtcV3Row(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { reason: 'row is not an object' };
  }
  for (const field of PLAYWRIGHT_ONLY_FIELDS) {
    if (raw[field] !== undefined) {
      return { reason: `field "${field}" belongs to the Playwright dialect, not ETC v3` };
    }
  }
  if (typeof raw.name !== 'string' || raw.name === '') return { reason: 'name is missing or empty' };
  if (typeof raw.value !== 'string') return { reason: 'value is missing or not a string' };
  if (typeof raw.domain !== 'string' || raw.domain === '') {
    return { reason: 'domain is missing or empty' };
  }
  // Canonical domain: outer whitespace and leading/trailing dots stripped —
  // a DNS-style trailing dot ("localhost.") must not turn a ferry-shaped
  // row into a foreign one downstream.
  if (raw.domain.trim().replace(/^\.+|\.+$/g, '') === '') {
    return { reason: 'domain is only dots' }; // would normalize to the empty host
  }
  if (raw.path !== undefined && (typeof raw.path !== 'string' || !raw.path.startsWith('/'))) {
    return { reason: 'path does not start with "/"' };
  }

  const hostOnly = boolOrUndef(raw.hostOnly);
  if (hostOnly === BAD_TYPE) return { reason: 'hostOnly is not a boolean' };
  const secure = boolOrUndef(raw.secure);
  if (secure === BAD_TYPE) return { reason: 'secure is not a boolean' };
  const httpOnly = boolOrUndef(raw.httpOnly);
  if (httpOnly === BAD_TYPE) return { reason: 'httpOnly is not a boolean' };

  let sameSite = 'unspecified';
  if (raw.sameSite !== undefined) {
    if (typeof raw.sameSite !== 'string' || !SAME_SITE_ENUMS.includes(raw.sameSite)) {
      return { reason: `sameSite "${raw.sameSite}" is not an ETC v3 enum value` };
    }
    sameSite = raw.sameSite;
  }

  if (raw.session !== undefined && typeof raw.session !== 'boolean') {
    return { reason: 'session is not a boolean' };
  }
  // JSON like 1e999 parses to Infinity — a non-finite expiry must not
  // silently degrade the row to a session cookie.
  if (raw.expirationDate !== undefined && (typeof raw.expirationDate !== 'number' || !Number.isFinite(raw.expirationDate))) {
    return { reason: 'expirationDate is not a finite number' };
  }

  let storeId = '0';
  if (raw.storeId !== undefined) {
    if (typeof raw.storeId === 'string' || typeof raw.storeId === 'number') storeId = String(raw.storeId);
    else return { reason: 'storeId is neither string nor number' };
  }

  const wantsPersistent =
    raw.session !== true && typeof raw.expirationDate === 'number' && Number.isFinite(raw.expirationDate);

  const row = {
    domain: raw.domain.trim().replace(/^\.+|\.+$/g, '').toLowerCase(),
    hostOnly: hostOnly ?? true, // a missing hostOnly is host-only (v1 semantics)
    name: raw.name,
    path: raw.path ?? '/',
    sameSite,
    secure: secure ?? false,
    session: !wantsPersistent,
    storeId,
    value: raw.value,
  };
  if (wantsPersistent) row.expirationDate = raw.expirationDate;
  if (httpOnly === true) row.httpOnly = true; // foreign exports carry it; ours never do
  return { row };
}

export const etcV3 = {
  id: 'etc-v3',
  fields: ETC_V3_FIELDS,
  // Bare JSON array, 2-space pretty print — human eyes are a clipboard
  // consumer too. JSON.stringify escaping is the dialect's whole escape law.
  serialize(coreCookies) {
    return JSON.stringify(coreCookies.map(projectToEtcV3), null, 2);
  },
  // Inbound: validate each row of a parsed bare array. Malformed rows are
  // rejected individually (bucket `invalid`) without failing the whole
  // parse; a parse where every row is invalid counts as unparseable.
  parse(value) {
    if (!Array.isArray(value)) return { ok: false, reason: 'ETC v3 is a bare JSON array' };
    const rows = [];
    const invalid = [];
    for (let i = 0; i < value.length; i++) {
      const res = validateEtcV3Row(value[i]);
      if (res.row) rows.push(res.row);
      else invalid.push({ index: i, reason: res.reason });
    }
    return { ok: true, rows, invalid };
  },
};

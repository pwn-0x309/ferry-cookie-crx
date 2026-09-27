// Dialect #1: EditThisCookie v3 — the serializer interface's first
// implementation. The serializer owns the encoding: field whitelist, field
// order, pretty-printing, and escaping live here, never in the core.
//
// Interface every dialect implements: { id, fields, serialize(coreCookies) }
// Future dialects (Playwright addCookies, cookies.txt, curl — see
// _bmad-output/specs/spec-cookie-ferry/serializer-dialects.md) are additive.

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

export const etcV3 = {
  id: 'etc-v3',
  fields: ETC_V3_FIELDS,
  // Bare JSON array, 2-space pretty print — human eyes are a clipboard
  // consumer too. JSON.stringify escaping is the dialect's whole escape law.
  serialize(coreCookies) {
    return JSON.stringify(coreCookies.map(projectToEtcV3), null, 2);
  },
};

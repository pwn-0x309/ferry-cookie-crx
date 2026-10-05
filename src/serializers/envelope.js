// Dialect: FC envelope — FerryCookie's native dock dialect. The bare ETC
// array legally cannot carry metadata; the envelope wraps the identical
// ETC-projected rows (no hidden fidelity — Q1 ruling) with exactly the
// metadata landing needs:
//   meta.grabbedAt    drives the freshness line ("grab is Nh old")
//   meta.sourceOrigin identifies the ferry route
//   meta.partitionMap records partitioned cookies excluded at grab
//                     (reported, never silently dropped)
//
// Outbound it is only written to storage.session (the dock lane); inbound
// it is sniffed from any lane like the other dialects.

import { projectToEtcV3, validateEtcV3Row } from './etc-v3.js';

export const ENVELOPE_META_FIELDS = ['grabbedAt', 'sourceOrigin', 'partitionMap'];

function validateMeta(meta) {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
    return { reason: 'meta is not an object' };
  }
  if (meta.grabbedAt !== undefined && typeof meta.grabbedAt !== 'number') {
    return { reason: 'meta.grabbedAt is not a number' };
  }
  if (meta.sourceOrigin !== undefined && typeof meta.sourceOrigin !== 'string') {
    return { reason: 'meta.sourceOrigin is not a string' };
  }
  if (meta.partitionMap !== undefined && (meta.partitionMap === null || typeof meta.partitionMap !== 'object' || Array.isArray(meta.partitionMap))) {
    return { reason: 'meta.partitionMap is not an object' };
  }
  return {};
}

export const envelope = {
  id: 'fc-envelope',

  // Dock write: ETC-projected rows (identical to the clipboard payload) +
  // metadata. 2-space pretty print, pinned field order. Missing meta fields
  // are legal (age-unknown envelopes); read from the validated local so a
  // missing meta object cannot throw a raw TypeError.
  serialize(coreCookies, meta) {
    const m = meta ?? {};
    const bad = validateMeta(m);
    if (bad.reason) throw new Error(`fc-envelope meta invalid: ${bad.reason}`);
    return JSON.stringify(
      {
        meta: {
          grabbedAt: m.grabbedAt,
          sourceOrigin: m.sourceOrigin,
          partitionMap: m.partitionMap ?? {},
        },
        cookies: coreCookies.map(projectToEtcV3),
      },
      null,
      2,
    );
  },

  // Inbound: structural meta check, then the cookies run through the ETC v3
  // validator (the dialect owns its rows; the envelope owns only the wrap).
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'FC envelope is a JSON object' };
    }
    if (value.meta === undefined || value.cookies === undefined) {
      return { ok: false, reason: 'FC envelope needs "meta" and "cookies"' };
    }
    const bad = validateMeta(value.meta);
    if (bad.reason) return { ok: false, reason: bad.reason };
    if (!Array.isArray(value.cookies)) {
      return { ok: false, reason: 'FC envelope cookies is not an array' };
    }
    const rows = [];
    const invalid = [];
    for (let i = 0; i < value.cookies.length; i++) {
      const res = validateEtcV3Row(value.cookies[i]);
      if (res.row) rows.push(res.row);
      else invalid.push({ index: i, reason: res.reason });
    }
    return {
      ok: true,
      meta: {
        grabbedAt: typeof value.meta.grabbedAt === 'number' ? value.meta.grabbedAt : null,
        sourceOrigin: typeof value.meta.sourceOrigin === 'string' ? value.meta.sourceOrigin : null,
        partitionMap: value.meta.partitionMap ?? {},
      },
      rows,
      invalid,
    };
  },
};

# Spike results — set() fidelity matrix (SPEC Q2) + clipboard-at-click (Q3)

Run: `node spike/run-spike.mjs` — loads the unpacked extension (manifest
patched to the mvp2 posture: `clipboardRead` added) into the bundled
Chromium and probes `chrome.cookies.set` / `navigator.clipboard` exactly the
way the landing runtime will call them. Raw dump: `spike-raw.json`.

## (a) `httpOnly: true` via set()

**ACCEPTED, stored verbatim** (`httpOnly: true` round-trips through
`getAll`). Foreign ETC exports carrying `httpOnly` can land verbatim — the
human ruling of 2026-09-28 is implementable as written.

## (b) `__Host-` via set() on `http://localhost` — the REPLAN gate

**WRITES.** `set({ url: 'http://localhost/', name: '__Host-x', secure: true,
path: '/' })` lands `secure: true, path: '/', hostOnly: true, domain:
'localhost'`. The `set()` path matches what v1's spike proved via CDP.
**Gate passed — no replan required.**

## (c) `partitionKey` writability

**Writable.** `set({ ..., partitionKey: {} })` succeeds and the row is
readable via `getAll({ partitionKey: {} })`. (Not used by the landing build —
our rows are ETC-projected and unpartitioned — but the fact is pinned.)

## (d) >4096-byte values and the ~180/jar cap

- A 5000-byte value: `set()` **throws** `Failed to parse or set cookie named
  "…"` → maps cleanly to the report's `failed` bucket (per-row error surface
  is a rejection with a message).
- Cap: 220 plain `set()` calls, **all resolved without error**, final jar
  held **159** of them. Chrome silently evicts near the per-domain budget —
  no error surface at all. Consequences pinned into the build:
  1. the capacity pre-flight (~180, "auth-class only" offer) is the only
     up-front guard, and
  2. the post-write jar re-read is the *only* authoritative count — the
     report must be jar-asserted, exactly as the spec mandates.

## (e) Per-row error surface

Mixed, by case:

- `sameSite: 'bogus'` → **promise rejection** (`Value must be one of lax,
  no_restriction, strict, unspecified`), row does not land.
- `name: ''` → **silent resolution**, and a row with an empty name LANDS.
- `sameSite: 'unspecified'` and an explicit `domain` both resolve fine.

So `set()` failures are *sometimes* rejections and sometimes invisible; the
paranoid validator (empty name is `invalid` before any write) plus the jar
re-read together own the report's `failed`/`landed` truth. Write calls are
never trusted on their own.

## (Q3) clipboard read at click under `clipboardRead`

`navigator.clipboard.readText()` inside the extension page, called from a
live click handler, **works with no prompt** once `clipboardRead` is in the
manifest. The clipboard lane is prompt-free in the popup; the textarea lane
still ships as the zero-permission fallback (and for cross-machine paste
without granting anything).

## Pinned decisions for the build

1. `writeCookie` passes `url` (host-only intent) and omits `domain`; the
   rows are host-only after retarget, per v1's flatten amendment.
2. `sameSite: 'unspecified'` is passed through to `set()` (legal).
3. Values are never truncated by us: an oversize value is a `failed` row.
4. Report counts come from the jar re-read, never from `set()` resolutions.
5. Capacity pre-flight threshold: 180.

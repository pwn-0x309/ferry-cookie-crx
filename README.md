# FerryCookie

One-gesture localhost cookie ferry, both directions. **Copy**: click,
context-menu, or shortcut puts a live site's cookies on your clipboard as
EditThisCookie-v3 JSON with every host rewritten to `localhost`. **Land**:
paste or reuse that grab, see exactly what would happen, and put the session
onto a local jar — with a per-row report and one-click undo.

Vanilla JS, no build step, no bundler — the whole extension is reviewable in
one sitting. That is the security pitch.

## Showcase

The whole loop in real screenshots — copy, land, proof, undo, refusals — in
[docs/showcase.md](docs/showcase.md). The short version:

| Copy | Land | Proof |
|---|---|---|
| ![Copy receipt](docs/screenshots/01-copy-grab.png) | ![Land diff](docs/screenshots/04-land-diff.png) | ![Local dev after landing](docs/screenshots/08-local-after.png) |

## Layout

```
manifest.json                     MV3: permissions, command, context menu, offscreen
src/core/rewrite.js               pure copy core: rewrite(sourceOrigin, targetOrigin)
                                  + jar dedupe/preview/protect + partitioned exclusion
src/core/landing.js               pure landing core: sniff → validate → retarget →
                                  planLanding → report buckets (the contract of
                                  spec-ferry-cookie-apply)
src/serializers/etc-v3.js         ETC v3 dialect: serialize (byte-stable) + parse
src/serializers/envelope.js       FC envelope dialect (the dock): serialize + parse
src/serializers/playwright.js     Playwright addCookies dialect: serialize + parse
src/shared/grab.js                chrome.* read helpers shared by popup and worker
src/shared/land.js                landing runtime: lanes, writes, snapshots,
                                  jar re-read verify
src/popup/                        receipt, guards, preview, protect list, clear,
                                  and the Land flow (diff screen, modes, routes,
                                  report, undo, textarea fallback)
src/background/service-worker.js  context-menu + command triggers; dock write
src/offscreen/                    clipboard fallback (DOM) outside the popup
spike/                            set() fidelity matrix results (throwaway probes)
test/fixtures/F1..F14.json        golden fixtures — copy (F1–F10) and landing
                                  (F11–F14) contracts
test/unit/                        node --test around the cores + dialects
test/e2e/                         Playwright: load unpacked, replay F1/F3/F10,
                                  the whole loop, refusals, undo
```

## Install

```
make run        # opens chrome://extensions
```

Then enable Developer mode and Load unpacked → select this `ferry-cookie/`
folder.

## Copy (unchanged from v1)

- **Popup (primary):** click the FerryCookie action. The receipt shows the
  cookie count, the source host, and the grab time. *Copy to clipboard* is
  the only thing that writes the clipboard, and only on your click.
- **Preview & protect:** the popup lists cookies present on both the grab
  and the local `localhost` jar (ports share one jar) in a collapsed-by-default
  **On localhost too** disclosure — it auto-expands on open while anything is
  protected. Tick a cookie to protect it: protected names never enter the
  JSON and are listed in the popup. The protect list (names only) lives in
  `storage.session`.
- **Clear:** after any copy the popup shows *clipboard holds credentials*
  with a one-tap **Clear clipboard**.
- **Context menu / shortcut:** right-click → *Copy cookies as localhost
  JSON*, or `Ctrl/Cmd+Shift+9`. These gestures copy through the offscreen
  document; the badge shows the count (or `!` when a page is restricted or
  has no cookies).

## Land (mvp2)

Every successful copy also refreshes the **dock** — the session-scoped copy
of the grab (an FC envelope: the same ETC rows plus `grabbedAt` /
`sourceOrigin` metadata). The Land flow lives in the popup below the copy
surface, and leads with a **quick action** — *Land last grab → localhost*,
pinned to dock lane, `localhost`, fill-gaps, no advanced toggle, whatever the
controls or session prefs say. The controls themselves (steps 1–3) sit behind
a collapsed *Change source, route, or mode* disclosure:

1. **Pick a lane** — *Dock (last grab)*, *Clipboard* (read at the Read
   click, never at popup-open), or *Paste* (a textarea; needs no clipboard
   permission at all).
2. **Pick a jar and a mode** — target `localhost`, `127.0.0.1`, or `[::1]`;
   mode *fill-gaps* (default — only names the jar lacks; can never destroy),
   *merge* (upsert), *replace* (clear + write), or *curated* (tick rows on
   the diff screen). The chosen lane/route/mode persist for the session
   only.
3. **Read input** — the click parses the lane. Dialects are sniffed in a
   pinned order (ETC v3 → FC envelope → Playwright `addCookies`); input
   that fits two dialects asks you to pick, never guesses. Unparseable or
   empty input disables Land naming the reason.
4. **The diff screen** — pre-flight math ("adds 4, overwrites 1, excludes 2
   foreign"), a freshness line ("grab is 5m old"; bare arrays say
   "age unknown"), and, in replace mode, a typed `LAND` confirmation.
   Fill-gaps/merge/curated confirm with one click. Enter confirms, Esc
   backs out.
5. **The report** — every row's fate in exactly one bucket:
   `landed` / `overwritten` / `skipped-foreign` / `skipped-protected` /
   `invalid` / `failed` — plus `removed` for replace-mode removals, and a
   kept-count for fill-gaps rows already present (never written, never
   excluded). Counts are asserted by re-reading the jar after the writes,
   never by trusting the write calls; partial success is loud.
6. **Undo** — the jar is snapshotted before the first write of every
   landing; the report screen offers a one-click restore (itself shown
   diff-then-confirm, so undo can never become the new accident).

### What Land will never do

- **Write outside the confirmed jar.** Rows whose domain is loopback-shaped
  (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost` — dot-insensitive)
  retarget onto the chosen target; every other domain is reported
  `skipped-foreign` and never written. A clipboard seeded with
  `.internal.corp` rows lands zero of them.
- **Land automatically.** Every landing is an explicit gesture.
- **Touch protected names.** The v1 protect list excludes names from
  landing in every mode (`skipped-protected`), and replace never removes
  them. Restores are the deliberate exception: a snapshot is the whole
  truth of the jar at grab time, so restoring one rebuilds every row it
  holds — protected or not.
- **Write a remote host silently.** The default build writes only the three
  loopback jars. An *Advanced* toggle unlocks remote targets one host at a
  time, with a standing warning: **a landed session acts as you against
  that backend.**

### Capacity

Chrome silently evicts cookies near ~180 per jar (the spike in `spike/`
measured it: 220 successful `set()` calls left 159 rows). When a landing
would push the jar past that line, Land offers an inline *auth-class only*
filter (`session|auth|token|jwt|^sid`) instead of failing — and the
post-write jar re-read catches anything the browser dropped anyway
(`failed` bucket).

## httpOnly deviation (read this)

Our dialects never emit `httpOnly` — the frozen ETC v3 field list stands
(human ruling, reaffirmed 2026-09-28). A landed session may therefore be
JS-readable on localhost where its production original was httpOnly. If you
need the httpOnly bit preserved, import the clipboard JSON via
EditThisCookie instead. Foreign ETC exports that *do* carry `httpOnly`
inbound are accepted and landed verbatim.

## Permissions posture

Preferred posture was C (`activeTab`, no standing host permissions).
Spike #0 could not produce the required user gesture in an automated
environment, and the `chrome.cookies` API is documented to return "only
cookies for domains that the extension has host permissions to" while
community evidence says it ignores `activeTab`'s temporary grant — so this
build ships the spec's fallback: `host_permissions: ["<all_urls>"]`, the
broadest-necessary set because the source site is arbitrary. Nothing else
about the extension reads pages; the permission exists only so
`cookies.getAll` can see the active tab's jar.

To revisit: remove `host_permissions` from `manifest.json`, add
`"activeTab"` to `permissions`, load unpacked, and click the action on a
logged-in page. If cookies appear, posture C works on your Chrome — flip
the manifest and keep the rest unchanged.

`clipboardWrite` exists for the alternate copy gestures only. `clipboardRead`
(spike-verified: read-at-click works prompt-free in the popup) exists for
the Land flow's clipboard lane; the textarea lane ships regardless and
needs no clipboard permission — that is the IT-approvable path. No code
path reads the clipboard except the explicit **Read input** click.

## Security notes

- Zero egress, zero telemetry.
- Cookie values at rest live only in `storage.session` — the dock grab and
  the undo snapshots. **Snapshots die with the browser; that is the
  retention policy.** Up to 3 are kept, oldest evicted.
- Cookie values are rendered via `textContent` only, never HTML.
- An empty array never reaches the clipboard; restricted pages
  (`chrome://`, Web Store, PDF viewer, extension pages) and zero-cookie
  pages disable the action naming the reason.
- Every copy and every landing is an explicit human act.

## Verify

```
make test       # node --test unit suite: F1–F10 (copy) + F11–F14 (landing)
make e2e        # Playwright: real Chromium, unpacked extension — copy
                # replays, the Playwright-dialect acceptance, the whole
                # loop (127.0.0.1 → copy → dock → Land on localhost →
                # undo), and the refusal paths
```

`make e2e` needs the playwright package with its bundled Chromium:
`cd test/e2e && npm install` (the install downloads that version's
Chromium), or point `FC_PLAYWRIGHT_ROOT` at a directory that already has
playwright. The harness launches the bundled Chromium first — branded
Google Chrome ignores `--load-extension` under automation on recent
versions and is only a last-resort fallback.

Manual check: on a real logged-in site, copy → open the popup → Land (dock
lane) → your dev server's request headers carry the session cookies →
Undo puts the jar back.

## Deferred

File-import lane (snapshot `.json` import), inbound `Cookie`-header /
`cookies.txt` parsing, outbound `curl` / `cookies.txt` dialects, keyboard
land shortcut, cross-profile routes, settings page — see
`_bmad-output/specs/spec-ferry-cookie-apply/SPEC.md` (Non-goals).

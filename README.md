# FerryCookie

One-gesture localhost cookie copy. Click, context-menu, or shortcut: every
cookie visible to the active tab's site lands on your clipboard as
EditThisCookie-v3 JSON with every host rewritten to `localhost`. Import it in
EditThisCookie and your local dev server runs with the live session.

Vanilla JS, no build step, no bundler — the whole extension is reviewable in
one sitting. That is the security pitch.

## Layout

```
manifest.json                     MV3: permissions, command, context menu, offscreen
src/core/rewrite.js               pure rewrite(sourceOrigin, targetOrigin) + jar
                                  dedupe/preview/protect + partitioned exclusion
                                  + pair-check (the contract of rewrite-policy.md)
src/serializers/etc-v3.js         ETC v3 encoding behind a serializer interface
src/shared/grab.js                chrome.* helpers shared by popup and worker
src/popup/                        receipt, guards, preview, protect list, clear
src/background/service-worker.js  context-menu + command triggers
src/offscreen/                    clipboard fallback (DOM) outside the popup
test/fixtures/F1..F10.json        golden fixtures — the rewrite contract
test/unit/                        node --test around rewrite() + serializer
test/e2e/                         Playwright: load unpacked, replay F1/F3/F10
```

## Install

```
make run        # opens chrome://extensions
```

Then enable Developer mode and Load unpacked → select this `ferry-cookie/`
folder.

## Use

- **Popup (primary):** click the FerryCookie action. The receipt shows the
  cookie count, the source host, and the grab time. *Copy to clipboard* is
  the only thing that writes the clipboard, and only on your click.
- **Preview & protect:** the popup lists cookies present on both the grab
  and the local `localhost` jar (ports share one jar). Tick a cookie to
  protect it: protected names never enter the JSON and are listed in the
  popup. The protect list (names only) lives in `storage.session`.
- **Clear:** after any copy the popup shows *clipboard holds credentials*
  with a one-tap **Clear clipboard**.
- **Context menu / shortcut:** right-click → *Copy cookies as localhost
  JSON*, or `Ctrl/Cmd+Shift+9`. These gestures copy through the offscreen
  document; the badge shows the count (or `!` when a page is restricted or
  has no cookies).

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
logged-in page. If cookies appear, posture C works on your Chrome — flip the
manifest and keep the rest unchanged.

`clipboardWrite` exists for the alternate gestures only: the offscreen
clipboard fallback (context menu / shortcut) cannot carry the popup's user
activation, and Chrome rejects that write without the permission. It grants
no new read surface, and no code path writes the clipboard except the
explicit copy actions above.

## Security notes

- Zero egress, zero telemetry. Cookie values are never persisted anywhere;
  transient state (receipt counts, protect *names*) lives in
  `storage.session` only.
- Cookie values are rendered via `textContent` only, never HTML.
- An empty array never reaches the clipboard; restricted pages
  (`chrome://`, Web Store, PDF viewer, extension pages) and zero-cookie
  pages disable the action naming the reason.
- Every copy is an explicit human act — popup click, context menu, or
  keyboard command.

## Verify

```
make test       # node --test unit suite on F1–F10 (no deps)
make e2e        # Playwright: real Chrome, unpacked extension, F1/F3/F10 replay
```

`make e2e` needs the playwright package with its bundled Chromium:
`cd test/e2e && npm install` (the install downloads that version's
Chromium), or point `FC_PLAYWRIGHT_ROOT` at a directory that already has
playwright. The harness launches the bundled Chromium first — branded
Google Chrome ignores `--load-extension` under automation on recent
versions and is only a last-resort fallback.

Manual check: on a real logged-in site, copy → paste into EditThisCookie →
import onto `localhost` → your dev server's request headers carry the
session cookies.

## Deferred

The Playwright `addCookies` dialect is a follow-up spec — see
`_bmad-output/specs/spec-cookie-ferry/serializer-dialects.md` and
`_bmad-output/implementation-artifacts/deferred-work.md`; the serializer
interface in `src/serializers/etc-v3.js` makes it additive.

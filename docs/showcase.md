# FerryCookie Showcase

The whole loop in screenshots: copy a logged-in site's cookies, land them on `localhost`, prove it, undo it. Every shot below is the real extension UI driven end to end — a production stand-in site on `127.0.0.1:8788` (logged in, 3 cookies) and a local dev server on `localhost:8787` (empty jar).

## 1 · Install (once)

`make run` opens `chrome://extensions` pointed at this folder — enable **Developer mode**, click **Load unpacked**, select `ferry-cookie/`. Nothing to configure.

## 2 · Copy — one gesture on the logged-in site

Open the site you're logged into and click the FerryCookie icon. The popup is a receipt, not a dashboard: source host, cookie count, grab time, and the flags that changed the story (partitioned cookies excluded, duplicates collapsed, broken `SameSite` pairs). The **Would overwrite** list shows which local cookies an import would clobber — tick a checkbox to *protect* a name the ferry must never touch, on either side.

![Copy view — receipt, flags, and the overwrite preview with protect checkboxes](screenshots/01-copy-grab.png)

Click **Copy to clipboard** (or use the right-click menu "Copy cookies as localhost JSON", or `Ctrl/Cmd+Shift+9`). The credential state becomes visible — the clipboard now holds live session data, with a one-tap clear:

![After Copy — clipboard holds credentials, one-tap clear](screenshots/02-copy-done.png)

The clipboard carries EditThisCookie-v3 JSON with every host already rewritten to `localhost` (paste it into EditThisCookie anywhere — it imports as-is). The same grab also lands in the **dock**, the extension's session-scoped holding area, so the same-browser loop needs no clipboard at all.

## 3 · Land — the guarded write

Open your local dev server (`http://localhost:3000` — ports share one jar) and open the popup again. The **Land** section defaults to the common case: dock lane, `localhost` route, fill-gaps mode:

![Land setup — lane, route, mode](screenshots/03-land-setup.png)

**Read input** shows the diff screen before anything is written — what lands, what overwrites, what's excluded, and how old the grab is:

![Land diff — pre-flight math, freshness, per-row fate](screenshots/04-land-diff.png)

One click lands it (fill-gaps and merge are single-click *because they cannot destroy*; replace requires typing `LAND` — see §6). The report is asserted against the jar re-read, not the write calls — partial success is loudly partial:

![Land report — jar-verified, every row's fate](screenshots/05-land-report.png)

## 4 · Proof — the local app sees the session

Before the landing, `document.cookie` on the local dev server is empty:

![Local dev server before landing](screenshots/07-local-before.png)

After, the ferried session is live:

![Local dev server after landing](screenshots/08-local-after.png)

> The session cookie lands **readable by page JavaScript** even when production's was `httpOnly` — a documented deviation by design (ferry lanes never carry the flag). If localhost misbehaves, remember the local stage is wider than production's.

## 5 · Undo — one click, guarded

Every landing snapshots the target jar first (`storage.session`, at most 3, dies with the browser — that's the retention policy). The popup's snapshot list offers the restore, and the restore is itself diff-then-confirm, so the undo can never become the new accident:

![Undo — restore diff before confirming](screenshots/06-undo-restore.png)

## 6 · Replace mode — the typed gate

Replace clears the jar before writing, so its confirm is proportional to its blast radius: type `LAND` to arm the button. The diff screen shows exactly what will be removed ("removes N") before you do:

![Replace mode — the typed LAND confirmation gate](screenshots/10-replace-gate.png)

## 7 · Refusals — foreign input and empty jars

Paste a real-world export (or a seeded clipboard) whose rows claim other domains, and Land refuses by name — the tool only ever writes the confirmed local target, so cross-domain rows can only ever be *reported*:

![Foreign input refused, domains named](screenshots/09-foreign-refused.png)

Pages with nothing to ferry disable the action with the reason instead of a dead button — an empty array never reaches the clipboard:

![Zero-cookie page — named disable](screenshots/11-guard-empty-jar.png)

## Cheat sheet

| Gesture | Where | Posture |
|---|---|---|
| Copy | popup / context menu / `Ctrl+Cmd+9` | one click + visible credential state |
| Land (fill-gaps, merge, curated) | popup → Read input → Land | one click on the diff |
| Land (replace) | popup → mode: replace | type `LAND` |
| Undo | report screen or snapshot list | diff-then-confirm |

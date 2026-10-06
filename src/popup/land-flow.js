// Land flow — the popup's mvp2 surface (CAP-1..8). Owns the setup →
// (dialect) → diff → report state machine and the restore (undo) flow.
// The v1 copy flow in popup.js is untouched; this module only adds.
//
// Laws held here:
//   - every landing is an explicit gesture; the clipboard is read at click,
//     never at popup-open;
//   - posture scales: fill-gaps/merge/curated one click on the diff screen,
//     replace requires typing LAND, restore is itself diff-then-confirm;
//   - the writer only ever writes the confirmed route target host
//     (routeGate refuses remote targets unless the advanced toggle is on);
//   - cookie values render via textContent only, never HTML.

import {
  DEFAULT_ROUTES,
  JAR_CAPACITY,
  authClassRows,
  freshnessLine,
  isLoopbackHost,
  originFor,
  planLanding,
  retargetRows,
  routeGate,
  sniff,
} from '../core/landing.js';
import {
  landWithSnapshot,
  listSnapshots,
  readClipboard,
  readDock,
  restoreSnapshot,
  planRestore,
} from '../shared/land.js';
import { getLocalJarCookies } from '../shared/grab.js';
import { jarKey } from '../core/rewrite.js';

const DIALECT_LABELS = {
  'etc-v3': 'EditThisCookie v3 array',
  'fc-envelope': 'FerryCookie envelope (dock)',
  playwright: 'Playwright addCookies array',
};

const $ = (id) => document.getElementById(id);

const PREFS_KEY = 'fc-land-prefs';

export function initLandFlow({ getProtect, getActiveTabUrl }) {
  const land = {
    view: 'setup', // setup | dialect | diff | report | restore
    chosen: null, // { dialect, parse }
    pipeline: null, // { targetHost, rows, foreign, filtered, invalid, meta, duplicatesCollapsed }
    plan: null,
    localJar: null,
    report: null,
    reportKind: null, // 'landing' | 'restore' — the report headline follows it
    undoSnapshot: null,
    restoreTarget: null,
    authFiltered: false,
    busy: false, // one landing gesture at a time — double-clicks must not run two
  };

  const views = ['land-setup', 'land-dialect', 'land-diff', 'land-report', 'land-restore'];

  // Double-click guard around every async gesture handler.
  async function guarded(fn) {
    if (land.busy) return;
    land.busy = true;
    try {
      await fn();
    } finally {
      land.busy = false;
    }
  }

  // Routes and mode are session-scoped (landing-policy): the chosen lane,
  // route, and mode survive popup reopens for this browser session and
  // never persist beyond it.
  async function restorePrefs() {
    try {
      const stored = await chrome.storage.session.get(PREFS_KEY);
      const prefs = stored[PREFS_KEY];
      if (!prefs) return;
      // Guard every stored value against the real option sets — a bad
      // stored lane/mode would make planLanding throw and kill the Read.
      const lanes = ['dock', 'clipboard', 'textarea'];
      const modes = ['fill-gaps', 'merge', 'replace', 'curated'];
      if (typeof prefs.lane === 'string' && lanes.includes(prefs.lane)) $('land-lane').value = prefs.lane;
      if (typeof prefs.route === 'string' && [...$('land-route').options].some((o) => o.value === prefs.route)) {
        $('land-route').value = prefs.route;
      }
      if (typeof prefs.mode === 'string' && modes.includes(prefs.mode)) $('land-mode').value = prefs.mode;
      if (typeof prefs.advanced === 'boolean') $('land-advanced-toggle').checked = prefs.advanced;
      $('land-textarea-row').hidden = $('land-lane').value !== 'textarea';
      // The typed-host row is always visible (loopback typed hosts are
      // default-writable); only the acts-as-you warning follows the toggle.
      $('land-remote-warning').hidden = !$('land-advanced-toggle').checked;
    } catch {
      // prefs are a convenience; never block the flow on them
    }
  }

  async function savePrefs() {
    try {
      await chrome.storage.session.set({
        [PREFS_KEY]: {
          lane: $('land-lane').value,
          route: $('land-route').value,
          mode: $('land-mode').value,
          advanced: $('land-advanced-toggle').checked,
        },
      });
    } catch {
      // same
    }
  }

  function show(view) {
    land.view = view;
    for (const id of views) $(id).hidden = id !== 'land-' + view;
    if (view === 'setup') renderSnapshotList();
  }

  function reason(text) {
    const el = $('land-reason');
    el.textContent = text ?? '';
    el.hidden = !text;
  }

  function targetHostOf() {
    // A typed host is honored when it is loopback-shaped (*.localhost is a
    // policy-default target — no toggle owed) or when the advanced toggle
    // is on; routeGate stays the single gatekeeper either way.
    const typed = $('land-remote-host').value.trim().toLowerCase();
    if (typed !== '') {
      if (isLoopbackHost(typed)) return typed;
      if ($('land-advanced-toggle').checked) return typed;
    }
    return $('land-route').value;
  }

  // -------------------------------------------------------------------------
  // Read (the gesture) → sniff → plan
  // -------------------------------------------------------------------------

  async function onReadInput() {
    reason('');
    const targetHost = targetHostOf();
    const gate = routeGate(targetHost, { advanced: $('land-advanced-toggle').checked });
    if (gate) {
      reason(gate);
      return;
    }

    let text;
    const lane = $('land-lane').value;
    try {
      if (lane === 'dock') {
        text = await readDock();
        if (text === null) {
          reason('the dock is empty — copy something first (this session)');
          return;
        }
      } else if (lane === 'clipboard') {
        text = await readClipboard(); // read at click, never at popup-open
        if (text.trim() === '') {
          reason('the clipboard is empty');
          return;
        }
      } else {
        text = $('land-textarea').value;
        if (text.trim() === '') {
          reason('the paste area is empty');
          return;
        }
      }
    } catch (err) {
      reason('lane read failed: ' + (err?.message ?? String(err)));
      return;
    }

    const result = sniff(text);
    if (!result.ok) {
      reason('cannot land: ' + result.reason);
      return;
    }
    if (result.ambiguous) {
      land.chosen = null;
      renderDialectOptions(result.candidates);
      show('dialect');
      return;
    }
    land.chosen = { dialect: result.dialect, parse: result.parse };
    await enterDiff(targetHost);
  }

  function renderDialectOptions(candidates) {
    const box = $('land-dialect-options');
    box.replaceChildren();
    for (const [i, candidate] of candidates.entries()) {
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'land-dialect-pick';
      radio.id = `land-dialect-${i}`;
      radio.value = i;
      if (i === 0) radio.checked = true;
      const label = document.createElement('label');
      label.htmlFor = radio.id;
      label.textContent = DIALECT_LABELS[candidate.dialect] ?? candidate.dialect;
      const row = document.createElement('div');
      row.className = 'land-row';
      row.append(radio, label);
      box.appendChild(row);
    }
    box.dataset.count = String(candidates.length);
    land.candidates = candidates;
  }

  async function onDialectPick() {
    const checked = document.querySelector('input[name="land-dialect-pick"]:checked');
    if (!checked) return;
    land.chosen = land.candidates[Number(checked.value)];
    land.candidates = null;
    await enterDiff(targetHostOf());
  }

  async function enterDiff(targetHost) {
    const parse = land.chosen.parse;
    const { rows, foreign, duplicatesCollapsed } = retargetRows(parse.rows, targetHost);
    const mode = $('land-mode').value;
    if (rows.length === 0 && foreign.length > 0) {
      reason(
        `zero written — every row is foreign, reported and never landed (${foreign
          .map((f) => `${f.name}@${f.domain}`)
          .join(', ')})`,
      );
      return;
    }
    let localJar;
    try {
      localJar = await getLocalJarCookies(originFor(targetHost));
    } catch (err) {
      reason('cannot read the target jar: ' + (err?.message ?? String(err)));
      return;
    }
    const protect = getProtect();
    let plan = planLanding(rows, localJar, mode, protect);
    if (plan.refused) {
      reason(plan.refused);
      return;
    }

    land.authFiltered = false;
    land.pipeline = {
      targetHost,
      rows,
      foreign,
      filtered: [], // rows dropped by the auth-class capacity offer — never foreign
      invalid: parse.invalid ?? [],
      meta: parse.meta ?? null,
      protect,
      duplicatesCollapsed,
    };
    land.localJar = localJar;
    land.plan = plan;
    renderDiff();
    show('diff');
  }

  // -------------------------------------------------------------------------
  // Diff screen
  // -------------------------------------------------------------------------

  function mathLine(plan, pipeline, curatedCount = null) {
    const parts = [`adds ${plan.math.adds}`, `overwrites ${plan.math.overwrites}`];
    if (plan.mode === 'replace') parts.push(`removes ${plan.math.removes}`);
    if (plan.math.keptExisting > 0) parts.push(`${plan.math.keptExisting} already present (kept)`);
    if (pipeline.foreign.length) parts.push(`excludes ${pipeline.foreign.length} foreign`);
    if (pipeline.filtered.length) parts.push(`${pipeline.filtered.length} filtered (auth-class)`);
    if (plan.skippedProtected.length) parts.push(`excludes ${plan.skippedProtected.length} protected`);
    if (pipeline.invalid.length) parts.push(`${pipeline.invalid.length} invalid`);
    if (pipeline.duplicatesCollapsed > 0) parts.push(`${pipeline.duplicatesCollapsed} duplicate${pipeline.duplicatesCollapsed === 1 ? '' : 's'} collapsed (last write wins)`);
    if (curatedCount !== null) parts.push(`${curatedCount} of ${pipeline.rows.length} rows checked`);
    return parts.join(', ');
  }

  function rowFate(plan, row) {
    const key = `${row.name}\n${row.path}`;
    if (plan.adds.some((r) => r.name === row.name && r.path === row.path)) return 'add';
    if (plan.overwrites.some((r) => r.name === row.name && r.path === row.path)) return 'overwrite';
    if (plan.keptExisting.some((r) => r.name === row.name && r.path === row.path)) return 'kept';
    return '—';
  }

  function renderDiff() {
    const { plan, pipeline } = land;
    // Freshness from the envelope's meta.grabbedAt; bare arrays have none —
    // "age unknown". Shown always; a stale grab lands fine (I/O matrix).
    $('land-freshness').textContent = freshnessLine(pipeline.meta?.grabbedAt ?? null);
    $('land-math').textContent = mathLine(plan, pipeline);

    const capacity = $('land-capacity');
    // The warning shows whenever the CURRENT plan is over — including the
    // auth-filtered one if it still does not fit. Only the offer button
    // disappears after filtering (offering twice would loop).
    if (plan.capacity.over) {
      capacity.replaceChildren();
      capacity.append(
        document.createTextNode(
          `This landing would push the jar past ~${JAR_CAPACITY} cookies (projected ${plan.capacity.projectedJarSize}) — Chrome silently evicts near the cap. ` +
            (land.authFiltered ? 'The auth-class filter still does not fit; landing anyway risks silent evictions.' : ''),
        ),
      );
      if (!land.authFiltered) {
        const offer = document.createElement('button');
        offer.className = 'secondary';
        offer.textContent = 'Land auth-class only (session|auth|token|jwt|^sid)';
        offer.addEventListener('click', onAuthClassOffer);
        capacity.appendChild(offer);
      }
      capacity.hidden = false;
    } else {
      capacity.hidden = true;
    }

    const ul = $('land-rows');
    ul.replaceChildren();
    const curated = $('land-mode').value === 'curated';
    for (const row of pipeline.rows) {
      ul.appendChild(renderRowLi(row, curated, rowFate(plan, row)));
    }
    for (const row of pipeline.foreign) {
      ul.appendChild(renderRowLi(row, false, 'foreign — not written', 'foreign'));
    }
    for (const row of pipeline.filtered) {
      ul.appendChild(renderRowLi(row, false, 'filtered out (auth-class) — not written', 'filtered'));
    }
    for (const entry of pipeline.invalid) {
      const li = document.createElement('li');
      li.className = 'invalid';
      const name = document.createElement('span');
      name.textContent = `row #${entry.index + 1}`;
      const fate = document.createElement('span');
      fate.className = 'fate';
      fate.textContent = `invalid — ${entry.reason}`;
      li.append(name, fate);
      ul.appendChild(li);
    }

    const replaceGateBox = $('land-replace-gate');
    const isReplace = plan.mode === 'replace';
    replaceGateBox.hidden = !isReplace;
    if (isReplace) {
      $('land-type-land').value = '';
      $('land-type-land').placeholder = 'removes ' + plan.math.removes + ' — type LAND';
    }

    const activeUrl = getActiveTabUrl();
    const activeHost = typeof activeUrl === 'string' && activeUrl ? jarKey(activeUrl) : null;
    $('land-confirm').textContent = activeHost === pipeline.targetHost ? 'Land here' : `Land to ${pipeline.targetHost}`;
    updateConfirmGate();
  }

  function renderRowLi(row, curated, fate, extraClass = '') {
    const li = document.createElement('li');
    if (extraClass) li.className = extraClass;
    const protectedRow = land.pipeline.protect.includes(row.name);
    if (curated && !protectedRow) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.dataset.name = row.name;
      box.dataset.path = row.path;
      box.setAttribute('aria-label', `land ${row.name} ${row.path}`);
      li.appendChild(box);
    } else if (curated) {
      const lock = document.createElement('span');
      lock.className = 'fate';
      lock.textContent = 'locked';
      li.appendChild(lock);
    }
    const name = document.createElement('span');
    name.textContent = row.name;
    const path = document.createElement('span');
    path.className = 'path';
    path.textContent = row.path;
    const fateEl = document.createElement('span');
    fateEl.className = 'fate';
    fateEl.textContent = protectedRow ? 'protected — skipped' : fate;
    li.append(name, path, fateEl);
    return li;
  }

  function onAuthClassOffer() {
    const { rows, filtered, invalid, targetHost, protect, meta } = land.pipeline;
    const keep = authClassRows(rows);
    land.authFiltered = true;
    const plan = planLanding(keep, land.localJar, $('land-mode').value, protect);
    if (plan.refused) {
      reason(plan.refused);
      return;
    }
    // Dropped rows are filtered (their own diff line + report count) —
    // never mislabeled foreign.
    land.pipeline = {
      ...land.pipeline,
      rows: keep,
      filtered: [...filtered, ...rows.filter((r) => !keep.includes(r))],
    };
    land.plan = plan;
    renderDiff();
  }

  function checkedCount() {
    return document.querySelectorAll('#land-rows input[type="checkbox"]:checked').length;
  }

  function updateConfirmGate() {
    const plan = land.plan;
    const confirm = $('land-confirm');
    if (plan.mode === 'replace') {
      confirm.disabled = $('land-type-land').value !== 'LAND';
      return;
    }
    if (plan.mode === 'curated') {
      // Gate on the LIVE checked-row count, not the stale full plan — an
      // empty curated selection must never reach a landing.
      confirm.disabled = checkedCount() === 0;
      if (confirm.disabled && land.view === 'diff') {
        reason('curated landing refused — no rows checked (nothing would land, no snapshot taken)');
      } else {
        reason('');
      }
      return;
    }
    confirm.disabled = plan.writes.length === 0;
    if (confirm.disabled && land.view === 'diff') {
      // Name the actual cause — zero writes can come from kept rows,
      // protected rows, or invalid rows, not only "already present".
      if (plan.keptExisting.length) {
        reason('nothing to write — every row is already present (fill-gaps keeps them)');
      } else if (plan.skippedProtectedCount) {
        reason('nothing to write — every row is protected (skipped, never written)');
      } else {
        reason('nothing to write — no rows survived validation');
      }
    } else {
      reason('');
    }
  }

  // -------------------------------------------------------------------------
  // Confirm → land → report
  // -------------------------------------------------------------------------

  async function onConfirm() {
    const { targetHost, foreign, filtered, invalid, protect, duplicatesCollapsed } = land.pipeline;
    let plan = land.plan;
    let rows = land.pipeline.rows; // the rows the executed plan must be re-derived from
    if (plan.mode === 'curated') {
      const checkedKeys = new Set(
        [...document.querySelectorAll('#land-rows input[type="checkbox"]')]
          .filter((box) => box.checked)
          .map((box) => `${box.dataset.name}\n${box.dataset.path}`),
      );
      const selected = land.pipeline.rows.filter((row) => checkedKeys.has(`${row.name}\n${row.path}`));
      if (selected.length === 0) {
        // No snapshot, no landing — a zero-row curated confirm is refused by name.
        reason('curated landing refused — no rows checked (nothing would land, no snapshot taken)');
        return;
      }
      // Re-plan as curated (not merge) so the snapshot label tells the truth.
      plan = planLanding(selected, land.localJar, 'curated', protect);
      if (plan.refused) {
        reason(plan.refused);
        return;
      }
      land.plan = plan;
      rows = selected;
    }

    const label = `${plan.mode} → ${targetHost} (adds ${plan.math.adds}, overwrites ${plan.math.overwrites}${plan.mode === 'replace' ? ', removes ' + plan.math.removes : ''})`;
    try {
      const result = await landWithSnapshot({
        plan,
        rows,
        targetHost,
        foreign,
        invalid,
        duplicatesCollapsed,
        label: `${label} — ${new Date().toLocaleTimeString()}`,
      });
      land.report = result.report;
      land.reportKind = 'landing';
      land.undoSnapshot = result.snapshot;
      renderReport(result.report);
      show('report');
    } catch (err) {
      reason('landing failed: ' + (err?.message ?? String(err)));
    }
  }

  function renderReport(report) {
    const c = report.counts;
    const attempted = c.landed + c.overwritten + c.failed;
    const line = $('land-report-line');
    if (report.unverified) {
      // The writes already happened; the verify re-read itself failed. Say
      // so instead of a plain "landing failed".
      line.textContent = `issued ${report.issued} writes — could not verify the jar (${report.verifyError})`;
    } else if (land.reportKind === 'restore') {
      // A restore's action is the rebuild, not "landed N/M" — its headline
      // says so (removals are the bulk of a restore, not a footnote).
      line.textContent = `restored ${c.landed + c.overwritten + c.removed} — jar-verified` + (report.partial ? ' — PARTIAL: some rows did not make it' : '');
    } else {
      line.textContent = `landed ${c.landed}/${attempted} — jar-verified` + (report.partial ? ' — PARTIAL: some rows did not make it' : '');
    }
    line.classList.toggle('partial', report.partial || Boolean(report.unverified));

    const ul = $('land-report-rows');
    ul.replaceChildren();
    const lines = [];
    if (report.unverified) lines.push(`could-not-verify: the post-write jar re-read failed (${report.verifyError})`);
    if (c.landed) lines.push(`landed: ${report.landed.map((r) => r.name).join(', ')}`);
    if (c.overwritten) lines.push(`overwritten: ${report.overwritten.map((r) => r.name).join(', ')}`);
    if (c.removed) lines.push(`removed: ${report.removed.map((r) => r.name).join(', ')}`);
    if (c.skippedForeign) lines.push(`skipped-foreign (never written): ${report.foreignNames.join(', ')}`);
    // Guarded reads: a restore's report must never quote the previous
    // landing's pipeline/plan state (onRestoreConfirm clears both, and the
    // guards keep a cleared state from throwing here).
    if (c.skippedProtected && land.plan?.skippedProtected?.length) {
      lines.push(`skipped-protected: ${land.plan.skippedProtected.join(', ')}`);
    }
    if (c.skippedProtected && land.reportKind === 'restore') {
      lines.push('skipped-protected: none — a restore rebuilds the whole snapshot jar');
    }
    if (land.pipeline?.filtered.length) {
      lines.push(`filtered out (auth-class), not written: ${land.pipeline.filtered.map((r) => r.name).join(', ')}`);
    }
    if (c.keptExisting) lines.push(`already present, kept: ${c.keptExisting}`);
    if (c.duplicatesCollapsed) lines.push(`${c.duplicatesCollapsed} duplicate${c.duplicatesCollapsed === 1 ? '' : 's'} collapsed (last write wins)`);
    if (c.invalid) lines.push(`invalid: ${report.invalid.map((e) => `#${e.index + 1} (${e.reason})`).join('; ')}`);
    if (c.failed) lines.push(`failed: ${report.failed.map((f) => `${f.name} — ${f.reason}`).join('; ')}`);
    for (const text of lines) {
      const li = document.createElement('li');
      li.textContent = text;
      ul.appendChild(li);
    }
    $('land-undo').hidden = !land.undoSnapshot;
  }

  // -------------------------------------------------------------------------
  // Restore (undo) — itself a guarded landing: diff-then-confirm
  // -------------------------------------------------------------------------

  async function openRestore(snapshot) {
    if (!snapshot) {
      reason('no snapshot to restore — snapshots live only for this session');
      return;
    }
    // A snapshot saved for an advanced remote target is still gated: with
    // the toggle off, restoring it would write a locked host.
    const gate = routeGate(snapshot.targetHost, { advanced: $('land-advanced-toggle').checked });
    if (gate) {
      reason(`cannot restore — ${gate}`);
      return;
    }
    land.restoreTarget = snapshot;
    let currentJar;
    try {
      currentJar = await getLocalJarCookies(originFor(snapshot.targetHost));
    } catch (err) {
      reason('cannot read the current jar: ' + (err?.message ?? String(err)));
      return;
    }
    const plan = planRestore(snapshot, currentJar);
    $('land-restore-line').textContent =
      `Restore ${snapshot.label} — ${snapshot.jar.length} cookies on ${snapshot.targetHost}`;
    $('land-restore-math').textContent = `adds ${plan.math.adds}, overwrites ${plan.math.overwrites}, removes ${plan.math.removes}`;
    show('restore');
  }

  async function onRestoreConfirm() {
    // Re-check at confirm time too — the toggle may have changed since the
    // restore screen opened.
    const gate = routeGate(land.restoreTarget.targetHost, { advanced: $('land-advanced-toggle').checked });
    if (gate) {
      reason(`cannot restore — ${gate}`);
      show('setup');
      return;
    }
    try {
      const result = await restoreSnapshot(land.restoreTarget);
      land.report = result.report;
      land.reportKind = 'restore';
      land.undoSnapshot = result.snapshot; // the restore is itself reversible
      // The restore's report must not quote the previous landing's pipeline
      // or plan — clear them before rendering (renderReport guards both).
      land.pipeline = null;
      land.plan = null;
      renderReport(result.report);
      show('report');
    } catch (err) {
      reason('restore failed: ' + (err?.message ?? String(err)));
    }
  }

  async function renderSnapshotList() {
    const box = $('land-snapshots');
    const ul = $('land-snapshot-list');
    let snapshots = [];
    try {
      snapshots = await listSnapshots();
    } catch {
      snapshots = [];
    }
    if (!snapshots.length) {
      box.hidden = true;
      ul.replaceChildren();
      return;
    }
    box.hidden = false;
    ul.replaceChildren();
    for (const snap of snapshots) {
      const li = document.createElement('li');
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${new Date(snap.at).toLocaleTimeString()} — ${snap.label}`;
      const button = document.createElement('button');
      button.className = 'secondary';
      button.textContent = 'Restore';
      // A snapshot of a currently-locked target (advanced off) cannot be
      // restored — disable its button and name the reason on hover.
      const gate = routeGate(snap.targetHost, { advanced: $('land-advanced-toggle').checked });
      if (gate) {
        button.disabled = true;
        button.title = gate;
      }
      button.addEventListener('click', () => guarded(() => openRestore(snap)));
      li.append(meta, button);
      ul.appendChild(li);
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  $('land-lane').addEventListener('change', () => {
    $('land-textarea-row').hidden = $('land-lane').value !== 'textarea';
    savePrefs();
  });
  $('land-route').addEventListener('change', savePrefs);
  $('land-mode').addEventListener('change', savePrefs);
  $('land-advanced-toggle').addEventListener('change', () => {
    const on = $('land-advanced-toggle').checked;
    $('land-remote-warning').hidden = !on;
    if (!on) $('land-remote-host').value = '';
    savePrefs();
    renderSnapshotList(); // the Restore buttons' gate follows the toggle live
  });
  $('land-read').addEventListener('click', () => guarded(onReadInput));
  $('land-dialect-use').addEventListener('click', () => guarded(onDialectPick));
  $('land-dialect-cancel').addEventListener('click', () => show('setup'));
  $('land-rows').addEventListener('change', () => {
    const plan = land.plan;
    if (plan.mode === 'curated') {
      $('land-math').textContent = mathLine(plan, land.pipeline, checkedCount());
      updateConfirmGate(); // the curated gate follows the live checked count
    }
  });
  $('land-type-land').addEventListener('input', updateConfirmGate);
  $('land-confirm').addEventListener('click', () => guarded(onConfirm));
  $('land-cancel').addEventListener('click', () => {
    reason('');
    show('setup');
  });
  $('land-undo').addEventListener('click', () => guarded(() => openRestore(land.undoSnapshot)));
  $('land-done').addEventListener('click', () => {
    reason('');
    show('setup');
  });
  $('land-restore-confirm').addEventListener('click', () => guarded(onRestoreConfirm));
  $('land-restore-cancel').addEventListener('click', () => show('setup'));

  // Keyboard: Enter confirms, Esc aborts (landing-policy) — but never while
  // a landing is in flight: aborting mid-write would hide the landing that
  // still completes, and the user would believe it was cancelled.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !land.busy && land.view !== 'setup') {
      event.preventDefault();
      reason('');
      show('setup');
    }
    if (event.key === 'Enter' && land.view === 'diff' && !$('land-confirm').disabled) {
      event.preventDefault();
      guarded(onConfirm);
    }
    if (event.key === 'Enter' && land.view === 'dialect') {
      event.preventDefault();
      guarded(onDialectPick);
    }
  });

  show('setup');
  restorePrefs();
  return { land };
}

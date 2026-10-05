// Unit suite around the pure landing core (src/core/landing.js) and the
// runtime's pure pieces, pinned by the F11–F14 golden fixtures (the landing
// contract). Run: node --test test/unit/

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_ROUTES,
  JAR_CAPACITY,
  assembleReport,
  authClassRows,
  evictSnapshots,
  freshnessLine,
  isAuthClassName,
  isLoopbackHost,
  planLanding,
  recomputeRemoves,
  retargetRows,
  routeGate,
  sniff,
} from '../../src/core/landing.js';
import { jarEntryKey } from '../../src/core/rewrite.js';
import { planRestore } from '../../src/shared/land.js';
import { envelope } from '../../src/serializers/envelope.js';
import { playwright } from '../../src/serializers/playwright.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function loadFixture(id) {
  return JSON.parse(readFileSync(join(fixturesDir, `${id}.json`), 'utf8'));
}

function planView(plan) {
  return {
    adds: plan.adds,
    overwrites: plan.overwrites,
    removes: plan.removes,
    keptExisting: plan.keptExisting,
    skippedProtected: plan.skippedProtected,
    writesOrder: plan.writes.map((w) => w.name),
    math: plan.math,
    capacity: { projectedJarSize: plan.capacity.projectedJarSize, over: plan.capacity.over },
  };
}

const baseRow = { domain: 'localhost', hostOnly: true, name: 'sid', path: '/', sameSite: 'lax', secure: true, session: true, storeId: '0', value: 'v' };

// The pipeline the popup runs, minus chrome.*: sniff → retarget → plan →
// (write) → jar-asserted report. jarAfter is simulated as the honest jar
// the browser would hold after the writes land.
function runPipeline(text, targetOrigin, localJar, mode, protect) {
  const result = sniff(text);
  assert.ok(result.ok, 'sniff ok');
  assert.ok(!result.ambiguous, 'not ambiguous');
  const { rows, foreign } = retargetRows(result.parse.rows, targetOrigin);
  const plan = planLanding(rows, localJar, mode, protect ?? []);
  const jarAfter = [...localJar, ...plan.writes];
  const report = assembleReport({
    plan,
    jarBefore: localJar,
    jarAfter,
    foreign,
    invalid: result.parse.invalid ?? [],
  });
  return { result, rows, foreign, plan, report };
}

describe('fixture catalog F11–F14 (the landing contract)', () => {
  it('F11 — retarget + foreign split, fill-gaps plan, jar-asserted report', () => {
    const fx = loadFixture('F11');
    const { result, rows, foreign, plan, report } = runPipeline(
      JSON.stringify(fx.input.cookies),
      fx.input.targetOrigin,
      fx.input.localCookies,
      'fill-gaps',
      fx.input.protectedNames,
    );
    assert.equal(result.dialect, fx.expected.dialect);
    assert.deepEqual(rows, fx.expected.retargeted, 'F11 retargeted rows');
    assert.deepEqual(
      foreign.map((r) => ({ name: r.name, domain: r.domain })),
      fx.expected.foreign,
      'F11 foreign rows (reported, never written)',
    );
    assert.deepEqual(planView(plan), fx.expected.plan, 'F11 plan');
    assert.deepEqual(
      {
        landed: report.landed,
        overwritten: report.overwritten,
        removed: report.removed,
        failed: report.failed,
        foreignNames: report.foreignNames,
        counts: report.counts,
        partial: report.partial,
      },
      fx.expected.report,
      'F11 report',
    );
  });

  it('F12 — mode matrix: fill-gaps / merge / replace / curated / protect / zero-row refusal', () => {
    const fx = loadFixture('F12');
    const text = JSON.stringify(fx.input.cookies);
    const jar = fx.input.localCookies;

    const fillGaps = planLanding(sniff(text).parse.rows, jar, 'fill-gaps', []);
    assert.deepEqual(planView(fillGaps), fx.expected.fillGaps, 'F12 fill-gaps');

    const merge = planLanding(sniff(text).parse.rows, jar, 'merge', []);
    assert.deepEqual(planView(merge), fx.expected.merge, 'F12 merge');

    const replace = planLanding(sniff(text).parse.rows, jar, 'replace', []);
    assert.deepEqual(planView(replace), fx.expected.replace, 'F12 replace');

    const replaceProtected = planLanding(sniff(text).parse.rows, jar, 'replace', fx.input.protectedVariant);
    assert.deepEqual(planView(replaceProtected), fx.expected.replaceProtected, 'F12 replace never removes or writes protected names');

    const { selected: curatedNames, ...curatedExpected } = fx.expected.curated;
    const curatedRows = sniff(text).parse.rows.filter((r) => curatedNames.includes(r.name));
    const curated = planLanding(curatedRows, jar, 'merge', []);
    assert.deepEqual(planView(curated), curatedExpected, 'F12 curated (merge on checked subset)');

    const refused = planLanding([], jar, 'replace', []);
    assert.equal(refused.refused, fx.expected.replaceZeroRows.refused, 'F12 replace refuses zero rows');

    const protectedPlan = planLanding(sniff(text).parse.rows, jar, 'fill-gaps', fx.input.protectedVariant);
    assert.deepEqual(
      {
        skippedProtected: protectedPlan.skippedProtected,
        keptExisting: protectedPlan.keptExisting,
        math: protectedPlan.math,
      },
      fx.expected.fillGapsProtected,
      'F12 protected names locked in every mode',
    );
  });

  it('F13 — capacity pre-flight offers auth-class only; filtered plan fits', () => {
    const fx = loadFixture('F13');
    const localJar = Array.from({ length: fx.input.localCount }, (_, i) => ({
      domain: 'localhost',
      hostOnly: true,
      name: `bulk-${i}`,
      path: '/',
      sameSite: 'lax',
      secure: false,
      session: true,
      storeId: '0',
      value: 'v',
    }));
    const rows = sniff(JSON.stringify(fx.input.cookies)).parse.rows;

    const full = planLanding(rows, localJar, 'fill-gaps', []);
    assert.deepEqual(
      { math: full.math, capacity: { projectedJarSize: full.capacity.projectedJarSize, over: full.capacity.over } },
      fx.expected.fullPlan,
      'F13 full plan trips the ~180 cap',
    );
    assert.ok(full.capacity.projectedJarSize > JAR_CAPACITY);

    const authRows = authClassRows(rows);
    assert.deepEqual(authRows.map((r) => r.name), fx.expected.authClassNames, 'F13 auth-class filter');

    const authPlan = planLanding(authRows, localJar, 'fill-gaps', []);
    assert.deepEqual(
      { math: authPlan.math, capacity: { projectedJarSize: authPlan.capacity.projectedJarSize, over: authPlan.capacity.over } },
      fx.expected.authPlan,
      'F13 auth-only plan fits under the cap',
    );
  });

  it('F14 — envelope round-trip, sniff, freshness, Playwright mapping', () => {
    const fx = loadFixture('F14');
    const text = envelope.serialize(fx.input.coreCookies, fx.input.meta);

    const result = sniff(text);
    assert.equal(result.ok, true);
    assert.equal(result.ambiguous, fx.expected.ambiguous);
    assert.equal(result.dialect, fx.expected.dialect);
    assert.deepEqual(result.parse.rows, fx.input.coreCookies, 'F14 rows round-trip');
    assert.deepEqual(
      { grabbedAt: result.parse.meta.grabbedAt, sourceOrigin: result.parse.meta.sourceOrigin, partitionMap: result.parse.meta.partitionMap },
      fx.expected.metaRoundTrip,
      'F14 meta round-trip',
    );
    assert.equal(freshnessLine(result.parse.meta.grabbedAt, fx.input.now), fx.expected.freshness);
    assert.equal(playwright.serialize(fx.input.coreCookies), fx.expected.playwrightJson, 'F14 Playwright dialect bytes');
    assert.ok(!text.includes('httpOnly'), 'no httpOnly ever emitted by our dialects');
  });
});

describe('loopback shape and route gate (CAP-7)', () => {
  it('loopback shapes are localhost, 127.0.0.1, [::1]/::1, *.localhost — dot-insensitive', () => {
    for (const host of ['localhost', 'LOCALHOST', '.localhost', '127.0.0.1', '[::1]', '::1', 'app.localhost', '.APP.localhost']) {
      assert.ok(isLoopbackHost(host), host);
    }
    for (const host of ['example.com', '.internal.corp', 'localhost.evil.com', '127.0.0.2']) {
      assert.ok(!isLoopbackHost(host), host);
    }
  });

  it('default routes are exactly the loopback jars; the gate names every refusal', () => {
    assert.deepEqual(DEFAULT_ROUTES, ['localhost', '127.0.0.1', '[::1]']);
    assert.equal(routeGate('localhost', { advanced: false }), null);
    assert.equal(routeGate('[::1]', { advanced: false }), null);
    assert.match(routeGate('staging.internal', { advanced: false }), /locked/);
    assert.equal(routeGate('staging.internal', { advanced: true }), null);
    assert.match(routeGate('not_a host', { advanced: true }), /not a valid host/);
    assert.match(routeGate('localhost.evil.com', { advanced: false }), /locked/);
  });

  it('a bare IPv6 route is refused (brackets required), a bracketed one passes', () => {
    assert.match(routeGate('::1', { advanced: false }), /not a valid host/);
    assert.equal(routeGate('[::1]', { advanced: false }), null);
  });
});

describe('freshness (stale envelopes land fine, the line is shown)', () => {
  it('bare arrays have no envelope: age unknown', () => {
    assert.equal(freshnessLine(null), 'age unknown');
    assert.equal(freshnessLine(undefined), 'age unknown');
  });

  it('humanizes the age from meta.grabbedAt', () => {
    const now = 1790000000000;
    assert.equal(freshnessLine(now - 30_000, now), 'grab is <1m old');
    assert.equal(freshnessLine(now - 90_000, now), 'grab is 2m old');
    assert.equal(freshnessLine(now - 3_600_000, now), 'grab is 1h old');
    assert.equal(freshnessLine(now - 2 * 3_600_000, now), 'grab is 2h old');
    assert.equal(freshnessLine(now - 3 * 86_400_000, now), 'grab is 3d old');
  });

  it('falls back to age unknown on implausible grabbedAt (seconds-epoch, negative, future beyond skew)', () => {
    const now = 1790000000000;
    assert.equal(freshnessLine(1790000000, now), 'age unknown'); // seconds, not ms
    assert.equal(freshnessLine(-1, now), 'age unknown');
    assert.equal(freshnessLine(now + 5_000, now), 'grab is <1m old'); // small skew is tolerated
    assert.equal(freshnessLine(now + 60_000 + 1, now), 'age unknown'); // beyond skew
    assert.equal(freshnessLine(1e6, now), 'age unknown'); // pre-2001 ms
  });
});

describe('sniffing (pinned order, ambiguity, refusal)', () => {
  it('sniffs an ETC v3 export (enum sameSite + hostOnly markers)', () => {
    const result = sniff(JSON.stringify([
      { domain: 'localhost', hostOnly: true, name: 'sid', path: '/', sameSite: 'lax', secure: true, session: true, storeId: '0', value: 'v' },
    ]));
    assert.equal(result.ok, true);
    assert.equal(result.ambiguous, false);
    assert.equal(result.dialect, 'etc-v3');
  });

  it('sniffs a Playwright array (expires marker) as playwright only', () => {
    const result = sniff(JSON.stringify([
      { name: 'sid', value: 'v', domain: 'localhost', path: '/', expires: 1810000000.5, sameSite: 'Lax', secure: true },
    ]));
    assert.equal(result.dialect, 'playwright');
  });

  it('sniffs the FC envelope as fc-envelope only', () => {
    const result = sniff(JSON.stringify({
      meta: { grabbedAt: 1790000000000, sourceOrigin: 'https://a.example', partitionMap: {} },
      cookies: [{ domain: 'localhost', hostOnly: true, name: 'sid', path: '/', session: true, storeId: '0', value: 'v' }],
    }));
    assert.equal(result.dialect, 'fc-envelope');
    assert.equal(result.parse.meta.grabbedAt, 1790000000000);
  });

  it('minimal rows fit two dialects: ambiguous, never guessed', () => {
    const result = sniff(JSON.stringify([
      { name: 'sid', value: 'v', domain: 'localhost', path: '/' },
      { name: 't', value: 'v', domain: 'localhost', path: '/' },
    ]));
    assert.equal(result.ok, true);
    assert.equal(result.ambiguous, true);
    assert.deepEqual(result.candidates.map((c) => c.dialect), ['etc-v3', 'playwright'], 'pinned sniff order');
  });

  it('names every refusal', () => {
    assert.match(sniff('').reason, /empty/);
    assert.match(sniff('   ').reason, /empty/);
    assert.match(sniff('not json at all').reason, /not valid JSON/);
    assert.match(sniff('[]').reason, /zero rows parsed/);
    assert.match(sniff('123').reason, /not a cookie JSON shape/);
    assert.match(
      sniff(JSON.stringify([{ name: '', value: 'v', domain: 'localhost' }])).reason,
      /no valid rows/,
    );
    assert.match(
      sniff(JSON.stringify({ meta: { grabbedAt: 'x' }, cookies: [{ name: 'a', value: 'v', domain: 'localhost' }] })).reason,
      /not a valid FC envelope/,
    );
  });
});

describe('retarget dedupe — rows flattening to one jar entry collapse', () => {
  it('collapses a host-only and a .localhost domain row of the same name/path, last write wins, counted', () => {
    const base = { name: 'sid', path: '/', sameSite: 'lax', secure: false, session: true, storeId: '0' };
    const { rows, foreign, duplicatesCollapsed } = retargetRows(
      [
        { ...base, domain: 'localhost', hostOnly: true, value: 'first' },
        { ...base, domain: '.localhost', hostOnly: false, value: 'last' },
        { ...base, domain: 'app.localhost', hostOnly: true, value: 'sub' }, // same key after flatten
      ],
      'http://localhost',
    );
    assert.equal(rows.length, 1, 'one jar entry survives');
    assert.equal(rows[0].value, 'sub', 'last write wins');
    assert.equal(rows[0].hostOnly, true);
    assert.deepEqual(foreign, []);
    assert.equal(duplicatesCollapsed, 2);
  });

  it('dedupes at the jar-entry level: a distinct path is a distinct row', () => {
    const { rows, duplicatesCollapsed } = retargetRows(
      [
        { domain: 'localhost', hostOnly: true, name: 'sid', path: '/', value: 'a', session: true, storeId: '0' },
        { domain: 'localhost', hostOnly: true, name: 'sid', path: '/deep', value: 'b', session: true, storeId: '0' },
      ],
      'http://localhost',
    );
    assert.equal(rows.length, 2);
    assert.equal(duplicatesCollapsed, 0);
  });
});

describe('recomputeRemoves — replaces execute against the fresh jar', () => {
  it('a cookie added between the diff screen and the confirm is removed by the executed replace', () => {
    const incoming = [{ ...baseRow, value: 'new' }];
    const diffTimeJar = [{ ...baseRow, name: 'legacy-diff' }];
    const plan = planLanding(incoming, diffTimeJar, 'replace', []);
    const freshJar = [...diffTimeJar, { ...baseRow, name: 'late-addition' }]; // landed after the diff
    const removes = recomputeRemoves(plan, freshJar);
    assert.deepEqual(removes.map((r) => r.name).sort(), ['late-addition', 'legacy-diff']);
  });

  it('removal refs carry hostOnly so a surviving .localhost domain row is not misreported', () => {
    const domainRow = { ...baseRow, name: 'scoped', domain: '.localhost', hostOnly: false };
    const plan = planLanding([baseRow], [domainRow], 'replace', []);
    const removes = recomputeRemoves(plan, [domainRow]);
    assert.deepEqual(removes, [{ name: 'scoped', path: '/', domain: '.localhost', hostOnly: false }]);
  });

  it('protected names stay untouchable in the recomputation; non-replace plans keep their (empty) removes', () => {
    const legacy = { ...baseRow, name: 'legacy' };
    const plan = planLanding([baseRow], [legacy, { ...baseRow, name: 'jwt' }], 'replace', ['jwt']);
    const removes = recomputeRemoves(plan, [legacy, { ...baseRow, name: 'jwt' }]);
    assert.deepEqual(removes.map((r) => r.name), ['legacy'], 'jwt is protected, never removed');
    const merge = planLanding([baseRow], [legacy], 'merge', []);
    assert.deepEqual(recomputeRemoves(merge, [legacy]), []);
  });
});

describe('assembleReport — the jar is the truth, partial is loud', () => {
  const otherRow = { ...baseRow, name: 'other' };

  it('a set() rejection maps to failed with the message', () => {
    const plan = planLanding([baseRow, otherRow], [], 'merge', []);
    const report = assembleReport({
      plan,
      jarBefore: [],
      jarAfter: [baseRow, otherRow],
      writeErrors: new Map([[jarEntryKey(baseRow), 'Failed to parse or set cookie named "sid".']]),
    });
    assert.deepEqual(report.landed.map((r) => r.name), ['other']);
    assert.equal(report.counts.failed, 1);
    assert.match(report.failed[0].reason, /Failed to parse or set/);
    assert.equal(report.partial, true);
  });

  it('a silent kill (cap eviction, pair-reject) is failed — the jar lacks the row', () => {
    const plan = planLanding([baseRow, otherRow], [], 'merge', []);
    const report = assembleReport({ plan, jarBefore: [], jarAfter: [otherRow] }); // sid never landed
    assert.deepEqual(report.failed.map((r) => r.name), ['sid']);
    assert.match(report.failed[0].reason, /not present in the jar after the write/);
  });

  it('an existing jar entry that the write replaces counts as overwritten, not landed', () => {
    const before = [{ ...baseRow, value: 'old' }];
    const plan = planLanding([baseRow], before, 'merge', []);
    const report = assembleReport({ plan, jarBefore: before, jarAfter: [baseRow] });
    assert.deepEqual(report.overwritten.map((r) => r.name), ['sid']);
    assert.deepEqual(report.landed, []);
    assert.equal(report.partial, false);
  });

  it('replace removals are verified against the jar; a survivor is failed', () => {
    const legacy = { ...baseRow, name: 'legacy' };
    const plan = planLanding([baseRow], [legacy], 'replace', []);
    const report = assembleReport({ plan, jarBefore: [legacy], jarAfter: [baseRow, legacy] });
    assert.deepEqual(report.removed, []);
    assert.equal(report.counts.failed, 1);
    assert.match(report.failed[0].reason, /still present in the jar after replace/);
  });
});

describe('snapshots and undo (CAP-6)', () => {
  it('keeps at most 3, oldest evicted, newest first', () => {
    const list = evictSnapshots([
      { id: 'a', at: 100 },
      { id: 'b', at: 300 },
      { id: 'c', at: 200 },
      { id: 'd', at: 400 },
      { id: 'e', at: 50 },
    ]);
    assert.deepEqual(list.map((s) => s.id), ['d', 'b', 'c']);
  });

  it('restore is itself a replace-mode landing of the snapshot jar', () => {
    const snapshot = {
      id: 'snap',
      at: 1,
      label: 'before landing → localhost',
      targetHost: 'localhost',
      jar: [
        { ...baseRow, value: 'original' },
        { ...baseRow, name: 'gone-now' },
      ],
    };
    const currentJar = [
      { ...baseRow, value: 'landed' },       // value differs -> overwritten back
      { ...baseRow, name: 'extra' },          // not in snapshot -> removed
    ];
    const plan = planRestore(snapshot, currentJar);
    assert.equal(plan.mode, 'replace');
    assert.deepEqual(plan.math, { adds: 1, overwrites: 1, removes: 1, keptExisting: 0, excludesProtected: 0 });
    assert.deepEqual(plan.removes.map((r) => r.name), ['extra']);
  });

  it('restoring an empty snapshot is a legitimate remove-everything plan (the Empty Jar refusal is a parse guard)', () => {
    const snapshot = { id: 'snap-empty', at: 2, label: 'empty', targetHost: 'localhost', jar: [] };
    const plan = planRestore(snapshot, [baseRow]);
    assert.equal(plan.refused, undefined);
    assert.deepEqual(plan.removes.map((r) => r.name), ['sid']);
    assert.deepEqual(plan.writes, []);
  });
});

describe('auth-class capacity filter', () => {
  it('matches session|auth|token|jwt|^sid, case-insensitive', () => {
    for (const name of ['sid', 'SID', 'sessionId', 'auth0', 'X-Auth-Token', 'jwt-a', 'a-bearer-token']) {
      assert.ok(isAuthClassName(name), name);
    }
    for (const name of ['theme', 'csrf', 'tracker-x', 'considered']) {
      assert.ok(!isAuthClassName(name), name);
    }
  });
});

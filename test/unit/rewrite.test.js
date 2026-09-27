// Unit suite around the pure rewrite() + ETC v3 serializer, pinned by the
// F1–F10 golden fixtures (the rewrite contract). Run: node --test test/unit/

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TARGET_DEFAULT, jarKey, previewOverlap, rewrite, rewriteGrab } from '../../src/core/rewrite.js';
import { ETC_V3_FIELDS, etcV3 } from '../../src/serializers/etc-v3.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function loadFixture(id) {
  return JSON.parse(readFileSync(join(fixturesDir, `${id}.json`), 'utf8'));
}

function runFixture(fx) {
  return rewriteGrab(fx.input.cookies, {
    sourceOrigin: fx.input.sourceOrigin,
    targetOrigin: fx.input.targetOrigin ?? TARGET_DEFAULT,
    protectedNames: fx.input.protectedNames ?? [],
  });
}

describe('fixture catalog F1–F10 (the rewrite contract)', () => {
  for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10']) {
    it(`${id} — ${loadFixture(id).description}`, () => {
      const fx = loadFixture(id);
      const { cookies, report } = runFixture(fx);
      assert.deepEqual(cookies, fx.expected.cookies, `${id} cookies`);
      assert.deepEqual(report, fx.expected.report, `${id} report`);
      if (fx.expected.json !== undefined) {
        assert.equal(etcV3.serialize(cookies), fx.expected.json, `${id} byte-exact ETC v3 JSON`);
      }
      if (fx.input.localCookies) {
        assert.deepEqual(previewOverlap(cookies, fx.input.localCookies), fx.expected.overlap, `${id} overlap`);
      }
    });
  }
});

describe('jar semantics', () => {
  it('ports share one jar; localhost, 127.0.0.1 and [::1] are distinct jars', () => {
    assert.equal(jarKey('http://localhost:3000'), 'localhost');
    assert.equal(jarKey('http://localhost:5173'), jarKey('http://localhost:3000'));
    assert.equal(jarKey('https://APP.example.com:8443'), 'app.example.com');
    assert.notEqual(jarKey('http://127.0.0.1:3000'), jarKey('http://localhost:3000'));
    assert.equal(jarKey('http://[::1]:3000'), '[::1]'); // URL hostname form keeps the brackets
    assert.notEqual(jarKey('http://[::1]:3000'), jarKey('http://localhost:3000'));
  });
});

describe('rewrite() purity and defaults', () => {
  it('defaults the target to localhost', () => {
    const rewriteCookie = rewrite('https://a.example');
    assert.equal(rewriteCookie({ name: 'x', domain: 'a.example', path: '/', value: 'v' }).domain, 'localhost');
  });

  it('treats a missing hostOnly as host-only and never emits domain=.localhost for it', () => {
    const out = rewrite('https://a.example')({ name: 'x', domain: 'a.example', path: '/', value: 'v' });
    assert.equal(out.hostOnly, true);
    assert.equal(out.domain, 'localhost');
  });

  it('derives session and drops the expirationDate key for session cookies', () => {
    const out = rewrite('https://a.example')({ name: 'x', domain: 'a.example', path: '/', value: 'v' });
    assert.equal(out.session, true);
    assert.equal('expirationDate' in out, false);
  });

  it('keeps expirationDate as an exact float', () => {
    const out = rewrite('https://a.example')({
      name: 'x', domain: 'a.example', path: '/', value: 'v', expirationDate: 253402300799.999,
    });
    assert.equal(out.expirationDate, 253402300799.999);
    assert.equal(out.session, false);
  });

  it('is deterministic: same input, same output object', () => {
    const cookie = { name: 'x', domain: 'a.example', path: '/', value: 'v', secure: true, httpOnly: true };
    const a = rewrite('https://a.example')(cookie);
    const b = rewrite('https://a.example')(cookie);
    assert.deepEqual(a, b);
  });
});

describe('__Host- guard', () => {
  it('coerces an impossible input to the legal local form and reports it', () => {
    const { cookies, report } = rewriteGrab(
      [
        {
          domain: 'a.example', hostOnly: false, name: '__Host-bad', path: '/sub',
          secure: false, sameSite: 'lax', session: true, storeId: '0', value: 'v',
        },
      ],
      { sourceOrigin: 'https://a.example', targetOrigin: 'http://localhost' },
    );
    assert.equal(cookies[0].secure, true);
    assert.equal(cookies[0].path, '/');
    assert.equal(cookies[0].hostOnly, true);
    assert.equal(cookies[0].domain, 'localhost'); // no dot, no domain attribute semantics
    assert.deepEqual(report.hostPrefixCoercedNames, ['__Host-bad']);
  });
});

describe('jar-level identity and reporting', () => {
  it('flattens every output cookie to a host-only target cookie, never a leading dot', () => {
    const base = { name: 'sid', path: '/', value: 'v', sameSite: 'lax', session: true, storeId: '0' };
    const { cookies } = rewriteGrab(
      [
        { ...base, domain: 'example.com', hostOnly: true },
        { ...base, domain: '.example.com', hostOnly: false },
      ],
      { sourceOrigin: 'https://example.com' },
    );
    for (const cookie of cookies) {
      assert.equal(cookie.domain, 'localhost');
      assert.equal(cookie.hostOnly, true);
    }
  });

  it('collapses a source host-only and domain cookie of the same name and path (identical target form)', () => {
    const base = { name: 'sid', path: '/', value: 'v', sameSite: 'lax', session: true, storeId: '0' };
    const { cookies, report } = rewriteGrab(
      [
        { ...base, domain: 'example.com', hostOnly: true, value: 'hostonly' },
        { ...base, domain: '.example.com', hostOnly: false, value: 'domain' },
      ],
      { sourceOrigin: 'https://example.com' },
    );
    assert.equal(cookies.length, 1, 'one target cookie survives');
    assert.equal(cookies[0].value, 'domain', 'last write wins');
    assert.equal(report.duplicatesCollapsed, 1, 'collapse is counted');
  });

  it('reports a flagged name once even when it appears at two paths', () => {
    const base = {
      domain: 'a.example', hostOnly: true, name: 'broken', secure: false,
      sameSite: 'no_restriction', session: true, storeId: '0', value: 'x',
    };
    const { report } = rewriteGrab(
      [
        { ...base, path: '/' },
        { ...base, path: '/x' },
      ],
      { sourceOrigin: 'https://a.example' },
    );
    assert.deepEqual(report.brokenPairNames, ['broken']);
  });

  it('does not claim an overwrite of a local .localhost domain cookie (grab side is host-only)', () => {
    const core = [{ name: 'sid', domain: 'localhost', hostOnly: true, path: '/' }];
    const local = [{ name: 'sid', domain: '.localhost', hostOnly: false, path: '/' }];
    assert.deepEqual(previewOverlap(core, local), []);
    // and the matching host-only local form does overlap
    const localMatching = [{ name: 'sid', domain: 'localhost', hostOnly: true, path: '/' }];
    assert.deepEqual(previewOverlap(core, localMatching), [
      { name: 'sid', domain: 'localhost', path: '/' },
    ]);
  });
});

describe('protect list', () => {
  it('drops protected names from the output and lists them in the report', () => {
    const base = [
      { domain: 'a.example', hostOnly: true, name: 'sid', path: '/', value: 'v1', sameSite: 'lax', session: true, storeId: '0' },
      { domain: 'a.example', hostOnly: true, name: 'theme', path: '/', value: 'v2', sameSite: 'lax', session: true, storeId: '0' },
    ];
    const { cookies, report } = rewriteGrab(base, {
      sourceOrigin: 'https://a.example',
      protectedNames: ['sid'],
    });
    assert.deepEqual(cookies.map((c) => c.name), ['theme']);
    assert.deepEqual(report.protectedNames, ['sid']);
  });
});

describe('ETC v3 serializer', () => {
  it('emits a bare array, 2-space pretty print, pinned field order, no httpOnly', () => {
    const fx = loadFixture('F1');
    const text = etcV3.serialize(runFixture(fx).cookies);
    assert.ok(text.startsWith('[\n  {\n    "domain"'), 'bare array + 2-space');
    const parsed = JSON.parse(text);
    assert.deepEqual(
      Object.keys(parsed[0]),
      ETC_V3_FIELDS.filter((f) => f !== 'expirationDate' || 'expirationDate' in parsed[0]),
    );
    assert.equal('httpOnly' in parsed[0], false);
  });

  it('serializes an empty grab as a bare empty array (never written to the clipboard)', () => {
    assert.equal(etcV3.serialize([]), '[]');
  });

  it('keeps unicode values verbatim through the dialect', () => {
    const fx = loadFixture('F4');
    const parsed = JSON.parse(etcV3.serialize(runFixture(fx).cookies));
    assert.equal(parsed[0].value, fx.input.cookies[0].value);
  });
});

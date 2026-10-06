// Unit suite for the three inbound dialects: ETC v3 `parse` (grown in
// mvp2), the FC envelope (dock dialect), and Playwright addCookies. The
// parser is liberal, the validator is paranoid; each dialect owns its
// encoding rules in both directions.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { etcV3, validateEtcV3Row } from '../../src/serializers/etc-v3.js';
import { envelope } from '../../src/serializers/envelope.js';
import { playwright } from '../../src/serializers/playwright.js';

describe('ETC v3 inbound (real EditThisCookie exports)', () => {
  it('accepts a full export row and normalizes it to the canonical shape', () => {
    const { rows, invalid } = etcV3.parse([
      {
        domain: '.LocalHost',
        expirationDate: 1810000000.5,
        hostOnly: false,
        httpOnly: true,
        name: 'sid',
        path: '/',
        sameSite: 'no_restriction',
        secure: true,
        session: false,
        storeId: '0',
        value: 'v',
      },
    ]);
    assert.deepEqual(invalid, []);
    assert.deepEqual(rows, [{
      domain: 'localhost', // dot stripped, lowercased
      expirationDate: 1810000000.5,
      hostOnly: false,
      httpOnly: true, // foreign httpOnly accepted, landed verbatim
      name: 'sid',
      path: '/',
      sameSite: 'no_restriction',
      secure: true,
      session: false,
      storeId: '0',
      value: 'v',
    }]);
  });

  it('tolerates both storeId forms ("0" and 0) and stringifies', () => {
    const { rows } = etcV3.parse([
      { domain: 'localhost', name: 'a', value: 'v', storeId: '0' },
      { domain: 'localhost', name: 'b', value: 'v', storeId: 0 },
    ]);
    assert.deepEqual(rows.map((r) => r.storeId), ['0', '0']);
  });

  it('session rows land as session cookies (no expirationDate key)', () => {
    const { rows } = etcV3.parse([{ domain: 'localhost', name: 'a', value: 'v', session: true }]);
    assert.equal(rows[0].session, true);
    assert.equal('expirationDate' in rows[0], false);
  });

  it('a missing hostOnly is host-only (v1 semantics); httpOnly===false is dropped', () => {
    const { rows } = etcV3.parse([{ domain: 'localhost', name: 'a', value: 'v', httpOnly: false }]);
    assert.equal(rows[0].hostOnly, true);
    assert.equal('httpOnly' in rows[0], false);
  });

  it('rejects malformed rows individually, naming the cause', () => {
    const cases = [
      [{ domain: 'localhost', value: 'v' }, 'name is missing or empty'],
      [{ domain: 'localhost', name: 'a', value: 5 }, 'value is missing or not a string'],
      [{ name: 'a', value: 'v' }, 'domain is missing or empty'],
      [{ domain: 'localhost', name: 'a', value: 'v', sameSite: 'Lax' }, 'sameSite "Lax" is not an ETC v3 enum value'],
      [{ domain: 'localhost', name: 'a', value: 'v', path: 'no-slash' }, 'path does not start with "/"'],
      [{ domain: 'localhost', name: 'a', value: 'v', secure: 'yes' }, 'secure is not a boolean'],
      [{ domain: 'localhost', name: 'a', value: 'v', expirationDate: 'soon' }, 'expirationDate is not a finite number'],
      [{ domain: 'localhost', name: 'a', value: 'v', expirationDate: Infinity }, 'expirationDate is not a finite number'], // JSON 1e999
      [{ domain: '...', name: 'a', value: 'v' }, 'domain is only dots'],
      [{ domain: 'localhost', name: 'a', value: 'v', expires: 123 }, 'field "expires" belongs to the Playwright dialect'],
      ['just a string', 'row is not an object'],
    ];
    for (const [row, reason] of cases) {
      const res = validateEtcV3Row(row);
      assert.ok(!res.row, JSON.stringify(row));
      assert.match(res.reason, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('normalizes trailing dots and outer whitespace in domains (a DNS-style "localhost." stays ferry-shaped)', () => {
    for (const domain of ['localhost.', '.localhost.', ' localhost', 'localhost ']) {
      const { row } = validateEtcV3Row({ domain, name: 'a', value: 'v' });
      assert.equal(row.domain, 'localhost', JSON.stringify(domain));
    }
  });

  it('rejects a Playwright url-form row whose URL has no host (file:///x)', () => {
    const { invalid } = playwright.parse([{ name: 'a', value: 'v', url: 'file:///x' }]);
    assert.equal(invalid.length, 1);
    assert.match(invalid[0].reason, /has no host/);
  });

  it('an array with one good and one bad row keeps the good one and reports the bad index', () => {
    const { rows, invalid } = etcV3.parse([
      { domain: 'localhost', name: 'good', value: 'v' },
      { domain: 'localhost', name: '', value: 'v' },
    ]);
    assert.deepEqual(rows.map((r) => r.name), ['good']);
    assert.deepEqual(invalid, [{ index: 1, reason: 'name is missing or empty' }]);
  });

  it('refuses a non-array structurally', () => {
    assert.equal(etcV3.parse({}).ok, false);
    assert.match(etcV3.parse({}).reason, /bare JSON array/);
  });
});

describe('FC envelope (the dock dialect)', () => {
  const ROWS = [{ domain: 'localhost', hostOnly: true, name: 'sid', path: '/', sameSite: 'lax', secure: true, session: true, storeId: '0', value: 'v' }];

  it('serializes to dock shape and parses back to identical rows + meta', () => {
    const text = envelope.serialize(ROWS, { grabbedAt: 1790000000123, sourceOrigin: 'https://a.example', partitionMap: { excluded: 1 } });
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed), ['meta', 'cookies']);
    const back = envelope.parse(parsed);
    assert.equal(back.ok, true);
    assert.deepEqual(back.rows, ROWS);
    assert.deepEqual(back.meta, { grabbedAt: 1790000000123, sourceOrigin: 'https://a.example', partitionMap: { excluded: 1 } });
  });

  it('the dock payload carries no httpOnly even when the core rows have it (identical lanes)', () => {
    const text = envelope.serialize([{ ...ROWS[0], httpOnly: true }], { grabbedAt: 1, sourceOrigin: 'https://a.example' });
    assert.ok(!text.includes('httpOnly'));
  });

  it('names structural failures', () => {
    assert.match(envelope.parse([]).reason, /JSON object/);
    assert.match(envelope.parse({ meta: {} }).reason, /"meta" and "cookies"/);
    assert.match(envelope.parse({ meta: { grabbedAt: 'x' }, cookies: [] }).reason, /grabbedAt is not a number/);
    assert.match(envelope.parse({ meta: { partitionMap: [] }, cookies: [] }).reason, /partitionMap is not an object/);
    assert.match(envelope.parse({ meta: {}, cookies: {} }).reason, /cookies is not an array/);
    assert.equal(envelope.parse({ meta: {}, cookies: [{ domain: 'localhost', name: '', value: 'v' }] }).invalid.length, 1);
  });

  it('missing meta fields parse as null meta values (age unknown is legal)', () => {
    const back = envelope.parse({ meta: {}, cookies: ROWS });
    assert.deepEqual(back.meta, { grabbedAt: null, sourceOrigin: null, partitionMap: {} });
  });

  it('serialize throws on invalid meta rather than writing a broken dock', () => {
    assert.throws(() => envelope.serialize(ROWS, { grabbedAt: 'x' }), /grabbedAt is not a number/);
  });
});

describe('Playwright addCookies dialect', () => {
  it('serializes the verified mapping: no dot for host-only, dot for domain, expires only when persistent, unspecified omitted, no httpOnly', () => {
    const text = playwright.serialize([
      { domain: 'localhost', hostOnly: true, name: 'a', path: '/', sameSite: 'lax', secure: true, session: false, expirationDate: 1810000000.5, storeId: '0', value: 'v1', httpOnly: true },
      { domain: 'localhost', hostOnly: false, name: 'b', path: '/', sameSite: 'no_restriction', secure: true, session: true, storeId: '0', value: 'v2' },
      { domain: 'localhost', hostOnly: true, name: 'c', path: '/', sameSite: 'unspecified', secure: false, session: true, storeId: '0', value: 'v3' },
    ]);
    const rows = JSON.parse(text);
    assert.equal(rows[0].domain, 'localhost'); // host-only: no leading dot
    assert.equal(rows[1].domain, '.localhost'); // domain cookie: leading dot
    assert.equal(rows[0].expires, 1810000000.5); // float seconds, no rounding
    assert.equal('expires' in rows[1], false); // session: omitted
    assert.equal(rows[0].sameSite, 'Lax');
    assert.equal(rows[1].sameSite, 'None');
    assert.equal('sameSite' in rows[2], false); // unspecified: no equivalent
    for (const row of rows) {
      assert.equal('httpOnly' in row, false, 'Q1 ruling: never emitted');
      assert.equal('storeId' in row, false, 'no equivalent — dropped');
      assert.equal('session' in row, false, 'no equivalent — dropped');
      assert.equal('hostOnly' in row, false, 'encoded in the dot, not a field');
    }
  });

  it('parses domain-form rows: leading dot is the domain-cookie marker', () => {
    const { rows, invalid } = playwright.parse([
      { name: 'a', value: 'v', domain: '.localhost', path: '/', secure: true, sameSite: 'Strict', expires: 1810000000.5 },
      { name: 'b', value: 'v', domain: 'localhost' },
    ]);
    assert.deepEqual(invalid, []);
    assert.equal(rows[0].domain, 'localhost');
    assert.equal(rows[0].hostOnly, false);
    assert.equal(rows[0].sameSite, 'strict');
    assert.equal(rows[0].session, false);
    assert.equal(rows[0].expirationDate, 1810000000.5);
    assert.equal(rows[1].hostOnly, true);
    assert.equal(rows[1].session, true); // no expires: session
  });

  it('parses url-form rows to host/path extraction', () => {
    const { rows } = playwright.parse([
      { name: 'a', value: 'v', url: 'https://app.example.com/deep/page' },
      { name: 'b', value: 'v', url: 'http://localhost:3000' },
    ]);
    assert.equal(rows[0].domain, 'app.example.com');
    assert.equal(rows[0].path, '/deep/page');
    assert.equal(rows[0].secure, true);
    assert.equal(rows[0].hostOnly, true);
    assert.equal(rows[1].domain, 'localhost');
    assert.equal(rows[1].path, '/');
    assert.equal(rows[1].secure, false);
  });

  it('accepts expires: -1 (CDP session convention) and inbound httpOnly verbatim', () => {
    const { rows } = playwright.parse([{ name: 'a', value: 'v', domain: 'localhost', expires: -1, httpOnly: true }]);
    assert.equal(rows[0].session, true);
    assert.equal('expirationDate' in rows[0], false);
    assert.equal(rows[0].httpOnly, true);
  });

  it('rejects ETC-only fields and bad enums, naming the cause', () => {
    const cases = [
      [{ name: 'a', value: 'v', domain: 'localhost', hostOnly: true }, 'field "hostOnly" belongs to the ETC v3 dialect'],
      [{ name: 'a', value: 'v', domain: 'localhost', expirationDate: 1 }, 'field "expirationDate" belongs to the ETC v3 dialect'],
      [{ name: 'a', value: 'v', domain: 'localhost', sameSite: 'lax' }, 'sameSite "lax" is not a Playwright enum value'],
      [{ name: 'a', value: 'v' }, 'domain is missing or empty'],
      [{ name: 'a', value: 'v', url: 'not a url', domain: undefined }, 'url "not a url" is not parseable'],
    ];
    for (const [row, reason] of cases) {
      const res = playwright.parse([row]);
      assert.equal(res.rows.length, 0, JSON.stringify(row));
      assert.match(res.invalid[0].reason, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('round-trips serialize → parse for a copy-side grab (CAP-8 lingua franca)', () => {
    const core = [
      { domain: 'localhost', expirationDate: 1798761600.5, hostOnly: true, name: '__Host-session', path: '/', sameSite: 'lax', secure: true, session: false, storeId: '0', value: 'v' },
      { domain: 'localhost', hostOnly: true, name: 'sid', path: '/', sameSite: 'unspecified', secure: false, session: true, storeId: '0', value: 'w' },
    ];
    const back = playwright.parse(JSON.parse(playwright.serialize(core)));
    assert.deepEqual(back.rows, core, 'serialize → parse is the identity on canonical rows');
    assert.deepEqual(back.invalid, []);
  });
});

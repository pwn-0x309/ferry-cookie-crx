// Unit cover for the popup/worker guard naming layer (src/shared/grab.js):
// restricted-page reasons and zero-cookie reasons. These name the cause the
// I/O matrix pins — the render path that disables the action on them is
// exercised end-to-end by test/e2e (F10).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { restrictReason, zeroReason } from '../../src/shared/grab.js';

describe('restrictReason — restricted pages are named, not silent', () => {
  const cases = [
    ['chrome://version/', 'a chrome:// page'],
    ['chrome://extensions/', 'a chrome:// page'],
    ['chrome-extension://abc/popup.html', 'an extension page'],
    ['chrome-untrusted://inner/page', 'a chrome-untrusted page'],
    ['devtools://devtools/bundled/inspector.html', 'a DevTools page'],
    ['view-source:https://example.com/', 'a view-source page'],
    ['about:blank', 'an about: page'],
    ['file:///Users/x/doc.pdf', 'a local file or PDF viewer page'],
    ['blob:http://localhost:3000/uuid', 'a blob URL page'],
    ['data:text/html,hello', 'a data: URL page'],
    ['chrome-error://chromewebdata/', 'a Chrome error page'],
    ['https://chromewebstore.google.com/detail/x', 'the Chrome Web Store'],
    ['https://chrome.google.com/webstore/category/extensions', 'the Chrome Web Store'],
  ];
  for (const [url, reason] of cases) {
    it(`${url} → ${reason}`, () => {
      assert.equal(restrictReason(url), reason);
    });
  }

  it('a regular page is not restricted', () => {
    assert.equal(restrictReason('https://app.example.com/dash'), null);
    assert.equal(restrictReason('http://localhost:3000/'), null);
  });

  it('an unparseable URL is named, never thrown', () => {
    assert.equal(restrictReason('not a url'), 'an unreadable page URL');
  });
});

describe('zeroReason — zero-cookie disables name the cause', () => {
  it('an empty grab is "no cookies here"', () => {
    assert.equal(zeroReason(0, { partitionedExcluded: 0, protectedNames: [] }), 'no cookies here');
  });

  it('an all-partitioned grab names the exclusion', () => {
    assert.equal(
      zeroReason(2, { partitionedExcluded: 2, protectedNames: [] }),
      'all cookies excluded (2 partitioned)',
    );
  });

  it('an all-protected grab names the protected cookies', () => {
    assert.equal(
      zeroReason(1, { partitionedExcluded: 0, protectedNames: ['sid'] }),
      'all cookies protected (sid)',
    );
  });
});

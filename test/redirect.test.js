const assert = require('node:assert/strict');
const test = require('node:test');

const { createRedirectTracker, evaluateOffSite } = require('../lib/network/redirect');

test('redirect tracker ignores requests whose frame is unavailable', () => {
  const tracker = createRedirectTracker();
  const request = {
    frame: () => {
      throw new Error('Request is issued by a service worker');
    },
    isNavigationRequest: () => true,
    url: () => 'https://example.com',
  };

  tracker.handlers.onRequest(request);
  tracker.handlers.onResponse({
    headers: () => ({ location: 'https://example.com/final' }),
    request: () => request,
    status: () => 302,
    url: () => 'https://example.com',
  });

  assert.deepEqual(tracker.getRedirects('https://example.com/final', 'https://example.com'), {
    count: 0,
    chain: [],
    finalUrl: 'https://example.com/final',
    offSite: false,
    offSiteHost: null,
  });
});

test('evaluateOffSite flags a different registrable domain', () => {
  assert.deepEqual(
    evaluateOffSite('https://example-shop.md', 'https://ads-spam.example.com/landing'),
    { offSite: true, offSiteHost: 'ads-spam.example.com' },
  );
});

test('evaluateOffSite treats apex<->www and http->https as same-site', () => {
  assert.deepEqual(
    evaluateOffSite('https://example-shop.md', 'https://www.example-shop.md/'),
    { offSite: false, offSiteHost: null },
  );
  assert.deepEqual(
    evaluateOffSite('http://example-shop.md', 'https://example-shop.md/'),
    { offSite: false, offSiteHost: null },
  );
});

test('evaluateOffSite is safe when a URL is missing or invalid', () => {
  assert.deepEqual(evaluateOffSite('https://example-shop.md', null), { offSite: false, offSiteHost: null });
  assert.deepEqual(evaluateOffSite(null, 'https://x.com'), { offSite: false, offSiteHost: null });
  assert.deepEqual(evaluateOffSite('not a url', 'also not'), { offSite: false, offSiteHost: null });
});

test('getRedirects reports off-site for a JS redirect with no 3xx chain', () => {

  const tracker = createRedirectTracker();
  assert.deepEqual(tracker.getRedirects('https://evil-ads.net/promo', 'https://example-shop.md'), {
    count: 0,
    chain: [],
    finalUrl: 'https://evil-ads.net/promo',
    offSite: true,
    offSiteHost: 'evil-ads.net',
  });
});

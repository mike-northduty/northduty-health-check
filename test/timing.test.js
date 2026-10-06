const assert = require('node:assert/strict');
const test = require('node:test');

const { collectResponseTime } = require('../lib/network/timing');

function pageWith(navigationEntry) {
  return {
    evaluate: async (fn) => {
      const originalPerformance = global.performance;
      global.performance = {
        getEntriesByType: (type) =>
          type === 'navigation' && navigationEntry ? [navigationEntry] : [],
      };

      try {
        return fn();
      } finally {
        global.performance = originalPerformance;
      }
    },
  };
}

function navigationEntry(overrides = {}) {
  return {
    startTime: 0,
    domainLookupStart: 10,
    domainLookupEnd: 30,
    connectStart: 30,
    secureConnectionStart: 50,
    connectEnd: 90,
    requestStart: 90,
    responseStart: 300,
    responseEnd: 400,
    domInteractive: 600,
    domContentLoadedEventEnd: 800,
    loadEventEnd: 1500,
    ...overrides,
  };
}

test('total comes from loadEventEnd when the load event fired', async () => {
  const result = await collectResponseTime(pageWith(navigationEntry()), 4321, {
    completedWith: 'domcontentloaded',
  });

  assert.equal(result.total, 1500);
  assert.equal(result.totalSource, 'full-load');
  assert.equal(result.fullLoad, 1500);

  assert.equal(result.wallClock, 4321);
});

test('total falls back to DOMContentLoaded when the load event never fired', async () => {
  const page = pageWith(navigationEntry({ loadEventEnd: 0 }));

  const result = await collectResponseTime(page, 4321, { completedWith: 'domcontentloaded' });

  assert.equal(result.total, 800);
  assert.equal(result.totalSource, 'dom-content-loaded');
  assert.equal(result.fullLoad, null);
});

test('commit-fallback wall clock is never reported as a load time', async () => {
  const page = pageWith(null);

  const result = await collectResponseTime(page, 180, { completedWith: 'commit' });

  assert.equal(result.total, null);
  assert.equal(result.totalSource, null);
  assert.equal(result.navigationCompletedWith, 'commit');
  assert.equal(result.wallClock, 180);
});

test('commit-fallback still reports browser-side timing when it is available', async () => {
  const page = pageWith(navigationEntry({ loadEventEnd: 0 }));

  const result = await collectResponseTime(page, 180, { completedWith: 'commit' });

  assert.equal(result.total, 800);
  assert.equal(result.totalSource, 'dom-content-loaded');
});

test('wall clock is used only when the primary navigation completed', async () => {
  const page = pageWith(null);

  const result = await collectResponseTime(page, 2600, { completedWith: 'domcontentloaded' });

  assert.equal(result.total, 2600);
  assert.equal(result.totalSource, 'wall-clock');
});

test('phase breakdown is still reported alongside total', async () => {
  const result = await collectResponseTime(pageWith(navigationEntry()), 1000, {
    completedWith: 'domcontentloaded',
  });

  assert.equal(result.dnsLookup, 20);
  assert.equal(result.tcpConnection, 20);
  assert.equal(result.tlsHandshake, 40);
  assert.equal(result.ttfb, 210);
  assert.equal(result.contentDownload, 100);
  assert.equal(result.domParsing, 200);
  assert.equal(result.domContentLoaded, 800);
});

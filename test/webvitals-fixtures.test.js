const assert = require('node:assert/strict');
const test = require('node:test');

const { collectResponseTime } = require('../lib/network/timing');
const { collectWebVitals } = require('../lib/page/vitals');
const { measureHostSpeed, isTrustworthyHostSpeed, hostSpeedFactor } = require('../lib/page/host-speed');
const { LIMITS } = require('../lib/constants');

const FAST_SITE = {
  label: 'maureenskenmare.ie (WP Rocket + Cloudflare, 45 requests)',
  navigation: {
    startTime: 0,
    domainLookupStart: 2,
    domainLookupEnd: 14,
    connectStart: 14,
    secureConnectionStart: 38,
    connectEnd: 96,
    requestStart: 96,
    responseStart: 281,
    responseEnd: 305,
    domInteractive: 402,
    domContentLoadedEventEnd: 419,
    loadEventEnd: 602,
  },
  paints: { 'first-contentful-paint': 361 },
  lcp: 498,
  cls: 0.02,
};

const SLOW_SITE = {
  label: 'filamentworld.de',
  navigation: {
    startTime: 0,
    domainLookupStart: 3,
    domainLookupEnd: 21,
    connectStart: 21,
    secureConnectionStart: 60,
    connectEnd: 140,
    requestStart: 140,
    responseStart: 1470,
    responseEnd: 1592,
    domInteractive: 1744,
    domContentLoadedEventEnd: 1795,
    loadEventEnd: 2275,
  },
  paints: { 'first-contentful-paint': 1663 },
  lcp: 2011,
  cls: 0.11,
};

const DEGRADED_HOST = {
  label: 'fast site measured on a CPU-starved worker',
  navigation: {
    startTime: 0,
    domainLookupStart: 0,
    domainLookupEnd: 19,
    connectStart: 19,
    secureConnectionStart: 21,
    connectEnd: 1305,
    requestStart: 1305,
    responseStart: 2038,
    responseEnd: 2134,
    domInteractive: 7950,
    domContentLoadedEventEnd: 8161,
    loadEventEnd: 8168,
  },
  paints: { 'first-contentful-paint': 2992 },
  lcp: 2992,
  cls: 0,
};

function timingPage(fixture) {
  return {
    evaluate: async (fn) => {
      const original = global.performance;
      global.performance = {
        getEntriesByType: (type) => (type === 'navigation' ? [fixture.navigation] : []),
      };
      try {
        return fn();
      } finally {
        global.performance = original;
      }
    },
  };
}

function vitalsPage(fixture) {
  return {
    evaluate: async (fn, arg) => {
      const originalPerformance = global.performance;
      const originalObserver = global.PerformanceObserver;

      global.performance = {
        getEntriesByName: (name) =>
          fixture.paints[name] !== undefined ? [{ name, startTime: fixture.paints[name] }] : [],
        getEntriesByType: () => [],
      };

      global.PerformanceObserver = class {
        constructor(callback) {
          this.callback = callback;
        }

        observe({ type }) {

          if (fixture.unsupported?.includes(type)) {
            throw new TypeError(`unsupported entry type: ${type}`);
          }
          if (type === 'largest-contentful-paint' && fixture.lcp !== null) {
            this.callback({ getEntries: () => [{ startTime: fixture.lcp }] });
          }
          if (type === 'layout-shift' && fixture.cls) {
            this.callback({
              getEntries: () => [{ value: fixture.cls, hadRecentInput: false }],
            });
          }
        }

        disconnect() {}
      };

      try {

        return await fn(0, arg);
      } finally {
        global.performance = originalPerformance;
        global.PerformanceObserver = originalObserver;
      }
    },
  };
}

for (const fixture of [FAST_SITE, SLOW_SITE]) {
  test(`reported load time matches the recorded load event — ${fixture.label}`, async () => {
    const timing = await collectResponseTime(timingPage(fixture), 9999, {
      completedWith: 'domcontentloaded',
    });

    assert.equal(timing.total, fixture.navigation.loadEventEnd);
    assert.equal(timing.totalSource, 'full-load');
    assert.equal(timing.wallClock, 9999);

    assert.equal(timing.ttfb, fixture.navigation.responseStart - fixture.navigation.requestStart);
    assert.equal(timing.domContentLoaded, fixture.navigation.domContentLoadedEventEnd);
    assert.equal(timing.fullLoad, fixture.navigation.loadEventEnd);
    assert.notEqual(timing.domContentLoaded, timing.total);
  });

  test(`paints are reported per metric, never zero-filled — ${fixture.label}`, async () => {
    const vitals = await collectWebVitals(vitalsPage(fixture));

    assert.equal(vitals.firstContentfulPaint, fixture.paints['first-contentful-paint']);
    assert.equal(vitals.largestContentfulPaint, fixture.lcp);
    assert.equal(vitals.cumulativeLayoutShift, fixture.cls);
    assert.notEqual(vitals.firstContentfulPaint, vitals.largestContentfulPaint);
    for (const [metric, value] of Object.entries(vitals)) {
      assert.notEqual(value, null, `${metric} was collected and must not read as absent`);
    }
  });
}

test('an unobserved paint is reported as null, never as a zero', async () => {
  const vitals = await collectWebVitals(vitalsPage({ paints: {}, lcp: null, cls: null }));

  assert.equal(vitals.firstContentfulPaint, null);
  assert.equal(vitals.largestContentfulPaint, null);

  assert.equal(vitals.cumulativeLayoutShift, 0);
});

test('CLS is null when layout-shift cannot be observed at all', async () => {
  const vitals = await collectWebVitals(
    vitalsPage({ paints: {}, lcp: null, cls: null, unsupported: ['layout-shift'] }),
  );

  assert.equal(vitals.cumulativeLayoutShift, null);
});

test('a page timing measured on a starved host is flagged, not published as a site verdict', async () => {
  const timing = await collectResponseTime(timingPage(DEGRADED_HOST), 8181, {
    completedWith: 'domcontentloaded',
  });

  assert.equal(timing.total, 8168);
  assert.equal(timing.totalSource, 'full-load');

  assert.ok(timing.ttfb < 1000, 'network was fine on this run');
  assert.ok(timing.domParsing > 5000, 'the time went into script parse/execute');

  assert.equal(isTrustworthyHostSpeed(LIMITS.MIN_TRUSTWORTHY_HOST_SPEED_INDEX - 1), false);
  assert.equal(isTrustworthyHostSpeed(LIMITS.MIN_TRUSTWORTHY_HOST_SPEED_INDEX), true);

  assert.equal(isTrustworthyHostSpeed(null), true);
});

test('host speed index reports units of work per second from inside the page', async () => {
  const page = {
    evaluate: async (fn, budgetMs) => {
      const original = global.performance;
      let now = 0;
      global.performance = {

        now: () => (now += budgetMs / 40),
      };
      try {
        return fn(budgetMs);
      } finally {
        global.performance = original;
      }
    },
  };

  const host = await measureHostSpeed(page);

  assert.equal(typeof host.speedIndex, 'number');
  assert.ok(host.speedIndex > 0);
  assert.equal(host.trustworthy, host.speedIndex >= LIMITS.MIN_TRUSTWORTHY_HOST_SPEED_INDEX);
  assert.equal(host.minTrustworthySpeedIndex, LIMITS.MIN_TRUSTWORTHY_HOST_SPEED_INDEX);
});

function benchPage({ perPageIndex, contextPages = [] }) {
  const makePage = (label) => ({
    __label: label,
    evaluate: async (fn, budgetMs) => {
      const original = global.performance;
      const passes = perPageIndex[label];
      let now = 0;
      global.performance = { now: () => (now += budgetMs / passes) };
      try {
        return fn(budgetMs);
      } finally {
        global.performance = original;
      }
    },
    close: async () => {},
    context: () => ({ newPage: async () => { const p = makePage('scratch'); contextPages.push(p); return p; } }),
    goto: async () => {},
  });

  return makePage('under-test');
}

test('host speed is measured on a scratch page, not the page under test', async () => {
  const opened = [];

  const page = benchPage({ perPageIndex: { 'under-test': 4, scratch: 40 }, contextPages: opened });

  const onScratch = await measureHostSpeed(page);

  assert.equal(opened.length, 1, 'a scratch page must be opened');

  const contaminated = benchPage({ perPageIndex: { 'under-test': 4, scratch: 40 } });
  contaminated.context = () => { throw new Error('context is closing'); };
  const onPageUnderTest = await measureHostSpeed(contaminated);

  assert.ok(
    onScratch.speedIndex > onPageUnderTest.speedIndex * 5,
    `scratch ${onScratch.speedIndex} should dwarf in-page ${onPageUnderTest.speedIndex}`,
  );
});

test('host speed falls back to the page under test when no scratch page can open', async () => {
  const page = benchPage({ perPageIndex: { 'under-test': 40 } });
  page.context = () => { throw new Error('context is closing'); };

  const host = await measureHostSpeed(page);

  assert.ok(Number.isFinite(host.speedIndex) && host.speedIndex > 0);
  assert.equal(host.samples.length, 3);
});

test('host speed takes the best sample, since interference can only slow it down', async () => {
  const budgets = [10, 40, 20];
  let call = 0;
  const page = {
    context: () => { throw new Error('no context'); },
    evaluate: async (fn, budgetMs) => {
      const original = global.performance;
      const passes = budgets[call++ % budgets.length];
      let now = 0;
      global.performance = { now: () => (now += budgetMs / passes) };
      try { return fn(budgetMs); } finally { global.performance = original; }
    },
  };

  const host = await measureHostSpeed(page);

  assert.equal(host.samples.length, 3);
  assert.equal(host.speedIndex, Math.max(...host.samples));
});

test('hostSpeedFactor scales toward the reference device and clamps absurd readings', () => {
  const reference = LIMITS.REFERENCE_HOST_SPEED_INDEX;

  assert.equal(hostSpeedFactor(reference), 1, 'a reference-speed host needs no correction');
  assert.equal(hostSpeedFactor(reference / 2), 0.5, 'a half-speed host halves its CPU-bound time');

  assert.equal(hostSpeedFactor(null), null);
  assert.equal(hostSpeedFactor(0), null);

  assert.equal(hostSpeedFactor(1), 0.2);
  assert.equal(hostSpeedFactor(reference * 100), 2);
});

const { applyHostSpeedNormalization } = require('../index');

function normalizedFor({ ttfb, contentDownload, domContentLoaded, total, fcp, lcp, speedIndex }) {
  const result = {
    responseTime: { ttfb, contentDownload, domContentLoaded, total },
    performance: { firstContentfulPaint: fcp, largestContentfulPaint: lcp, cumulativeLayoutShift: 0 },
    host: { speedIndex, referenceSpeedIndex: LIMITS.REFERENCE_HOST_SPEED_INDEX },
  };
  applyHostSpeedNormalization(result, (field, value) => { result[field] = value; });

  return result;
}

test('normalization corrects only the parse/execute span, not transfer time', () => {
  const r = normalizedFor({
    ttfb: 328, contentDownload: 40, domContentLoaded: 2812, total: 10275,
    fcp: 1776, lcp: 4740, speedIndex: 2576,
  });

  assert.equal(r.responseTime.cpuSpanMs, 2444);
  assert.equal(r.responseTime.cpuCorrectionMs, 1545);
  assert.equal(r.responseTime.normalizedTotal, 10275 - 1545);

  assert.ok(
    r.responseTime.normalizedTotal > 8000,
    `expected the transfer tail to survive correction, got ${r.responseTime.normalizedTotal}`,
  );
});

test('a metric is never corrected below its own network floor', () => {
  const r = normalizedFor({
    ttfb: 611, contentDownload: 20, domContentLoaded: 1688, total: 1757,

    fcp: 700, lcp: 1500, speedIndex: 3531,
  });

  assert.ok(r.performance.normalizedFirstContentfulPaint >= 631, 'FCP must not drop below responseEnd');
  assert.ok(r.responseTime.normalizedTotal <= 1757);
});

test('a reference-speed host gets no correction at all', () => {
  const r = normalizedFor({
    ttfb: 200, contentDownload: 50, domContentLoaded: 1500, total: 4000,
    fcp: 900, lcp: 1200, speedIndex: LIMITS.REFERENCE_HOST_SPEED_INDEX,
  });

  assert.equal(r.responseTime.cpuCorrectionMs, 0);
  assert.equal(r.responseTime.normalizedTotal, 4000);
});

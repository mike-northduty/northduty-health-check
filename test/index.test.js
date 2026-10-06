const assert = require('node:assert/strict');
const test = require('node:test');

const { TIMEOUTS } = require('../lib/constants');
const {
  checkWebPageWithTimeout,
  getPageSubcheckTimeout,
  hasRetryBudget,
  index,
  isTransientFailure,
} = require('../index');

test('isTransientFailure retries DNS resolution failures', () => {
  assert.equal(
    isTransientFailure({
      dns: { resolved: false, error: 'EAI_AGAIN' },
      httpStatus: { code: null, ok: false, error: 'DNS resolution failed: EAI_AGAIN' },
    }),
    true,
  );
});

test('isTransientFailure retries network-level SSL failures but not certificate failures', () => {
  assert.equal(
    isTransientFailure({
      ssl: { valid: false, error: 'Connection timeout', transient: true },
      dns: { resolved: true },
      httpStatus: { code: 200, ok: true },
    }),
    true,
  );

  assert.equal(
    isTransientFailure({
      ssl: {
        valid: false,
        error: 'certificate has expired',
        code: 'CERT_HAS_EXPIRED',
        transient: false,
      },
      dns: { resolved: true },
      httpStatus: { code: 200, ok: true },
    }),
    false,
  );
});

test('isTransientFailure retries blank verdicts reached via the commit fallback', () => {
  assert.equal(
    isTransientFailure({
      dns: { resolved: true },
      httpStatus: { code: 200, ok: true },
      navigation: { completedWith: 'commit', warnings: [] },
      blankPage: { isBlank: true },
    }),
    true,
  );

  assert.equal(
    isTransientFailure({
      dns: { resolved: true },
      httpStatus: { code: 200, ok: true },
      navigation: { completedWith: 'domcontentloaded', warnings: [] },
      blankPage: { isBlank: true },
    }),
    false,
  );
});

test('isTransientFailure never retries SSRF blocks', () => {
  assert.equal(
    isTransientFailure({
      dns: { resolved: false },
      httpStatus: { code: null, ok: false },
      ssrfBlocked: [{ url: 'http://169.254.169.254/', reason: 'Blocked private/reserved IP' }],
    }),
    false,
  );
});

test('hasRetryBudget only allows retries that fit inside the health deadline', () => {
  const now = 1_000_000;
  const requiredBudget =
    TIMEOUTS.HEALTH_CHECK_RETRY_DELAY + TIMEOUTS.HEALTH_CHECK_RETRY_MIN_REMAINING;

  assert.equal(hasRetryBudget(now + requiredBudget + 1, now), true);
  assert.equal(hasRetryBudget(now + requiredBudget, now), false);
});

test('index returns a failed structured result for unsupported protocols', async () => {
  const result = await index('ftp://example.com/file');

  assert.equal(result.error, 'Unsupported protocol: ftp: — expected http: or https:');
  assert.deepEqual(result.httpStatus, {
    code: null,
    ok: false,
    error: 'Unsupported protocol: ftp: — expected http: or https:',
  });
  assert.deepEqual(result.blankPage, {
    isBlank: null,
    error: 'Unsupported protocol: ftp: — expected http: or https:',
  });
});

test('checkWebPageWithTimeout forwards the check tier to the check function', async () => {
  const tiers = [];
  const recordingCheck = async (url, signal, partialResult, deadline, checks) => {
    tiers.push(checks);
    return {};
  };

  await checkWebPageWithTimeout('https://example.com', {}, 50, 'Browser check hard timeout', recordingCheck, 'uptime');
  await checkWebPageWithTimeout('https://example.com', {}, 50, 'Browser check hard timeout', recordingCheck);

  assert.deepEqual(tiers, ['uptime', 'full']);
});

test('checkWebPageWithTimeout returns failed browser timeout when no page data is available', async () => {
  const result = {};

  await checkWebPageWithTimeout(
    'https://example.com',
    result,
    5,
    'Browser check hard timeout',
    async () => {
      await sleep(25);
      return {};
    },
  );

  assert.equal(result.error, 'Browser check hard timeout');
  assert.deepEqual(result.httpStatus, {
    code: null,
    ok: false,
    error: 'Browser check hard timeout',
  });
  assert.deepEqual(result.blankPage, {
    isBlank: null,
    error: 'Browser check hard timeout',
  });
});

test('checkWebPageWithTimeout preserves page data when a late browser task times out', async () => {
  const result = {};

  await checkWebPageWithTimeout(
    'https://example.com',
    result,
    5,
    'Browser check hard timeout',
    async (_url, _signal, partialResult) => {
      partialResult.httpStatus = { code: 200, ok: true };
      partialResult.blankPage = { isBlank: false };
      await sleep(25);
      return partialResult;
    },
  );

  assert.equal(result.error, undefined);
  assert.deepEqual(result.httpStatus, { code: 200, ok: true });
  assert.deepEqual(result.blankPage, { isBlank: false });
  assert.deepEqual(result.browserCheck, {
    completed: false,
    error: 'Browser check hard timeout',
  });
});

test('getPageSubcheckTimeout returns the nominal timeout when there is no deadline', () => {
  assert.equal(getPageSubcheckTimeout(null, TIMEOUTS.PAGE_SUBCHECK), TIMEOUTS.PAGE_SUBCHECK);
  assert.equal(getPageSubcheckTimeout(undefined, 1234), 1234);
});

test('getPageSubcheckTimeout keeps the nominal timeout when the deadline is far away', () => {

  const deadline = Date.now() + 60_000;
  assert.equal(getPageSubcheckTimeout(deadline, TIMEOUTS.PAGE_SUBCHECK), TIMEOUTS.PAGE_SUBCHECK);
});

test('getPageSubcheckTimeout clamps to the remaining budget minus the deadline margin', () => {

  const offset = 3_000;
  const deadline = Date.now() + offset;
  const expectedCeiling = offset - TIMEOUTS.BROWSER_DEADLINE_MARGIN;

  const timeout = getPageSubcheckTimeout(deadline, TIMEOUTS.ACCESSIBILITY_AUDIT);

  assert.ok(timeout <= expectedCeiling, `expected <= ${expectedCeiling}, got ${timeout}`);

  assert.ok(timeout > expectedCeiling - 200, `expected > ${expectedCeiling - 200}, got ${timeout}`);
});

test('getPageSubcheckTimeout never returns negative when the deadline has passed', () => {
  assert.equal(getPageSubcheckTimeout(Date.now() - 5_000, TIMEOUTS.PAGE_SUBCHECK), 0);

  assert.equal(getPageSubcheckTimeout(Date.now() + 100, TIMEOUTS.PAGE_SUBCHECK), 0);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

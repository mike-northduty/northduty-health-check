const assert = require('node:assert/strict');
const test = require('node:test');

const { buildHttpStatus, navigateWithFallback } = require('../lib/browser');

test('navigateWithFallback clears navigationError after a successful fallback', async () => {
  let callCount = 0;
  const response = {
    ok: () => true,
    status: () => 200,
    statusText: () => 'OK',
  };

  const page = {
    goto: async (_url, options) => {
      callCount += 1;

      if (callCount === 1) {
        assert.equal(options.waitUntil, 'domcontentloaded');
        throw new Error('primary navigation timeout');
      }

      assert.equal(options.waitUntil, 'commit');
      return response;
    },
    waitForLoadState: async () => {},
    url: () => 'https://example.com/final',
  };

  const result = await navigateWithFallback(page, 'https://example.com');
  const httpStatus = buildHttpStatus(result.response, result.navigationError);

  assert.equal(result.navigationError, null);
  assert.equal(result.completedWith, 'commit');
  assert.equal(result.finalUrl, 'https://example.com/final');
  assert.equal(result.response, response);
  assert.equal(typeof result.loadTime, 'number');
  assert.deepEqual(result.warnings, [
    {
      phase: 'domcontentloaded',
      message: 'primary navigation timeout',
    },
  ]);
  assert.equal(httpStatus.ok, true);
  assert.equal('navigationError' in httpStatus, false);
});

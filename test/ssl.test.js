const assert = require('node:assert/strict');
const test = require('node:test');

const { buildSslErrorResult } = require('../lib/security/ssl');

test('buildSslErrorResult marks connection-level failures as transient', () => {
  for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH']) {
    const result = buildSslErrorResult({ message: 'boom', code });
    assert.equal(result.valid, false);
    assert.equal(result.transient, true, `${code} should be transient`);
    assert.equal(result.code, code);
  }
});

test('buildSslErrorResult marks certificate validation failures as final', () => {
  for (const code of ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    const result = buildSslErrorResult({ message: 'bad cert', code });
    assert.equal(result.valid, false);
    assert.equal(result.transient, false, `${code} should not be transient`);
  }
});

test('buildSslErrorResult adds an incomplete-chain hint for issuer errors', () => {
  const result = buildSslErrorResult({
    message: 'unable to get local issuer certificate',
    code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  });

  assert.equal(result.valid, false);
  assert.equal(result.transient, false);
  assert.match(result.hint, /incomplete certificate chain/);
});

test('buildSslErrorResult tolerates errors without a code', () => {
  const result = buildSslErrorResult({ message: 'mystery failure' });

  assert.deepEqual(result, {
    valid: false,
    error: 'mystery failure',
    transient: false,
  });
});

const assert = require('node:assert/strict');
const test = require('node:test');

const { isPrivateAddress, isUrlAllowed } = require('../lib/network/ssrf');

test('isPrivateAddress flags loopback IPv4', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('127.255.255.254'), true);
});

test('isPrivateAddress flags RFC 1918 ranges', () => {
  assert.equal(isPrivateAddress('10.0.0.1'), true);
  assert.equal(isPrivateAddress('10.255.255.255'), true);
  assert.equal(isPrivateAddress('172.16.0.1'), true);
  assert.equal(isPrivateAddress('172.31.255.255'), true);
  assert.equal(isPrivateAddress('192.168.0.1'), true);
});

test('isPrivateAddress flags EC2 IMDS link-local', () => {
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('169.254.0.1'), true);
});

test('isPrivateAddress flags multicast and reserved', () => {
  assert.equal(isPrivateAddress('224.0.0.1'), true);
  assert.equal(isPrivateAddress('239.255.255.255'), true);
  assert.equal(isPrivateAddress('255.255.255.255'), true);
});

test('isPrivateAddress flags CGN range', () => {
  assert.equal(isPrivateAddress('100.64.0.1'), true);
  assert.equal(isPrivateAddress('100.127.255.255'), true);
});

test('isPrivateAddress flags IPv6 loopback and link-local', () => {
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('::'), true);
  assert.equal(isPrivateAddress('fe80::1'), true);
  assert.equal(isPrivateAddress('fc00::1'), true);
  assert.equal(isPrivateAddress('fd12:3456::1'), true);
});

test('isPrivateAddress flags IPv4-mapped IPv6 of private ranges', () => {
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:169.254.169.254'), true);
});

test('isPrivateAddress flags hex-form IPv4-mapped IPv6 of private ranges', () => {
  assert.equal(isPrivateAddress('::ffff:7f00:1'), true);
  assert.equal(isPrivateAddress('::ffff:7f00:0001'), true);
  assert.equal(isPrivateAddress('::ffff:a9fe:a9fe'), true);
  assert.equal(isPrivateAddress('::ffff:0a00:0001'), true);
  assert.equal(isPrivateAddress('::ffff:c0a8:0001'), true);
});

test('isPrivateAddress allows hex-form IPv4-mapped IPv6 of public ranges', () => {
  assert.equal(isPrivateAddress('::ffff:0808:0808'), false);
  assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
});

test('isPrivateAddress flags NAT64 well-known prefix of private targets', () => {
  assert.equal(isPrivateAddress('64:ff9b::7f00:1'), true);
  assert.equal(isPrivateAddress('64:ff9b::a9fe:a9fe'), true);
  assert.equal(isPrivateAddress('64:ff9b::192.168.0.1'), true);
});

test('isPrivateAddress flags IPv4-compatible (deprecated) embedded private', () => {
  assert.equal(isPrivateAddress('::7f00:1'), true);
  assert.equal(isPrivateAddress('::a9fe:a9fe'), true);
});

test('isPrivateAddress allows public IPv4', () => {
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('1.1.1.1'), false);
  assert.equal(isPrivateAddress('93.184.216.34'), false);
});

test('isPrivateAddress allows public IPv6', () => {
  assert.equal(isPrivateAddress('2001:4860:4860::8888'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('isPrivateAddress is safe for malformed input', () => {
  assert.equal(isPrivateAddress(''), false);
  assert.equal(isPrivateAddress('not-an-ip'), false);
  assert.equal(isPrivateAddress(null), false);
  assert.equal(isPrivateAddress(undefined), false);
  assert.equal(isPrivateAddress(123), false);
});

test('isUrlAllowed blocks IP literals in private ranges', async () => {
  const result = await isUrlAllowed('http://127.0.0.1/foo');
  assert.equal(result.allowed, false);
  assert.match(result.reason, /private\/reserved IP/);
});

test('isUrlAllowed blocks EC2 IMDS by literal', async () => {
  const result = await isUrlAllowed('http://169.254.169.254/latest/meta-data/');
  assert.equal(result.allowed, false);
  assert.match(result.reason, /169\.254\.169\.254/);
});

test('isUrlAllowed blocks localhost by name without resolving DNS', async () => {
  const result = await isUrlAllowed('http://localhost:8080/');
  assert.equal(result.allowed, false);
  assert.match(result.reason, /localhost/);
});

test('isUrlAllowed allows public IP literals', async () => {
  const result = await isUrlAllowed('http://8.8.8.8/');
  assert.equal(result.allowed, true);
  assert.deepEqual(result.addresses, ['8.8.8.8']);
});

test('isUrlAllowed rejects malformed URLs', async () => {
  const result = await isUrlAllowed('not a url');
  assert.equal(result.allowed, false);
});

test('isUrlAllowed honours ALLOW_PRIVATE_URLS=true override', async () => {
  const original = process.env.ALLOW_PRIVATE_URLS;
  process.env.ALLOW_PRIVATE_URLS = 'true';
  try {
    const result = await isUrlAllowed('http://169.254.169.254/');
    assert.equal(result.allowed, true);
    assert.equal(result.override, true);
  } finally {
    if (original === undefined) {
      delete process.env.ALLOW_PRIVATE_URLS;
    } else {
      process.env.ALLOW_PRIVATE_URLS = original;
    }
  }
});

test('ALLOW_PRIVATE_URLS override is ignored when NODE_ENV=production', async () => {
  const originalOverride = process.env.ALLOW_PRIVATE_URLS;
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.ALLOW_PRIVATE_URLS = 'true';
  process.env.NODE_ENV = 'production';
  try {
    const result = await isUrlAllowed('http://169.254.169.254/');
    assert.equal(result.allowed, false);
    assert.match(result.reason, /private\/reserved IP/);
  } finally {
    if (originalOverride === undefined) {
      delete process.env.ALLOW_PRIVATE_URLS;
    } else {
      process.env.ALLOW_PRIVATE_URLS = originalOverride;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }
});

test('isUrlAllowed handles IPv6 literals with brackets', async () => {
  const result = await isUrlAllowed('http://[::1]/');
  assert.equal(result.allowed, false);
  assert.match(result.reason, /::1/);
});

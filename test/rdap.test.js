const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildRdapResult,
  parseBootstrap,
  resolveRdapUrl,
  _setBootstrapCacheForTest,
  _resetBootstrapCacheForTest,
} = require('../lib/domain/rdap');

test('buildRdapResult reads expiration + registration events and registrar vcard', () => {
  const result = buildRdapResult('example.com', {
    events: [
      { eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' },
      { eventAction: 'expiration', eventDate: '2030-08-13T04:00:00Z' },
      { eventAction: 'last changed', eventDate: '2024-01-01T00:00:00Z' },
    ],
    entities: [
      {
        roles: ['registrar'],
        vcardArray: ['vcard', [
          ['version', {}, 'text', '4.0'],
          ['fn', {}, 'text', 'MarkMonitor Inc.'],
        ]],
      },
    ],
  });
  assert.equal(result.name, 'example.com');
  assert.equal(result.registrar, 'MarkMonitor Inc.');
  assert.equal(result.creationDate, '1995-08-14T04:00:00.000Z');
  assert.equal(result.expirationDate, '2030-08-13T04:00:00.000Z');
  assert.ok(result.daysUntilExpiry > 0);
});

test('buildRdapResult finds a registrar nested one level deep', () => {
  const result = buildRdapResult('nested.example', {
    entities: [
      {
        roles: ['registrant'],
        entities: [
          {
            roles: ['registrar'],
            vcardArray: ['vcard', [['fn', {}, 'text', 'Nested Registrar LLC']]],
          },
        ],
      },
    ],
  });
  assert.equal(result.registrar, 'Nested Registrar LLC');
});

test('buildRdapResult returns null expiry (not zero) when no expiration event', () => {
  const result = buildRdapResult('no-expiry.example', {
    events: [{ eventAction: 'registration', eventDate: '2010-01-01T00:00:00Z' }],
    entities: [],
  });
  assert.equal(result.expirationDate, null);
  assert.equal(result.daysUntilExpiry, null);
  assert.equal(result.registrar, null);
  assert.equal(result.creationDate, '2010-01-01T00:00:00.000Z');
});

test('buildRdapResult is null-safe for empty / malformed input', () => {
  for (const input of [null, undefined, {}, { events: 'nope', entities: 5 }]) {
    const result = buildRdapResult('x.example', input);
    assert.equal(result.name, 'x.example');
    assert.equal(result.registrar, null);
    assert.equal(result.creationDate, null);
    assert.equal(result.expirationDate, null);
    assert.equal(result.daysUntilExpiry, null);
  }
});

test('buildRdapResult ignores unparseable event dates', () => {
  const result = buildRdapResult('bad-date.example', {
    events: [{ eventAction: 'expiration', eventDate: 'never' }],
  });
  assert.equal(result.expirationDate, null);
  assert.equal(result.daysUntilExpiry, null);
});

test('parseBootstrap maps TLDs to an https base URL with a trailing slash', () => {
  const map = parseBootstrap({
    services: [
      [['com', 'net'], ['https://rdap.verisign.com/com/v1']],
      [['org'], ['https://rdap.publicinterestregistry.org/rdap/']],
    ],
  });
  assert.equal(map.get('com'), 'https://rdap.verisign.com/com/v1/');
  assert.equal(map.get('net'), 'https://rdap.verisign.com/com/v1/');
  assert.equal(map.get('org'), 'https://rdap.publicinterestregistry.org/rdap/');
});

test('parseBootstrap prefers https and skips services with no https URL', () => {
  const map = parseBootstrap({
    services: [
      [['test'], ['http://insecure.example/rdap/', 'https://secure.example/rdap/']],
      [['nohttps'], ['http://only-insecure.example/rdap/']],
    ],
  });
  assert.equal(map.get('test'), 'https://secure.example/rdap/');
  assert.equal(map.has('nohttps'), false);
});

test('parseBootstrap tolerates a missing/empty services array', () => {
  assert.equal(parseBootstrap({}).size, 0);
  assert.equal(parseBootstrap(null).size, 0);
});

test('resolveRdapUrl builds a registry URL for a known TLD', async () => {
  _setBootstrapCacheForTest(new Map([['com', 'https://rdap.verisign.com/com/v1/']]));
  const url = await resolveRdapUrl('example.com', 5000);
  assert.equal(url, 'https://rdap.verisign.com/com/v1/domain/example.com');
  _resetBootstrapCacheForTest();
});

test('resolveRdapUrl returns null for a TLD with no RDAP service', async () => {
  _setBootstrapCacheForTest(new Map([['com', 'https://rdap.verisign.com/com/v1/']]));
  assert.equal(await resolveRdapUrl('example.de', 5000), null);
  _resetBootstrapCacheForTest();
});

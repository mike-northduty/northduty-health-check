const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildWhoisCandidates,
  checkDomain,
  parseWhoisDate,
  buildDomainResult,
} = require('../lib/domain/whois');

test('buildWhoisCandidates prefers the registrable domain for multi-part ccTLDs', () => {
  assert.deepEqual(
    buildWhoisCandidates('www.shop.example.co.uk'),
    ['example.co.uk', 'www.shop.example.co.uk']
  );
});

test('buildWhoisCandidates queries the ICANN-registered domain for private suffixes', () => {

  assert.deepEqual(
    buildWhoisCandidates('foo.github.io'),
    ['github.io', 'foo.github.io']
  );
});

test('checkDomain skips WHOIS for localhost', async () => {
  assert.deepEqual(await checkDomain('http://localhost:3000'), {
    name: 'localhost',
    note: 'WHOIS is not supported for localhost or IP addresses',
  });
});

test('parseWhoisDate returns null for null / empty / unparseable input', () => {
  assert.equal(parseWhoisDate(null), null);
  assert.equal(parseWhoisDate(undefined), null);
  assert.equal(parseWhoisDate(''), null);
  assert.equal(parseWhoisDate('   '), null);
  assert.equal(parseWhoisDate('not a date'), null);
});

test('parseWhoisDate parses ISO-8601 strings', () => {
  assert.equal(
    parseWhoisDate('2025-09-19T00:00:00Z').toISOString(),
    '2025-09-19T00:00:00.000Z'
  );
});

test('parseWhoisDate normalizes dotted dates (.cz, some .ru responses)', () => {
  const parsed = parseWhoisDate('2025.09.19');
  assert.ok(parsed instanceof Date);
  assert.equal(parsed.toISOString().slice(0, 10), '2025-09-19');
});

test('parseWhoisDate strips trailing " UTC" markers', () => {
  const parsed = parseWhoisDate('2025-09-19 00:00:00 UTC');
  assert.equal(parsed.toISOString(), '2025-09-19T00:00:00.000Z');
});

test('parseWhoisDate accepts the first value when given an array', () => {
  const parsed = parseWhoisDate(['2025-09-19T00:00:00Z', '2099-01-01T00:00:00Z']);
  assert.equal(parsed.toISOString(), '2025-09-19T00:00:00.000Z');
});

test('buildDomainResult reads ICANN gTLD shape (.com)', () => {
  const result = buildDomainResult('example.com', {
    registrar: 'GoDaddy.com, LLC',
    creationDate: '1995-08-14T04:00:00Z',
    registryExpiryDate: '2030-08-13T04:00:00Z',
  });
  assert.equal(result.registrar, 'GoDaddy.com, LLC');
  assert.equal(result.creationDate, '1995-08-14T04:00:00.000Z');
  assert.equal(result.expirationDate, '2030-08-13T04:00:00.000Z');
  assert.ok(result.daysUntilExpiry > 0);
});

test('buildDomainResult reads .md shape (expiresOn / registeredOn)', () => {
  const future = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString();
  const result = buildDomainResult('point.md', {
    registrar: 'HOST.MD',
    registeredOn: '2003-09-19T00:00:00Z',
    expiresOn: future,
  });
  assert.equal(result.registrar, 'HOST.MD');
  assert.equal(result.creationDate, '2003-09-19T00:00:00.000Z');
  assert.equal(result.expirationDate, new Date(future).toISOString());
  assert.equal(result.daysUntilExpiry, 100);
});

test('buildDomainResult reads .ru shape (paidTill / created)', () => {
  const result = buildDomainResult('example.ru', {
    registrar: 'RU-CENTER-RU',
    created: '2010.01.15',
    paidTill: '2026.01.15',
  });
  assert.equal(result.registrar, 'RU-CENTER-RU');
  assert.equal(result.creationDate.slice(0, 10), '2010-01-15');
  assert.equal(result.expirationDate.slice(0, 10), '2026-01-15');
});

test('buildDomainResult reads .cn shape (expirationTime / registrationTime)', () => {
  const result = buildDomainResult('example.cn', {
    sponsoringRegistrar: 'Alibaba Cloud Computing Ltd.',
    registrationTime: '2015-01-01T00:00:00Z',
    expirationTime: '2026-01-01T00:00:00Z',
  });
  assert.equal(result.registrar, 'Alibaba Cloud Computing Ltd.');
  assert.equal(result.creationDate, '2015-01-01T00:00:00.000Z');
  assert.equal(result.expirationDate, '2026-01-01T00:00:00.000Z');
});

test('buildDomainResult reads .pl shape (renewalDate)', () => {
  const result = buildDomainResult('example.pl', {
    registrarName: 'home.pl S.A.',
    creationDate: '2018-05-10T00:00:00Z',
    renewalDate: '2027-05-10T00:00:00Z',
  });
  assert.equal(result.registrar, 'home.pl S.A.');
  assert.equal(result.expirationDate, '2027-05-10T00:00:00.000Z');
});

test('buildDomainResult pattern-matches unknown expiry field names', () => {
  const result = buildDomainResult('example.xyz', {
    registrar: 'Some Registrar',
    domainExpiresAt: '2030-01-01T00:00:00Z',
  });
  assert.equal(result.expirationDate, '2030-01-01T00:00:00.000Z');
});

test('buildDomainResult pattern-matches unknown creation field names', () => {
  const result = buildDomainResult('example.xyz', {
    registrar: 'Some Registrar',
    domainRegisteredAt: '2010-01-01T00:00:00Z',
  });
  assert.equal(result.creationDate, '2010-01-01T00:00:00.000Z');
});

test('buildDomainResult does not confuse registrar fields with creation dates', () => {

  const result = buildDomainResult('example.com', {
    registrarName: 'Example Registrar Inc.',
    creationDate: '2020-01-01T00:00:00Z',
  });
  assert.equal(result.registrar, 'Example Registrar Inc.');
  assert.equal(result.creationDate, '2020-01-01T00:00:00.000Z');
});

test('buildDomainResult does not confuse registrationExpirationDate with a creation date', () => {

  const result = buildDomainResult('example.kr', {
    registrar: 'Whois Corp.',
    registeredDate: '2018-03-01T00:00:00Z',
    registrationExpirationDate: '2026-03-01T00:00:00Z',
  });
  assert.equal(result.creationDate, '2018-03-01T00:00:00.000Z');
  assert.equal(result.expirationDate, '2026-03-01T00:00:00.000Z');
});

test('buildDomainResult returns nulls (not zeros) when nothing is available', () => {
  const result = buildDomainResult('example.test', {});
  assert.equal(result.registrar, null);
  assert.equal(result.creationDate, null);
  assert.equal(result.expirationDate, null);
  assert.equal(result.daysUntilExpiry, null);
});

test('buildDomainResult tolerates null/undefined whoisData', () => {
  const a = buildDomainResult('example.test', null);
  const b = buildDomainResult('example.test', undefined);
  assert.equal(a.registrar, null);
  assert.equal(a.expirationDate, null);
  assert.equal(b.registrar, null);
  assert.equal(b.expirationDate, null);
});

test('buildDomainResult ignores unparseable date strings', () => {
  const result = buildDomainResult('example.test', {
    registrar: 'X',
    expirationDate: 'never',
    creationDate: '',
  });
  assert.equal(result.registrar, 'X');
  assert.equal(result.expirationDate, null);
  assert.equal(result.creationDate, null);
  assert.equal(result.daysUntilExpiry, null);
});

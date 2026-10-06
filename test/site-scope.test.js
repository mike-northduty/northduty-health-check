const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createSiteScope,
  getRegistrableDomain,
  isUrlInSiteScope,
} = require('../lib/site-scope');

test('getRegistrableDomain resolves multi-part ccTLDs via the PSL', () => {
  assert.equal(getRegistrableDomain('www.shop.example.co.uk'), 'example.co.uk');
  assert.equal(getRegistrableDomain('sub.example.com'), 'example.com');
});

test('getRegistrableDomain treats private-suffix tenants as separate sites', () => {
  assert.equal(getRegistrableDomain('foo.github.io'), 'foo.github.io');
  assert.equal(getRegistrableDomain('bar.s3.amazonaws.com'), 'bar.s3.amazonaws.com');
});

test('getRegistrableDomain passes through localhost and IPs', () => {
  assert.equal(getRegistrableDomain('localhost'), 'localhost');
  assert.equal(getRegistrableDomain('127.0.0.1'), '127.0.0.1');
});

test('getRegistrableDomain falls back to the hostname for unknown suffixes', () => {
  assert.equal(getRegistrableDomain('intranet'), 'intranet');
});

test('isUrlInSiteScope keeps subdomains of the checked site in scope', () => {
  const scope = createSiteScope('https://www.example.com');
  assert.equal(isUrlInSiteScope('https://api.example.com/v1', scope), true);
  assert.equal(isUrlInSiteScope('https://cdn.other.com/lib.js', scope), false);
});

test('isUrlInSiteScope does not leak across shared-host tenants', () => {
  const scope = createSiteScope('https://foo.github.io');
  assert.equal(isUrlInSiteScope('https://foo.github.io/app.js', scope), true);
  assert.equal(isUrlInSiteScope('https://bar.github.io/app.js', scope), false);
});

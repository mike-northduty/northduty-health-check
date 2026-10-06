const test = require('node:test');
const assert = require('node:assert/strict');

const { createCookieJar } = require('../lib/network/cookie-jar');

test('stores and sends a host-only cookie back to the same host only', () => {
  const jar = createCookieJar();
  jar.store(['a=1; Path=/'], 'https://www.shop.ba/x');

  assert.equal(jar.headerFor('https://www.shop.ba/y'), 'a=1');
  assert.equal(jar.headerFor('https://shop.ba/y'), null);
});

test('a Domain cookie reaches sibling subdomains of the same site', () => {
  const jar = createCookieJar();
  jar.store(['a=1; Domain=shop.ba; Path=/'], 'https://www.shop.ba/');

  assert.equal(jar.headerFor('https://clerk.shop.ba/'), 'a=1');
  assert.equal(jar.headerFor('https://shop.ba/'), 'a=1');
  assert.equal(jar.headerFor('https://evil.ba/'), null);
});

test('refuses Domain attributes outside the setting site', () => {
  const jar = createCookieJar();
  jar.store(['a=1; Domain=ba', 'b=2; Domain=other.com', 'c=3; Domain=github.io'], 'https://www.shop.ba/');
  jar.store(['d=4; Domain=github.io'], 'https://me.github.io/');

  assert.equal(jar.size(), 0);
});

test('expired and Max-Age=0 cookies delete the stored value', () => {
  const jar = createCookieJar();
  jar.store(['a=1; Path=/', 'b=2; Path=/'], 'https://x.com/');
  jar.store(['a=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'b=; Path=/; Max-Age=0'], 'https://x.com/');

  assert.equal(jar.headerFor('https://x.com/'), null);
});

test('Max-Age expiry is honoured over time', () => {
  let t = 1_000_000;
  const jar = createCookieJar({ now: () => t });
  jar.store(['a=1; Path=/; Max-Age=10'], 'https://x.com/');
  assert.equal(jar.headerFor('https://x.com/'), 'a=1');
  t += 11_000;
  assert.equal(jar.headerFor('https://x.com/'), null);
});

test('Secure cookies are never sent over plain http', () => {
  const jar = createCookieJar();
  jar.store(['a=1; Path=/; Secure'], 'https://x.com/');

  assert.equal(jar.headerFor('http://x.com/'), null);
  assert.equal(jar.headerFor('https://x.com/'), 'a=1');
});

test('path scoping and default path follow RFC 6265', () => {
  const jar = createCookieJar();
  jar.store(['a=1; Path=/shop'], 'https://x.com/');
  jar.store(['b=2'], 'https://x.com/bs/shop');

  assert.equal(jar.headerFor('https://x.com/shop/item'), 'a=1');
  assert.equal(jar.headerFor('https://x.com/shopping'), null);
  assert.equal(jar.headerFor('https://x.com/bs/other'), 'b=2');
  assert.equal(jar.headerFor('https://x.com/'), null);
});

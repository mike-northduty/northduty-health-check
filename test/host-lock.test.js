const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function withLockDir(fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-lock-test-'));
    const prevDir = process.env.HEALTH_LOCK_DIR;
    const prevMax = process.env.HEALTH_MAX_CONCURRENT_BROWSERS;
    const prevWait = process.env.HEALTH_LOCK_WAIT_MS;
    process.env.HEALTH_LOCK_DIR = dir;

    delete require.cache[require.resolve('../lib/host-lock')];
    const lock = require('../lib/host-lock');

    try {
      await fn(lock, dir);
    } finally {
      if (prevDir === undefined) delete process.env.HEALTH_LOCK_DIR; else process.env.HEALTH_LOCK_DIR = prevDir;
      if (prevMax === undefined) delete process.env.HEALTH_MAX_CONCURRENT_BROWSERS; else process.env.HEALTH_MAX_CONCURRENT_BROWSERS = prevMax;
      if (prevWait === undefined) delete process.env.HEALTH_LOCK_WAIT_MS; else process.env.HEALTH_LOCK_WAIT_MS = prevWait;
      fs.rmSync(dir, { recursive: true, force: true });
      delete require.cache[require.resolve('../lib/host-lock')];
    }
  };
}

test('only one browser check holds a slot at a time by default', withLockDir(async (lock) => {
  process.env.HEALTH_LOCK_WAIT_MS = '0';

  const first = await lock.acquireBrowserSlot();
  assert.equal(first.acquired, true);

  const second = await lock.acquireBrowserSlot();
  assert.equal(second.acquired, false, 'a second render must not start alongside the first');

  await first.release();

  const third = await lock.acquireBrowserSlot();
  assert.equal(third.acquired, true, 'the slot is reusable once released');
  await third.release();
}));

test('the limit is configurable for hosts with more cores', withLockDir(async (lock) => {
  process.env.HEALTH_LOCK_WAIT_MS = '0';
  process.env.HEALTH_MAX_CONCURRENT_BROWSERS = '2';

  const a = await lock.acquireBrowserSlot();
  const b = await lock.acquireBrowserSlot();
  const c = await lock.acquireBrowserSlot();

  assert.equal(a.acquired, true);
  assert.equal(b.acquired, true);
  assert.equal(c.acquired, false);

  await a.release();
  await b.release();
}));

test('a run proceeds when the wait budget is exhausted', withLockDir(async (lock) => {
  process.env.HEALTH_LOCK_WAIT_MS = '300';

  const held = await lock.acquireBrowserSlot();
  assert.equal(held.acquired, true);

  const started = Date.now();
  const blocked = await lock.acquireBrowserSlot();

  assert.equal(blocked.acquired, false);

  assert.ok(Date.now() - started >= 250, 'it should wait out the budget before barging in');

  await blocked.release();
  await held.release();
}));

test('a slot left behind by a crashed process is reclaimed once it goes stale', withLockDir(async (lock, dir) => {
  process.env.HEALTH_LOCK_WAIT_MS = '0';

  const orphan = path.join(dir, 'browser-0.lock');
  fs.mkdirSync(orphan, { recursive: true });
  const longAgo = new Date(Date.now() - lock.STALE_AFTER_MS - 60_000);
  fs.utimesSync(orphan, longAgo, longAgo);

  const claimed = await lock.acquireBrowserSlot();

  assert.equal(claimed.acquired, true, 'a dead holder must not block the host forever');
  await claimed.release();
}));

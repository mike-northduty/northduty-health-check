const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const LOCK_ROOT = process.env.HEALTH_LOCK_DIR || path.join(os.tmpdir(), 'northduty-health-locks');

const STALE_AFTER_MS = 120_000;

const POLL_INTERVAL_MS = 250;

function maxConcurrent() {
  const configured = Number.parseInt(process.env.HEALTH_MAX_CONCURRENT_BROWSERS ?? '', 10);

  return Number.isFinite(configured) && configured > 0 ? configured : 1;
}

function waitBudgetMs() {
  const configured = Number.parseInt(process.env.HEALTH_LOCK_WAIT_MS ?? '', 10);

  return Number.isFinite(configured) && configured >= 0 ? configured : 90_000;
}

function slotPath(slot) {
  return path.join(LOCK_ROOT, `browser-${slot}.lock`);
}

async function tryClaim(slot, { allowReclaim = true } = {}) {
  const dir = slotPath(slot);

  try {
    await fsp.mkdir(dir, { recursive: false });
    await fsp.writeFile(path.join(dir, 'owner'), `${process.pid} ${Date.now()}`, 'utf8');

    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (!allowReclaim) return false;

    try {
      const stat = await fsp.stat(dir);

      if (Date.now() - stat.mtimeMs <= STALE_AFTER_MS) return false;

      await fsp.rm(dir, { recursive: true, force: true });
    } catch {

      return false;
    }

    return tryClaim(slot, { allowReclaim: false });
  }
}

async function acquireBrowserSlot({ now = () => Date.now(), sleep = defaultSleep } = {}) {
  const limit = maxConcurrent();
  const budget = waitBudgetMs();
  const startedAt = now();

  await fsp.mkdir(LOCK_ROOT, { recursive: true }).catch(() => {});

  for (;;) {
    for (let slot = 0; slot < limit; slot++) {
      let claimed;

      try {
        claimed = await tryClaim(slot);
      } catch {

        return { acquired: false, waitedMs: now() - startedAt, release: async () => {} };
      }

      if (claimed) {
        return {
          acquired: true,
          waitedMs: now() - startedAt,
          release: async () => {
            await fsp.rm(slotPath(slot), { recursive: true, force: true }).catch(() => {});
          },
        };
      }
    }

    if (now() - startedAt >= budget) {
      return { acquired: false, waitedMs: now() - startedAt, release: async () => {} };
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  acquireBrowserSlot,
  maxConcurrent,
  waitBudgetMs,
  LOCK_ROOT,
  STALE_AFTER_MS,

  _internal: { tryClaim, slotPath, fs },
};

const { TIMEOUTS, LIMITS } = require('../constants');

const HOST_SPEED_SAMPLES = 3;

async function measureHostSpeed(page) {
  let scratch = null;

  try {
    scratch = await page.context().newPage();
    await scratch.goto('about:blank');

    return await runBenchmark(scratch);
  } catch {
    return await runBenchmark(page);
  } finally {
    if (scratch) {
      await scratch.close().catch(() => {});
    }
  }
}

async function runBenchmark(page) {
  const samples = [];

  for (let i = 0; i < HOST_SPEED_SAMPLES; i++) {
    const sample = await measureOnce(page);

    if (Number.isFinite(sample)) {
      samples.push(sample);
    }
  }

  const speedIndex = samples.length > 0 ? Math.max(...samples) : null;

  return {
    speedIndex,
    benchmarkMs: TIMEOUTS.HOST_SPEED_BENCHMARK,
    samples,

    trustworthy: isTrustworthyHostSpeed(speedIndex),
    minTrustworthySpeedIndex: LIMITS.MIN_TRUSTWORTHY_HOST_SPEED_INDEX,
    referenceSpeedIndex: LIMITS.REFERENCE_HOST_SPEED_INDEX,
  };
}

async function measureOnce(page) {
  return page.evaluate((budgetMs) => {
    const SIZE = 100000;
    const arr = new Array(SIZE);
    for (let i = 0; i < SIZE; i++) arr[i] = i;

    const start = performance.now();
    let units = 0;

    while (performance.now() - start < budgetMs) {
      let sum = 0;
      for (let i = 0; i < SIZE; i++) sum += Math.sqrt(arr[i]);
      if (!Number.isFinite(sum)) return null;
      units++;
    }

    const elapsed = performance.now() - start;
    return elapsed > 0 ? Math.round((units / elapsed) * 1000) : null;
  }, TIMEOUTS.HOST_SPEED_BENCHMARK);
}

function isTrustworthyHostSpeed(speedIndex) {
  if (!Number.isFinite(speedIndex)) return true;

  return speedIndex >= LIMITS.MIN_TRUSTWORTHY_HOST_SPEED_INDEX;
}

function hostSpeedFactor(speedIndex) {
  if (!Number.isFinite(speedIndex) || speedIndex <= 0) return null;

  const reference = LIMITS.REFERENCE_HOST_SPEED_INDEX;

  if (!Number.isFinite(reference) || reference <= 0) return null;

  return Math.min(2, Math.max(0.2, speedIndex / reference));
}

module.exports = { measureHostSpeed, isTrustworthyHostSpeed, hostSpeedFactor };

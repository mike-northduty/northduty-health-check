async function collectResponseTime(page, loadTime, options = {}) {
  const { completedWith = null } = options;

  const timing = await page.evaluate(() => {
    const perf = performance.getEntriesByType('navigation')[0];
    if (!perf) return null;

    const startTime = perf.startTime || 0;
    const duration = (start, end) => {
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
        return null;
      }

      return Math.round(end - start);
    };

    const elapsedSinceStart = (value) => {
      if (!Number.isFinite(value) || value <= 0) {
        return null;
      }

      return Math.round(value - startTime);
    };

    return {
      dnsLookup: duration(perf.domainLookupStart, perf.domainLookupEnd),

      tcpConnection:
        perf.secureConnectionStart > 0
          ? duration(perf.connectStart, perf.secureConnectionStart)
          : duration(perf.connectStart, perf.connectEnd),
      tlsHandshake:
        perf.secureConnectionStart > 0
          ? duration(perf.secureConnectionStart, perf.connectEnd)
          : null,
      ttfb: duration(perf.requestStart, perf.responseStart),
      contentDownload: duration(perf.responseStart, perf.responseEnd),
      domParsing: duration(perf.responseEnd, perf.domInteractive),
      domContentLoaded: elapsedSinceStart(perf.domContentLoadedEventEnd),
      fullLoad: elapsedSinceStart(perf.loadEventEnd),
    };
  });

  const { total, totalSource } = resolveTotal(timing, loadTime, completedWith);

  return {
    ...(timing || {}),
    total,

    totalSource,
    navigationCompletedWith: completedWith,
    wallClock: Number.isFinite(loadTime) ? loadTime : null,
  };
}

function resolveTotal(timing, loadTime, completedWith) {
  if (Number.isFinite(timing?.fullLoad) && timing.fullLoad > 0) {
    return { total: timing.fullLoad, totalSource: 'full-load' };
  }

  if (Number.isFinite(timing?.domContentLoaded) && timing.domContentLoaded > 0) {
    return { total: timing.domContentLoaded, totalSource: 'dom-content-loaded' };
  }

  if (completedWith === 'domcontentloaded' && Number.isFinite(loadTime)) {
    return { total: loadTime, totalSource: 'wall-clock' };
  }

  return { total: null, totalSource: null };
}

module.exports = { collectResponseTime };

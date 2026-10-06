const { TIMEOUTS } = require('../constants');

async function collectWebVitals(page) {
  const vitals = await page.evaluate((timeout) => {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const metrics = { lcp: null, cls: null, fcp: null };

      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        metrics.lcp = lcpValue !== null ? Math.round(lcpValue) : null;
        metrics.cls = clsValue !== null ? Math.round(clsValue * 1000) / 1000 : null;
        lcpObserver.disconnect();
        clsObserver.disconnect();
        resolve(metrics);
      };

      const fcpEntry = performance.getEntriesByName('first-contentful-paint')[0];
      if (fcpEntry) {
        metrics.fcp = Math.round(fcpEntry.startTime);
      }

      let lcpValue = null;
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        if (entries.length > 0) {
          lcpValue = entries[entries.length - 1].startTime;
        }
      });
      try {
        lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {}

      let clsValue = null;
      let clsObserverReady = false;
      const clsObserver = new PerformanceObserver((list) => {
        if (!clsObserverReady) {
          clsObserverReady = true;
          if (clsValue === null) clsValue = 0;
        }
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            clsValue += entry.value;
          }
        }
      });
      try {
        clsObserver.observe({ type: 'layout-shift', buffered: true });

        if (!clsObserverReady) {
          clsObserverReady = true;
          clsValue = 0;
        }
      } catch {}

      timer = setTimeout(finish, timeout);
    });
  }, TIMEOUTS.WEB_VITALS_COLLECTION);

  return {
    firstContentfulPaint: vitals.fcp,
    largestContentfulPaint: vitals.lcp,
    cumulativeLayoutShift: vitals.cls,
  };
}

module.exports = { collectWebVitals };

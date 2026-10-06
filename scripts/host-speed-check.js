const os = require('os');
const { chromium } = require('playwright');
const { TIMEOUTS, LIMITS } = require('../lib/constants');
const { measureHostSpeed } = require('../lib/page/host-speed');
const { collectResponseTime } = require('../lib/network/timing');
const { collectWebVitals } = require('../lib/page/vitals');

async function main() {
  const url = process.argv[2] || null;
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  try {
    const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();

    await page.goto(url || 'about:blank', { waitUntil: url ? 'domcontentloaded' : 'load', timeout: TIMEOUTS.PAGE_NAVIGATION });

    const report = {
      host: {
        cpus: os.cpus().length,
        loadavg: os.loadavg().map((n) => Number(n.toFixed(2))),
        totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
        freeMemMb: Math.round(os.freemem() / 1024 / 1024),
      },
      speed: await measureHostSpeed(page),
      minTrustworthy: LIMITS.MIN_TRUSTWORTHY_HOST_SPEED_INDEX,
    };

    if (url) {
      await page.waitForLoadState('load', { timeout: TIMEOUTS.PAGE_LOAD_STATE }).catch(() => {});
      report.url = url;
      report.responseTime = await collectResponseTime(page, null, { completedWith: 'domcontentloaded' });
      report.performance = await collectWebVitals(page);

      report.verdict = {
        networkLooksFine: Number.isFinite(report.responseTime.ttfb) && report.responseTime.ttfb < 1500,
        parseLooksHostBound: Number.isFinite(report.responseTime.domParsing) && report.responseTime.domParsing > 3000,
      };
    }

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: err.message }));
  process.exitCode = 1;
});

const { URL } = require('url');
const { checkSSL } = require('./lib/security/ssl');
const { detectCloudflare } = require('./lib/security/cloudflare');
const { detectBotProtection } = require('./lib/security/bot-protection');
const { collectResponseTime } = require('./lib/network/timing');
const { collectWebVitals } = require('./lib/page/vitals');
const { measureHostSpeed, hostSpeedFactor } = require('./lib/page/host-speed');
const { acquireBrowserSlot } = require('./lib/host-lock');
const { checkOverHttp } = require('./lib/http-check');
const {
  detectBlankPage,
  createResourceTracker,
  collectContentSize,
} = require('./lib/page/analysis');
const { createErrorTracker } = require('./lib/page/errors');
const { createApiTracker } = require('./lib/page/api-tracker');
const { createRedirectTracker } = require('./lib/network/redirect');
const {
  createBrowser,
  navigateWithFallback,
  buildHttpStatus,
  getDefaultContextOptions,
} = require('./lib/browser');
const { checkDomain } = require('./lib/domain/whois');
const { checkDns } = require('./lib/network/dns');
const { collectHeaders } = require('./lib/network/headers');
const { createProtocolTracker } = require('./lib/network/protocol');
const { installSsrfGuard, isUrlAllowed } = require('./lib/network/ssrf');
const { checkRobotsTxt, checkSitemapXml } = require('./lib/network/robots');
const { runAccessibilityAudit } = require('./lib/page/accessibility');
const { collectSeoData, scoreSeo } = require('./lib/page/seo');
const { TIMEOUTS } = require('./lib/constants');

async function checkWebPage(urlString, signal, partialResult = null, deadline = null, checks = 'full') {
  const result = {};
  let browser;
  let aborted = false;
  const setField = (field, value) => {
    result[field] = value;
    if (partialResult && !signal?.aborted) {
      partialResult[field] = value;
    }
  };
  const setFields = (fields) => {
    Object.assign(result, fields);
    if (partialResult && !signal?.aborted) {
      Object.assign(partialResult, fields);
    }
  };
  const protocolTracker = createProtocolTracker();
  const abortHandler = () => {
    aborted = true;
    if (browser) {
      browser.close().catch(() => {});
    }
  };

  if (signal?.aborted) {
    throw new Error('Browser check hard timeout');
  }

  signal?.addEventListener('abort', abortHandler, { once: true });

  let primaryHostname = null;
  try {
    primaryHostname = new URL(urlString).hostname;
  } catch {}

  const slot = await acquireBrowserSlot();

  if (!slot.acquired) {
    console.error(JSON.stringify({
      warning: 'Proceeding without a browser slot',
      detail: 'Wait budget elapsed; page timings for this run may be inflated by host contention.',
      url: urlString,
      waitedMs: slot.waitedMs,
    }));
  }

  try {
    browser = await createBrowser();
    if (signal?.aborted) {
      throw new Error('Browser check hard timeout');
    }

    const context = await browser.newContext(getDefaultContextOptions());
    const ssrfGuard = await installSsrfGuard(context, primaryHostname);
    const page = await context.newPage();

    const resourceTracker = createResourceTracker();
    const errorTracker = createErrorTracker();
    const redirectTracker = createRedirectTracker();
    const apiTracker = createApiTracker();

    await protocolTracker.setup(page);

    page.on('pageerror', errorTracker.handlers.onPageError);
    page.on('console', errorTracker.handlers.onConsoleError);
    page.on('requestfailed', resourceTracker.handlers.onRequestFailed);
    page.on('response', resourceTracker.handlers.onResponse);
    page.on('request', redirectTracker.handlers.onRequest);
    page.on('response', redirectTracker.handlers.onResponse);
    page.on('request', apiTracker.handlers.onRequest);
    page.on('response', apiTracker.handlers.onResponse);
    page.on('requestfailed', apiTracker.handlers.onRequestFailed);

    const { response, loadTime, navigationError, finalUrl, completedWith, warnings } =
      await navigateWithFallback(page, urlString, {
        beforeFallback: () => {
          resourceTracker.reset();
          errorTracker.reset();
          apiTracker.reset();
          redirectTracker.reset();
          protocolTracker.reset();
        },
      });

    setFields({
      httpStatus: buildHttpStatus(response, navigationError),
      navigation: {
        completedWith,
        warnings,
      },
      redirect: redirectTracker.getRedirects(finalUrl, urlString),
      http: response ? protocolTracker.getProtocol() : null,
      headers: response ? collectHeaders(response.headers()) : null,
      brokenResources: resourceTracker.getResources(urlString, finalUrl),
      jsErrors: errorTracker.getErrors(),
      apiCalls: apiTracker.getApiCalls(urlString, finalUrl),
    });

    if (response) {
      const safe = async (label, fn, fallback, timeoutMs = TIMEOUTS.PAGE_SUBCHECK) => {
        try {
          const subcheckTimeout = getPageSubcheckTimeout(deadline, timeoutMs);
          return await withOperationTimeout(fn, subcheckTimeout, `${label} timed out`);
        } catch (err) {
          console.error(
            JSON.stringify({
              error: 'Sub-check failed',
              check: label,
              url: urlString,
              detail: err.message,
            }),
          );
          return withFallbackError(fallback, err.message);
        }
      };

      setField(
        'blankPage',
        await safe('blankPage', () => detectBlankPage(page), { isBlank: null }),
      );
      setField(
        'cloudflare',
        await safe('cloudflare', () => detectCloudflare(page, response), { detected: null }),
      );
      setField(
        'botProtection',
        await safe('botProtection', () => detectBotProtection(page, response), { detected: null }),
      );
      setField(
        'responseTime',
        await safe('responseTime', () => collectResponseTime(page, loadTime, { completedWith }), {
          total: completedWith === 'domcontentloaded' ? (loadTime ?? null) : null,
          totalSource: completedWith === 'domcontentloaded' && loadTime != null ? 'wall-clock' : null,
          navigationCompletedWith: completedWith,
          wallClock: loadTime ?? null,
        }),
      );
      setField(
        'content',
        await safe('contentSize', () => collectContentSize(page), {
          size: null,
          encodedSize: null,
          transferSize: null,
        }),
      );
      setField(
        'performance',
        await safe('vitals', () => collectWebVitals(page), {
          firstContentfulPaint: null,
          largestContentfulPaint: null,
          cumulativeLayoutShift: null,
        }),
      );

      setField(
        'host',
        await safe('hostSpeed', () => measureHostSpeed(page), {
          speedIndex: null,
          trustworthy: true,
        }),
      );

      setField('host', {
        ...(result.host || {}),
        slotAcquired: slot.acquired,
        slotWaitMs: slot.waitedMs,
      });
      applyHostSpeedNormalization(result, setField);

      if (checks !== 'uptime') {
        setField('seoData', await safe('seo', () => collectSeoData(page), { error: null }));
        setField(
          'accessibility',
          await safe(
            'accessibility',
            () => runAccessibilityAudit(page),
            {
              violations: [],
              criticalCount: 0,
              seriousCount: 0,
              moderateCount: 0,
              minorCount: 0,
              score: null,
            },
            TIMEOUTS.ACCESSIBILITY_AUDIT,
          ),
        );
      }
    } else {
      setField('blankPage', { isBlank: null, error: navigationError || 'Navigation failed' });
    }

    if (ssrfGuard.blocked.length > 0) {
      setField('ssrfBlocked', ssrfGuard.blocked);
    }
  } catch (err) {
    const message = aborted ? 'Browser check hard timeout' : err.message;
    setField('error', message);
    if (!result.httpStatus) {
      setField('httpStatus', { code: null, ok: false, error: message });
    }
    if (!result.blankPage) {
      setField('blankPage', { isBlank: null, error: message });
    }
  } finally {
    signal?.removeEventListener('abort', abortHandler);
    await protocolTracker.detach();
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }

    await slot.release();
  }

  return result;
}

async function index(urlString, options = {}) {
  const checks = options.checks === 'uptime' ? 'uptime' : 'full';
  const result = {
    url: urlString,
    timestamp: new Date().toISOString(),
    checksTier: checks,
    httpStatus: null,
    ssl: null,
    dns: null,
    domain: null,
    http: null,
    headers: null,
    responseTime: null,
    host: null,
    navigation: null,
    redirect: null,
    performance: null,
    content: null,
    blankPage: null,
    brokenResources: [],
    cloudflare: null,
    botProtection: null,
    jsErrors: [],
    apiCalls: [],
    ssrfBlocked: null,
    accessibility: null,
    seo: null,
    browserCheck: null,
  };

  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    result.error = 'Invalid URL';
    return result;
  }

  if (!isSupportedProtocol(parsedUrl)) {
    result.error = `Unsupported protocol: ${parsedUrl.protocol} — expected http: or https:`;
    result.httpStatus = { code: null, ok: false, error: result.error };
    result.blankPage = { isBlank: null, error: result.error };
    return result;
  }

  const healthDeadline = Date.now() + TIMEOUTS.HEALTH_CHECK_TOTAL_TIMEOUT;
  let ssrfCheck;
  try {
    ssrfCheck = await withDeadline(
      isUrlAllowed(urlString),
      healthDeadline,
      'Health check total timeout',
    );
  } catch (error) {
    applyHealthTimeout(result, error.message);
    return result;
  }

  if (!ssrfCheck.allowed) {
    result.error = `SSRF blocked: ${ssrfCheck.reason}`;
    result.httpStatus = { code: null, ok: false, error: result.error };
    result.blankPage = { isBlank: null, error: result.error };
    result.ssrfBlocked = [{ url: urlString, reason: ssrfCheck.reason, navigation: true }];
    return result;
  }

  await runHealthChecks(urlString, parsedUrl, result, healthDeadline, checks);

  let retries = 0;
  while (
    isTransientFailure(result) &&
    retries < TIMEOUTS.HEALTH_CHECK_MAX_RETRIES &&
    hasRetryBudget(healthDeadline)
  ) {
    retries += 1;
    await sleep(TIMEOUTS.HEALTH_CHECK_RETRY_DELAY);
    resetCheckResult(result);
    await runHealthChecks(urlString, parsedUrl, result, healthDeadline, checks);
  }

  if (retries > 0) {
    result.retries = retries;
  }

  return result;
}

async function runHealthChecks(urlString, parsedUrl, result, deadline, checks = 'full') {
  const sslPort = parsedUrl.port ? Number(parsedUrl.port) : 443;
  const origin = `${parsedUrl.protocol}//${parsedUrl.host}`;
  const fullTier = checks !== 'uptime';

  const [ssl, dns, domain, robotsOk, sitemapOk] = await Promise.all([
    parsedUrl.protocol === 'https:'
      ? checkSSL(parsedUrl.hostname, sslPort)
      : Promise.resolve({ valid: null, note: 'Not an HTTPS URL' }),
    checkDns(parsedUrl.hostname),
    fullTier ? checkDomain(urlString) : Promise.resolve(null),
    fullTier ? checkRobotsTxt(origin) : Promise.resolve(null),
    fullTier ? checkSitemapXml(origin) : Promise.resolve(null),
  ]);
  result.ssl = ssl;
  result.dns = dns;
  result.domain = domain;

  if (!dns.resolved) {
    result.httpStatus = {
      code: null,
      ok: false,
      error: `DNS resolution failed: ${dns.error || 'unknown'}`,
    };
    result.blankPage = { isBlank: null, error: 'Skipped — DNS did not resolve' };
    return;
  }

  if (!fullTier) {
    const httpTimeout = Math.min(TIMEOUTS.API_REQUEST, remainingTime(deadline));

    if (httpTimeout <= 0) {
      applyHealthTimeout(result);
      return;
    }

    Object.assign(result, await checkOverHttp(urlString, { timeoutMs: httpTimeout }));
    result.seo = null;
    delete result.seoData;

    return;
  }

  const browserTimeout = Math.min(TIMEOUTS.CHECK_HARD_TIMEOUT, remainingTime(deadline));
  if (browserTimeout <= 0) {
    applyHealthTimeout(result);
    return;
  }

  await checkWebPageWithTimeout(
    urlString,
    result,
    browserTimeout,
    browserTimeout < TIMEOUTS.CHECK_HARD_TIMEOUT
      ? 'Health check total timeout'
      : 'Browser check hard timeout',
    checkWebPage,
    checks,
  );

  if (result.seoData && !result.seoData.error) {
    const scored = scoreSeo(result.seoData, robotsOk, sitemapOk);
    result.seo = { ...scored, data: { ...result.seoData, robotsOk, sitemapOk } };
  } else {
    result.seo = {
      score: null,
      findings: [],
      error: result.seoData?.error || 'SEO data collection failed',
    };
  }
  delete result.seoData;
}

function isTransientFailure(result) {
  if (result.ssrfBlocked && result.ssrfBlocked.length > 0) return false;

  if (result.dns && !result.dns.resolved) return true;

  if (result.ssl?.valid === false && result.ssl.transient) return true;

  if (!result.httpStatus) return false;

  if (result.httpStatus.navigationError) return true;

  if (result.error) return true;

  if (result.blankPage?.isBlank === true && result.navigation?.completedWith === 'commit')
    return true;

  const code = result.httpStatus.code;
  if (code !== null && code >= 500) return true;

  return false;
}

function resetCheckResult(result) {
  result.ssl = null;
  result.dns = null;
  result.domain = null;
  result.httpStatus = null;
  result.navigation = null;
  result.redirect = null;
  result.http = null;
  result.headers = null;
  result.responseTime = null;
  result.performance = null;
  result.content = null;
  result.blankPage = null;
  result.brokenResources = [];
  result.cloudflare = null;
  result.botProtection = null;
  result.jsErrors = [];
  result.apiCalls = [];
  result.accessibility = null;
  result.seo = null;
  result.browserCheck = null;
  delete result.seoData;
  delete result.error;
  delete result.ssrfBlocked;
}

async function checkWebPageWithTimeout(
  urlString,
  result,
  timeoutMs = TIMEOUTS.CHECK_HARD_TIMEOUT,
  timeoutMessage = 'Browser check hard timeout',
  checkFn = checkWebPage,
  checks = 'full',
) {
  let timer;
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const checkPromise = checkFn(urlString, controller.signal, result, deadline, checks);
  checkPromise.catch(() => {});

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });

  try {
    const pageResult = await Promise.race([checkPromise, timeout]);
    Object.assign(result, pageResult);
  } catch (err) {
    controller.abort();
    applyBrowserTimeout(result, err.message);
  } finally {
    clearTimeout(timer);
  }
}

function applyBrowserTimeout(result, message) {
  if (result.httpStatus && result.blankPage) {
    result.browserCheck = { completed: false, error: message };
    return;
  }

  result.error = message;
  if (!result.httpStatus) {
    result.httpStatus = { code: null, ok: false, error: message };
  }
  if (!result.blankPage) {
    result.blankPage = { isBlank: null, error: message };
  }
}

function applyHealthTimeout(result, message = 'Health check total timeout') {
  result.error = message;
  result.httpStatus = { code: null, ok: false, error: result.error };
  result.blankPage = { isBlank: null, error: result.error };
}

function hasRetryBudget(deadline, now = Date.now()) {
  return (
    deadline - now > TIMEOUTS.HEALTH_CHECK_RETRY_DELAY + TIMEOUTS.HEALTH_CHECK_RETRY_MIN_REMAINING
  );
}

function remainingTime(deadline) {
  return deadline - Date.now();
}

function applyHostSpeedNormalization(result, setField) {
  const factor = hostSpeedFactor(result.host?.speedIndex);

  if (factor === null) return;

  const timing = result.responseTime || {};
  const ttfb = Number.isFinite(timing.ttfb) ? timing.ttfb : 0;
  const download = Number.isFinite(timing.contentDownload) ? timing.contentDownload : 0;

  const responseEnd = ttfb + download;

  const cpuSpan = Number.isFinite(timing.domContentLoaded)
    ? Math.max(0, timing.domContentLoaded - responseEnd)
    : 0;

  const savings = Math.round(cpuSpan * (1 - factor));

  const normalize = (value) => {
    if (!Number.isFinite(value) || value <= 0) return null;

    const correctable = Math.max(0, Math.min(savings, value - responseEnd));

    return Math.round(value - correctable);
  };

  const shared = {
    hostSpeedFactor: Math.round(factor * 1000) / 1000,

    cpuSpanMs: cpuSpan,
    cpuCorrectionMs: savings,
  };

  if (result.responseTime) {
    setField('responseTime', {
      ...result.responseTime,
      normalizedTotal: normalize(result.responseTime.total),
      normalizedDomContentLoaded: normalize(result.responseTime.domContentLoaded),
      referenceSpeedIndex: result.host?.referenceSpeedIndex ?? null,
      ...shared,
    });
  }

  if (result.performance) {
    setField('performance', {
      ...result.performance,
      normalizedFirstContentfulPaint: normalize(result.performance.firstContentfulPaint),
      normalizedLargestContentfulPaint: normalize(result.performance.largestContentfulPaint),
      ...shared,
    });
  }
}

function getPageSubcheckTimeout(deadline, timeoutMs) {
  if (!deadline) return timeoutMs;

  return Math.min(
    timeoutMs,
    Math.max(0, remainingTime(deadline) - TIMEOUTS.BROWSER_DEADLINE_MARGIN),
  );
}

async function withOperationTimeout(fn, timeoutMs, message) {
  if (timeoutMs <= 0) {
    throw new Error('Browser check budget exhausted');
  }

  let timer;
  const operation = Promise.resolve().then(fn);
  operation.catch(() => {});

  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function withFallbackError(fallback, message) {
  return { ...fallback, error: message };
}

async function withDeadline(promise, deadline, message) {
  const timeoutMs = remainingTime(deadline);
  if (timeoutMs <= 0) {
    throw new Error(message);
  }

  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSupportedProtocol(parsedUrl) {
  return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
}

async function main() {
  const args = process.argv.slice(2);
  const watch = args.includes('--watch');
  const uptimeOnly = args.includes('--uptime');
  const url = args.find((arg) => !arg.startsWith('--'));

  if (!url) {
    console.error(JSON.stringify({ error: 'Usage: node index.js <url> [--watch] [--uptime]' }));
    process.exit(1);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    console.error(JSON.stringify({ error: `Malformed URL: ${url}` }));
    process.exit(1);
  }

  if (!isSupportedProtocol(parsedUrl)) {
    console.error(
      JSON.stringify({
        error: `Unsupported protocol: ${parsedUrl.protocol} — expected http: or https:`,
      }),
    );
    process.exit(1);
  }

  let shuttingDown = false;
  let sleepTimer = null;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (sleepTimer) clearTimeout(sleepTimer);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  while (!shuttingDown) {
    try {
      const result = await index(url, { checks: uptimeOnly ? 'uptime' : 'full' });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(
        JSON.stringify({ error: error.message, url, timestamp: new Date().toISOString() }),
      );
    }

    if (!watch || shuttingDown) break;

    await new Promise((resolve) => {
      sleepTimer = setTimeout(resolve, TIMEOUTS.CHECK_INTERVAL);
    });
    sleepTimer = null;
  }
}

module.exports = {
  index,

  applyHostSpeedNormalization,
  checkWebPageWithTimeout,
  getPageSubcheckTimeout,
  hasRetryBudget,
  isTransientFailure,
};

if (require.main === module) {
  process.on('unhandledRejection', (reason) => {
    console.error(JSON.stringify({ error: 'unhandledRejection', detail: String(reason) }));
  });
  process.on('uncaughtException', (error) => {
    console.error(JSON.stringify({ error: 'uncaughtException', detail: error.message }));
    process.exit(1);
  });

  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exit(1);
  });
}

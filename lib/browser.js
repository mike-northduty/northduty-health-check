const { chromium } = require('playwright');
const { TIMEOUTS } = require('./constants');

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const VIEWPORT = { width: 1920, height: 1080 };

async function createBrowser() {
  return chromium.launch({
    args: [
      `--user-agent=${USER_AGENT}`,
      '--disable-blink-features=AutomationControlled',

      '--no-sandbox',

      '--disable-dev-shm-usage',
    ],
  });
}

function getDefaultContextOptions() {
  return {
    userAgent: USER_AGENT,
    viewport: VIEWPORT,
  };
}

async function navigateWithFallback(page, url, { beforeFallback } = {}) {
  let response = null;
  let navigationError = null;
  const warnings = [];
  let completedWith = null;
  let loadTime = null;

  try {
    const primaryStart = Date.now();
    response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUTS.PAGE_NAVIGATION,
    });

    completedWith = 'domcontentloaded';
    loadTime = Date.now() - primaryStart;
    await waitForOptionalLoadState(page, warnings);
    await settleAfterNavigation(page);
  } catch (err) {
    warnings.push({
      phase: 'domcontentloaded',
      message: err.message,
    });

    if (beforeFallback) beforeFallback();

    try {
      const fallbackStart = Date.now();
      response = await page.goto(url, {
        waitUntil: 'commit',
        timeout: TIMEOUTS.PAGE_FALLBACK,
      });

      completedWith = 'commit';
      loadTime = Date.now() - fallbackStart;

      await page.waitForLoadState('domcontentloaded', { timeout: TIMEOUTS.COMMIT_SETTLE }).catch(() => {});
      await settleAfterNavigation(page);
    } catch (fallbackError) {
      navigationError = fallbackError.message;
    }
  }

  const finalUrl = navigationError ? url : page.url();

  return {
    response,
    loadTime,
    navigationError,
    finalUrl,
    completedWith,
    warnings,
  };
}

async function waitForOptionalLoadState(page, warnings) {
  try {
    await page.waitForLoadState('load', {
      timeout: TIMEOUTS.PAGE_LOAD_STATE,
    });
  } catch (error) {

    warnings.push({
      phase: 'load',
      message: error.message,
    });
  }
}

async function settleAfterNavigation(page) {
  try {
    await page.waitForLoadState('networkidle', {
      timeout: TIMEOUTS.POST_NAVIGATION_SETTLE,
    });
  } catch {

  }
}

function buildHttpStatus(response, navigationError) {
  return {
    code: response?.status() ?? null,
    ok: response?.ok() ?? false,
    statusText: response?.statusText() ?? null,
    ...(navigationError && { navigationError }),
  };
}

module.exports = { createBrowser, navigateWithFallback, buildHttpStatus, getDefaultContextOptions };

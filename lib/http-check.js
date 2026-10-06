const { TIMEOUTS } = require('./constants');
const { collectHeaders } = require('./network/headers');
const { evaluateOffSite } = require('./network/redirect');
const { classifyBotProtection } = require('./security/bot-protection');
const { classifyCloudflare } = require('./security/cloudflare');
const { isUrlAllowed } = require('./network/ssrf');
const { createCookieJar } = require('./network/cookie-jar');

const BODY_SAMPLE_BYTES = 64 * 1024;

const MAX_REDIRECTS = 10;

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36 NorthDuty/1.0 (+https://northduty.com/docs/monitoring-ips)';

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const CLIENT_REFUSED_STATUSES = [403, 429, 503];

async function probeWithBrowserUserAgent(url, signal, jar) {
  try {
    const cookie = jar?.headerFor(url);
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        'user-agent': BROWSER_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        ...(cookie ? { cookie } : {}),
      },
    });

    return { status: response.status, ok: response.status >= 200 && response.status < 400 };
  } catch {

    return null;
  }
}

function markersFromHtml(html) {
  const lower = html.toLowerCase();

  return {
    cloudflare: {
      jsChallenge:
        html.includes('cf-browser-verification') ||
        html.includes('cf_chl_opt') ||
        html.includes('_cf_chl_tk'),
      titleJustAMoment: /<title[^>]*>[^<]*just a moment/i.test(html),
      challengePlatform:
        html.includes('/cdn-cgi/challenge-platform/') ||
        html.includes('challenge-platform') ||
        html.includes('cf_chl_'),
      challengeRunning: html.includes('cf-challenge-running'),
      turnstileWidget:
        lower.includes('cf-turnstile') || lower.includes('challenges.cloudflare.com/turnstile'),
      hCaptcha: html.includes('h-captcha'),
      cfErrorCode: html.includes('cf-error-code'),
      titleAccessDenied: /<title[^>]*>[^<]*(access denied|attention required)/i.test(html),
      checkingBrowser: html.includes('checking your browser'),
      ddosProtection: html.includes('ddos-protection'),
      rayId: (html.match(/Ray ID[:\s]*([a-f0-9]+)/i) || [])[1] || null,
    },
    bot: {
      dataDomeChallenge: html.includes('captcha-delivery.com'),
      perimeterXChallenge: html.includes('px-captcha') || html.includes('_pxAppId'),
      incapsulaChallenge: html.includes('_Incapsula_Resource'),
      incapsulaBlocked: html.includes('subject=WAF Block Page'),
      akamaiDenied:
        html.includes('errors.edgesuite.net') &&
        /<title[^>]*>[^<]*access denied/i.test(html),
    },
  };
}

async function readBodySample(response) {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (received >= BODY_SAMPLE_BYTES) break;
    }
  } catch {

  } finally {

    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

async function fetchOnce(url, signal, jar) {
  const startedAt = performance.now();
  const cookie = jar?.headerFor(url);

  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal,
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      ...(cookie ? { cookie } : {}),
    },
  });

  jar?.store(response.headers.getSetCookie?.() ?? [], url);

  const ttfb = Math.round(performance.now() - startedAt);
  const body = await readBodySample(response);

  return { response, ttfb, body, elapsed: Math.round(performance.now() - startedAt) };
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function checkOverHttp(
  urlString,
  { signal, timeoutMs = TIMEOUTS.API_REQUEST, isAllowed = isUrlAllowed } = {},
) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const redirects = [];

  const jar = createCookieJar();
  let currentUrl = urlString;
  let last = null;
  let ssrfBlocked = null;

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      last = await fetchOnce(currentUrl, controller.signal, jar);
      const status = last.response.status;

      if (!isRedirectStatus(status)) break;

      const location = last.response.headers.get('location');
      if (!location) break;

      const nextUrl = new URL(location, currentUrl).toString();
      const allowed = await isAllowed(nextUrl);

      if (!allowed.allowed) {
        ssrfBlocked = [{ url: nextUrl, reason: allowed.reason, navigation: true }];
        break;
      }

      redirects.push({ from: currentUrl, to: nextUrl, status });
      currentUrl = nextUrl;

      if (hop === MAX_REDIRECTS) {
        return buildResult(urlString, currentUrl, last, redirects, ssrfBlocked, {
          error: `Too many redirects (more than ${MAX_REDIRECTS})`,
        });
      }
    }

    const clientFiltered = await classifyRefusal(last, currentUrl, controller.signal, jar);

    return buildResult(urlString, currentUrl, last, redirects, ssrfBlocked, { clientFiltered });
  } catch (err) {
    const timedOut = controller.signal.aborted;

    return buildResult(urlString, currentUrl, last, redirects, ssrfBlocked, {
      error: timedOut ? `Request timed out after ${timeoutMs}ms` : err.message,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function classifyRefusal(last, finalUrl, signal, jar) {
  if (!last) return null;

  const status = last.response.status;
  if (!CLIENT_REFUSED_STATUSES.includes(status)) return null;

  const headers = Object.fromEntries(last.response.headers.entries());
  const markers = markersFromHtml(last.body);
  const cloudflare = classifyCloudflare(headers, markers.cloudflare, status);
  const botProtection = classifyBotProtection(headers, markers.bot);

  if (cloudflare?.protected === true || botProtection?.detected === true) return null;

  const probe = await probeWithBrowserUserAgent(finalUrl, signal, jar);
  if (!probe?.ok) return null;

  return {
    detected: true,
    evidence: 'browser_user_agent_accepted',
    refusedStatus: status,
    probeStatus: probe.status,
  };
}

function buildResult(requestedUrl, finalUrl, last, redirects, ssrfBlocked, { error = null, clientFiltered = null } = {}) {

  const unmeasured = {
    performance: {
      firstContentfulPaint: null,
      largestContentfulPaint: null,
      cumulativeLayoutShift: null,
      notMeasured: 'uptime-tier check — no browser was used',
    },
    content: { size: null, encodedSize: null, transferSize: null },
    blankPage: { isBlank: null, notMeasured: 'uptime-tier check — no browser was used' },
    brokenResources: null,
    jsErrors: null,
    apiCalls: null,
    host: { speedIndex: null, trustworthy: true, notMeasured: 'uptime-tier check — no browser was used' },
  };

  if (!last) {
    return {
      ...unmeasured,
      httpStatus: { code: null, ok: false, error: error || 'Request failed' },
      headers: null,
      http: null,
      responseTime: emptyTiming(),
      redirect: null,
      finalUrl: requestedUrl,
      cloudflare: { detected: null },
      botProtection: { detected: null },
      clientFiltered: null,
      ssrfBlocked,
      error,
    };
  }

  const headers = Object.fromEntries(last.response.headers.entries());
  const markers = markersFromHtml(last.body);
  const status = last.response.status;
  const { offSite, offSiteHost } = evaluateOffSite(requestedUrl, finalUrl);

  return {
    ...unmeasured,
    httpStatus: {
      code: status,
      ok: status >= 200 && status < 400,
      statusText: last.response.statusText || null,
      ...(error ? { error } : {}),
    },
    headers: collectHeaders(headers),

    http: null,
    responseTime: {
      ...emptyTiming(),
      ttfb: last.ttfb,

      totalSource: null,
    },
    redirect: {
      chain: redirects,
      count: redirects.length,
      finalUrl,
      offSite,
      offSiteHost,
    },
    finalUrl,
    cloudflare: classifyCloudflare(headers, markers.cloudflare, status),
    botProtection: classifyBotProtection(headers, markers.bot),
    clientFiltered,
    ssrfBlocked,
    ...(error ? { error } : {}),
  };
}

function emptyTiming() {
  return {
    total: null,
    totalSource: null,
    dnsLookup: null,
    tcpConnection: null,
    tlsHandshake: null,
    ttfb: null,
    contentDownload: null,
    domParsing: null,
    domContentLoaded: null,
    fullLoad: null,
  };
}

module.exports = {
  checkOverHttp,

  markersFromHtml,
  BODY_SAMPLE_BYTES,
  MAX_REDIRECTS,
  USER_AGENT,
  BROWSER_USER_AGENT,
  CLIENT_REFUSED_STATUSES,
};

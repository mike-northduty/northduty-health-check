async function detectCloudflare(page, response) {
  const headers = response?.headers() || {};
  const status = typeof response?.status === 'function' ? response.status() : null;

  const pageMarkers = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const htmlLower = html.toLowerCase();
    const title = document.title.toLowerCase();

    return {
      jsChallenge:
        html.includes('cf-browser-verification') ||
        html.includes('cf_chl_opt') ||
        html.includes('_cf_chl_tk'),
      titleJustAMoment: title.includes('just a moment'),
      challengePlatform:
        html.includes('/cdn-cgi/challenge-platform/') ||
        html.includes('challenge-platform') ||
        html.includes('cf_chl_'),
      challengeRunning: html.includes('cf-challenge-running'),

      turnstileWidget:
        htmlLower.includes('cf-turnstile') ||
        htmlLower.includes('challenges.cloudflare.com/turnstile'),
      hCaptcha: html.includes('h-captcha'),

      cfErrorCode: html.includes('cf-error-code'),

      titleAccessDenied:
        title.includes('access denied') || title.includes('attention required'),
      checkingBrowser: html.includes('checking your browser'),
      ddosProtection: html.includes('ddos-protection'),
      rayId: (html.match(/Ray ID[:\s]*([a-f0-9]+)/i) || [])[1] || null,
    };
  });

  return classifyCloudflare(headers, pageMarkers, status);
}

function classifyCloudflare(headers, pageMarkers, status = null) {
  const cfRay = getHeader(headers, 'cf-ray');
  const server = getHeader(headers, 'server') || '';
  const isCloudflareServer = server.toLowerCase().includes('cloudflare');
  const hasDefiniteCloudflareSignal = isCloudflareServer || cfRay !== null;
  const statusCode = Number(status);
  const challengeStatus = [403, 429, 503].includes(statusCode);

  const blocked =
    Boolean(pageMarkers.cfErrorCode) ||
    (hasDefiniteCloudflareSignal && challengeStatus && Boolean(pageMarkers.titleAccessDenied));

  const underAttack =
    hasDefiniteCloudflareSignal &&
    (pageMarkers.checkingBrowser || pageMarkers.ddosProtection);

  const captchaChallenge =
    Boolean(pageMarkers.challengeRunning) ||
    (
      hasDefiniteCloudflareSignal &&
      challengeStatus &&
      (Boolean(pageMarkers.turnstileWidget) || Boolean(pageMarkers.hCaptcha))
    );

  const jsChallenge =
    Boolean(pageMarkers.jsChallenge) ||
    (hasDefiniteCloudflareSignal && Boolean(pageMarkers.titleJustAMoment)) ||
    (
      hasDefiniteCloudflareSignal &&
      challengeStatus &&
      Boolean(pageMarkers.challengePlatform) &&
      !blocked
    );

  const isProtected =
    jsChallenge ||
    captchaChallenge ||
    blocked ||
    underAttack;

  return {
    detected: isCloudflareServer || cfRay !== null || isProtected || Boolean(pageMarkers.turnstileWidget),
    protected: isProtected,
    rayId: cfRay || pageMarkers.rayId,
    details: {
      jsChallenge,
      captchaChallenge,
      blocked,
      underAttack,
      turnstileWidget: Boolean(pageMarkers.turnstileWidget),
    },
  };
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const direct = headers[name];
  if (direct !== undefined) return direct;

  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) {
      return value;
    }
  }

  return null;
}

module.exports = {
  detectCloudflare,

  classifyCloudflare,
};

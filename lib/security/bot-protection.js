async function detectBotProtection(page, response) {
  const headers = response?.headers() || {};

  const markers = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    const title = document.title.toLowerCase();

    return {
      dataDomeChallenge: html.includes('captcha-delivery.com'),

      perimeterXChallenge: html.includes('px-captcha') || html.includes('_pxAppId'),

      incapsulaChallenge: html.includes('_Incapsula_Resource'),

      incapsulaBlocked: html.includes('subject=WAF Block Page'),

      akamaiDenied: html.includes('errors.edgesuite.net') && title.includes('access denied'),
    };
  });

  return classifyBotProtection(headers, markers);
}

function classifyBotProtection(headers, markers) {
  const serverHeader = (headers['server'] || '').toLowerCase();

  const vendors = [];

  if (headers['x-datadome'] || serverHeader.includes('datadome') || markers.dataDomeChallenge) {
    vendors.push({
      vendor: 'datadome',
      challenged: Boolean(markers.dataDomeChallenge),
      blocked: false,
    });
  }

  if (markers.perimeterXChallenge) {
    vendors.push({
      vendor: 'perimeterx',
      challenged: true,
      blocked: false,
    });
  }

  if (headers['x-iinfo'] || (headers['x-cdn'] || '').toLowerCase().includes('incapsula')
    || markers.incapsulaChallenge || markers.incapsulaBlocked) {
    vendors.push({
      vendor: 'imperva',
      challenged: Boolean(markers.incapsulaChallenge) && !markers.incapsulaBlocked,
      blocked: Boolean(markers.incapsulaBlocked),
    });
  }

  if (serverHeader.includes('akamaighost') || markers.akamaiDenied) {
    vendors.push({
      vendor: 'akamai',

      challenged: false,
      blocked: Boolean(markers.akamaiDenied),
    });
  }

  return {
    detected: vendors.length > 0,
    vendor: vendors[0]?.vendor || null,
    challenged: vendors.some((entry) => entry.challenged),
    blocked: vendors.some((entry) => entry.blocked),
    vendors: vendors.map((entry) => entry.vendor),
  };
}

module.exports = {
  detectBotProtection,

  classifyBotProtection,
};

const { TIMEOUTS } = require('../constants');

async function checkRobotsTxt(origin) {
  return checkUrl(`${origin}/robots.txt`);
}

async function checkSitemapXml(origin) {
  return checkUrl(`${origin}/sitemap.xml`);
}

async function checkUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUTS.DNS_LOOKUP);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'NorthDuty-Bot/1.0' },
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { checkRobotsTxt, checkSitemapXml };

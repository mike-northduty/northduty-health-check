const net = require('net');
const { URL } = require('url');
const { getDomain } = require('tldts');

function getRegistrableDomain(hostname) {
  const normalized = normalizeHostname(hostname);

  if (!normalized || normalized === 'localhost' || net.isIP(normalized)) {
    return normalized;
  }

  return getDomain(normalized, { allowPrivateDomains: true }) || normalized;
}

function createSiteScope(...urlStrings) {
  const hostnames = new Set();
  const registrableDomains = new Set();

  for (const urlString of urlStrings) {
    const hostname = extractHostname(urlString);
    if (!hostname) {
      continue;
    }

    hostnames.add(hostname);

    const registrableDomain = getRegistrableDomain(hostname);
    if (registrableDomain) {
      registrableDomains.add(registrableDomain);
    }
  }

  return { hostnames, registrableDomains };
}

function isUrlInSiteScope(urlString, siteScope) {
  const hostname = extractHostname(urlString);
  return Boolean(hostname) && isHostnameInSiteScope(hostname, siteScope);
}

function isHostnameInSiteScope(hostname, siteScope) {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    return false;
  }

  if (siteScope.hostnames.has(normalized)) {
    return true;
  }

  const registrableDomain = getRegistrableDomain(normalized);
  return Boolean(registrableDomain) && siteScope.registrableDomains.has(registrableDomain);
}

function extractHostname(urlString) {
  try {
    return normalizeHostname(new URL(urlString).hostname);
  } catch {
    return null;
  }
}

function normalizeHostname(hostname) {
  return hostname ? hostname.toLowerCase().replace(/\.$/, '') : null;
}

module.exports = {
  createSiteScope,
  getRegistrableDomain,
  isUrlInSiteScope,
};

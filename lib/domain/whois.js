const whois = require('whois-json');
const net = require('net');
const { URL } = require('url');
const { getDomain } = require('tldts');
const { TIMEOUTS } = require('../constants');
const { lookupRdap } = require('./rdap');

const WHOIS_CACHE_TTL = 1000 * 60 * 60;
const WHOIS_CACHE_MAX_SIZE = 500;
const whoisCache = new Map();

function buildWhoisCandidates(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');

  if (!normalized || normalized === 'localhost' || net.isIP(normalized)) {
    return [normalized];
  }

  const candidates = [];
  const registrableDomain = getDomain(normalized);
  if (registrableDomain) {
    candidates.push(registrableDomain);
  }

  candidates.push(normalized);

  return [...new Set(candidates)];
}

function parseWhoisDate(dateStr) {
  if (dateStr == null) return null;

  if (Array.isArray(dateStr)) {
    dateStr = dateStr[0];
  }

  if (dateStr == null) return null;
  if (typeof dateStr !== 'string') {
    const date = new Date(dateStr);
    return isNaN(date.getTime()) ? null : date;
  }

  let normalized = dateStr.trim();
  if (!normalized) return null;

  normalized = normalized.replace(/\s*#.*$/, '');
  normalized = normalized.replace(/\s*\((?:UTC|GMT)\)\s*$/i, 'Z');

  if (/^\d{4}\.\d{2}\.\d{2}/.test(normalized)) {
    normalized = normalized.replace(/^(\d{4})\.(\d{2})\.(\d{2})/, '$1-$2-$3');
  }

  normalized = normalized.replace(/\s+UTC\s*$/i, 'Z');

  const date = new Date(normalized);
  return isNaN(date.getTime()) ? null : date;
}

const EXPIRY_FIELD_ALIASES = [
  'expirationDate',
  'registrarRegistrationExpirationDate',
  'registryExpiryDate',
  'registryExpiryDateUtc',
  'expiryDate',
  'domainExpirationDate',

  'expiresOn',
  'expires',
  'expire',
  'expireDate',
  'expirationTime',
  'paidTill',
  'renewalDate',
  'validUntil',
  'recordExpiresOn',
  'registrationExpirationDate',
];

const CREATION_FIELD_ALIASES = [
  'creationDate',
  'createdDate',
  'created',
  'creationTime',
  'domainRegisteredDate',

  'registeredOn',
  'registeredDate',
  'registrationTime',
  'recordCreatedOn',
];

const REGISTRAR_FIELD_ALIASES = [
  'registrar',
  'registrarName',
  'sponsoringRegistrar',
  'registrarOrganization',
];

function matchesExpiry(key) {
  const k = key.toLowerCase();
  return (
    k.includes('expir') ||
    k.includes('paidtill') ||
    k.includes('validuntil') ||
    k.includes('renewal')
  );
}

function matchesCreation(key) {
  const k = key.toLowerCase();

  if (k.startsWith('registrar')) return false;

  if (k.includes('expir')) return false;
  return k.includes('creat') || k.includes('register');
}

function matchesRegistrar(key) {
  const k = key.toLowerCase();

  if (k.includes('expir')) return false;
  return k.startsWith('registrar') || k.includes('sponsoringregistrar');
}

const EXPIRY_FALLBACK_MATCHER = matchesExpiry;
const CREATION_FALLBACK_MATCHER = matchesCreation;
const REGISTRAR_FALLBACK_MATCHER = matchesRegistrar;

function findFieldValue(whoisData, aliases, fallbackMatcher) {
  if (!whoisData || typeof whoisData !== 'object') return null;

  for (const alias of aliases) {
    const value = whoisData[alias];
    if (value != null && value !== '') return value;
  }

  if (typeof fallbackMatcher !== 'function') return null;

  for (const [key, value] of Object.entries(whoisData)) {
    if (value == null || value === '') continue;
    if (fallbackMatcher(key)) return value;
  }

  return null;
}

function daysUntil(date) {
  if (!date) return null;
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

const NULL_EXPIRY_NOTE =
  'Registry did not expose an expiration date; null does not mean the domain is expiring.';

function finalizeDomainResult(result, source) {
  result.source = source;
  if (!result.expirationDate) {
    result.note = NULL_EXPIRY_NOTE;
  }
  return result;
}

async function checkDomain(urlString) {
  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    return { error: 'Invalid URL' };
  }

  const candidates = buildWhoisCandidates(parsedUrl.hostname);
  const primaryDomain = candidates[0];

  if (parsedUrl.hostname === 'localhost' || net.isIP(parsedUrl.hostname)) {
    return {
      name: parsedUrl.hostname,
      note: 'WHOIS is not supported for localhost or IP addresses',
    };
  }

  const deadline = Date.now() + TIMEOUTS.WHOIS_LOOKUP;
  let lastError = null;
  let bestResult = null;

  try {
    for (const candidate of candidates) {
      let remainingTime = deadline - Date.now();
      if (remainingTime <= 0) {
        lastError = 'WHOIS lookup timeout';
        break;
      }

      try {
        const rdapResult = await lookupRdap(
          candidate,
          Math.min(remainingTime, TIMEOUTS.RDAP_LOOKUP)
        );

        if (rdapResult && hasMeaningfulWhoisData(rdapResult)) {
          return finalizeDomainResult(rdapResult, 'rdap');
        }
        if (rdapResult && !bestResult) {
          bestResult = { ...rdapResult, source: 'rdap' };
        }
      } catch (err) {
        lastError = err.message;
      }

      remainingTime = deadline - Date.now();
      if (remainingTime <= 0) {
        lastError = 'WHOIS lookup timeout';
        break;
      }

      try {
        const whoisData = await lookupWhois(candidate, remainingTime);
        const result = buildDomainResult(candidate, whoisData);

        if (hasMeaningfulWhoisData(result)) {
          return finalizeDomainResult(result, 'whois');
        }

        if (!bestResult) {
          bestResult = { ...result, source: 'whois' };
        }
      } catch (err) {
        lastError = err.message;
      }
    }
  } catch (err) {
    lastError = err.message;
  }

  if (lastError) {
    return {
      ...(bestResult || { name: primaryDomain }),
      note: `WHOIS unavailable: ${lastError}`,
    };
  }

  return {
    ...(bestResult || { name: primaryDomain }),
    note: 'Registry returned no usable registration data; null fields are a registry limitation, not a domain problem.',
  };
}

function lookupWhois(domain, timeoutMs) {
  const cached = whoisCache.get(domain);
  if (cached && Date.now() - cached.time < WHOIS_CACHE_TTL) {
    whoisCache.delete(domain);
    whoisCache.set(domain, cached);
    return Promise.resolve(cached.data);
  }

  let timer;
  let timedOut = false;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error('WHOIS lookup timeout'));
    }, timeoutMs);
  });

  const whoisPromise = whois(domain);

  return Promise.race([whoisPromise, timeoutPromise])
    .then((data) => {
      if (whoisCache.size >= WHOIS_CACHE_MAX_SIZE) {
        const oldestKey = whoisCache.keys().next().value;
        whoisCache.delete(oldestKey);
      }
      whoisCache.set(domain, { data, time: Date.now() });
      return data;
    })
    .finally(() => {
      clearTimeout(timer);

      if (timedOut) {
        whoisPromise.catch(() => {});
      }
    });
}

function buildDomainResult(domain, whoisData) {
  const data = whoisData && typeof whoisData === 'object' ? whoisData : {};

  const expirationDate = parseWhoisDate(
    findFieldValue(data, EXPIRY_FIELD_ALIASES, EXPIRY_FALLBACK_MATCHER)
  );

  const creationDate = parseWhoisDate(
    findFieldValue(data, CREATION_FIELD_ALIASES, CREATION_FALLBACK_MATCHER)
  );

  const registrar = findFieldValue(data, REGISTRAR_FIELD_ALIASES, REGISTRAR_FALLBACK_MATCHER);

  return {
    name: domain,
    registrar: registrar || null,
    creationDate: creationDate ? creationDate.toISOString() : null,
    expirationDate: expirationDate ? expirationDate.toISOString() : null,
    daysUntilExpiry: daysUntil(expirationDate),
  };
}

function hasMeaningfulWhoisData(result) {
  return Boolean(result.registrar || result.creationDate || result.expirationDate);
}

module.exports = {
  buildWhoisCandidates,
  checkDomain,
  parseWhoisDate,

  buildDomainResult,
};

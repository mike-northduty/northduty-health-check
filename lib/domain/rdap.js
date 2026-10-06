const { TIMEOUTS } = require('../constants');

const IANA_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_TTL = 1000 * 60 * 60 * 24;
const RDAP_ACCEPT = 'application/rdap+json';

let bootstrapCache = { map: null, time: 0 };

async function fetchJson(url, timeoutMs, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: accept ? { Accept: accept } : undefined,
      redirect: 'follow',
    });
    if (res.status === 404) {
      return { notFound: true };
    }
    if (!res.ok) {
      throw new Error(`RDAP HTTP ${res.status}`);
    }
    const body = await res.json();
    return { body };
  } finally {
    clearTimeout(timer);
  }
}

function parseBootstrap(json) {
  const map = new Map();
  const services = Array.isArray(json?.services) ? json.services : [];
  for (const service of services) {
    const tlds = Array.isArray(service?.[0]) ? service[0] : [];
    const urls = Array.isArray(service?.[1]) ? service[1] : [];
    const httpsUrl =
      urls.find((u) => typeof u === 'string' && u.startsWith('https://')) || null;
    if (!httpsUrl) continue;
    const base = httpsUrl.endsWith('/') ? httpsUrl : `${httpsUrl}/`;
    for (const tld of tlds) {
      if (typeof tld === 'string' && tld) {
        map.set(tld.toLowerCase(), base);
      }
    }
  }
  return map;
}

async function getBootstrapMap(timeoutMs) {
  if (bootstrapCache.map && Date.now() - bootstrapCache.time < BOOTSTRAP_TTL) {
    return bootstrapCache.map;
  }
  const { body } = await fetchJson(IANA_BOOTSTRAP_URL, timeoutMs, 'application/json');
  const map = parseBootstrap(body);

  if (map.size > 0) {
    bootstrapCache = { map, time: Date.now() };
  }
  return map;
}

function tldOf(domain) {
  const parts = String(domain).toLowerCase().replace(/\.$/, '').split('.');
  return parts.length > 1 ? parts[parts.length - 1] : '';
}

async function resolveRdapUrl(domain, timeoutMs) {
  const tld = tldOf(domain);
  if (!tld) return null;
  const map = await getBootstrapMap(timeoutMs);
  const base = map.get(tld);
  if (!base) return null;
  return `${base}domain/${encodeURIComponent(domain)}`;
}

function daysUntil(date) {
  if (!date) return null;
  const diffMs = date.getTime() - Date.now();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

function toDate(value) {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value.trim());
  return isNaN(d.getTime()) ? null : d;
}

function registrarFromEntity(entity) {
  const vcard = entity?.vcardArray;
  if (!Array.isArray(vcard) || !Array.isArray(vcard[1])) return null;
  for (const field of vcard[1]) {
    if (Array.isArray(field) && field[0] === 'fn' && field[3]) {
      return String(field[3]);
    }
  }
  return null;
}

function findRegistrar(entities, depth = 0) {
  if (!Array.isArray(entities) || depth > 2) return null;
  for (const entity of entities) {
    const roles = Array.isArray(entity?.roles) ? entity.roles : [];
    if (roles.includes('registrar')) {
      const name = registrarFromEntity(entity);
      if (name) return name;
    }
  }

  for (const entity of entities) {
    const nested = findRegistrar(entity?.entities, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function buildRdapResult(domain, rdapData) {
  const data = rdapData && typeof rdapData === 'object' ? rdapData : {};
  const events = Array.isArray(data.events) ? data.events : [];

  let expiration = null;
  let creation = null;
  for (const ev of events) {
    if (ev?.eventAction === 'expiration') expiration = toDate(ev.eventDate);
    else if (ev?.eventAction === 'registration') creation = toDate(ev.eventDate);
  }

  const registrar = findRegistrar(data.entities);

  return {
    name: domain,
    registrar: registrar || null,
    creationDate: creation ? creation.toISOString() : null,
    expirationDate: expiration ? expiration.toISOString() : null,
    daysUntilExpiry: daysUntil(expiration),
  };
}

async function lookupRdap(domain, timeoutMs = TIMEOUTS.RDAP_LOOKUP) {
  const deadline = Date.now() + timeoutMs;

  const url = await resolveRdapUrl(domain, deadline - Date.now());
  if (!url) return null;

  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('RDAP lookup timeout');

  const { body, notFound } = await fetchJson(url, remaining, RDAP_ACCEPT);
  if (notFound) return null;

  return buildRdapResult(domain, body);
}

module.exports = {
  lookupRdap,
  buildRdapResult,

  parseBootstrap,
  resolveRdapUrl,
  _setBootstrapCacheForTest(map) {
    bootstrapCache = { map, time: Date.now() };
  },
  _resetBootstrapCacheForTest() {
    bootstrapCache = { map: null, time: 0 };
  },
};

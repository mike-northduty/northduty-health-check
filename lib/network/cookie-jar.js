const { getRegistrableDomain } = require('../site-scope');

function createCookieJar({ now = () => Date.now() } = {}) {
  const cookies = new Map();

  function store(setCookieHeaders, responseUrl) {
    let url;
    try {
      url = new URL(responseUrl);
    } catch {
      return;
    }
    const host = url.hostname.toLowerCase();

    for (const header of setCookieHeaders || []) {
      const cookie = parseSetCookie(header, url, host, now());
      if (!cookie) continue;

      const key = `${cookie.domain}|${cookie.path}|${cookie.name}`;
      if (cookie.expiresAt !== null && cookie.expiresAt <= now()) {
        cookies.delete(key);
      } else {
        cookies.set(key, cookie);
      }
    }
  }

  function headerFor(requestUrl) {
    let url;
    try {
      url = new URL(requestUrl);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    const path = url.pathname || '/';
    const secure = url.protocol === 'https:';
    const t = now();

    const matching = [];
    for (const [key, c] of cookies) {
      if (c.expiresAt !== null && c.expiresAt <= t) {
        cookies.delete(key);
        continue;
      }
      if (c.secure && !secure) continue;
      if (c.hostOnly ? host !== c.domain : !domainMatches(host, c.domain)) continue;
      if (!pathMatches(path, c.path)) continue;
      matching.push(c);
    }
    if (matching.length === 0) return null;

    matching.sort((a, b) => b.path.length - a.path.length);

    return matching.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  return { store, headerFor, size: () => cookies.size };
}

function parseSetCookie(header, url, host, nowMs) {
  const parts = String(header).split(';');
  const pair = parts.shift();
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;

  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!name) return null;

  let domain = null;
  let path = null;
  let secure = false;
  let maxAge = null;
  let expires = null;

  for (const part of parts) {
    const i = part.indexOf('=');
    const attr = (i === -1 ? part : part.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? '' : part.slice(i + 1).trim();

    if (attr === 'domain' && val) {
      domain = val.toLowerCase().replace(/^\./, '');
    } else if (attr === 'path' && val.startsWith('/')) {
      path = val;
    } else if (attr === 'secure') {
      secure = true;
    } else if (attr === 'max-age' && /^-?\d+$/.test(val)) {
      maxAge = Number(val);
    } else if (attr === 'expires' && val) {
      const parsed = Date.parse(val);
      if (!Number.isNaN(parsed)) expires = parsed;
    }
  }

  let hostOnly = true;
  if (domain) {
    if (!domainMatches(host, domain)) return null;
    const registrable = getRegistrableDomain(host);
    if (registrable && domain !== registrable && !domain.endsWith(`.${registrable}`)) return null;
    hostOnly = false;
  } else {
    domain = host;
  }

  let expiresAt = null;
  if (maxAge !== null) {
    expiresAt = maxAge <= 0 ? 0 : nowMs + maxAge * 1000;
  } else if (expires !== null) {
    expiresAt = expires;
  }

  return {
    name,
    value,
    domain,
    hostOnly,
    path: path || defaultPath(url.pathname),
    secure,
    expiresAt,
  };
}

function defaultPath(pathname) {
  if (!pathname || !pathname.startsWith('/')) return '/';
  const last = pathname.lastIndexOf('/');

  return last <= 0 ? '/' : pathname.slice(0, last);
}

function domainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;

  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

module.exports = { createCookieJar };

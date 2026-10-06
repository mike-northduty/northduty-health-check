const net = require('net');
const dns = require('dns').promises;
const { URL } = require('url');

const IPV4_BLOCKED_CIDRS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result * 256) + n;
  }
  return result;
}

function isInCidr(ipInt, baseInt, prefix) {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isPrivateIPv4Int(ipInt) {
  for (const [base, prefix] of IPV4_BLOCKED_CIDRS) {
    const baseInt = ipv4ToInt(base);
    if (baseInt !== null && isInCidr(ipInt, baseInt, prefix)) {
      return true;
    }
  }
  return false;
}

function isPrivateIPv4(ip) {
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;

  return isPrivateIPv4Int(ipInt);
}

function ipv6ToHextets(ip) {
  let addr = ip.toLowerCase().split('%')[0];

  const v4Match = addr.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4Match) {
    const v4Int = ipv4ToInt(v4Match[1]);
    if (v4Int === null) return null;
    const hi = (v4Int >>> 16) & 0xffff;
    const lo = v4Int & 0xffff;
    addr = addr.slice(0, v4Match.index) + hi.toString(16) + ':' + lo.toString(16);
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : null;

  let groups;
  if (tail === null) {
    groups = head;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  }

  if (groups.length !== 8) return null;

  const hextets = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    hextets.push(parseInt(group, 16) & 0xffff);
  }
  return hextets;
}

function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();

  if (normalized === '::' || normalized === '::1') return true;

  const groups = ipv6ToHextets(normalized);
  if (groups) {
    const allZeroPrefix = groups[0] === 0 && groups[1] === 0 && groups[2] === 0
      && groups[3] === 0 && groups[4] === 0;
    const embeddedV4 = (((groups[6] << 16) >>> 0) | groups[7]) >>> 0;

    if (allZeroPrefix && groups[5] === 0xffff) {
      return isPrivateIPv4Int(embeddedV4);
    }

    if (allZeroPrefix && groups[5] === 0 && embeddedV4 !== 0 && embeddedV4 !== 1) {
      return isPrivateIPv4Int(embeddedV4);
    }

    if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0
      && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) {
      return isPrivateIPv4Int(embeddedV4);
    }
  }

  if (/^fe[89ab][0-9a-f]?:/.test(normalized)) return true;

  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;

  if (/^ff[0-9a-f]{2}:/.test(normalized)) return true;

  if (/^2001:db8:/.test(normalized)) return true;

  return false;
}

function isPrivateAddress(ip) {
  if (typeof ip !== 'string') return false;
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return false;
}

let overrideWarningLogged = false;

function isAllowOverrideEnabled() {
  if (process.env.ALLOW_PRIVATE_URLS !== 'true') {
    overrideWarningLogged = false;
    return false;
  }

  if (process.env.NODE_ENV === 'production') {
    if (!overrideWarningLogged) {
      overrideWarningLogged = true;
      console.error(JSON.stringify({
        warning: 'ALLOW_PRIVATE_URLS=true ignored because NODE_ENV=production',
      }));
    }
    return false;
  }

  if (!overrideWarningLogged) {
    overrideWarningLogged = true;
    console.error(JSON.stringify({
      warning: 'SSRF guard disabled via ALLOW_PRIVATE_URLS=true — private and reserved IPs are reachable',
    }));
  }
  return true;
}

async function isUrlAllowed(urlString) {
  if (isAllowOverrideEnabled()) {
    return { allowed: true, override: true };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    return { allowed: false, reason: 'Invalid URL' };
  }

  const hostname = parsedUrl.hostname;

  if (!hostname) {
    return { allowed: false, reason: 'URL has no hostname' };
  }

  const bareHost = hostname.replace(/^\[|\]$/g, '');

  if (bareHost.toLowerCase() === 'localhost') {
    return { allowed: false, reason: 'Blocked hostname: localhost' };
  }

  if (net.isIP(bareHost)) {
    if (isPrivateAddress(bareHost)) {
      return { allowed: false, reason: `Blocked private/reserved IP: ${bareHost}` };
    }
    return { allowed: true, addresses: [bareHost] };
  }

  let resolved;
  try {
    resolved = await dns.lookup(bareHost, { all: true });
  } catch (err) {

    return { allowed: false, dnsError: err.code || err.message, reason: `DNS resolution failed for ${bareHost}: ${err.code || err.message}` };
  }

  for (const { address } of resolved) {
    if (isPrivateAddress(address)) {
      return {
        allowed: false,
        reason: `Blocked private/reserved IP via DNS: ${bareHost} → ${address}`,
        addresses: resolved.map((entry) => entry.address),
      };
    }
  }

  return { allowed: true, addresses: resolved.map((entry) => entry.address) };
}

const HOST_CACHE_TTL_MS = 5000;

async function installSsrfGuard(context, primaryHostname) {
  const blocked = [];

  const allowedHostnameCache = new Map();
  void primaryHostname;

  if (isAllowOverrideEnabled()) {
    return { blocked };
  }

  await context.route('**/*', async (route, request) => {
    let url;
    try {
      url = new URL(request.url());
    } catch {
      await route.continue();
      return;
    }

    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

    const cachedUntil = allowedHostnameCache.get(host);
    if (cachedUntil !== undefined && cachedUntil > Date.now()) {
      await route.continue();
      return;
    }

    const check = await isUrlAllowed(request.url());
    if (!check.allowed) {
      blocked.push({
        url: request.url(),
        reason: check.reason,
        resourceType: request.resourceType(),
        navigation: request.isNavigationRequest(),
      });
      await route.abort('blockedbyclient');
      return;
    }

    allowedHostnameCache.set(host, Date.now() + HOST_CACHE_TTL_MS);
    await route.continue();
  });

  return { blocked };
}

module.exports = {
  isPrivateAddress,
  isUrlAllowed,
  installSsrfGuard,
};

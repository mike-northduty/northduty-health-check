function collectHeaders(headers) {
  const hsts = headers['strict-transport-security'] || null;
  const csp = headers['content-security-policy'] || null;
  const xfo = headers['x-frame-options'] || null;
  const xcto = headers['x-content-type-options'] || null;
  const referrer = headers['referrer-policy'] || null;
  const permissions = headers['permissions-policy'] || null;
  const xPoweredBy = headers['x-powered-by'] || null;
  const server = headers['server'] || null;

  return {

    contentType: headers['content-type'] || null,
    cacheControl: headers['cache-control'] || null,
    server: server,
    contentSecurityPolicy: csp,

    strictTransportSecurity: hsts,
    xFrameOptions: xfo,
    xContentTypeOptions: xcto,
    referrerPolicy: referrer,
    permissionsPolicy: permissions,
    xPoweredBy: xPoweredBy,

    security: scoreSecurityHeaders({ hsts, csp, xfo, xcto, referrer, permissions, xPoweredBy, server }),
  };
}

function scoreSecurityHeaders({ hsts, csp, xfo, xcto, referrer, permissions, xPoweredBy, server }) {
  let score = 0;
  const findings = [];

  if (hsts) {
    score += 20;
  } else {
    findings.push({ header: 'Strict-Transport-Security', issue: 'Missing — browsers will not enforce HTTPS upgrades' });
  }

  if (csp && !isTrivialCsp(csp)) {
    score += 20;
  } else if (csp) {
    score += 10;
    findings.push({ header: 'Content-Security-Policy', issue: 'Present but overly permissive (unsafe-inline + unsafe-eval without nonce/hash)' });
  } else {
    findings.push({ header: 'Content-Security-Policy', issue: 'Missing' });
  }

  const hasFrameAncestors = csp ? /frame-ancestors/i.test(csp) : false;
  if (xfo || hasFrameAncestors) {
    score += 15;
  } else {
    findings.push({ header: 'X-Frame-Options', issue: 'Missing — page may be embeddable in iframes (clickjacking risk)' });
  }

  if (xcto && xcto.toLowerCase().includes('nosniff')) {
    score += 15;
  } else if (xcto) {
    findings.push({ header: 'X-Content-Type-Options', issue: `Value is "${xcto}" instead of "nosniff"` });
  } else {
    findings.push({ header: 'X-Content-Type-Options', issue: 'Missing — MIME-type sniffing attacks possible' });
  }

  if (referrer && referrer.toLowerCase() !== 'unsafe-url') {
    score += 10;
  } else if (!referrer) {
    findings.push({ header: 'Referrer-Policy', issue: 'Missing — browser default may leak full URL to third-party origins' });
  } else {
    findings.push({ header: 'Referrer-Policy', issue: '"unsafe-url" sends full URL including path/query on cross-origin requests' });
  }

  if (permissions) {
    score += 10;
  } else {
    findings.push({ header: 'Permissions-Policy', issue: 'Missing — browser feature access (camera, microphone, geolocation) is unrestricted' });
  }

  const serverExposes = hasVersionDisclosure(server);
  const poweredByExposes = hasVersionDisclosure(xPoweredBy);
  if (!serverExposes && !poweredByExposes) {
    score += 5;
  } else {
    findings.push({
      header: serverExposes ? 'Server' : 'X-Powered-By',
      issue: 'Exposes server version string — helps attackers identify known CVEs',
    });
  }

  if (!csp || !hasMixedContentSource(csp)) {
    score += 5;
  } else {
    findings.push({ header: 'Content-Security-Policy', issue: 'Policy allows http: sources — mixed content possible' });
  }

  return { score: Math.min(100, score), findings };
}

function isTrivialCsp(csp) {
  const lower = csp.toLowerCase();
  if (/default-src\s+['"]?\*['"]?/.test(lower)) return true;
  const hasUnsafeInline = /unsafe-inline/.test(lower);
  const hasUnsafeEval = /unsafe-eval/.test(lower);
  const hasNonceOrHash = /nonce-|'sha\d+-/.test(lower);
  return hasUnsafeInline && hasUnsafeEval && !hasNonceOrHash;
}

function hasVersionDisclosure(headerValue) {
  if (!headerValue) return false;
  return /\/\d+\.\d+/.test(headerValue);
}

function hasMixedContentSource(csp) {

  return /(?:^|[\s;])http:/.test(csp);
}

module.exports = { collectHeaders, scoreSecurityHeaders };

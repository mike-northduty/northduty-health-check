const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { checkOverHttp, markersFromHtml, USER_AGENT } = require('../lib/http-check');

function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function withServer(handler, fn) {
  const { server, base } = await serve(handler);
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('an ordinary 200 reports availability without a browser', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'strict-transport-security': 'max-age=63072000' });
    res.end('<html><body>hello</body></html>');
  }, async (base) => {
    const result = await checkOverHttp(base);

    assert.equal(result.httpStatus.code, 200);
    assert.equal(result.httpStatus.ok, true);
    assert.ok(Number.isFinite(result.responseTime.ttfb));
    assert.ok(result.headers, 'response headers are still collected on this tier');
  });
});

test('rendering-derived fields are null, never zero or empty', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>hello</body></html>');
  }, async (base) => {
    const result = await checkOverHttp(base);

    assert.equal(result.brokenResources, null);
    assert.equal(result.jsErrors, null);
    assert.equal(result.apiCalls, null);
    assert.equal(result.performance.firstContentfulPaint, null);
    assert.equal(result.performance.largestContentfulPaint, null);
    assert.equal(result.performance.cumulativeLayoutShift, null);
    assert.equal(result.blankPage.isBlank, null);
    assert.equal(result.content.size, null);

    assert.equal(result.responseTime.total, null);
    assert.equal(result.responseTime.totalSource, null);
  });
});

test('a 500 is reported as not ok', async () => {
  await withServer((req, res) => {
    res.writeHead(500, { 'content-type': 'text/html' });
    res.end('boom');
  }, async (base) => {
    const result = await checkOverHttp(base);

    assert.equal(result.httpStatus.code, 500);
    assert.equal(result.httpStatus.ok, false);
  });
});

test('redirects are followed and the chain is recorded', async () => {
  await withServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(301, { location: '/final' });
      res.end();

      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>final</body></html>');
  }, async (base) => {
    const result = await checkOverHttp(base, { isAllowed: async () => ({ allowed: true }) });

    assert.equal(result.httpStatus.code, 200);
    assert.equal(result.redirect.count, 1);
    assert.equal(result.redirect.chain[0].status, 301);
    assert.ok(result.finalUrl.endsWith('/final'));

    assert.equal(result.redirect.offSite, false);
  });
});

test('a redirect loop terminates instead of hanging', async () => {
  await withServer((req, res) => {
    res.writeHead(302, { location: '/next' });
    res.end();
  }, async (base) => {
    const result = await checkOverHttp(base, { isAllowed: async () => ({ allowed: true }) });

    assert.match(String(result.httpStatus.error || result.error), /Too many redirects/);
  });
});

test('a hung server is cut off by the timeout rather than holding a worker', async () => {
  await withServer(() => {
  }, async (base) => {
    const startedAt = Date.now();
    const result = await checkOverHttp(base, { timeoutMs: 400 });

    assert.equal(result.httpStatus.ok, false);
    assert.match(String(result.httpStatus.error), /timed out/i);
    assert.ok(Date.now() - startedAt < 5000, 'must not wait beyond its budget');
  });
});

test('it identifies itself so site owners can allowlist the monitor', async () => {
  let seen = null;
  await withServer((req, res) => {
    seen = req.headers['user-agent'];
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('ok');
  }, async (base) => {
    await checkOverHttp(base);
  });

  assert.match(seen, /NorthDuty/);
  assert.match(USER_AGENT, /northduty\.com\/docs\/monitoring-ips/);
});

test('a Cloudflare challenge page is still detected from the raw HTML', async () => {
  await withServer((req, res) => {
    res.writeHead(403, { 'content-type': 'text/html', 'cf-ray': 'abc123', server: 'cloudflare' });
    res.end('<html><head><title>Just a moment...</title></head><body><div class="cf-browser-verification"></div></body></html>');
  }, async (base) => {
    const result = await checkOverHttp(base);

    assert.equal(result.cloudflare.detected, true);
    assert.equal(result.httpStatus.ok, false);
  });
});

test('markersFromHtml recognises the vendor signatures the browser path looks for', () => {
  const cf = markersFromHtml('<html><title>Just a moment...</title><body>cf-browser-verification</body></html>');
  assert.equal(cf.cloudflare.jsChallenge, true);
  assert.equal(cf.cloudflare.titleJustAMoment, true);

  const dd = markersFromHtml('<html><body><script src="https://captcha-delivery.com/x.js"></script></body></html>');
  assert.equal(dd.bot.dataDomeChallenge, true);

  const clean = markersFromHtml('<html><title>Shop</title><body>Welcome</body></html>');
  assert.equal(clean.cloudflare.jsChallenge, false);
  assert.equal(clean.bot.dataDomeChallenge, false);
});

test('a redirect into a blocked address stops the check and is recorded', async () => {
  await withServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();

      return;
    }
    res.writeHead(200);
    res.end('should never be reached');
  }, async (base) => {
    const result = await checkOverHttp(base);

    assert.ok(Array.isArray(result.ssrfBlocked), 'the blocked hop must be recorded');
    assert.match(result.ssrfBlocked[0].url, /169\.254\.169\.254/);
    assert.equal(result.redirect.count, 0, 'the blocked hop is not counted as followed');
  });
});

test('a 403 for the identified UA that serves a plain browser UA is reported as client filtering', async () => {
  await withServer((req, res) => {
    if (/NorthDuty/i.test(req.headers['user-agent'] || '')) {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html><body>Forbidden</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>the real page</body></html>');
  }, async (base) => {
    const result = await checkOverHttp(base);

    assert.equal(result.httpStatus.code, 403);
    assert.equal(result.clientFiltered?.detected, true);
    assert.equal(result.clientFiltered.evidence, 'browser_user_agent_accepted');
    assert.equal(result.clientFiltered.refusedStatus, 403);
    assert.equal(result.clientFiltered.probeStatus, 200);
  });
});

test('a 403 served to everyone stays a plain failure', async () => {
  await withServer((req, res) => {
    res.writeHead(403, { 'content-type': 'text/html' });
    res.end('<html><body>Forbidden</body></html>');
  }, async (base) => {
    const result = await checkOverHttp(base);

    assert.equal(result.httpStatus.code, 403);
    assert.equal(result.clientFiltered, null, 'no evidence of filtering, so none is claimed');
  });
});

test('a recognised vendor challenge is left to the vendor classifier', async () => {
  await withServer((req, res) => {
    res.writeHead(403, { 'content-type': 'text/html', 'cf-ray': '8f2a1b3c4d5e6f70-YYZ', server: 'cloudflare' });
    res.end('<html><head><title>Just a moment...</title></head><body>cf-browser-verification</body></html>');
  }, async (base) => {
    const result = await checkOverHttp(base);

    assert.equal(result.clientFiltered, null, 'vendor signals are classified without a probe');
  });
});

test('a 404 is never probed — a missing page is the site\'s problem, not ours', async () => {
  await withServer((req, res) => {
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<html><body>not found</body></html>');
  }, async (base) => {
    const result = await checkOverHttp(base);

    assert.equal(result.httpStatus.code, 404);
    assert.equal(result.clientFiltered, null);
  });
});

test('a Clerk-style cookie handshake completes instead of looping', async () => {
  const seenCookies = [];
  await withServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seenCookies.push(req.headers.cookie || null);

    if (url.pathname === '/v1/client/handshake') {
      res.writeHead(307, { location: '/shop?__clerk_handshake=token' });
      res.end();

      return;
    }
    if (url.searchParams.has('__clerk_handshake')) {
      res.writeHead(307, {
        location: '/shop',
        'set-cookie': [
          '__client_uat=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
          '__client_uat=0; Path=/; Max-Age=315360000',
          '__clerk_db_jwt=dvb_abc; Path=/; Expires=Wed, 29 Sep 2099 09:09:11 GMT',
        ],
      });
      res.end();

      return;
    }
    if (!/__client_uat=0/.test(req.headers.cookie || '')) {
      res.writeHead(307, { location: '/v1/client/handshake' });
      res.end();

      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>shop</body></html>');
  }, async (base) => {
    const result = await checkOverHttp(`${base}/shop`, { isAllowed: async () => ({ allowed: true }) });

    assert.equal(result.httpStatus.code, 200);
    assert.equal(result.httpStatus.ok, true);
    assert.equal(result.redirect.count, 3);
    assert.ok(result.finalUrl.endsWith('/shop'));
    assert.match(seenCookies.at(-1), /__client_uat=0/);
    assert.match(seenCookies.at(-1), /__clerk_db_jwt=dvb_abc/);
  });
});

test('cookies do not carry over between checks', async () => {
  const seenCookies = [];
  await withServer((req, res) => {
    seenCookies.push(req.headers.cookie || null);
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=1; Path=/' });
    res.end('<html><body>ok</body></html>');
  }, async (base) => {
    await checkOverHttp(base);
    await checkOverHttp(base);

    assert.deepEqual(seenCookies, [null, null]);
  });
});

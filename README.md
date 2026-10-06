# NorthDuty Health Check

The open-source website health-check engine behind [NorthDuty](https://northduty.com).

Point it at a URL and it tells you whether the site is actually working, not just whether the server answered: HTTP status, SSL certificate, DNS, redirects, response timing, Core Web Vitals, JavaScript errors, failed requests, blank pages, and bot-protection challenges. It runs as a command-line tool or as an SQS queue worker.

## Quick start

Requires Node.js 20+.

```bash
git clone https://github.com/mike-northduty/northduty-health-check.git
cd northduty-health-check
npm install
npm run install:browsers   # downloads Chromium for Playwright (once)

node index.js https://example.com            # full check, prints JSON
node index.js https://example.com --uptime   # fast check, no browser
node index.js https://example.com --watch    # re-check every 60 s until Ctrl+C
```

## What it checks

- **HTTP status**: response code, and whether the site redirected somewhere it shouldn't (off-site redirects)
- **SSL certificate**: validity, issuer, expiry date, days until expiry
- **DNS**: whether the hostname resolves, and to which IP
- **Domain expiry**: RDAP/WHOIS lookup of the registration expiry
- **Redirects**: the full chain and the final URL
- **HTTP version**: HTTP/1.1, HTTP/2 or HTTP/3
- **Headers**: content type, caching, server, security headers
- **Timing**: DNS lookup, TCP connect, TLS handshake, time to first byte, full load
- **Core Web Vitals**: FCP, LCP and CLS, measured in a real browser
- **Blank pages**: pages that return 200 but render nothing visible
- **Failed resources**: scripts, styles and images that fail or return 4xx/5xx
- **JavaScript errors**: uncaught page errors and `console.error` output
- **API calls**: every XHR/fetch request the page makes, with status and timing
- **Bot protection**: Cloudflare, Akamai, DataDome, PerimeterX and Imperva challenges, so a challenge page is never reported as a healthy 200
- **Accessibility and SEO basics**: an axe-core audit and on-page SEO checks

## Two tiers: uptime and full

Launching a browser to learn an HTTP status code is expensive. A full render takes 10–20 seconds of CPU and pulls the whole page (often 2–3 MB). Done every minute, that is 1,440 page loads a day per site: enough to trip a site's firewall, and far more compute than the answer needs. So there are two tiers:

| | **uptime** (`--uptime`) | **full** (default) |
|---|---|---|
| Browser | No, one HTTPS request | Yes, Chromium via Playwright |
| Typical cost | ~200–500 ms, mostly waiting on the network | 10–20 s of one CPU core |
| Data pulled from the site | Headers plus the first 64 KB of HTML | The whole page |
| Good for | Frequent checks | Periodic audits, and checks right after a deploy |

**Both tiers** check SSL and DNS. **Uptime** adds the HTTP status, response headers, the redirect chain and off-site detection, TTFB, and Cloudflare/bot-protection classification. The challenge detectors are the same functions the browser uses, fed markers parsed from the raw HTML, so a firewall challenge can't pass as a healthy 200. **Full** adds everything that needs rendering: page load time, FCP, LCP, CLS, blank-page detection, failed resources, JavaScript errors, API calls, content size, HTTP version, accessibility and SEO. It also runs the domain-expiry, robots.txt and sitemap checks. The result's `checksTier` field says which tier ran.

### Absent is not clean

An uptime run reports `null` for everything only a render can produce: load time, paint metrics, blank-page detection, failed resources, JavaScript errors, API calls. It never reports `0` or `[]` for these. If you store results, keep that distinction: "we looked and found nothing" and "we never looked" are different answers, and only `checksTier` tells them apart once a `null` becomes a `0` in a database column.

Likewise, `responseTime.total` (full page load) stays `null` on the uptime tier. Fetching only the HTML doesn't measure a page load.

## Concurrency

After TTFB, a browser check is CPU-bound. Running several renders at once on the same machine doesn't give you several fast checks. It gives you several wrong timings. So each browser check takes a host-wide slot before launching (`lib/host-lock.js`). By default only one browser check renders at a time. If no slot frees up within the wait budget, the check runs anyway and records `host.slotAcquired: false`: a noisy timing is better than a missing check. Uptime checks take no slot.

Page timings are also normalized for the speed of the machine running the check (`lib/page/host-speed.js`). On a host too slow to produce meaningful numbers, the result says so (`host.trustworthy: false`), so those timings can be ignored rather than blamed on the site.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `HEALTH_MAX_CONCURRENT_BROWSERS` | `1` | Browser checks allowed to render at once on this host |
| `HEALTH_LOCK_WAIT_MS` | `90000` | How long a check waits for a browser slot before running anyway |
| `HEALTH_LOCK_DIR` | OS temp dir | Where the slot lock files live |
| `REFERENCE_HOST_SPEED_INDEX` | `7000` | The device reported timings describe (a mid-to-high-end desktop). Higher makes every site look slower |
| `MIN_TRUSTWORTHY_HOST_SPEED_INDEX` | `1200` | Below this, the run's timings describe the worker, not the site, and are flagged |
| `ALLOW_PRIVATE_URLS` | unset | Dev/test only: set to `true` to disable the SSRF guard so private and reserved IPs can be checked. Ignored when `NODE_ENV=production` |

By default the checker refuses to fetch private, loopback, link-local and cloud-metadata addresses, including when a public hostname resolves to one (`lib/network/ssrf.js`).

## Running as a queue worker

`worker.js` long-polls an SQS queue, runs one check per message, and publishes the result to a second queue. A result is always published before the request message is deleted, so a job never disappears silently. Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|---|---|
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | SQS credentials |
| `SQS_ENDPOINT` | Optional, e.g. `http://localhost:4566` for LocalStack |
| `HEALTH_REQUEST_QUEUE_URL`, `HEALTH_RESULT_QUEUE_URL` | Health-check request and result queues |
| `API_MONITOR_REQUEST_QUEUE_URL`, `API_MONITOR_RESULT_QUEUE_URL` | Optional: when both are set, the worker also runs multi-step API monitors |

A request message looks like this (`checks` is `"uptime"` or `"full"`):

```json
{
  "type": "health.check.requested",
  "job_id": "…",
  "trace_id": "…",
  "requested_at": "2026-10-06T12:00:00Z",
  "project_id": 42,
  "monitoring_setting_id": 7,
  "url": "https://example.com",
  "checks": "full"
}
```

```bash
npm run worker
```

Or with Docker (the image is based on the official Playwright image, so Chromium is included):

```bash
docker build -t northduty-health-check .
docker run --env-file .env northduty-health-check
```

## Example output

Abbreviated output of a full check:

```json
{
  "url": "https://example.com",
  "timestamp": "2026-03-11T21:00:00.000Z",
  "checksTier": "full",
  "httpStatus": {
    "code": 200,
    "ok": true,
    "statusText": null
  },
  "ssl": {
    "valid": true,
    "issuer": "DigiCert Inc",
    "validFrom": "Jan 15 00:00:00 2026 GMT",
    "validTo": "Jan 15 23:59:59 2027 GMT",
    "daysUntilExpiry": 310
  },
  "dns": {
    "resolved": true,
    "hostname": "example.com",
    "ip": "93.184.216.34"
  },
  "domain": {
    "name": "example.com",
    "daysUntilExpiry": 154
  },
  "redirect": {
    "count": 0,
    "chain": [],
    "finalUrl": "https://example.com/"
  },
  "http": {
    "version": "h2"
  },
  "headers": {
    "contentType": "text/html; charset=UTF-8",
    "cacheControl": "max-age=604800",
    "server": "ECAcc",
    "contentSecurityPolicy": null
  },
  "responseTime": {
    "total": 1250,
    "dnsLookup": 15,
    "tcpConnection": 45,
    "tlsHandshake": 30,
    "ttfb": 120,
    "contentDownload": 85
  },
  "content": {
    "size": 1256,
    "encodedSize": 648,
    "transferSize": 948
  },
  "performance": {
    "firstContentfulPaint": 450,
    "largestContentfulPaint": 890,
    "cumulativeLayoutShift": 0.02
  },
  "blankPage": {
    "isBlank": false
  },
  "brokenResources": [],
  "cloudflare": {
    "detected": false
  },
  "botProtection": {
    "detected": false,
    "vendor": null,
    "challenged": false,
    "blocked": false,
    "vendors": []
  },
  "jsErrors": [],
  "apiCalls": [
    {
      "url": "https://api.example.com/data",
      "method": "GET",
      "status": 200,
      "ok": true,
      "responseTime": 145
    }
  ]
}
```

[usage.md](usage.md) explains every field: what it means, what to chart over time, and which changes are worth an alert.

## Project structure

```
index.js              Health-check entry point and CLI
worker.js             SQS worker; also starts the API-monitor loop when configured
api-monitor-worker.js API-monitor SQS worker
lib/
  http-check.js       Browserless uptime tier
  browser.js          Playwright browser setup
  host-lock.js        Host-wide cap on concurrent browser checks
  api-monitor.js      Multi-step API monitor runner
  constants.js        Timeouts and limits
  network/            DNS, redirects, timing, headers, HTTP version, robots.txt, SSRF guard
  security/           SSL, Cloudflare and bot-protection detection
  page/               Blank pages, Web Vitals, JS errors, API calls, accessibility, SEO, host speed
  domain/             RDAP and WHOIS domain expiry
test/                 node:test suites
```

## Development

```bash
npm test        # node --test
npm run lint
```

## License

[MIT](LICENSE). Built by [NorthDuty](https://northduty.com), which runs these checks continuously, alongside real-browser journeys through checkout, login and forms.

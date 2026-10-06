# Northduty Health

URL health checker that analyzes websites for HTTP status, SSL certificates, performance metrics, and rendering issues.
The same SQS worker can also run dedicated API monitors when `API_MONITOR_*_QUEUE_URL` is configured.

## Features

- **HTTP Availability** - Response code and status
- **SSL Certificate** - Validity, issuer, expiry date, days until expiration
- **DNS Resolution** - Verifies DNS resolves correctly and captures IP address
- **Domain Expiration** - WHOIS lookup for domain registration expiry
- **Redirect Monitoring** - Tracks redirect chains and final destination URL
- **HTTP Version** - Detects HTTP/1.1, HTTP/2 (h2), HTTP/3 (h3)
- **HTTP Headers** - Critical headers (content-type, cache-control, server, CSP)
- **Response Size** - Content size for detecting broken deploys
- **Network Timing** - DNS lookup, TCP connection, TLS handshake, TTFB, full load time
- **Core Web Vitals** - FCP, LCP, CLS
- **Empty Page Detection** - Detects pages with no visible content
- **Failed Resource Requests** - Failed network requests and 4xx/5xx responses
- **JavaScript Errors** - Page errors and console.error messages
- **Cloudflare Detection** - Identifies Cloudflare protection and challenge pages
- **API Call Tracking** - Captures all XHR/Fetch requests made by the page with status and timing
- **Dedicated API Monitors** - Runs multi-step API checks with method, headers, auth, body, JSONPath assertions, extracted variables, and latency thresholds

## Check tiers — when a browser is launched

There are two tiers. Which one runs is decided by the scheduler in
northduty-back (`HealthCheckSchedulerService`) and arrives on the SQS message as
`checks`; the tier is recorded on every stored run as `checks_tier`.

| | **uptime** | **full** |
|---|---|---|
| Browser | **No** — one HTTPS request | **Yes** — Chromium via Playwright |
| Typical cost | ~200-500 ms, mostly idle I/O | 10-20 s holding a CPU core |
| Traffic pulled from the customer | HTML headers + first 64 KB | The whole page, 2-3 MB |
| How often | Every scheduled check | At most once per hour per site |

### Why the split

Everything a browser adds is a fact about **rendering**. "Is the site up, what
did it answer, is it still on its own domain, is the certificate valid" needs no
rendering at all. Launching Chromium to learn an HTTP status code costs a core
for 10-20 seconds and 1,440 full page loads a day per site at a one-minute
cadence — enough to trip a client's WAF, and enough that the compute bill
exceeds the plan price. See `lib/http-check.js`.

### When the full (browser) tier runs

- The first check of a newly created project — `last_full_audit_queued_at` is
  null, so the first run is always full.
- Once `FULL_AUDIT_INTERVAL` (1 hour) has elapsed since the last full audit for
  that monitoring setting.
- Any forced check: a detected deploy or content change (`DeployTriggerFanout`).
  A deploy is exactly when SSL, redirects, robots.txt and Core Web Vitals are
  most likely to have broken, and the uptime tier sees none of them.
- Any setting whose cadence is an hour or slower gets a full audit every run.

Every other scheduled check runs the uptime tier.

### What each tier measures

Browserless in both tiers (they never needed a browser): **SSL**, **DNS**.
Full tier only, from the preflight: **WHOIS / domain expiry**, **robots.txt**,
**sitemap.xml**.

**uptime** — HTTP status, response headers (so the security-header score is
still produced), redirect chain and off-site detection, TTFB, Cloudflare and
bot-protection classification. The challenge classifiers are the *same*
functions the browser path uses, fed markers parsed from the raw HTML, so a WAF
interstitial cannot be recorded as a healthy 200.

**full** — everything above plus: full page load time, FCP, LCP, CLS,
blank-page detection, failed resource requests, JavaScript errors, XHR/fetch
calls, content size, HTTP protocol version, accessibility audit, SEO.

### Absent is not clean

An uptime run reports `null` — never `0`, never `[]` — for everything only a
render can produce: page load time, the paint metrics, blank-page detection,
broken resources, JS errors, API calls, host speed.

This matters because `broken_resources_count`, `js_errors_count` and
`api_calls_count` are non-nullable integer columns, so an uptime row stores `0`
in all three. `checks_tier` is what tells the difference between "we looked and
found nothing" and "we never looked". Consumers must check it:

- `HealthScoreCalculator` drops performance, stability, errors, accessibility
  and SEO for uptime rows, leaving the overall score resting on uptime alone.
  Security is deliberately kept — response headers are as real over one request
  as inside a browser.
- The front end renders those counts as **"Not measured"**, not a green "None".

TTFB is measured on the uptime tier; `responseTime.total` is not, and stays
null. `total` means full page load everywhere else in this system, and a request
that fetched only the HTML has not measured that.

### Concurrency

A browser check takes a host-wide slot before launching (`lib/host-lock.js`).
`HEALTH_MAX_CONCURRENT_BROWSERS` defaults to **1**: everything after TTFB is
CPU-bound, so overlapping renders do not produce N fast checks, they produce N
wrong ones. If the wait budget (`HEALTH_LOCK_WAIT_MS`, default 90 s) runs out
the check proceeds anyway and records `host.slotAcquired: false` — a missing
check is a hole in the uptime record, which is worse than a noisy timing.

Uptime checks take no slot. They are I/O-bound and do not compete for CPU.

## Installation

```bash
npm install
```

## Usage

```bash
# One-shot check (prints JSON and exits)
node index.js <url>

# Continuous monitoring (re-checks every 60s until SIGINT/SIGTERM)
node index.js <url> --watch
```

### Environment variables

- `ALLOW_PRIVATE_URLS=true` — dev/test only: disables the SSRF guard so private/reserved IPs can be checked. Logs a warning when active and is **ignored when `NODE_ENV=production`**.
- `HEALTH_REQUEST_QUEUE_URL` / `HEALTH_RESULT_QUEUE_URL` — health-check SQS request/result queues.
- `API_MONITOR_REQUEST_QUEUE_URL` / `API_MONITOR_RESULT_QUEUE_URL` — optional API-monitor SQS request/result queues. When both are present, `npm run worker` starts the API monitor loop next to the health loop.
- `HEALTH_MAX_CONCURRENT_BROWSERS` — how many browser checks may render on this host at once. Default `1`. Raise it only on a box with cores to spare; oversubscribing corrupts every page timing it produces.
- `HEALTH_LOCK_WAIT_MS` — how long a check waits for a browser slot before running anyway. Default `90000`.
- `HEALTH_LOCK_DIR` — where the slot locks live. Defaults to a directory under the OS temp dir.
- `REFERENCE_HOST_SPEED_INDEX` — the device our reported page timings are meant to describe, in units of `lib/page/host-speed.js`. Default `7000` (a mid-to-high-end desktop browser). CPU-bound timings are scaled by `hostSpeedIndex / this`. Raising it makes every site look slower; lowering it makes every site look faster.
- `MIN_TRUSTWORTHY_HOST_SPEED_INDEX` — below this the run's page timings describe our worker rather than the site, and are excluded from scoring. Default `1200`.

## Example Output

```json
{
  "url": "https://example.com",
  "timestamp": "2026-03-11T21:00:00.000Z",
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

## Project Structure

```
index.js              # Health-check entry point
worker.js             # Health worker; also starts API monitor loop when configured
api-monitor-worker.js # API monitor SQS worker
lib/
  api-monitor.js      # Multi-step API monitor runner
  browser.js          # Playwright browser setup
  http-check.js       # Browserless uptime check — the no-browser tier
  host-lock.js        # Host-wide cap on concurrent browser checks
  constants.js        # Timeout configuration
  network/
    dns.js            # DNS resolution check
    redirect.js       # Redirect chain tracking
    timing.js         # Response time metrics
    headers.js        # HTTP header collection
    protocol.js       # HTTP version detection
  security/
    ssl.js            # SSL certificate validation
    cloudflare.js     # Cloudflare detection
    bot-protection.js # Akamai / DataDome / PerimeterX / Imperva detection
  page/
    analysis.js       # Blank page & content size
    vitals.js         # Web Vitals (FCP, LCP, CLS)
    errors.js         # JS error tracking
    api-tracker.js    # XHR/Fetch API call tracking
  domain/
    whois.js          # Domain expiration checks
```

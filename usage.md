# Using NorthDuty Health Data in Your Uptime Platform

This guide explains how to integrate NorthDuty Health response data into your uptime monitoring platform, covering which metrics to graph over time and which changes should trigger user notifications.

## Response Structure Overview

Health returns a JSON object containing comprehensive health check data for any URL.

**Available fields:** `url`, `timestamp`, `httpStatus`, `ssl`, `dns`, `domain`, `redirect`, `http`, `headers`, `responseTime`, `content`, `performance`, `blankPage`, `brokenResources`, `cloudflare`, `botProtection`, `jsErrors`, `apiCalls`

---

## What Each Check Means for Business

This section explains each monitored parameter in plain language—what it measures, what happens when it fails, and how it impacts your customers and revenue.

### HTTP Status (`httpStatus`)

**What it is:** The basic response code your website sends when someone visits it (like 200 for "OK" or 500 for "Server Error").

**What happens if it fails:**
- **Visitors see error pages** instead of your website ("This site can't be reached", "500 Internal Server Error")
- **Lost sales and leads** — customers can't browse products, fill out forms, or complete purchases
- **SEO damage** — search engines will lower your rankings if your site shows errors
- **Customers go to competitors** — most people won't wait or retry; they'll find another option

**Common causes:** Server crashes, code bugs after updates, hosting provider issues, exceeded server limits during traffic spikes

---

### SSL Certificate (`ssl`)

**What it is:** The security certificate that enables the padlock icon in browsers and "https://" in your URL.

**What happens if it expires or becomes invalid:**
- **Scary browser warnings** — visitors see a full-screen "Your connection is not private" warning that tells them NOT to proceed
- **Most visitors will leave immediately** — browsers actively discourage them from continuing
- **Payment processing stops** — credit card transactions require valid SSL; no SSL = no sales
- **Contact forms fail** — visitors can't submit inquiries or sign up for newsletters
- **Google will de-rank your site** — SSL is a ranking factor; invalid SSL hurts SEO

**Common causes:** Forgetting to renew the certificate, auto-renewal failure, certificate provider issues, wrong certificate installed after migration

---

### DNS Resolution (`dns`)

**What it is:** The internet's "phone book" that translates your domain name (yourbusiness.com) into the server address where your website lives.

**What happens if it fails:**
- **Your website completely disappears** — typing your URL does nothing; it's as if the site doesn't exist
- **Email stops working too** — most business email relies on the same DNS records
- **Affects ALL visitors worldwide** — this isn't a partial outage; nobody can reach you
- **Can take hours to fix** — DNS changes take time to spread across the internet (propagation)

**Common causes:** Domain expired, accidental DNS record deletion, DNS provider outage, domain hijacking/theft

---

### Domain Expiration (`domain`)

**What it is:** The registration status of your domain name (yourbusiness.com).

**What happens if your domain expires:**
- **Total website outage** — your domain stops resolving; website and email go completely offline
- **Domain grabbers can steal it** — expired domains get snatched quickly by opportunists who resell them at huge markups
- **Business email dies** — no domain = no @yourbusiness.com email
- **Expensive to recover** — buying back an expired domain can cost thousands of dollars
- **Reputation damage** — scammers sometimes buy expired business domains to impersonate the company

**Common causes:** Credit card on file expired, registration emails going to spam, staff changes and forgotten renewals

---

### Redirects (`redirect`)

**What it is:** When visitors are automatically sent from one URL to another (like from http:// to https://, or old pages to new ones).

**What happens if redirects break:**
- **Redirect loops** — visitors get stuck in infinite redirects; browser shows "Too many redirects" error
- **Broken links everywhere** — old bookmarks, Google results, and shared links lead to error pages
- **Slow page loads** — each unnecessary redirect adds 100-500ms delay
- **Lost analytics data** — tracking parameters get dropped during redirect chains
- **SEO problems** — search engines don't like long redirect chains; rankings suffer

**Common causes:** Misconfigured www/non-www settings, HTTP to HTTPS setup errors, conflicting redirect rules, website migration mistakes

---

### Response Time (`responseTime`)

**What it is:** How long visitors wait for your website to load, broken down by stages (DNS, server processing, content download, etc.).

**What happens if it's too slow:**
- **Visitors leave before seeing your site** — 40% of people abandon sites that take over 3 seconds to load
- **Direct revenue loss** — Amazon found every 100ms of delay cost them 1% in sales
- **Mobile users suffer most** — slower connections make delays feel even longer
- **Lower search rankings** — Google uses page speed as a ranking factor
- **Poor brand perception** — slow sites feel unprofessional and untrustworthy

**Key metrics to watch:**
- **TTFB (Time to First Byte)** — how fast your server responds. If slow, your hosting is struggling.
- **DNS Lookup** — if slow, your DNS provider may be the bottleneck
- **Full Load** — total time until everything displays; this is what visitors experience

**Measurement note:** the checker routes every request through its SSRF guard (Playwright request interception), which adds a few milliseconds of overhead per request. Timings are consistent check-to-check, so trends and alert thresholds are unaffected, but absolute values can read slightly higher than an uninstrumented browser.

---

### Web Vitals / Performance (`performance`)

**What it is:** Google's official metrics for measuring real user experience—how fast content appears and how stable the page is.

**What happens if these scores are poor:**
- **Lower Google rankings** — Core Web Vitals are an official SEO ranking factor since 2021
- **Frustrating experience** — page content jumps around (layout shift) causing misclicks
- **Visitors see blank screens too long** — they'll assume the site is broken and leave
- **Lost conversions** — poor UX directly reduces signups, sales, and engagement

**Key metrics:**
- **First Contentful Paint (FCP)** — when visitors first see something (< 1.8s is good)
- **Largest Contentful Paint (LCP)** — when the main content loads (< 2.5s is good)
- **Cumulative Layout Shift (CLS)** — how much the page jumps around (< 0.1 is good)

---

### Blank Page Detection (`blankPage`)

**What it is:** Checks if your website loads but shows a completely empty white page.

**What happens if your page is blank:**
- **Visitors see nothing** — worse than an error page because there's no explanation
- **Higher bounce rates** — people refresh once then leave
- **Complete business interruption** — can't sell, can't capture leads, can't communicate
- **Support overwhelmed** — customers call/email asking "is your site down?"

**Common causes:** JavaScript errors preventing page render, failed build/deployment, database connection lost, hosting configuration issues

---

### Broken Resources (`brokenResources`)

**What it is:** Images, stylesheets, scripts, or fonts that fail to load on your pages.

**What happens with broken resources:**
- **Missing images** — products show placeholder icons; looks unprofessional
- **Broken design** — missing CSS makes site look like it's from 1995
- **Features stop working** — missing JavaScript breaks buttons, forms, shopping carts
- **Text displays wrong** — missing fonts cause ugly text or invisible characters

**Common causes:** Deleted files, changed URLs without redirects, third-party CDN outage, ad blockers blocking legitimate resources

---

### JavaScript Errors (`jsErrors`)

**What it is:** Programming errors in your website's interactive code.

**What happens with JavaScript errors:**
- **Shopping carts break** — "Add to Cart" buttons stop working
- **Forms fail silently** — visitors fill out forms but nothing submits
- **Tracking stops** — analytics and conversion tracking break; you lose data
- **Infinite spinners** — loading animations never complete
- **Mobile-specific failures** — code that works on desktop can crash on phones

**Common causes:** Code bugs in updates, conflicts between scripts, browser compatibility issues, third-party widget failures

---

### API Calls (`apiCalls`)

**What it is:** Requests your website makes to backend services for data (like loading product prices, user accounts, search results).

**What happens if API calls fail:**
- **Search returns no results** — even when products exist
- **Wrong prices displayed** — can cause order cancellations or financial loss
- **Login/account issues** — users can't sign in or see their orders
- **Inventory errors** — showing items as in-stock when they're not
- **Checkout failures** — payment APIs failing = abandoned purchases

**Common causes:** Backend server overload, database problems, third-party service outages, expired API keys

---

### Cloudflare Protection (`cloudflare`)

**What it is:** Detection of Cloudflare security challenge pages that may be blocking legitimate visitors.

**What happens if Cloudflare is blocking visitors:**
- **CAPTCHA walls** — real customers get asked to prove they're human
- **Complete blocks** — some visitors can't access your site at all
- **Mobile users affected** — challenge pages are harder on small screens
- **Geographic blocks** — visitors from certain countries get blocked
- **Bot traffic mixed with real traffic** — legitimate services (like monitoring tools) get blocked

**Common causes:** Security settings too aggressive, DDoS mitigation affecting real users, bot detection false positives

---

### HTTP Version (`http`)

**What it is:** The protocol version used to deliver your website (HTTP/1.1, HTTP/2, or HTTP/3).

**What happens with older HTTP versions:**
- **Slower page loads** — HTTP/2 and HTTP/3 are significantly faster than HTTP/1.1
- **More connections required** — older protocols need more network roundtrips
- **Worse mobile performance** — modern protocols handle spotty connections better

**Why it might downgrade:** Server misconfiguration, CDN issues, SSL certificate problems, load balancer settings

---

### Content Size (`content`)

**What it is:** The size of your webpage in bytes.

**What sudden size changes mean:**
- **Size dropped 50%+** — likely a broken deployment; half your page isn't loading
- **Size doubled unexpectedly** — possible malware injection, accidental file inclusion, or broken build
- **Gradual increase over time** — "page bloat" slowing down your site

---

### Headers (`headers`)

**What it is:** Technical response headers your server sends, including security settings and caching rules.

**Why header changes matter:**
- **Security headers removed** — your site becomes vulnerable to attacks (XSS, clickjacking)
- **Cache settings changed** — visitors might see stale content, or your server gets overloaded
- **Server header changed** — might indicate server migration or unauthorized changes

---

## Graphable Metrics (Time-Series Data)

These numeric values should be stored historically and visualized in graphs to track performance trends.

### Response Time Metrics

All values in **milliseconds (ms)**. Store each check's values to build performance graphs.

| Field | Description | Graph Type | Typical Range |
|-------|-------------|------------|---------------|
| `responseTime.total` | Total page/request load time | Line chart | 100-5000ms |
| `responseTime.ttfb` | Time to First Byte (server response time) | Line chart | 50-500ms |
| `responseTime.dnsLookup` | DNS resolution time | Line chart | 1-100ms |
| `responseTime.tcpConnection` | TCP connection establishment | Line chart | 10-200ms |
| `responseTime.tlsHandshake` | TLS/SSL handshake time | Line chart | 20-300ms |
| `responseTime.contentDownload` | Content transfer time | Line chart | 10-2000ms |
| `responseTime.domParsing` | DOM parsing time | Line chart | 50-1000ms |
| `responseTime.domContentLoaded` | DOMContentLoaded event | Line chart | 200-3000ms |
| `responseTime.fullLoad` | Load event fired | Line chart | 500-10000ms |

**Usage example:**
```javascript
const metrics = healthResult;

// Store for graphing
storeMetric('response_time_total', metrics.responseTime.total);
storeMetric('ttfb', metrics.responseTime.ttfb);
storeMetric('dns_lookup', metrics.responseTime.dnsLookup);
```

### Web Vitals

Core Web Vitals are key user experience metrics defined by Google.

| Field | Description | Good | Needs Improvement | Poor |
|-------|-------------|------|-------------------|------|
| `performance.firstContentfulPaint` | First content rendered (ms) | < 1800 | 1800-3000 | > 3000 |
| `performance.largestContentfulPaint` | Largest content rendered (ms) | < 2500 | 2500-4000 | > 4000 |
| `performance.cumulativeLayoutShift` | Visual stability score (0-1) | < 0.1 | 0.1-0.25 | > 0.25 |

**Usage example:**
```javascript
// Store Web Vitals for performance tracking
if (metrics.performance) {
  storeMetric('fcp', metrics.performance.firstContentfulPaint);
  storeMetric('lcp', metrics.performance.largestContentfulPaint);
  storeMetric('cls', metrics.performance.cumulativeLayoutShift);
}
```

### Content Size Metrics

Track content size to detect broken deployments or bloated pages.

| Field | Description | Unit |
|-------|-------------|------|
| `content.size` | Decoded (uncompressed) body size | bytes |
| `content.encodedSize` | Compressed body size | bytes |
| `content.transferSize` | Total transfer size including headers | bytes |

**Usage example:**
```javascript
// Detect significant size changes (possible broken deploy)
storeMetric('content_size', metrics.content.size);

// Alert if size drops dramatically (e.g., > 50% reduction)
const previousSize = getPreviousMetric('content_size');
if (previousSize && metrics.content.size < previousSize * 0.5) {
  triggerAlert('Content size dropped significantly - possible broken deploy');
}
```

### Expiry Countdowns

Track days until expiry for SSL certificates and domain registration.

| Field | Description | Alert Thresholds |
|-------|-------------|------------------|
| `ssl.daysUntilExpiry` | Days until SSL certificate expires | < 30 warn, < 14 critical |
| `domain.daysUntilExpiry` | Days until domain expires | < 60 warn, < 30 critical |

**Usage example:**
```javascript
// Graph expiry countdown and alert on thresholds
storeMetric('ssl_days_remaining', metrics.ssl.daysUntilExpiry);

if (metrics.ssl.daysUntilExpiry < 14) {
  triggerCriticalAlert(`SSL certificate expires in ${metrics.ssl.daysUntilExpiry} days`);
} else if (metrics.ssl.daysUntilExpiry < 30) {
  triggerWarning(`SSL certificate expires in ${metrics.ssl.daysUntilExpiry} days`);
}
```

### API Calls Response Times

Northduty Health captures all XHR/Fetch API requests made by the page. Each API call's response time can be graphed.

| Field | Description | Graph Type | Typical Range |
|-------|-------------|------------|---------------|
| `apiCalls[].responseTime` | Individual API call response time | Line chart | 50-2000ms |

**Usage example:**
```javascript
// Graph each API endpoint's response time separately
if (result.apiCalls && result.apiCalls.length > 0) {
  for (const call of result.apiCalls) {
    // Create a metric name from the API path
    const apiPath = new URL(call.url).pathname;
    storeMetric(`api_response_time_${apiPath}`, call.responseTime, result.timestamp);
  }
  
  // Or store aggregate stats
  const avgResponseTime = result.apiCalls.reduce((sum, c) => sum + (c.responseTime || 0), 0) / result.apiCalls.length;
  storeMetric('api_calls_avg_response_time', avgResponseTime, result.timestamp);
  storeMetric('api_calls_count', result.apiCalls.length, result.timestamp);
}
```

---

## Alert-Worthy Changes (Notify on Difference)

These values should trigger notifications when they change from the previous check. Store the previous state and compare.

### Critical Alerts (Immediate Notification)

Changes that indicate the site/service is down or severely degraded.

| Field | Trigger Condition | Severity |
|-------|-------------------|----------|
| `httpStatus.ok` | Changes from `true` to `false` | 🔴 Critical |
| `httpStatus.code` | Changes to 4xx or 5xx | 🔴 Critical |
| `ssl.valid` | Changes from `true` to `false` | 🔴 Critical |
| `dns.resolved` | Changes from `true` to `false` | 🔴 Critical |
| `blankPage.isBlank` | Changes from `false` to `true` | 🔴 Critical |

**Usage example:**
```javascript
function checkCriticalChanges(current, previous) {
  const alerts = [];

  // HTTP status degraded
  if (previous.httpStatus.ok && !current.httpStatus.ok) {
    alerts.push({
      severity: 'critical',
      message: `Site down: HTTP ${current.httpStatus.code} (was ${previous.httpStatus.code})`
    });
  }

  // SSL became invalid
  if (previous.ssl.valid && !current.ssl.valid) {
    alerts.push({
      severity: 'critical',
      message: `SSL certificate invalid: ${current.ssl.error || 'Unknown error'}`
    });
  }

  // DNS resolution failed
  if (previous.dns.resolved && !current.dns.resolved) {
    alerts.push({
      severity: 'critical',
      message: `DNS resolution failed: ${current.dns.error}`
    });
  }

  // Page became blank
  if (current.blankPage && previous.blankPage) {
    if (!previous.blankPage.isBlank && current.blankPage.isBlank) {
      alerts.push({
        severity: 'critical',
        message: 'Page is now blank - possible rendering failure or broken deploy'
      });
    }
  }

  return alerts;
}
```

### Warning Alerts (Important Changes)

Changes that may indicate problems or require attention.

| Field | Trigger Condition | Severity |
|-------|-------------------|----------|
| `dns.ip` | IP address changed | 🟡 Warning |
| `redirect.finalUrl` | Final URL changed | 🟡 Warning |
| `redirect.count` | Redirect count increased | 🟡 Warning |
| `http.version` | HTTP version downgraded (h2 → HTTP/1.1) | 🟡 Warning |
| `cloudflare.protected` | Site became Cloudflare-protected | 🟡 Warning |
| `ssl.issuer` | SSL issuer changed | 🟡 Warning |
| `headers.server` | Server header changed | 🟡 Warning |

**Usage example:**
```javascript
function checkWarningChanges(current, previous) {
  const alerts = [];

  // DNS IP changed (possible DNS hijacking or infrastructure change)
  if (previous.dns.ip && current.dns.ip && previous.dns.ip !== current.dns.ip) {
    alerts.push({
      severity: 'warning',
      message: `IP address changed: ${previous.dns.ip} → ${current.dns.ip}`
    });
  }

  // Final URL changed (new redirect)
  if (previous.redirect?.finalUrl !== current.redirect?.finalUrl) {
    alerts.push({
      severity: 'warning',
      message: `Final URL changed: ${previous.redirect?.finalUrl} → ${current.redirect?.finalUrl}`
    });
  }

  // More redirects added
  if (current.redirect?.count > (previous.redirect?.count || 0)) {
    alerts.push({
      severity: 'warning',
      message: `Redirect count increased: ${previous.redirect?.count} → ${current.redirect.count}`
    });
  }

  // HTTP version downgraded
  const httpRank = { 'h3': 3, 'h2': 2, 'HTTP/2': 2, 'HTTP/1.1': 1, 'http/1.1': 1 };
  const prevRank = httpRank[previous.http?.version] || 0;
  const currRank = httpRank[current.http?.version] || 0;
  if (prevRank > currRank && currRank > 0) {
    alerts.push({
      severity: 'warning',
      message: `HTTP version downgraded: ${previous.http.version} → ${current.http.version}`
    });
  }

  // Cloudflare protection changed
  if (current.cloudflare && previous.cloudflare) {
    if (!previous.cloudflare.protected && current.cloudflare.protected) {
      alerts.push({
        severity: 'warning',
        message: 'Site is now showing Cloudflare challenge page'
      });
    }
  }

  return alerts;
}
```

### Informational Alerts (Track Changes)

Changes worth logging but may not require immediate notification.

| Field | Trigger Condition | Action |
|-------|-------------------|--------|
| `brokenResources.length` | New broken resources appeared | Log + optional alert |
| `jsErrors.length` | New JavaScript errors appeared | Log + optional alert |
| `apiCalls[].ok` | API call failed (ok: false) | Log + optional alert |
| `apiCalls[].responseTime` | API call response time (for graphing) | Graph |
| `headers.contentType` | Content type changed | Log |
| `headers.cacheControl` | Cache policy changed | Log |

**Usage example:**
```javascript
function checkInformationalChanges(current, previous) {
  const logs = [];

  // New broken resources
  const prevBroken = previous.brokenResources?.length || 0;
  const currBroken = current.brokenResources?.length || 0;
  if (currBroken > prevBroken) {
    const newResources = current.brokenResources.slice(prevBroken);
    logs.push({
      type: 'broken_resources',
      message: `${currBroken - prevBroken} new broken resource(s)`,
      details: newResources.map(r => `${r.resourceType}: ${r.url} (${r.error || r.status})`)
    });
  }

  // New JS errors
  const prevErrors = previous.jsErrors?.length || 0;
  const currErrors = current.jsErrors?.length || 0;
  if (currErrors > prevErrors) {
    const newErrors = current.jsErrors.slice(prevErrors);
    logs.push({
      type: 'js_errors',
      message: `${currErrors - prevErrors} new JavaScript error(s)`,
      details: newErrors.map(e => e.message)
    });
  }

  // Failed API calls made by the page
  if (current.apiCalls) {
    const failedCalls = current.apiCalls.filter(call => !call.ok);
    if (failedCalls.length > 0) {
      logs.push({
        type: 'failed_api_calls',
        message: `${failedCalls.length} API call(s) failed`,
        details: failedCalls.map(c => `${c.method} ${c.url} - ${c.status || c.error}`)
      });
    }
  }

  return logs;
}
```

### API Calls Made by Page

Track all XHR/Fetch requests the page makes during loading. Useful for monitoring backend API health.

| Field | Description | Use |
|-------|-------------|-----|
| `apiCalls[].url` | API endpoint URL | Identify which APIs are called |
| `apiCalls[].method` | HTTP method (GET, POST, etc.) | Request type |
| `apiCalls[].status` | HTTP status code | Health check |
| `apiCalls[].ok` | true if status 2xx | Alert trigger |
| `apiCalls[].responseTime` | Response time in ms | Graph for trends |

**Usage example:**
```javascript
// Graph API call response times
if (result.apiCalls) {
  for (const call of result.apiCalls) {
    storeMetric(`api_${new URL(call.url).pathname}`, call.responseTime, result.timestamp);
  }
  
  // Alert on failed API calls
  const failed = result.apiCalls.filter(c => !c.ok);
  if (failed.length > 0) {
    triggerWarning(`${failed.length} API calls failed: ${failed.map(c => c.url).join(', ')}`);
  }
}
```

---

## Complete Integration Example

```javascript
class UptimeMonitor {
  constructor(url) {
    this.url = url;
    this.previousResult = null;
  }

  async check() {
    // Run Health check (assumes it's available as a module or subprocess)
    const result = await runHealthCheck(this.url);
    
    // Store graphable metrics
    this.storeMetrics(result);
    
    // Check for alert-worthy changes
    if (this.previousResult) {
      const criticalAlerts = this.checkCriticalChanges(result, this.previousResult);
      const warningAlerts = this.checkWarningChanges(result, this.previousResult);
      const infoLogs = this.checkInformationalChanges(result, this.previousResult);
      
      // Send notifications
      criticalAlerts.forEach(alert => this.notifyImmediate(alert));
      warningAlerts.forEach(alert => this.notifyWarning(alert));
      infoLogs.forEach(log => this.logChange(log));
    }
    
    // Update previous result
    this.previousResult = result;
    
    return result;
  }

  storeMetrics(result) {
    const timestamp = result.timestamp;
    
    // Response times
    if (result.responseTime) {
      this.store('response_time_total', result.responseTime.total, timestamp);
      this.store('ttfb', result.responseTime.ttfb, timestamp);
      this.store('dns_lookup', result.responseTime.dnsLookup, timestamp);
      this.store('tcp_connection', result.responseTime.tcpConnection, timestamp);
      this.store('tls_handshake', result.responseTime.tlsHandshake, timestamp);
    }
    
    // Web Vitals (webpages only)
    if (result.performance) {
      this.store('fcp', result.performance.firstContentfulPaint, timestamp);
      this.store('lcp', result.performance.largestContentfulPaint, timestamp);
      this.store('cls', result.performance.cumulativeLayoutShift, timestamp);
    }
    
    // Content size
    if (result.content) {
      this.store('content_size', result.content.size, timestamp);
    }
    
    // Expiry countdowns
    if (result.ssl?.daysUntilExpiry) {
      this.store('ssl_days_remaining', result.ssl.daysUntilExpiry, timestamp);
    }
    if (result.domain?.daysUntilExpiry) {
      this.store('domain_days_remaining', result.domain.daysUntilExpiry, timestamp);
    }
    
    // API calls made by the page (webpages only)
    if (result.apiCalls && result.apiCalls.length > 0) {
      for (const call of result.apiCalls) {
        const apiPath = new URL(call.url).pathname;
        this.store(`api_${apiPath}_response_time`, call.responseTime, timestamp);
        this.store(`api_${apiPath}_status`, call.status, timestamp);
      }
      this.store('api_calls_count', result.apiCalls.length, timestamp);
    }
  }

  // ... implement checkCriticalChanges, checkWarningChanges, checkInformationalChanges
  // ... as shown in previous examples
}
```

---

## Recommended Thresholds

### Response Time Thresholds

| Metric | Good | Acceptable | Poor |
|--------|------|------------|------|
| Total load time | < 2s | 2-5s | > 5s |
| TTFB | < 200ms | 200-500ms | > 500ms |
| DNS lookup | < 50ms | 50-100ms | > 100ms |

### Expiry Thresholds

| Resource | Warning | Critical |
|----------|---------|----------|
| SSL Certificate | < 30 days | < 14 days |
| Domain Registration | < 60 days | < 30 days |

### Size Change Thresholds

| Change | Action |
|--------|--------|
| > 50% decrease | Critical alert (possible broken deploy) |
| > 100% increase | Warning (possible bloat or attack) |
| < 10% change | Normal variance, no alert |

### API Calls Thresholds

| Condition | Severity | Action |
|-----------|----------|--------|
| Any API call with `ok: false` | 🟡 Warning | Backend API is failing |
| API call `responseTime > 2000ms` | 🟡 Warning | Slow backend performance |
| API call `status: null` with `error` | 🔴 Critical | Network/CORS failure |
| New API endpoint appeared | ℹ️ Info | Track for baseline |

---

## Monitoring Intervals

| URL Type | Recommended Interval | Reasoning |
|----------|---------------------|-----------|
| Production website | 1-5 minutes | Quick detection of outages |
| Staging/dev | 15-30 minutes | Less critical, save resources |
| SSL/Domain expiry | Daily | Slow-changing, expiry alerts matter |

---

## Field Reference

| Field | Description |
|-------|-------------|
| `url` | The checked URL |
| `timestamp` | ISO 8601 timestamp of the check |
| `httpStatus` | code, ok, statusText/error |
| `ssl` | valid, issuer, validFrom, validTo, daysUntilExpiry |
| `dns` | resolved, hostname, ip, error |
| `domain` | name, registrar, expirationDate, daysUntilExpiry |
| `redirect` | count, chain, finalUrl |
| `http` | version (h2, h3, HTTP/1.1) |
| `headers` | contentType, cacheControl, server, contentSecurityPolicy |
| `responseTime` | total, dnsLookup, tcpConnection, tlsHandshake, ttfb, contentDownload, domParsing, domContentLoaded, fullLoad |
| `content` | size, encodedSize, transferSize |
| `performance` | firstContentfulPaint, largestContentfulPaint, cumulativeLayoutShift |
| `blankPage` | isBlank, metrics |
| `brokenResources` | Array of failed resource requests |
| `cloudflare` | detected, protected, rayId, details |
| `botProtection` | detected, vendor, challenged, blocked, vendors (Akamai / DataDome / PerimeterX / Imperva) |
| `jsErrors` | Array of JavaScript errors |
| `apiCalls` | Array of XHR/Fetch requests (url, method, status, ok, responseTime) |

const { TIMEOUTS, LIMITS } = require('./constants');
const { isUrlAllowed } = require('./network/ssrf');

const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD']);
const DEFAULT_STATUS_ASSERTION = { type: 'status_code', operator: 'between', min: 200, max: 299 };

const RETRYABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

function permanentError(message) {
  const error = new Error(message);
  error.permanent = true;
  return error;
}

async function runApiMonitor(request, dependencies = {}) {
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const urlAllowed = dependencies.isUrlAllowed || isUrlAllowed;

  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch API is not available in this runtime.');
  }

  const startedAt = Date.now();
  const totalTimeoutMs = normalizeTimeout(request.timeout_ms);
  const deadline = startedAt + totalTimeoutMs;
  const variables = {
    base_url: request.base_url || '',
  };
  const stepResults = [];

  for (let index = 0; index < request.steps.length; index += 1) {
    if (remainingTime(deadline) <= 0) {
      const timeoutResult = buildTimeoutStepResult(request.steps[index], index, variables, totalTimeoutMs);
      stepResults.push(timeoutResult);

      return {
        status: 'failed',
        duration_ms: Date.now() - startedAt,
        step_results: stepResults,
        error_message: timeoutResult.error_message,
      };
    }

    const step = request.steps[index];
    let result = await runStep(step, index, variables, deadline, totalTimeoutMs, fetchImpl, urlAllowed);

    if (shouldRetryStep(result) && remainingTime(deadline) > 0) {
      result = await runStep(step, index, variables, deadline, totalTimeoutMs, fetchImpl, urlAllowed);
      result.retried = true;
    }

    stepResults.push(result);

    if (result.status !== 'succeeded') {
      return {
        status: 'failed',
        duration_ms: Date.now() - startedAt,
        step_results: stepResults,
        error_message: result.error_message || `API monitor step ${index + 1} failed.`,
      };
    }
  }

  return {
    status: 'succeeded',
    duration_ms: Date.now() - startedAt,
    step_results: stepResults,
    error_message: null,
  };
}

async function runStep(step, index, variables, deadline, totalTimeoutMs, fetchImpl, urlAllowed) {
  const startedAt = Date.now();
  const method = String(step.method || 'GET').toUpperCase();
  const name = String(step.name || `Step ${index + 1}`);
  const result = {
    index,
    name,
    method,
    url: null,
    status: 'failed',
    http_status: null,
    duration_ms: null,
    assertions: [],
    extracted: [],
    error_message: null,
  };

  try {
    const url = renderTemplate(String(step.url || ''), variables);
    result.url = url;

    const headers = buildHeaders(step, variables);
    const body = buildBody(step, method, headers, variables);
    const requestTimeoutMs = Math.min(TIMEOUTS.API_MONITOR_STEP, remainingTime(deadline));
    if (requestTimeoutMs <= 0) {
      throw permanentError(`API monitor timed out after ${totalTimeoutMs}ms.`);
    }

    const response = await fetchFollowingRedirects(fetchImpl, urlAllowed, url, {
      method,
      headers,
      body,
    }, requestTimeoutMs);

    const text = await withTimeout(
      response.text(),
      remainingTime(deadline),
      `API monitor timed out after ${totalTimeoutMs}ms.`,
    );
    const durationMs = Date.now() - startedAt;
    const json = parseJsonResponse(text, response.headers.get('content-type'));
    const assertions = buildAssertions(step);
    const assertionResults = assertions.map((assertion) => evaluateAssertion(assertion, {
      response,
      body: text,
      json,
      durationMs,
    }));

    result.http_status = response.status;
    result.duration_ms = durationMs;
    result.assertions = assertionResults;
    result.response_preview = truncate(text, LIMITS.MAX_LOG_VALUE_LENGTH);

    const failedAssertion = assertionResults.find((assertion) => assertion.passed !== true);
    if (failedAssertion) {
      result.error_message = failedAssertion.message;
      return result;
    }

    const extracted = extractVariables(step.extract, json, variables);
    result.extracted = extracted;
    result.status = 'succeeded';
    return result;
  } catch (error) {
    result.duration_ms = Date.now() - startedAt;
    result.error_message = error.message || 'API monitor step failed.';

    result.network_error = error.permanent !== true && result.http_status === null;
    return result;
  }
}

function shouldRetryStep(result) {
  return (
    result.status !== 'succeeded' &&
    result.network_error === true &&
    RETRYABLE_METHODS.has(result.method)
  );
}

function buildTimeoutStepResult(step, index, variables, totalTimeoutMs) {
  let url = null;
  try {
    url = renderTemplate(String(step?.url || ''), variables);
  } catch {}

  return {
    index,
    name: String(step?.name || `Step ${index + 1}`),
    method: String(step?.method || 'GET').toUpperCase(),
    url,
    status: 'failed',
    http_status: null,
    duration_ms: null,
    assertions: [],
    extracted: [],
    error_message: `API monitor timed out after ${totalTimeoutMs}ms.`,
  };
}

function normalizeTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return TIMEOUTS.API_MONITOR_STEP;
  }

  return Math.min(Math.max(Math.round(parsed), 1000), TIMEOUTS.API_MONITOR_TOTAL);
}

function buildHeaders(step, variables) {
  const headers = {};
  for (const [key, value] of Object.entries(step.headers || {})) {
    headers[key] = renderTemplate(String(value), variables);
  }

  const auth = step.auth && typeof step.auth === 'object' ? step.auth : null;
  if (!auth || auth.type === 'none') {
    return headers;
  }

  if (auth.type === 'bearer' && auth.token) {
    headers.Authorization = `Bearer ${renderTemplate(String(auth.token), variables)}`;
  }

  if (auth.type === 'basic') {
    const username = renderTemplate(String(auth.username || ''), variables);
    const password = renderTemplate(String(auth.password || ''), variables);
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }

  if (auth.type === 'api_key') {
    const headerName = String(auth.header_name || auth.headerName || '').trim();
    if (headerName) {
      headers[headerName] = renderTemplate(String(auth.value || ''), variables);
    }
  }

  return headers;
}

function buildBody(step, method, headers, variables) {
  if (METHODS_WITHOUT_BODY.has(method) || !Object.prototype.hasOwnProperty.call(step, 'body')) {
    return undefined;
  }

  if (typeof step.body === 'string') {
    return renderTemplate(step.body, variables);
  }

  const rendered = renderValue(step.body, variables);
  if (!hasHeader(headers, 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  return JSON.stringify(rendered);
}

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function fetchFollowingRedirects(fetchImpl, urlAllowed, initialUrl, options, timeoutMs) {
  let currentUrl = initialUrl;
  let method = String(options.method || 'GET').toUpperCase();
  let headers = { ...options.headers };
  let body = options.body;
  const deadline = Date.now() + timeoutMs;

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const parsed = new URL(currentUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw permanentError('Only http(s) URLs are supported.');
    }

    const ssrf = await urlAllowed(currentUrl);
    if (!ssrf.allowed) {
      throw permanentError(ssrf.reason || 'URL blocked by SSRF guard.');
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`API request timed out after ${timeoutMs}ms.`);
    }

    const response = await fetchWithTimeout(fetchImpl, currentUrl, {
      method,
      headers,
      body,
      redirect: 'manual',
    }, remaining);

    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      return response;
    }

    if (redirects === MAX_REDIRECTS) {
      throw permanentError(`Too many redirects (>${MAX_REDIRECTS}).`);
    }

    const nextUrl = new URL(location, currentUrl);

    if (response.status === 303 || ((response.status === 301 || response.status === 302) && !METHODS_WITHOUT_BODY.has(method))) {
      method = 'GET';
      body = undefined;
      headers = stripHeader(stripHeader(headers, 'content-type'), 'content-length');
    }

    if (nextUrl.origin !== parsed.origin) {
      headers = stripHeader(headers, 'authorization');
    }

    currentUrl = nextUrl.toString();
  }

  throw permanentError(`Too many redirects (>${MAX_REDIRECTS}).`);
}

function stripHeader(headers, name) {
  const lowerName = name.toLowerCase();
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== lowerName),
  );
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`API request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout(promise, timeoutMs, message) {
  if (timeoutMs <= 0) {
    throw new Error(message);
  }

  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function remainingTime(deadline) {
  return deadline - Date.now();
}

function buildAssertions(step) {
  const assertions = Array.isArray(step.assertions) ? [...step.assertions] : [];
  const hasStatusAssertion = assertions.some((assertion) => assertion?.type === 'status_code');

  if (!hasStatusAssertion) {
    assertions.unshift(DEFAULT_STATUS_ASSERTION);
  }

  if (step.latency_threshold_ms) {
    assertions.push({
      type: 'response_time',
      operator: 'less_than_or_equal',
      expected: Number(step.latency_threshold_ms),
    });
  }

  return assertions;
}

function evaluateAssertion(assertion, context) {
  const type = assertion?.type;

  try {
    if (type === 'status_code') {
      const actual = context.response.status;
      const operator = assertion.operator || 'equals';
      const expected = assertion.expected ?? assertion.value ?? 200;
      const passed = compare(actual, operator, expected, assertion);
      return assertionResult(type, passed, actual, expected, operator);
    }

    if (type === 'json_path') {
      const actual = evaluateJsonPath(context.json, String(assertion.path || ''));
      const operator = assertion.operator || (Object.prototype.hasOwnProperty.call(assertion, 'expected') ? 'equals' : 'exists');
      const expected = assertion.expected ?? assertion.value ?? true;
      const passed = compare(actual, operator, expected, assertion);
      return assertionResult(type, passed, actual, expected, operator, assertion.path);
    }

    if (type === 'header') {
      const headerName = String(assertion.name || '').toLowerCase();
      const actual = context.response.headers.get(headerName);
      const operator = assertion.operator || (Object.prototype.hasOwnProperty.call(assertion, 'expected') ? 'equals' : 'exists');
      const expected = assertion.expected ?? assertion.value ?? true;
      const passed = compare(actual, operator, expected, assertion);
      return assertionResult(type, passed, actual, expected, operator, assertion.name);
    }

    if (type === 'body_contains') {
      const raw = assertion.expected ?? assertion.value;
      const expected = raw === undefined || raw === null ? '' : String(raw);
      const actual = context.body;
      if (expected === '') {
        return {
          type,
          target: null,
          operator: 'contains',
          expected,
          actual: truncate(actual, 240),
          passed: false,
          message: 'body_contains assertion requires a non-empty expected value.',
        };
      }
      const passed = actual.includes(expected);
      return assertionResult(type, passed, truncate(actual, 240), expected, 'contains');
    }

    if (type === 'response_time') {
      const actual = context.durationMs;
      const expected = Number(assertion.expected ?? assertion.value ?? assertion.max_ms);
      const operator = assertion.operator || 'less_than_or_equal';
      const passed = compare(actual, operator, expected, assertion);
      return assertionResult(type, passed, actual, expected, operator);
    }

    return {
      type: String(type || 'unknown'),
      passed: false,
      message: `Unsupported assertion type "${type || 'unknown'}".`,
    };
  } catch (error) {
    return {
      type: String(type || 'unknown'),
      passed: false,
      message: error.message || 'Assertion failed.',
    };
  }
}

function assertionResult(type, passed, actual, expected, operator, target = null) {
  return {
    type,
    target,
    operator,
    expected: compactAssertionValue(expected),
    actual: compactAssertionValue(actual),
    passed,
    message: passed ? null : `${type} assertion failed: expected ${formatAssertionValue(actual)} to be ${operator} ${formatAssertionValue(expected)}.`,
  };
}

function compare(actual, operator, expected, assertion = {}) {
  switch (operator) {
    case 'equals':
      return looseEqual(actual, expected);
    case 'not_equals':
      return !looseEqual(actual, expected);
    case 'exists':

      if (Array.isArray(actual)) return actual.length > 0;
      return actual !== undefined && actual !== null;
    case 'not_exists':
      if (Array.isArray(actual)) return actual.length === 0;
      return actual === undefined || actual === null;
    case 'contains':

      if (Array.isArray(actual)) return actual.some((entry) => looseEqual(entry, expected));
      return String(actual ?? '').includes(String(expected ?? ''));
    case 'greater_than':
      return Number(actual) > Number(expected);
    case 'greater_than_or_equal':
      return Number(actual) >= Number(expected);
    case 'less_than':
      return Number(actual) < Number(expected);
    case 'less_than_or_equal':
      return Number(actual) <= Number(expected);
    case 'between':
      return Number(actual) >= Number(assertion.min) && Number(actual) <= Number(assertion.max);
    case 'in':
      return Array.isArray(expected) && expected.some((entry) => looseEqual(entry, actual));
    default:
      return false;
  }
}

function isScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function looseEqual(left, right) {
  if (deepEqual(left, right)) {
    return true;
  }

  if (left === undefined || right === undefined) {
    return false;
  }

  if (isScalar(left) && isScalar(right)) {
    return String(left) === String(right);
  }

  return false;
}

function extractVariables(extract, json, variables) {
  if (!extract || typeof extract !== 'object' || Array.isArray(extract)) {
    return [];
  }

  const names = [];
  for (const [name, path] of Object.entries(extract)) {
    const value = evaluateJsonPath(json, String(path));
    if (value === undefined || value === null) {
      throw new Error(`Unable to extract "${name}" from ${path}.`);
    }

    variables[name] = typeof value === 'string' ? value : JSON.stringify(value);
    names.push(name);
  }

  return names;
}

function parseJsonResponse(body, contentType) {
  const trimmed = body.trim();
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');

  if (!looksJson && !String(contentType || '').includes('json')) {
    return null;
  }

  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function evaluateJsonPath(json, path) {
  if (json === null || json === undefined || typeof path !== 'string' || path.trim() === '') {
    return undefined;
  }

  const tokens = tokenizeJsonPath(path.trim());
  let value = json;

  for (const token of tokens) {
    if (value === null || value === undefined) {
      return undefined;
    }

    if (token === '*') {
      if (!Array.isArray(value)) {
        return undefined;
      }
      value = value.flatMap((entry) => Array.isArray(entry) ? entry : [entry]);
      continue;
    }

    if (Array.isArray(value) && typeof token === 'number') {
      value = value[token];
      continue;
    }

    if (Array.isArray(value)) {
      value = value.map((entry) => entry?.[token]).filter((entry) => entry !== undefined);
      continue;
    }

    value = value[token];
  }

  return value;
}

function tokenizeJsonPath(path) {
  if (path === '$') {
    return [];
  }

  if (!path.startsWith('$.') && !path.startsWith('$[')) {
    throw new Error('JSONPath must start with $.');
  }

  const tokens = [];

  const pattern = /\.([A-Za-z_][A-Za-z0-9_-]*)|\.(\d+)|\[['"]([^'"]+)['"]\]|\[(\d+)\]|\[\*\]/g;
  let cursor = 1;
  let match;

  while ((match = pattern.exec(path)) !== null) {
    if (match.index !== cursor) {
      throw new Error(`Unsupported JSONPath segment near "${path.slice(cursor)}".`);
    }

    if (match[1]) tokens.push(match[1]);
    else if (match[2]) tokens.push(Number(match[2]));
    else if (match[3]) tokens.push(match[3]);
    else if (match[4]) tokens.push(Number(match[4]));
    else tokens.push('*');

    cursor = pattern.lastIndex;
  }

  if (cursor !== path.length) {
    throw new Error(`Unsupported JSONPath segment near "${path.slice(cursor)}".`);
  }

  return tokens;
}

function renderValue(value, variables) {
  if (typeof value === 'string') {
    return renderTemplate(value, variables);
  }

  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, variables));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, renderValue(entry, variables)]));
  }

  return value;
}

function renderTemplate(value, variables) {
  return value.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, key) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) {
      throw new Error(`Variable "${key}" is not available.`);
    }

    return variables[key];
  });
}

function hasHeader(headers, name) {
  const lowerName = name.toLowerCase();
  return Object.keys(headers).some((header) => header.toLowerCase() === lowerName);
}

function compactAssertionValue(value) {
  if (typeof value === 'string') {
    return truncate(value, 240);
  }

  if (value === undefined) {
    return null;
  }

  return value;
}

function formatAssertionValue(value) {
  if (typeof value === 'string') return `"${truncate(value, 80)}"`;
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}

function truncate(value, maxLength) {
  const stringValue = String(value || '');
  if (stringValue.length <= maxLength) {
    return stringValue;
  }

  return `${stringValue.slice(0, maxLength)}...[truncated ${stringValue.length - maxLength} chars]`;
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

module.exports = {
  evaluateJsonPath,
  renderTemplate,
  runApiMonitor,
};

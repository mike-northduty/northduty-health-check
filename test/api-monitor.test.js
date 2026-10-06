const assert = require('node:assert/strict');
const test = require('node:test');

const { runApiMonitor, evaluateJsonPath, renderTemplate } = require('../lib/api-monitor');
const { LIMITS } = require('../lib/constants');
const { processMessage, serializeResultMessage } = require('../api-monitor-worker');

const allowUrl = async () => ({ allowed: true });

test('runApiMonitor executes chained variables, auth, JSONPath assertions and latency thresholds', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });

    if (url === 'https://api.example.com/login') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { email: 'ops@example.com' });
      return new Response(JSON.stringify({
        token: 'secret-token',
        user: { id: 42 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url === 'https://api.example.com/users/42') {
      assert.equal(options.headers.Authorization, 'Bearer secret-token');
      return new Response(JSON.stringify({
        ok: true,
        users: [{ id: 42, name: 'Ops' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  };

  const result = await runApiMonitor({
      timeout_ms: 5000,
      base_url: 'https://api.example.com',
      steps: [
        {
          name: 'Login',
          method: 'POST',
          url: '{{base_url}}/login',
          headers: { 'Content-Type': 'application/json' },
          body: { email: 'ops@example.com' },
          assertions: [
            { type: 'status_code', operator: 'equals', expected: 200 },
            { type: 'json_path', path: '$.token', operator: 'exists' },
          ],
          extract: {
            token: '$.token',
            user_id: '$.user.id',
          },
        },
        {
          name: 'Fetch user',
          method: 'GET',
          url: '{{base_url}}/users/{{user_id}}',
          auth: { type: 'bearer', token: '{{token}}' },
          latency_threshold_ms: 5000,
          assertions: [
            { type: 'json_path', path: '$.ok', operator: 'equals', expected: true },
            { type: 'json_path', path: '$.users[*].id', operator: 'contains', expected: '42' },
          ],
        },
      ],
    }, { fetch, isUrlAllowed: allowUrl });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.step_results.length, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(result.step_results[0].extracted, ['token', 'user_id']);
  assert.equal(result.step_results[1].http_status, 200);
  assert.equal(result.step_results[1].assertions.every((assertion) => assertion.passed), true);
});

test('runApiMonitor returns failed when an assertion fails', async () => {
  const fetch = async () => new Response(JSON.stringify({ ok: false }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });

  const result = await runApiMonitor({
      timeout_ms: 5000,
      base_url: 'https://api.example.com',
      steps: [
        {
          method: 'GET',
          url: '{{base_url}}/users/42',
          assertions: [
            { type: 'status_code', operator: 'equals', expected: 200 },
          ],
        },
      ],
    }, { fetch, isUrlAllowed: allowUrl });

  assert.equal(result.status, 'failed');
  assert.match(result.error_message, /status_code assertion failed/);
  assert.equal(result.step_results[0].http_status, 401);
});

test('runApiMonitor retries a GET step once after a transient network failure', async () => {
  let attempts = 0;
  const fetch = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new TypeError('fetch failed');
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await runApiMonitor({
      timeout_ms: 5000,
      base_url: 'https://api.example.com',
      steps: [
        { method: 'GET', url: '{{base_url}}/health' },
      ],
    }, { fetch, isUrlAllowed: allowUrl });

  assert.equal(result.status, 'succeeded');
  assert.equal(attempts, 2);
  assert.equal(result.step_results[0].retried, true);
  assert.equal(result.step_results[0].status, 'succeeded');
});

test('runApiMonitor does not retry POST steps after a network failure', async () => {
  let attempts = 0;
  const fetch = async () => {
    attempts += 1;
    throw new TypeError('fetch failed');
  };

  const result = await runApiMonitor({
      timeout_ms: 5000,
      base_url: 'https://api.example.com',
      steps: [
        { method: 'POST', url: '{{base_url}}/orders', body: { sku: 'x' } },
      ],
    }, { fetch, isUrlAllowed: allowUrl });

  assert.equal(result.status, 'failed');
  assert.equal(attempts, 1, 'A POST may have executed server-side — it must not be re-sent.');
});

test('runApiMonitor does not retry assertion failures', async () => {
  let attempts = 0;
  const fetch = async () => {
    attempts += 1;
    return new Response(JSON.stringify({ ok: false }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  };

  const result = await runApiMonitor({
      timeout_ms: 5000,
      base_url: 'https://api.example.com',
      steps: [
        { method: 'GET', url: '{{base_url}}/health' },
      ],
    }, { fetch, isUrlAllowed: allowUrl });

  assert.equal(result.status, 'failed');
  assert.equal(attempts, 1, 'An HTTP response arrived — the failure is real, not a network blip.');
});

test('runApiMonitor does not retry SSRF-blocked steps', async () => {
  let attempts = 0;
  const fetch = async () => {
    attempts += 1;
    return new Response('{}', { status: 200 });
  };
  const blockUrl = async () => ({ allowed: false, reason: 'Blocked private/reserved IP: 10.0.0.1' });

  const result = await runApiMonitor({
      timeout_ms: 5000,
      base_url: 'https://api.example.com',
      steps: [
        { method: 'GET', url: '{{base_url}}/health' },
      ],
    }, { fetch, isUrlAllowed: blockUrl });

  assert.equal(result.status, 'failed');
  assert.equal(attempts, 0);
  assert.match(result.error_message, /Blocked private/);
});

const jsonResponse = (payload, status = 200) => async () => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' },
});
const findAssertion = (result, type) => result.step_results[0].assertions.find((a) => a.type === type);

test('body_contains with an empty/missing expected fails instead of silently passing', async () => {
  const result = await runApiMonitor({
    timeout_ms: 5000,
    base_url: 'https://api.example.com',
    steps: [{
      method: 'GET',
      url: '{{base_url}}/health',
      assertions: [
        { type: 'status_code', operator: 'equals', expected: 200 },
        { type: 'body_contains' },
      ],
    }],
  }, { fetch: async () => new Response('OUTAGE', { status: 200, headers: { 'content-type': 'text/plain' } }), isUrlAllowed: allowUrl });

  assert.equal(result.status, 'failed');
  assert.equal(findAssertion(result, 'body_contains').passed, false);
});

test('json_path exists fails when an array projection matched nothing', async () => {
  const matched = await runApiMonitor({
    timeout_ms: 5000,
    base_url: 'https://api.example.com',
    steps: [{ method: 'GET', url: '{{base_url}}/users', assertions: [{ type: 'json_path', path: '$.users[*].id', operator: 'exists' }] }],
  }, { fetch: jsonResponse({ users: [{ id: 7 }] }), isUrlAllowed: allowUrl });
  assert.equal(matched.status, 'succeeded');

  const empty = await runApiMonitor({
    timeout_ms: 5000,
    base_url: 'https://api.example.com',
    steps: [{ method: 'GET', url: '{{base_url}}/users', assertions: [{ type: 'json_path', path: '$.users[*].id', operator: 'exists' }] }],
  }, { fetch: jsonResponse({ users: [] }), isUrlAllowed: allowUrl });
  assert.equal(empty.status, 'failed');
  assert.equal(findAssertion(empty, 'json_path').passed, false);
});

test('contains against an array checks membership, not a stringified substring', async () => {
  const result = await runApiMonitor({
    timeout_ms: 5000,
    base_url: 'https://api.example.com',
    steps: [{ method: 'GET', url: '{{base_url}}/ids', assertions: [{ type: 'json_path', path: '$.ids', operator: 'contains', expected: '42' }] }],
  }, { fetch: jsonResponse({ ids: [1, 2, 342] }), isUrlAllowed: allowUrl });

  assert.equal(result.status, 'failed');
  assert.equal(findAssertion(result, 'json_path').passed, false);

  const present = await runApiMonitor({
    timeout_ms: 5000,
    base_url: 'https://api.example.com',
    steps: [{ method: 'GET', url: '{{base_url}}/ids', assertions: [{ type: 'json_path', path: '$.ids', operator: 'contains', expected: 42 }] }],
  }, { fetch: jsonResponse({ ids: [1, 2, 42] }), isUrlAllowed: allowUrl });
  assert.equal(present.status, 'succeeded');
});

test('equals tolerates JSON type drift (numeric status vs string expected)', async () => {
  const result = await runApiMonitor({
    timeout_ms: 5000,
    base_url: 'https://api.example.com',
    steps: [{ method: 'GET', url: '{{base_url}}/health', assertions: [{ type: 'status_code', operator: 'equals', expected: '200' }] }],
  }, { fetch: async () => new Response('ok', { status: 200 }), isUrlAllowed: allowUrl });

  assert.equal(result.status, 'succeeded');

  const missing = await runApiMonitor({
    timeout_ms: 5000,
    base_url: 'https://api.example.com',
    steps: [{ method: 'GET', url: '{{base_url}}/health', assertions: [{ type: 'json_path', path: '$.absent', operator: 'equals', expected: '200' }] }],
  }, { fetch: jsonResponse({ ok: true }), isUrlAllowed: allowUrl });
  assert.equal(missing.status, 'failed');
});

test('runApiMonitor re-applies the SSRF guard to redirect targets', async () => {
  const checked = [];
  const isUrlAllowed = async (url) => {
    checked.push(url);
    if (new URL(url).hostname === '169.254.169.254') {
      return { allowed: false, reason: 'Blocked private/reserved IP: 169.254.169.254' };
    }
    return { allowed: true };
  };

  const fetch = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (url === 'https://api.example.com/start') {
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    }
    throw new Error(`Unexpected fetch to internal host: ${url}`);
  };

  const result = await runApiMonitor({
    timeout_ms: 5000,
    base_url: 'https://api.example.com',
    steps: [{ method: 'GET', url: '{{base_url}}/start' }],
  }, { fetch, isUrlAllowed });

  assert.equal(result.status, 'failed');
  assert.match(result.error_message, /Blocked private\/reserved IP/);
  assert.deepEqual(checked, ['https://api.example.com/start', 'http://169.254.169.254/latest/meta-data']);
});

test('runApiMonitor follows allowed redirects and asserts on the final response', async () => {
  const fetch = async (url) => {
    if (url === 'https://api.example.com/start') {
      return new Response(null, { status: 302, headers: { location: 'https://api.example.com/final' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const result = await runApiMonitor({
    timeout_ms: 5000,
    base_url: 'https://api.example.com',
    steps: [{ method: 'GET', url: '{{base_url}}/start', assertions: [{ type: 'json_path', path: '$.ok', operator: 'equals', expected: true }] }],
  }, { fetch, isUrlAllowed: allowUrl });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.step_results[0].http_status, 200);
});

test('runApiMonitor enforces timeout across the whole monitor run', async () => {
  const fetch = async (_url, options) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    }, 700);

    options.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  const result = await runApiMonitor({
    timeout_ms: 1000,
    base_url: 'https://api.example.com',
    steps: [
      { method: 'GET', url: '{{base_url}}/one' },
      { method: 'GET', url: '{{base_url}}/two' },
    ],
  }, { fetch, isUrlAllowed: allowUrl });

  assert.equal(result.status, 'failed');
  assert.equal(result.step_results.length, 2);
  assert.equal(result.step_results[0].status, 'succeeded');
  assert.equal(result.step_results[1].status, 'failed');
  assert.match(result.error_message, /timed out|aborted/i);
  assert.ok(result.duration_ms < 1500);
});

test('api monitor processMessage publishes before deleting valid messages', async () => {
  const commands = [];
  const client = {
    send: async (command) => {
      commands.push(command);
      return {};
    },
  };

  const rawMessage = {
    Body: JSON.stringify({
      type: 'api_monitor.run_requested',
      job_id: 'job-1',
      trace_id: 'trace-1',
      requested_at: '2026-06-13T00:00:00+00:00',
      project_id: 1,
      api_monitor_id: 2,
      steps: [{ method: 'GET', url: 'https://example.com' }],
    }),
    MessageId: 'message-1',
    ReceiptHandle: 'receipt-1',
  };

  const result = await processMessage(client, 'request-queue', 'result-queue', rawMessage, {
    runApiMonitor: async () => ({
      status: 'succeeded',
      duration_ms: 12,
      step_results: [],
      error_message: null,
    }),
  });

  assert.equal(result.status, 'succeeded');
  assert.deepEqual(commands.map((command) => command.constructor.name), [
    'SendMessageCommand',
    'DeleteMessageCommand',
  ]);
});

test('api monitor processMessage deletes malformed messages', async () => {
  const commands = [];
  const client = {
    send: async (command) => {
      commands.push(command);
      return {};
    },
  };

  const originalError = console.error;
  console.error = () => {};

  try {
    const result = await processMessage(client, 'request-queue', 'result-queue', {
      Body: JSON.stringify({ type: 'api_monitor.run_requested' }),
      MessageId: 'bad-message',
      ReceiptHandle: 'receipt-2',
    });

    assert.equal(result.status, 'invalid');
    assert.deepEqual(commands.map((command) => command.constructor.name), ['DeleteMessageCommand']);
  } finally {
    console.error = originalError;
  }
});

test('api monitor result serialization compacts oversized step results for SQS', () => {
  const resultMessage = {
    version: 1,
    type: 'api_monitor.run_completed',
    job_id: 'job-large',
    trace_id: 'trace-large',
    requested_at: '2026-06-13T00:00:00+00:00',
    completed_at: '2026-06-13T00:00:01+00:00',
    project_id: 1,
    api_monitor_id: 2,
    status: 'failed',
    duration_ms: 1234,
    step_results: Array.from({ length: 20 }, (_, index) => ({
      index,
      name: `Step ${index + 1}`,
      method: 'GET',
      url: `https://api.example.com/${index}`,
      status: index === 19 ? 'failed' : 'succeeded',
      http_status: index === 19 ? 500 : 200,
      duration_ms: 50 + index,
      assertions: Array.from({ length: 25 }, (_value, assertionIndex) => ({
        type: 'json_path',
        target: `$.items[${assertionIndex}]`,
        operator: 'equals',
        expected: 'ok',
        actual: Array.from({ length: 1000 }, (__value, itemIndex) => ({
          id: itemIndex,
          value: 'x'.repeat(100),
        })),
        passed: assertionIndex !== 24,
        message: assertionIndex === 24 ? 'm'.repeat(5000) : null,
      })),
      extracted: [],
      error_message: index === 19 ? 'Final assertion failed.' : null,
      response_preview: 'y'.repeat(20000),
    })),
    error_message: 'Final assertion failed.',
  };

  const body = serializeResultMessage(resultMessage);
  const parsed = JSON.parse(body);
  const truncationStep = parsed.step_results.at(-1);

  assert.ok(Buffer.byteLength(body, 'utf8') <= LIMITS.MAX_MESSAGE_BYTES);
  assert.equal(parsed.step_results[0].name, 'Step 1');
  assert.equal(parsed.error_message, 'Final assertion failed.');
  assert.equal(truncationStep.name, 'Result truncated for queue delivery');
  assert.equal(truncationStep._truncated.queueMessage, true);
  assert.equal(truncationStep._truncated.originalBytes > LIMITS.MAX_MESSAGE_BYTES, true);
});

test('template and JSONPath helpers support bracket paths and missing variables', () => {
  assert.equal(evaluateJsonPath({ 'access-token': 'abc' }, "$['access-token']"), 'abc');
  assert.deepEqual(evaluateJsonPath({ users: [{ id: 1 }, { id: 2 }] }, '$.users[*].id'), [1, 2]);
  assert.throws(() => renderTemplate('{{missing}}', {}), /Variable "missing" is not available/);
});

test('JSONPath accepts dotted numeric segments as array indexes', () => {
  assert.equal(evaluateJsonPath([{ id: 7 }, { id: 8 }], '$.0.id'), 7);
  assert.equal(evaluateJsonPath({ data: [{ id: 7 }, { id: 8 }] }, '$.data.1.id'), 8);
  assert.equal(evaluateJsonPath({ '0': { id: 'obj' } }, '$.0.id'), 'obj');
  assert.equal(evaluateJsonPath([{ id: 7 }], '$.5.id'), undefined);
  assert.throws(() => evaluateJsonPath({}, '$.0x.id'), /Unsupported JSONPath segment/);
});

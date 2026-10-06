const assert = require('node:assert/strict');
const test = require('node:test');

const { LIMITS } = require('../lib/constants');
const {
  deriveOutcome,
  deriveStatus,
  isBehindBotChallenge,
  isBotBlock,
  isClientFiltered,
  main,
  processMessage,
  publishResult,
  serializeResultMessage,
} = require('../worker');

function withMutedConsole(fn) {
  const originalError = console.error;
  console.error = () => {};

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.error = originalError;
    });
}

test('processMessage deletes malformed messages so they do not poison the queue', async () => {
  const commands = [];
  const client = {
    send: async (command) => {
      commands.push(command);
      return {};
    },
  };

  const rawMessage = {
    Body: JSON.stringify({
      type: 'health.check.requested',
      job_id: 'job-1',
    }),
    MessageId: 'msg-1',
    ReceiptHandle: 'receipt-1',
  };

  const result = await withMutedConsole(() =>
    processMessage(client, 'request-queue', 'result-queue', rawMessage)
  );

  assert.equal(result.status, 'invalid');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].constructor.name, 'DeleteMessageCommand');
});

test('processMessage leaves the message in the queue if publishing fails', async () => {
  const commands = [];
  const client = {
    send: async (command) => {
      commands.push(command);
      return {};
    },
  };

  const rawMessage = {
    Body: JSON.stringify({
      type: 'health.check.requested',
      job_id: 'job-1',
      monitoring_setting_id: 'setting-1',
      project_id: 'project-1',
      requested_at: '2026-04-20T00:00:00.000Z',
      trace_id: 'trace-1',
      url: 'https://example.com',
    }),
    MessageId: 'msg-2',
    ReceiptHandle: 'receipt-2',
  };

  await withMutedConsole(async () => {
    await assert.rejects(
      processMessage(client, 'request-queue', 'result-queue', rawMessage, {
        index: async () => ({ ok: true }),
        publishResult: async () => {
          throw new Error('publish failed');
        },
      }),
      /publish failed/
    );
  });

  assert.equal(
    commands.some((command) => command.constructor.name === 'DeleteMessageCommand'),
    false
  );
});

test('processMessage returns failed when the health check payload failed', async () => {
  const client = {
    send: async () => ({}),
  };

  const rawMessage = {
    Body: JSON.stringify({
      type: 'health.check.requested',
      job_id: 'job-1',
      monitoring_setting_id: 'setting-1',
      project_id: 'project-1',
      requested_at: '2026-04-20T00:00:00.000Z',
      trace_id: 'trace-1',
      url: 'https://example.com',
    }),
    MessageId: 'msg-3',
    ReceiptHandle: 'receipt-3',
  };

  const result = await withMutedConsole(() =>
    processMessage(client, 'request-queue', 'result-queue', rawMessage, {
      index: async () => ({
        httpStatus: { ok: false },
      }),
      publishResult: async () => {},
    })
  );

  assert.equal(result.status, 'failed');
});

test('deriveStatus returns succeeded for Cloudflare challenge pages', () => {
  assert.equal(
    deriveStatus({
      httpStatus: { code: 403, ok: false },
      cloudflare: { detected: true, protected: true, details: { jsChallenge: true } },
    }),
    'succeeded'
  );
});

test('deriveStatus returns succeeded for blank Cloudflare challenge interstitials', () => {
  assert.equal(
    deriveStatus({
      httpStatus: { code: 403, ok: false },
      blankPage: { isBlank: true },
      cloudflare: { detected: true, protected: true, details: { jsChallenge: true } },
    }),
    'succeeded'
  );
});

test('deriveStatus treats a Cloudflare hard block of the checker as reachable-but-limited', () => {

  assert.deepEqual(
    deriveOutcome({
      httpStatus: { code: 403, ok: false },
      cloudflare: { detected: true, protected: true, details: { blocked: true } },
    }),
    { status: 'succeeded', reason: null }
  );
});

test('deriveStatus still fails a 403 that carries no bot-protection signal', () => {
  assert.deepEqual(
    deriveOutcome({
      httpStatus: { code: 403, ok: false },
      cloudflare: { detected: true, protected: false, details: { blocked: false } },
      botProtection: { detected: false, blocked: false, challenged: false },
    }),
    { status: 'failed', reason: 'http_error' }
  );
});

test('isBotBlock needs both a vendor block signal and a challenge-style status', () => {
  assert.equal(
    isBotBlock({ httpStatus: { code: 403 }, cloudflare: { protected: true, details: { blocked: true } } }),
    true
  );
  assert.equal(
    isBotBlock({ httpStatus: { code: 403 }, botProtection: { blocked: true } }),
    true
  );

  assert.equal(
    isBotBlock({ httpStatus: { code: 200, ok: true }, cloudflare: { protected: true, details: { blocked: true } } }),
    false
  );
  assert.equal(isBotBlock({ httpStatus: { code: 403 }, cloudflare: { protected: false } }), false);
});

test('deriveStatus still fails for blank pages that only embed a Turnstile widget', () => {
  assert.equal(
    deriveStatus({
      httpStatus: { code: 200, ok: true },
      blankPage: { isBlank: true },
      cloudflare: {
        detected: true,
        protected: false,
        details: { turnstileWidget: true, captchaChallenge: false },
      },
    }),
    'failed'
  );
});

test('deriveStatus returns succeeded for non-Cloudflare bot-protection challenges', () => {
  assert.equal(
    deriveStatus({
      httpStatus: { code: 403, ok: false },
      cloudflare: null,
      botProtection: { detected: true, vendor: 'datadome', challenged: true, blocked: false },
    }),
    'succeeded'
  );
});

test('isBehindBotChallenge flags Cloudflare and vendor challenge interstitials', () => {
  assert.equal(
    isBehindBotChallenge({ cloudflare: { protected: true, details: { jsChallenge: true } } }),
    true
  );
  assert.equal(
    isBehindBotChallenge({ botProtection: { challenged: true } }),
    true
  );
});

test('isBehindBotChallenge is false for a normal page and for hard blocks', () => {

  assert.equal(isBehindBotChallenge({ cloudflare: { protected: false }, botProtection: null }), false);

  assert.equal(isBehindBotChallenge({ cloudflare: { protected: true, details: { blocked: true } } }), false);

  assert.equal(
    isBehindBotChallenge({
      cloudflare: { protected: false, details: { turnstileWidget: true, captchaChallenge: false } },
    }),
    false
  );
});

test('deriveStatus treats a vendor hard block of the checker as reachable-but-limited', () => {
  assert.equal(
    deriveStatus({
      httpStatus: { code: 403, ok: false },
      cloudflare: null,
      botProtection: { detected: true, vendor: 'akamai', challenged: false, blocked: true },
    }),
    'succeeded'
  );
});

test('deriveOutcome names the branch that decided a failed status', () => {
  assert.deepEqual(
    deriveOutcome({ error: 'Health check total timeout' }),
    { status: 'failed', reason: 'timeout' }
  );
  assert.deepEqual(
    deriveOutcome({ error: 'SSRF blocked: Blocked private/reserved IP: 10.0.0.1' }),
    { status: 'failed', reason: 'blocked_url' }
  );
  assert.deepEqual(
    deriveOutcome({ error: 'browserType.launch: crashed' }),
    { status: 'failed', reason: 'check_error' }
  );
  assert.deepEqual(
    deriveOutcome({ httpStatus: { code: null, ok: false }, dns: { resolved: false } }),
    { status: 'failed', reason: 'dns_failure' }
  );
  assert.deepEqual(
    deriveOutcome({ httpStatus: { code: 200, ok: true }, ssl: { valid: false } }),
    { status: 'failed', reason: 'ssl_invalid' }
  );
  assert.deepEqual(
    deriveOutcome({ httpStatus: { code: 200, ok: true }, blankPage: { isBlank: true } }),
    { status: 'failed', reason: 'blank_page' }
  );
  assert.deepEqual(
    deriveOutcome({
      httpStatus: { code: 200, ok: true },
      blankPage: { isBlank: false },
      redirect: { offSite: true, offSiteHost: 'scam.example.net' },
    }),
    { status: 'failed', reason: 'off_site_redirect' }
  );
  assert.deepEqual(
    deriveOutcome({ httpStatus: { code: 500, ok: false } }),
    { status: 'failed', reason: 'http_error' }
  );
});

test('deriveOutcome returns a null reason for succeeded checks', () => {
  assert.deepEqual(
    deriveOutcome({ httpStatus: { code: 200, ok: true }, blankPage: { isBlank: false } }),
    { status: 'succeeded', reason: null }
  );

  assert.deepEqual(
    deriveOutcome({
      httpStatus: { code: 403, ok: false },
      cloudflare: { detected: true, protected: true, details: { jsChallenge: true } },
    }),
    { status: 'succeeded', reason: null }
  );
});

test('normalizeRequest defaults the check tier to full and accepts uptime', async () => {
  const { normalizeRequest } = require('../worker');
  const base = {
    type: 'health.check.requested',
    job_id: 'job-tier',
    trace_id: 'trace-tier',
    requested_at: '2026-07-07T00:00:00.000Z',
    project_id: 1,
    monitoring_setting_id: 2,
    url: 'https://example.com',
  };

  assert.equal(normalizeRequest(JSON.stringify(base)).checks, 'full');
  assert.equal(normalizeRequest(JSON.stringify({ ...base, checks: 'uptime' })).checks, 'uptime');

  assert.equal(normalizeRequest(JSON.stringify({ ...base, checks: 'bogus' })).checks, 'full');
});

test('processMessage forwards the check tier to index', async () => {
  const seen = [];
  const client = { send: async () => ({}) };
  const rawMessage = {
    Body: JSON.stringify({
      type: 'health.check.requested',
      job_id: 'job-tier-2',
      monitoring_setting_id: 'setting-1',
      project_id: 'project-1',
      requested_at: '2026-07-07T00:00:00.000Z',
      trace_id: 'trace-tier-2',
      url: 'https://example.com',
      checks: 'uptime',
    }),
    MessageId: 'msg-tier',
    ReceiptHandle: 'receipt-tier',
  };

  await processMessage(client, 'request-queue', 'result-queue', rawMessage, {
    index: async (url, options) => {
      seen.push({ url, options });
      return { httpStatus: { code: 200, ok: true } };
    },
    publishResult: async () => {},
  });

  assert.deepEqual(seen, [{ url: 'https://example.com', options: { checks: 'uptime' } }]);
});

test('publishResult includes status_reason in the queue message', async () => {
  const sent = [];
  const client = {
    send: async (command) => {
      sent.push(command.input);
      return {};
    },
  };
  const request = {
    job_id: 'job-reason',
    trace_id: 'trace-reason',
    requested_at: '2026-07-07T00:00:00.000Z',
    project_id: 1,
    monitoring_setting_id: 2,
    url: 'https://example.com',
  };

  await publishResult(client, 'result-queue', request, 'failed', { httpStatus: { code: 500, ok: false } }, null, 'http_error');
  await publishResult(client, 'result-queue', request, 'succeeded', { httpStatus: { code: 200, ok: true } }, null, null);

  assert.equal(JSON.parse(sent[0].MessageBody).status_reason, 'http_error');
  assert.equal(JSON.parse(sent[1].MessageBody).status_reason, null);
});

test('deriveStatus treats challenged-and-blocked as a block, not a passable challenge', () => {

  const payload = {
    httpStatus: { code: 403, ok: false },
    cloudflare: null,
    botProtection: {
      detected: true,
      vendor: 'datadome',
      challenged: true,
      blocked: true,
      vendors: ['datadome', 'akamai'],
    },
  };
  assert.equal(isBehindBotChallenge(payload), false);
  assert.equal(isBotBlock(payload), true);
  assert.equal(deriveStatus(payload), 'succeeded');
});

test('deriveStatus returns failed when the site redirects off its own domain', () => {

  assert.equal(
    deriveStatus({
      httpStatus: { code: 200, ok: true },
      blankPage: { isBlank: false },
      redirect: { count: 0, offSite: true, offSiteHost: 'ads-spam.example.com' },
    }),
    'failed'
  );
});

test('deriveStatus stays succeeded for a same-domain redirect', () => {
  assert.equal(
    deriveStatus({
      httpStatus: { code: 200, ok: true },
      blankPage: { isBlank: false },
      redirect: { count: 1, offSite: false, offSiteHost: null },
    }),
    'succeeded'
  );
});

test('deriveStatus returns failed for non-Cloudflare 403', () => {
  assert.equal(
    deriveStatus({
      httpStatus: { code: 403, ok: false },
      cloudflare: null,
    }),
    'failed'
  );
});

test('deriveStatus returns failed when payload has error', () => {
  assert.equal(
    deriveStatus({
      error: 'Browser crashed',
      httpStatus: { code: 200, ok: true },
    }),
    'failed'
  );
});

test('deriveStatus returns succeeded for healthy page', () => {
  assert.equal(
    deriveStatus({
      httpStatus: { code: 200, ok: true },
      cloudflare: null,
    }),
    'succeeded'
  );
});

test('deriveStatus returns failed when httpStatus is null', () => {
  assert.equal(
    deriveStatus({ httpStatus: null }),
    'failed'
  );
});

test('deriveStatus returns failed for CF-detected 403 without protected flag', () => {
  assert.equal(
    deriveStatus({
      httpStatus: { code: 403, ok: false },
      cloudflare: { detected: true, protected: false },
    }),
    'failed'
  );
});

test('deriveStatus returns failed for CF-detected 503 without protected flag', () => {
  assert.equal(
    deriveStatus({
      httpStatus: { code: 503, ok: false },
      cloudflare: { detected: true, protected: false },
    }),
    'failed'
  );
});

test('deriveStatus returns failed for critical non-HTTP health failures', () => {
  assert.equal(
    deriveStatus({
      httpStatus: { code: 200, ok: true },
      dns: { resolved: false },
    }),
    'failed'
  );
  assert.equal(
    deriveStatus({
      httpStatus: { code: 200, ok: true },
      ssl: { valid: false },
    }),
    'failed'
  );
  assert.equal(
    deriveStatus({
      httpStatus: { code: 200, ok: true },
      blankPage: { isBlank: true },
    }),
    'failed'
  );
});

test('deriveStatus succeeds for an incomplete cert chain when the page loaded', () => {

  assert.equal(
    deriveStatus({
      httpStatus: { code: 200, ok: true },
      ssl: { valid: false, incompleteChain: true },
    }),
    'succeeded'
  );
});

test('deriveStatus still fails for an incomplete chain when the page did not load', () => {
  assert.equal(
    deriveStatus({
      httpStatus: { code: 200, ok: false },
      ssl: { valid: false, incompleteChain: true },
    }),
    'failed'
  );
});

test('deriveStatus succeeds for a transient SSL probe failure when the page loaded', () => {

  assert.equal(
    deriveStatus({
      httpStatus: { code: 200, ok: true },
      ssl: { valid: false, error: 'read ECONNRESET', code: 'ECONNRESET', transient: true },
    }),
    'succeeded'
  );
});

test('deriveStatus still fails for a transient SSL failure when the page did not load', () => {
  assert.equal(
    deriveStatus({
      httpStatus: { code: 200, ok: false },
      ssl: { valid: false, error: 'Connection timeout', transient: true },
    }),
    'failed'
  );
});

test('deriveStatus still fails for a deterministic cert failure even when the page loaded', () => {

  assert.equal(
    deriveStatus({
      httpStatus: { code: 200, ok: true },
      ssl: { valid: false, error: 'certificate has expired', code: 'CERT_HAS_EXPIRED', transient: false },
    }),
    'failed'
  );
});

test('processMessage returns succeeded for Cloudflare-protected page', async () => {
  const published = [];
  const client = {
    send: async () => ({}),
  };

  const rawMessage = {
    Body: JSON.stringify({
      type: 'health.check.requested',
      job_id: 'job-cf',
      monitoring_setting_id: 'setting-1',
      project_id: 'project-1',
      requested_at: '2026-04-20T00:00:00.000Z',
      trace_id: 'trace-cf',
      url: 'https://example.com',
    }),
    MessageId: 'msg-cf',
    ReceiptHandle: 'receipt-cf',
  };

  const result = await processMessage(client, 'request-queue', 'result-queue', rawMessage, {
    index: async () => ({
      httpStatus: { code: 403, ok: false },
      cloudflare: { detected: true, protected: true, details: { jsChallenge: true } },
    }),
    publishResult: async (_c, _q, _r, status, payload) => {
      published.push({ status, payload });
    },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(published[0].status, 'succeeded');
  assert.equal(published[0].payload.behindBotChallenge, true);
  assert.equal(published[0].payload.monitoringState, 'limited_by_bot_challenge');
  assert.equal(published[0].payload.monitoringLimitedReason, 'bot_challenge');
});

test('processMessage reports a Cloudflare hard block as limited monitoring, not an outage', async () => {
  const published = [];
  const client = { send: async () => ({}) };

  const rawMessage = {
    Body: JSON.stringify({
      type: 'health.check.requested',
      job_id: 'job-cf-block',
      monitoring_setting_id: 'setting-1',
      project_id: 'project-1',
      requested_at: '2026-04-20T00:00:00.000Z',
      trace_id: 'trace-cf-block',
      url: 'https://example.com',
    }),
    MessageId: 'msg-cf-block',
    ReceiptHandle: 'receipt-cf-block',
  };

  const result = await processMessage(client, 'request-queue', 'result-queue', rawMessage, {
    index: async () => ({
      httpStatus: { code: 403, ok: false, statusText: '' },
      cloudflare: { detected: true, protected: true, rayId: 'a37698eadf8d2058-IAD', details: { blocked: true, jsChallenge: false } },
      botProtection: { detected: false, blocked: false, challenged: false, vendors: [] },
    }),
    publishResult: async (_c, _q, _r, status, payload, error, reason) => {
      published.push({ status, payload, error, reason });
    },
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(published[0].status, 'succeeded');
  assert.equal(published[0].reason, null);
  assert.equal(published[0].payload.behindBotChallenge, true);
  assert.equal(published[0].payload.monitoringState, 'limited_by_bot_block');
  assert.equal(published[0].payload.monitoringLimitedReason, 'bot_block');
});

test('processMessage does not publish a failed result after successful publish when delete fails', async () => {
  const published = [];
  const client = {
    send: async (command) => {
      if (command.constructor.name === 'DeleteMessageCommand') {
        throw new Error('delete failed');
      }

      return {};
    },
  };

  const rawMessage = {
    Body: JSON.stringify({
      type: 'health.check.requested',
      job_id: 'job-delete',
      monitoring_setting_id: 'setting-1',
      project_id: 'project-1',
      requested_at: '2026-04-20T00:00:00.000Z',
      trace_id: 'trace-delete',
      url: 'https://example.com',
    }),
    MessageId: 'msg-delete',
    ReceiptHandle: 'receipt-delete',
  };

  await withMutedConsole(async () => {
    await assert.rejects(
      processMessage(client, 'request-queue', 'result-queue', rawMessage, {
        index: async () => ({
          httpStatus: { code: 200, ok: true },
        }),
        publishResult: async (_c, _q, _r, status, payload) => {
          published.push({ status, payload });
        },
      }),
      /delete failed/
    );
  });

  assert.deepEqual(
    published.map((message) => message.status),
    ['succeeded']
  );
});

test('serializeResultMessage compacts oversized health payloads for SQS', () => {
  const resultMessage = {
    version: 1,
    type: 'health.check.completed',
    job_id: 'job-large',
    trace_id: 'trace-large',
    requested_at: '2026-04-20T00:00:00.000Z',
    completed_at: '2026-04-20T00:00:01.000Z',
    project_id: 'project-1',
    monitoring_setting_id: 'setting-1',
    url: 'https://example.com',
    status: 'failed',
    payload: {
      url: 'https://example.com',
      timestamp: '2026-04-20T00:00:01.000Z',
      httpStatus: { code: 500, ok: false },
      apiCalls: Array.from({ length: 100 }, (_, index) => ({
        url: `https://api.example.com/${index}/${'x'.repeat(5000)}`,
        method: 'GET',
        status: 500,
        ok: false,
        error: 'y'.repeat(5000),
      })),
      jsErrors: Array.from({ length: 50 }, () => ({
        message: 'z'.repeat(5000),
      })),
    },
    error_message: null,
  };

  const body = serializeResultMessage(resultMessage);
  const parsed = JSON.parse(body);

  assert.ok(Buffer.byteLength(body, 'utf8') <= LIMITS.MAX_MESSAGE_BYTES);
  assert.equal(parsed.payload.httpStatus.code, 500);
  assert.equal(parsed.payload._truncated.queueMessage, true);
});

test('serializeResultMessage handles non-serializable payload objects', () => {
  const payload = {
    httpStatus: { code: 200, ok: true },
    buildNumber: 123n,
  };
  payload.self = payload;

  const body = serializeResultMessage({
    version: 1,
    type: 'health.check.completed',
    job_id: 'job-circular',
    trace_id: 'trace-circular',
    requested_at: '2026-04-20T00:00:00.000Z',
    completed_at: '2026-04-20T00:00:01.000Z',
    project_id: 'project-1',
    monitoring_setting_id: 'setting-1',
    url: 'https://example.com',
    status: 'succeeded',
    payload,
    error_message: null,
  });

  const parsed = JSON.parse(body);

  assert.equal(parsed.payload.self, '[Circular]');
  assert.equal(parsed.payload.buildNumber, '123');
  assert.equal(parsed.payload._truncated.queueMessage, true);
});

test('main keeps polling after transient receive failures', async () => {
  let pollCount = 0;
  let sleepCount = 0;

  const client = {
    send: async (command) => {
      assert.equal(command.constructor.name, 'ReceiveMessageCommand');
      pollCount += 1;

      if (pollCount === 1) {
        throw new Error('temporary SQS outage');
      }

      return { Messages: [] };
    },
  };

  await withMutedConsole(() =>
    main({
      client,
      maxIterations: 2,
      requestQueueUrl: 'request-queue',
      resultQueueUrl: 'result-queue',
      sleep: async () => {
        sleepCount += 1;
      },
    })
  );

  assert.equal(pollCount, 2);
  assert.equal(sleepCount, 1);
});

test('a user-agent filtered checker is monitoring-limited, not an outage', () => {
  const payload = {
    httpStatus: { code: 403, ok: false },
    clientFiltered: { detected: true, evidence: 'browser_user_agent_accepted', refusedStatus: 403, probeStatus: 200 },
  };

  assert.equal(isClientFiltered(payload), true);
  assert.deepEqual(deriveOutcome(payload), { status: 'succeeded', reason: null });
});

test('a 403 with no filtering evidence still fails', () => {
  const payload = { httpStatus: { code: 403, ok: false }, clientFiltered: null };

  assert.equal(isClientFiltered(payload), false);
  assert.deepEqual(deriveOutcome(payload), { status: 'failed', reason: 'http_error' });
});

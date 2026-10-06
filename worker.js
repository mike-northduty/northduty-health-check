require('dotenv').config();

const {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} = require('@aws-sdk/client-sqs');
const { index } = require('./index');
const { TIMEOUTS } = require('./lib/constants');
const { serializeHealthResultMessage } = require('./lib/sqs-message');

function requiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function buildClient() {
  const region = process.env.AWS_REGION || 'eu-west-1';
  const endpoint = process.env.SQS_ENDPOINT || undefined;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const credentials = accessKeyId && secretAccessKey
    ? { accessKeyId, secretAccessKey }
    : undefined;

  return new SQSClient({
    region,
    endpoint,
    credentials,
  });
}

function normalizeRequest(body) {
  const payload = JSON.parse(body);

  if (payload.type !== 'health.check.requested') {
    throw new Error(`Unsupported message type: ${payload.type || 'unknown'}`);
  }

  if (!payload.job_id || !payload.trace_id || !payload.requested_at || !payload.project_id || !payload.monitoring_setting_id || !payload.url) {
    throw new Error('Health request message is missing required fields.');
  }

  payload.checks = payload.checks === 'uptime' ? 'uptime' : 'full';

  return payload;
}

async function publishResult(client, resultQueueUrl, request, status, payload = null, errorMessage = null, statusReason = null) {
  const resultMessage = {
    version: 1,
    type: 'health.check.completed',
    job_id: request.job_id,
    trace_id: request.trace_id,
    requested_at: request.requested_at,
    completed_at: new Date().toISOString(),
    project_id: request.project_id,
    monitoring_setting_id: request.monitoring_setting_id,
    url: request.url,
    status,
    status_reason: statusReason,
    payload,
    error_message: errorMessage,
  };

  const messageBody = serializeResultMessage(resultMessage);

  await client.send(new SendMessageCommand({
    QueueUrl: resultQueueUrl,
    MessageBody: messageBody,
  }));
}

function serializeResultMessage(resultMessage) {
  return serializeHealthResultMessage(resultMessage);
}

function deriveStatus(payload) {
  return deriveOutcome(payload).status;
}

function deriveOutcome(payload) {
  if (payload.error) return { status: 'failed', reason: classifyErrorReason(payload.error) };
  if (!payload.httpStatus) return { status: 'failed', reason: 'check_error' };

  if (payload.dns?.resolved === false) return { status: 'failed', reason: 'dns_failure' };

  if (
    payload.ssl?.valid === false &&
    !(
      payload.httpStatus.ok === true &&
      (payload.ssl.incompleteChain === true || payload.ssl.transient === true)
    )
  ) {
    return { status: 'failed', reason: 'ssl_invalid' };
  }

  if (
    [403, 429, 503].includes(payload.httpStatus.code) &&
    (isCloudflareChallenge(payload.cloudflare) || isPassableBotChallenge(payload.botProtection))
  ) {
    return { status: 'succeeded', reason: null };
  }

  if (isBotBlock(payload)) {
    return { status: 'succeeded', reason: null };
  }

  if (isClientFiltered(payload)) {
    return { status: 'succeeded', reason: null };
  }

  if (payload.blankPage?.isBlank === true) return { status: 'failed', reason: 'blank_page' };

  if (payload.redirect?.offSite === true) return { status: 'failed', reason: 'off_site_redirect' };

  if (payload.httpStatus.ok === false) return { status: 'failed', reason: 'http_error' };

  return { status: 'succeeded', reason: null };
}

function classifyErrorReason(errorMessage) {
  const message = String(errorMessage);
  if (/^SSRF blocked/i.test(message)) return 'blocked_url';
  if (/timeout/i.test(message)) return 'timeout';
  return 'check_error';
}

function isBehindBotChallenge(payload) {
  return isCloudflareChallenge(payload?.cloudflare) || isPassableBotChallenge(payload?.botProtection);
}

function isBotBlock(payload) {
  const code = Number(payload?.httpStatus?.code);
  if (![403, 429, 503].includes(code)) return false;

  const cloudflare = payload?.cloudflare;
  if (cloudflare?.protected === true && cloudflare?.details?.blocked === true) return true;

  return payload?.botProtection?.blocked === true;
}

function isClientFiltered(payload) {
  return payload?.clientFiltered?.detected === true;
}

function isPassableBotChallenge(botProtection) {
  return botProtection?.challenged === true && botProtection?.blocked !== true;
}

function isCloudflareChallenge(cloudflare) {
  if (!cloudflare?.protected) return false;

  const details = cloudflare.details;
  if (!details) return false;

  if (details.blocked === true) return false;

  return Boolean(details.jsChallenge || details.captchaChallenge || details.underAttack);
}

async function processMessage(client, requestQueueUrl, resultQueueUrl, rawMessage, dependencies = {}) {
  if (!rawMessage.Body || !rawMessage.ReceiptHandle) {
    throw new Error('Received SQS message without Body or ReceiptHandle.');
  }

  const runIndex = dependencies.index || index;
  const publish = dependencies.publishResult || publishResult;
  let request;

  try {
    request = normalizeRequest(rawMessage.Body);
  } catch (error) {
    console.error(JSON.stringify({
      error: 'Invalid health request message',
      detail: error.message,
      messageId: rawMessage.MessageId || null,
      ...extractCorrelationIds(rawMessage.Body),
    }));

    await deleteMessage(client, requestQueueUrl, rawMessage.ReceiptHandle);
    return { deleted: true, status: 'invalid' };
  }

  let published = false;
  const correlation = {
    messageId: rawMessage.MessageId || null,
    job_id: request.job_id,
    trace_id: request.trace_id,
  };

  try {
    const payload = await runIndex(request.url, { checks: request.checks });
    const behindChallenge = isBehindBotChallenge(payload);

    const botBlocked = !behindChallenge && (isBotBlock(payload) || isClientFiltered(payload));

    payload.behindBotChallenge = behindChallenge || botBlocked;
    payload.monitoringState = behindChallenge
      ? 'limited_by_bot_challenge'
      : botBlocked ? 'limited_by_bot_block' : 'measured';
    payload.monitoringLimitedReason = behindChallenge
      ? 'bot_challenge'
      : botBlocked ? 'bot_block' : null;
    const { status, reason } = deriveOutcome(payload);

    await publish(client, resultQueueUrl, request, status, payload, payload.error || null, reason);
    published = true;
    await deleteMessage(client, requestQueueUrl, rawMessage.ReceiptHandle);
    return { deleted: true, status };
  } catch (error) {
    if (published) {
      console.error(JSON.stringify({
        error: 'Failed to delete processed message',
        detail: error.message,
        ...correlation,
      }));
      throw error;
    }

    try {
      await publish(client, resultQueueUrl, request, 'failed', null, error.message, 'check_error');
      await deleteMessage(client, requestQueueUrl, rawMessage.ReceiptHandle);
      return { deleted: true, status: 'failed' };
    } catch (publishError) {
      console.error(JSON.stringify({
        error: 'Failed to publish failed result',
        detail: publishError.message,
        ...correlation,
      }));
      throw publishError;
    }
  }
}

async function deleteMessage(client, requestQueueUrl, receiptHandle) {
  await client.send(new DeleteMessageCommand({
    QueueUrl: requestQueueUrl,
    ReceiptHandle: receiptHandle,
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withJitter(ms, fraction = 0.2) {
  const delta = ms * fraction;
  return Math.max(0, Math.round(ms + (Math.random() * 2 - 1) * delta));
}

function isAbortError(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return true;
  const message = String(error.message || '');
  return /aborted/i.test(message) || /request aborted/i.test(message);
}

async function main(options = {}) {
  const requestQueueUrl = options.requestQueueUrl || requiredEnv('HEALTH_REQUEST_QUEUE_URL');
  const resultQueueUrl = options.resultQueueUrl || requiredEnv('HEALTH_RESULT_QUEUE_URL');
  const client = options.client || buildClient();
  const maxIterations = options.maxIterations ?? Number.POSITIVE_INFINITY;
  const sleepFn = options.sleep || sleep;
  let iteration = 0;

  let shuttingDown = false;
  let retrySleepTimer = null;
  const receiveAbortController = new AbortController();
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (retrySleepTimer) clearTimeout(retrySleepTimer);

    try { receiveAbortController.abort(); } catch {}
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  while (iteration < maxIterations && !shuttingDown) {
    iteration += 1;

    try {
      const response = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: requestQueueUrl,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 20,
          VisibilityTimeout: TIMEOUTS.WORKER_VISIBILITY_TIMEOUT,
        }),
        { abortSignal: receiveAbortController.signal },
      );

      if (!response.Messages || response.Messages.length === 0) {
        continue;
      }

      for (const rawMessage of response.Messages) {
        try {
          await processMessage(client, requestQueueUrl, resultQueueUrl, rawMessage);
        } catch (error) {
          const correlation = extractCorrelationIds(rawMessage.Body);
          console.error(JSON.stringify({
            error: error.message,
            messageId: rawMessage.MessageId || null,
            ...correlation,
          }));
        }
      }
    } catch (error) {
      if (shuttingDown && isAbortError(error)) {
        break;
      }

      console.error(JSON.stringify({
        error: 'Failed to poll request queue',
        detail: error.message,
      }));
      if (!shuttingDown) {
        const delay = withJitter(TIMEOUTS.WORKER_RETRY_DELAY);
        if (sleepFn === sleep) {
          await new Promise((resolve) => {
            retrySleepTimer = setTimeout(resolve, delay);
          });
          retrySleepTimer = null;
        } else {
          await sleepFn(delay);
        }
      }
    }
  }
}

function extractCorrelationIds(body) {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    return {
      job_id: parsed.job_id || null,
      trace_id: parsed.trace_id || null,
    };
  } catch {
    return {};
  }
}

module.exports = {
  buildClient,
  deriveOutcome,
  deriveStatus,
  isBehindBotChallenge,
  isBotBlock,
  isClientFiltered,
  main,
  normalizeRequest,
  processMessage,
  publishResult,
  requiredEnv,
  serializeResultMessage,
};

if (require.main === module) {
  process.on('unhandledRejection', (reason) => {
    console.error(JSON.stringify({ error: 'unhandledRejection', detail: String(reason) }));
  });
  process.on('uncaughtException', (error) => {
    console.error(JSON.stringify({ error: 'uncaughtException', detail: error.message }));
    process.exit(1);
  });

  startConfiguredWorkers().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exit(1);
  });
}

async function startConfiguredWorkers() {
  const workers = [main()];

  if (process.env.API_MONITOR_REQUEST_QUEUE_URL || process.env.API_MONITOR_RESULT_QUEUE_URL) {
    if (!process.env.API_MONITOR_REQUEST_QUEUE_URL || !process.env.API_MONITOR_RESULT_QUEUE_URL) {
      throw new Error('Both API_MONITOR_REQUEST_QUEUE_URL and API_MONITOR_RESULT_QUEUE_URL are required when API monitor worker is enabled.');
    }

    const apiMonitorWorker = require('./api-monitor-worker');
    workers.push(apiMonitorWorker.main());
  }

  await Promise.all(workers);
}

require('dotenv').config();

const {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} = require('@aws-sdk/client-sqs');
const { runApiMonitor } = require('./lib/api-monitor');
const { TIMEOUTS } = require('./lib/constants');
const { serializeApiMonitorResultMessage } = require('./lib/sqs-message');

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

  if (payload.type !== 'api_monitor.run_requested') {
    throw new Error(`Unsupported message type: ${payload.type || 'unknown'}`);
  }

  if (!payload.job_id || !payload.trace_id || !payload.requested_at || !payload.project_id || !payload.api_monitor_id || !Array.isArray(payload.steps)) {
    throw new Error('API monitor request message is missing required fields.');
  }

  return payload;
}

async function publishResult(client, resultQueueUrl, request, result) {
  const resultMessage = {
    version: 1,
    type: 'api_monitor.run_completed',
    job_id: request.job_id,
    trace_id: request.trace_id,
    requested_at: request.requested_at,
    completed_at: new Date().toISOString(),
    project_id: request.project_id,
    api_monitor_id: request.api_monitor_id,
    status: result.status,
    duration_ms: result.duration_ms,
    step_results: result.step_results || [],
    error_message: result.error_message || null,
  };

  await client.send(new SendMessageCommand({
    QueueUrl: resultQueueUrl,
    MessageBody: serializeResultMessage(resultMessage),
  }));
}

function serializeResultMessage(resultMessage) {
  return serializeApiMonitorResultMessage(resultMessage);
}

async function processMessage(client, requestQueueUrl, resultQueueUrl, rawMessage, dependencies = {}) {
  if (!rawMessage.Body || !rawMessage.ReceiptHandle) {
    throw new Error('Received SQS message without Body or ReceiptHandle.');
  }

  const runner = dependencies.runApiMonitor || runApiMonitor;
  const publish = dependencies.publishResult || publishResult;
  let request;

  try {
    request = normalizeRequest(rawMessage.Body);
  } catch (error) {
    console.error(JSON.stringify({
      error: 'Invalid API monitor request message',
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
    const result = await runner(request);
    await publish(client, resultQueueUrl, request, result);
    published = true;
    await deleteMessage(client, requestQueueUrl, rawMessage.ReceiptHandle);
    return { deleted: true, status: result.status };
  } catch (error) {
    if (published) {
      console.error(JSON.stringify({
        error: 'Failed to delete processed API monitor message',
        detail: error.message,
        ...correlation,
      }));
      throw error;
    }

    try {
      await publish(client, resultQueueUrl, request, {
        status: 'failed',
        duration_ms: null,
        step_results: [],
        error_message: error.message,
      });
      await deleteMessage(client, requestQueueUrl, rawMessage.ReceiptHandle);
      return { deleted: true, status: 'failed' };
    } catch (publishError) {
      console.error(JSON.stringify({
        error: 'Failed to publish failed API monitor result',
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
  const requestQueueUrl = options.requestQueueUrl || requiredEnv('API_MONITOR_REQUEST_QUEUE_URL');
  const resultQueueUrl = options.resultQueueUrl || requiredEnv('API_MONITOR_RESULT_QUEUE_URL');
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
        error: 'Failed to poll API monitor request queue',
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

  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exit(1);
  });
}

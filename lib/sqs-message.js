const { LIMITS } = require('./constants');

const HEALTH_COMPACTION_LEVELS = [
  { maxStringLength: 1024, maxArrayItems: 50, maxDepth: 4 },
  { maxStringLength: 512, maxArrayItems: 25, maxDepth: 4 },
  { maxStringLength: 256, maxArrayItems: 10, maxDepth: 3 },
  { maxStringLength: 128, maxArrayItems: 5, maxDepth: 3 },
];

const API_MONITOR_COMPACTION_LEVELS = [
  { maxStringLength: 1024, maxArrayItems: 50, maxDepth: 5, maxStepResults: 20 },
  { maxStringLength: 512, maxArrayItems: 25, maxDepth: 5, maxStepResults: 20 },
  { maxStringLength: 256, maxArrayItems: 10, maxDepth: 4, maxStepResults: 20 },
  { maxStringLength: 128, maxArrayItems: 5, maxDepth: 4, maxStepResults: 10 },
];

function serializeHealthResultMessage(resultMessage) {
  const { body: originalBody, bytes: originalBytes } = stringifyWithSize(resultMessage);

  if (originalBody && originalBytes <= LIMITS.MAX_MESSAGE_BYTES) {
    return originalBody;
  }

  for (const options of HEALTH_COMPACTION_LEVELS) {
    const compactedMessage = {
      ...resultMessage,
      payload: addCompactionMetadata(compactValue(resultMessage.payload, options), originalBytes),
    };
    const { body, bytes } = stringifyWithSize(compactedMessage);

    if (body && bytes <= LIMITS.MAX_MESSAGE_BYTES) {
      return body;
    }
  }

  const minimalMessage = {
    ...resultMessage,
    payload: buildMinimalHealthPayload(resultMessage.payload, originalBytes),
    error_message:
      resultMessage.error_message || 'Health check payload was truncated for queue delivery.',
  };
  const { body: minimalBody, bytes: minimalBytes } = stringifyWithSize(minimalMessage);

  if (minimalBody && minimalBytes <= LIMITS.MAX_MESSAGE_BYTES) {
    return minimalBody;
  }

  return JSON.stringify(
    compactValue(
      {
        ...minimalMessage,
        payload: null,
      },
      {
        maxStringLength: 256,
        maxArrayItems: 5,
        maxDepth: 3,
      },
    ),
  );
}

function serializeApiMonitorResultMessage(resultMessage) {
  const { body: originalBody, bytes: originalBytes } = stringifyWithSize(resultMessage);

  if (originalBody && originalBytes <= LIMITS.MAX_MESSAGE_BYTES) {
    return originalBody;
  }

  for (const options of API_MONITOR_COMPACTION_LEVELS) {
    const compactedMessage = {
      ...resultMessage,
      step_results: compactApiMonitorSteps(resultMessage.step_results, options, originalBytes),
      error_message:
        resultMessage.error_message === null || resultMessage.error_message === undefined
          ? resultMessage.error_message
          : truncateString(String(resultMessage.error_message), options.maxStringLength),
    };
    const { body, bytes } = stringifyWithSize(compactedMessage);

    if (body && bytes <= LIMITS.MAX_MESSAGE_BYTES) {
      return body;
    }
  }

  const minimalMessage = {
    ...resultMessage,
    step_results: [
      buildApiMonitorTruncationStep({
        originalBytes,
        keptSteps: 0,
        omittedSteps: Array.isArray(resultMessage.step_results)
          ? resultMessage.step_results.length
          : 0,
      }),
    ],
    error_message:
      resultMessage.error_message === null || resultMessage.error_message === undefined
        ? resultMessage.error_message
        : truncateString(String(resultMessage.error_message), 512),
  };
  const { body: minimalBody, bytes: minimalBytes } = stringifyWithSize(minimalMessage);

  if (minimalBody && minimalBytes <= LIMITS.MAX_MESSAGE_BYTES) {
    return minimalBody;
  }

  return JSON.stringify(
    compactValue(minimalMessage, {
      maxStringLength: 256,
      maxArrayItems: 5,
      maxDepth: 3,
    }),
  );
}

function stringifyWithSize(value) {
  try {
    const body = JSON.stringify(value);
    return {
      body,
      bytes: Buffer.byteLength(body, 'utf8'),
    };
  } catch {
    return {
      body: null,
      bytes: LIMITS.MAX_MESSAGE_BYTES + 1,
    };
  }
}

function compactValue(value, options, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return truncateString(value, options.maxStringLength);
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  if (depth >= options.maxDepth) {
    return '[Truncated object]';
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const compacted = value
      .slice(0, options.maxArrayItems)
      .map((item) => compactValue(item, options, depth + 1, seen));
    seen.delete(value);
    return compacted;
  }

  const compacted = {};
  for (const [key, entryValue] of Object.entries(value)) {
    compacted[key] = compactValue(entryValue, options, depth + 1, seen);
  }
  seen.delete(value);
  return compacted;
}

function addCompactionMetadata(payload, originalBytes) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  return {
    ...payload,
    _truncated: {
      queueMessage: true,
      originalBytes,
      maxBytes: LIMITS.MAX_MESSAGE_BYTES,
    },
  };
}

function buildMinimalHealthPayload(payload, originalBytes) {
  return compactValue(
    {
      url: payload?.url || null,
      timestamp: payload?.timestamp || null,
      error: payload?.error || null,
      httpStatus: payload?.httpStatus || null,
      dns: payload?.dns || null,
      ssl: payload?.ssl || null,
      blankPage: payload?.blankPage || null,
      _truncated: {
        queueMessage: true,
        originalBytes,
        maxBytes: LIMITS.MAX_MESSAGE_BYTES,
        reason: 'Health check payload exceeded queue message size limit.',
      },
    },
    {
      maxStringLength: 512,
      maxArrayItems: 5,
      maxDepth: 3,
    },
  );
}

function compactApiMonitorSteps(stepResults, options, originalBytes) {
  const steps = Array.isArray(stepResults) ? stepResults : [];
  const keptSteps = steps.slice(0, options.maxStepResults);
  const compactedSteps = keptSteps.map((step) => compactValue(step, options));

  compactedSteps.push(
    buildApiMonitorTruncationStep({
      originalBytes,
      keptSteps: compactedSteps.length,
      omittedSteps: Math.max(0, steps.length - keptSteps.length),
      maxStringLength: options.maxStringLength,
      maxArrayItems: options.maxArrayItems,
      maxDepth: options.maxDepth,
    }),
  );

  return compactedSteps;
}

function buildApiMonitorTruncationStep(metadata) {
  return {
    index: metadata.keptSteps,
    name: 'Result truncated for queue delivery',
    method: null,
    url: null,
    status: 'succeeded',
    http_status: null,
    duration_ms: null,
    assertions: [],
    extracted: [],
    error_message: null,
    _truncated: {
      queueMessage: true,
      originalBytes: metadata.originalBytes,
      maxBytes: LIMITS.MAX_MESSAGE_BYTES,
      keptSteps: metadata.keptSteps,
      omittedSteps: metadata.omittedSteps,
      maxStringLength: metadata.maxStringLength || null,
      maxArrayItems: metadata.maxArrayItems || null,
      maxDepth: metadata.maxDepth || null,
      reason: 'API monitor result exceeded queue message size limit.',
    },
  };
}

function truncateString(value, maxLength) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}

module.exports = {
  serializeApiMonitorResultMessage,
  serializeHealthResultMessage,
};

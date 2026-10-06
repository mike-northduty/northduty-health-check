const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyBlankPageMetrics,
  createResourceTracker,
  isSignalWorthyFailure,
  isSignalWorthyResponse,
} = require('../lib/page/analysis');
const { createApiTracker } = require('../lib/page/api-tracker');
const { createErrorTracker, isActionableConsoleError } = require('../lib/page/errors');

function createRequest({
  errorText = null,
  frame = { parentFrame: () => null },
  method = 'GET',
  type = 'fetch',
  url = 'https://example.com/resource',
} = {}) {
  return {
    failure: () => (errorText ? { errorText } : null),
    frame: () => frame,
    isNavigationRequest: () => type === 'document',
    method: () => method,
    resourceType: () => type,
    url: () => url,
  };
}

test('blank-page classifier marks page with only empty elements as blank', () => {
  assert.equal(
    classifyBlankPageMetrics({
      hasBackgroundVisuals: false,
      hasCanvas: false,
      hasIframes: false,
      hasImages: false,
      hasSvg: false,
      hasVideo: false,
      hasVisibleContent: false,
      shadowHostCount: 0,
      visibleElementCount: 3,
    }),
    true
  );
});

test('blank-page classifier keeps page with real visual content from being marked blank', () => {
  assert.equal(
    classifyBlankPageMetrics({
      hasBackgroundVisuals: true,
      hasCanvas: false,
      hasFormControls: false,
      hasIframes: false,
      hasImages: false,
      hasStyledSurface: false,
      hasSvg: false,
      hasVideo: false,
      hasVisibleContent: false,
      shadowHostCount: 0,
      visibleElementCount: 3,
    }),
    false
  );
});

test('blank-page classifier keeps body-level background images from being marked blank', () => {
  assert.equal(
    classifyBlankPageMetrics({
      hasBackgroundVisuals: false,
      hasBodyBackground: true,
      hasCanvas: false,
      hasFormControls: false,
      hasIframes: false,
      hasImages: false,
      hasStyledSurface: false,
      hasSvg: false,
      hasVideo: false,
      hasVisibleContent: false,
      shadowHostCount: 0,
      visibleElementCount: 0,
    }),
    false
  );
});

test('blank-page classifier keeps styled layouts from being marked blank', () => {
  assert.equal(
    classifyBlankPageMetrics({
      hasBackgroundVisuals: false,
      hasCanvas: false,
      hasFormControls: false,
      hasIframes: false,
      hasImages: false,
      hasStyledSurface: true,
      hasSvg: false,
      hasVideo: false,
      hasVisibleContent: false,
      shadowHostCount: 0,
      visibleElementCount: 3,
    }),
    false
  );
});

test('resource issue filters ignore noisy failures and keep critical ones', () => {
  assert.equal(
    isSignalWorthyResponse(
      createRequest({
        type: 'fetch',
        url: 'https://example.com/api/session',
      }),
      401
    ),
    false
  );

  assert.equal(
    isSignalWorthyFailure(
      createRequest({
        errorText: 'net::ERR_ABORTED',
        type: 'script',
        url: 'https://example.com/app.js',
      })
    ),
    false
  );

  assert.equal(
    isSignalWorthyResponse(
      createRequest({
        type: 'script',
        url: 'https://example.com/app.js',
      }),
      500
    ),
    true
  );
});

test('resource issue filters ignore requests whose frame is unavailable', () => {
  const request = createRequest({
    type: 'script',
    url: 'https://example.com/app.js',
  });
  request.frame = () => {
    throw new Error('Request is issued by a service worker');
  };

  assert.equal(isSignalWorthyResponse(request, 500), false);
  assert.equal(
    isSignalWorthyFailure({
      ...request,
      failure: () => ({ errorText: 'net::ERR_FAILED' }),
    }),
    false
  );
});

test('api tracker ignores requests whose frame is unavailable', () => {
  const tracker = createApiTracker();
  const request = createRequest({
    type: 'fetch',
    url: 'https://example.com/api/data',
  });
  request.frame = () => {
    throw new Error('Request is issued by a service worker');
  };

  tracker.handlers.onRequest(request);
  tracker.handlers.onResponse({
    request: () => request,
    status: () => 200,
    url: () => 'https://example.com/api/data',
  });

  assert.deepEqual(tracker.getApiCalls('https://example.com'), []);
});

test('blank-page classifier treats hidden visual elements as blank', () => {
  assert.equal(
    classifyBlankPageMetrics({
      hasBackgroundVisuals: false,
      hasCanvas: false,
      hasFormControls: false,
      hasIframes: false,
      hasImages: false,
      hasStyledSurface: false,
      hasSvg: false,
      hasVideo: false,
      hasVisibleContent: false,
      shadowHostCount: 0,
      visibleElementCount: 0,
    }),
    true
  );
});

test('resource tracker only returns first-party top-level failures', () => {
  const tracker = createResourceTracker();
  const topLevelFrame = { parentFrame: () => null };
  const iframe = { parentFrame: () => ({}) };

  tracker.handlers.onResponse({
    request: () => createRequest({
      frame: topLevelFrame,
      type: 'script',
      url: 'https://cdn.example.com/app.js',
    }),
    status: () => 500,
    statusText: () => 'Server Error',
    url: () => 'https://cdn.example.com/app.js',
  });
  tracker.handlers.onResponse({
    request: () => createRequest({
      frame: topLevelFrame,
      type: 'script',
      url: 'https://widgets.thirdparty.com/app.js',
    }),
    status: () => 500,
    statusText: () => 'Server Error',
    url: () => 'https://widgets.thirdparty.com/app.js',
  });
  tracker.handlers.onResponse({
    request: () => createRequest({
      frame: iframe,
      type: 'script',
      url: 'https://example.com/iframe.js',
    }),
    status: () => 500,
    statusText: () => 'Server Error',
    url: () => 'https://example.com/iframe.js',
  });

  assert.deepEqual(
    tracker.getResources('https://www.example.com', 'https://example.com/home'),
    [
      {
        resourceType: 'script',
        status: 500,
        statusText: 'Server Error',
        url: 'https://cdn.example.com/app.js',
      },
    ]
  );
});

test('error tracker ignores non-actionable console.error noise', () => {
  const tracker = createErrorTracker();

  tracker.handlers.onConsoleError({
    text: () => 'Failed to send telemetry beacon',
    type: () => 'error',
  });
  tracker.handlers.onConsoleError({
    text: () => 'Uncaught TypeError: boom',
    type: () => 'error',
  });

  assert.equal(isActionableConsoleError('Failed to send telemetry beacon'), false);
  assert.deepEqual(tracker.getErrors(), [
    {
      type: 'console.error',
      message: 'Uncaught TypeError: boom',
    },
  ]);
});

test('api tracker keeps concurrent requests to the same URL separate', () => {
  const tracker = createApiTracker();
  const firstRequest = createRequest({
    type: 'fetch',
    url: 'https://example.com/api/data',
  });
  const secondRequest = createRequest({
    type: 'fetch',
    url: 'https://example.com/api/data',
  });

  const originalNow = Date.now;
  const timestamps = [100, 120, 200, 260];
  Date.now = () => timestamps.shift();

  try {
    tracker.handlers.onRequest(firstRequest);
    tracker.handlers.onRequest(secondRequest);
    tracker.handlers.onResponse({
      request: () => secondRequest,
      status: () => 200,
      url: () => 'https://example.com/api/data',
    });
    tracker.handlers.onResponse({
      request: () => firstRequest,
      status: () => 200,
      url: () => 'https://example.com/api/data',
    });
  } finally {
    Date.now = originalNow;
  }

  assert.deepEqual(
    tracker.getApiCalls('https://example.com').map((call) => call.responseTime),
    [80, 160]
  );
});

test('api tracker filters out third-party and iframe calls', () => {
  const tracker = createApiTracker();
  const topLevelFrame = { parentFrame: () => null };
  const iframe = { parentFrame: () => ({}) };

  const firstParty = createRequest({
    frame: topLevelFrame,
    type: 'fetch',
    url: 'https://api.example.com/session',
  });
  const thirdParty = createRequest({
    frame: topLevelFrame,
    type: 'fetch',
    url: 'https://analytics.vendor.com/collect',
  });
  const iframeRequest = createRequest({
    frame: iframe,
    type: 'fetch',
    url: 'https://example.com/embed-data',
  });

  tracker.handlers.onRequest(firstParty);
  tracker.handlers.onRequest(thirdParty);
  tracker.handlers.onRequest(iframeRequest);

  tracker.handlers.onResponse({
    request: () => firstParty,
    status: () => 200,
    url: () => 'https://api.example.com/session',
  });
  tracker.handlers.onResponse({
    request: () => thirdParty,
    status: () => 503,
    url: () => 'https://analytics.vendor.com/collect',
  });
  tracker.handlers.onRequestFailed(iframeRequest);

  assert.deepEqual(
    tracker.getApiCalls('https://www.example.com', 'https://example.com/home'),
    [
      {
        method: 'GET',
        ok: true,
        responseTime: 0,
        status: 200,
        url: 'https://api.example.com/session',
      },
    ]
  );
});

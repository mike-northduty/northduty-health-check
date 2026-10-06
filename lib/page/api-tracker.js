const { createSiteScope, isUrlInSiteScope } = require('../site-scope');
const { LIMITS } = require('../constants');
const { isTopLevelFrameRequest } = require('../playwright-helpers');

function createApiTracker() {
  const apiCalls = [];
  const requestTimings = new Map();

  const handlers = {
    onRequest: (request) => {
      const type = request.resourceType();
      if (type === 'xhr' || type === 'fetch') {
        requestTimings.set(request, {
          startTime: Date.now(),
          method: request.method(),
          topLevelFrame: isTopLevelFrameRequest(request),
        });
      }
    },

    onResponse: (response) => {
      const request = response.request();
      const type = request.resourceType();
      if (type === 'xhr' || type === 'fetch') {
        const timing = requestTimings.get(request);
        if (apiCalls.length < LIMITS.MAX_API_CALLS) {
          apiCalls.push({
            url: response.url(),
            method: request.method(),
            status: response.status(),
            ok: response.status() >= 200 && response.status() < 300,
            responseTime: timing ? Date.now() - timing.startTime : null,
            topLevelFrame: timing ? timing.topLevelFrame : isTopLevelFrameRequest(request),
          });
        }
        requestTimings.delete(request);
      }
    },

    onRequestFailed: (request) => {
      const type = request.resourceType();
      if (type === 'xhr' || type === 'fetch') {
        const timing = requestTimings.get(request);
        if (apiCalls.length < LIMITS.MAX_API_CALLS) {
          apiCalls.push({
            url: request.url(),
            method: request.method(),
            status: null,
            ok: false,
            error: request.failure()?.errorText || 'Request failed',
            responseTime: timing ? Date.now() - timing.startTime : null,
            topLevelFrame: timing ? timing.topLevelFrame : isTopLevelFrameRequest(request),
          });
        }
        requestTimings.delete(request);
      }
    },
  };

  return {
    handlers,
    reset: () => { apiCalls.length = 0; requestTimings.clear(); },
    getApiCalls: (...siteUrls) => {
      const siteScope = createSiteScope(...siteUrls);
      return apiCalls
        .filter((call) => call.topLevelFrame)
        .filter((call) => isUrlInSiteScope(call.url, siteScope))
        .map(({ topLevelFrame, ...call }) => call);
    },
  };
}

module.exports = { createApiTracker };

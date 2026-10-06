const { URL } = require('url');
const { isTopLevelFrameRequest } = require('../playwright-helpers');
const { getRegistrableDomain } = require('../site-scope');

function hostnameOf(urlString) {
  try {
    return new URL(urlString).hostname.toLowerCase().replace(/\.$/, '') || null;
  } catch {
    return null;
  }
}

function evaluateOffSite(requestedUrl, finalUrl) {
  const requestedHost = hostnameOf(requestedUrl);
  const finalHost = hostnameOf(finalUrl);
  if (!requestedHost || !finalHost) {
    return { offSite: false, offSiteHost: null };
  }
  const requestedDomain = getRegistrableDomain(requestedHost);
  const finalDomain = getRegistrableDomain(finalHost);
  if (!requestedDomain || !finalDomain) {
    return { offSite: false, offSiteHost: null };
  }
  const offSite = requestedDomain !== finalDomain;
  return { offSite, offSiteHost: offSite ? finalHost : null };
}

function createRedirectTracker() {
  const redirectChain = [];
  let initialUrl = null;

  const handlers = {
    onRequest: (request) => {
      const topLevelFrame = isTopLevelFrameRequest(request);
      if (request.isNavigationRequest() && topLevelFrame) {
        if (initialUrl === null) {
          initialUrl = request.url();
        }
      }
    },

    onResponse: (response) => {
      const request = response.request();

      if (!request.isNavigationRequest() || !isTopLevelFrameRequest(request)) {
        return;
      }

      const status = response.status();

      if (status >= 300 && status < 400) {
        const headers = response.headers();
        redirectChain.push({
          url: response.url(),
          status,
          location: headers['location'] || null,
        });
      }
    },
  };

  return {
    handlers,
    reset: () => { redirectChain.length = 0; initialUrl = null; },
    getRedirects: (finalUrl, requestedUrl = initialUrl) => {
      const { offSite, offSiteHost } = evaluateOffSite(requestedUrl, finalUrl);
      return {
        count: redirectChain.length,
        chain: [...redirectChain],
        finalUrl,
        offSite,
        offSiteHost,
      };
    },
  };
}

module.exports = { createRedirectTracker, evaluateOffSite };

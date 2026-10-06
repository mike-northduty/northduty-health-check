const { createSiteScope, isUrlInSiteScope } = require('../site-scope');
const { LIMITS } = require('../constants');
const { isTopLevelFrameRequest } = require('../playwright-helpers');

const CRITICAL_RESOURCE_TYPES = new Set([
  'script',
  'stylesheet',
  'font',
]);

const IGNORED_REQUEST_FAILURE_PATTERNS = [
  /ERR_ABORTED/i,
  /ERR_CANCELED/i,
  /NS_BINDING_ABORTED/i,
  /ERR_BLOCKED_BY_CLIENT/i,
];

async function detectBlankPage(page) {
  const metrics = await page.evaluate(() => {
    const body = document.body;
    const bodyText = body?.innerText?.trim() || '';

    if (bodyText.length >= 20) {
      return {
        textLength: bodyText.length,
        hasVisibleContent: true,
        hasImages: false,
        hasCanvas: false,
        hasSvg: false,
        hasVideo: false,
        hasIframes: false,
        hasBackgroundVisuals: false,
        hasBodyBackground: false,
        hasStyledSurface: false,
        hasFormControls: false,
        visibleElementCount: 0,
        shadowHostCount: 0,
        bodyHeight: body?.scrollHeight || 0,
        bodyWidth: body?.scrollWidth || 0,
        fastPath: true,
      };
    }

    const visibleElements = Array.from(document.querySelectorAll('body *'))
      .filter((element) => isVisibleElement(element));

    const hasBackgroundVisuals = visibleElements.some((element) => {
      const style = window.getComputedStyle(element);
      return style.backgroundImage && style.backgroundImage !== 'none';
    });

    const hasBodyBackground = [document.documentElement, document.body].some((element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      return Boolean(style.backgroundImage) && style.backgroundImage !== 'none';
    });

    const hasStyledSurface = visibleElements.some((element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const area = rect.width * rect.height;

      return area >= 64 && (
        hasOpaqueFill(style.backgroundColor) ||
        hasVisibleBorder(style) ||
        style.boxShadow !== 'none'
      );
    });

    const hasFormControls = Array.from(
      document.querySelectorAll('input, select, textarea, button')
    ).some((element) => isVisibleElement(element));

    const shadowHostCount = visibleElements.filter((element) => element.shadowRoot).length;

    return {
      textLength: bodyText.length,
      hasVisibleContent: bodyText.length > 0,
      hasImages: Array.from(document.querySelectorAll('img')).some(
        (img) => isVisibleElement(img) && img.naturalWidth > 0
      ),
      hasCanvas: Array.from(document.querySelectorAll('canvas')).some(
        (c) => isVisibleElement(c) && c.width > 0 && c.height > 0
      ),
      hasSvg: Array.from(document.querySelectorAll('svg')).some(isVisibleElement),
      hasVideo: Array.from(document.querySelectorAll('video')).some(isVisibleElement),
      hasIframes: Array.from(document.querySelectorAll('iframe')).some(isVisibleElement),
      hasBackgroundVisuals,
      hasBodyBackground,
      hasStyledSurface,
      hasFormControls,
      visibleElementCount: visibleElements.length,
      shadowHostCount,
      bodyHeight: body?.scrollHeight || 0,
      bodyWidth: body?.scrollWidth || 0,
    };

    function isVisibleElement(element) {
      if (['SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT'].includes(element.tagName)) {
        return false;
      }

      const style = window.getComputedStyle(element);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0'
      ) {
        return false;
      }

      const rect = element.getBoundingClientRect();
      return rect.width >= 4 && rect.height >= 4;
    }

    function hasOpaqueFill(color) {
      if (!color || color === 'transparent') {
        return false;
      }

      const match = color.match(/rgba?\(([^)]+)\)/i);
      if (!match) {
        return true;
      }

      const parts = match[1].split(',').map((part) => part.trim());
      if (parts.length < 4) {
        return true;
      }

      return Number(parts[3]) > 0;
    }

    function hasVisibleBorder(style) {
      const sides = ['Top', 'Right', 'Bottom', 'Left'];
      return sides.some((side) => (
        parseFloat(style[`border${side}Width`]) > 0 &&
        style[`border${side}Style`] !== 'none'
      ));
    }
  });

  return {
    isBlank: classifyBlankPageMetrics(metrics),
    metrics,
  };
}

function classifyBlankPageMetrics(metrics) {
  const hasVisualSurface =
    metrics.hasImages ||
    metrics.hasCanvas ||
    metrics.hasSvg ||
    metrics.hasVideo ||
    metrics.hasIframes ||
    metrics.hasBackgroundVisuals ||
    metrics.hasBodyBackground ||
    metrics.hasStyledSurface ||
    metrics.hasFormControls ||
    metrics.shadowHostCount > 0;

  return !metrics.hasVisibleContent && !hasVisualSurface;
}

function createResourceTracker() {
  const brokenResources = [];

  const handlers = {
    onRequestFailed: (request) => {
      if (brokenResources.length >= LIMITS.MAX_BROKEN_RESOURCES) return;
      if (!isSignalWorthyFailure(request)) {
        return;
      }

      brokenResources.push({
        url: request.url(),
        resourceType: request.resourceType(),
        error: request.failure()?.errorText || 'Unknown error',
        topLevelFrame: isTopLevelFrameRequest(request),
      });
    },

    onResponse: (response) => {
      if (brokenResources.length >= LIMITS.MAX_BROKEN_RESOURCES) return;
      const status = response.status();
      const request = response.request();

      if (!isSignalWorthyResponse(request, status)) {
        return;
      }

      brokenResources.push({
        url: response.url(),
        resourceType: request.resourceType(),
        status,
        statusText: response.statusText(),
        topLevelFrame: isTopLevelFrameRequest(request),
      });
    },
  };

  return {
    handlers,
    reset: () => { brokenResources.length = 0; },
    getResources: (...siteUrls) => {
      const siteScope = createSiteScope(...siteUrls);
      return brokenResources
        .filter((resource) => resource.topLevelFrame)
        .filter((resource) => isUrlInSiteScope(resource.url, siteScope))
        .map(({ topLevelFrame, ...resource }) => resource);
    },
  };
}

async function collectContentSize(page) {
  const sizes = await page.evaluate(() => {
    const perf = performance.getEntriesByType('navigation')[0];
    if (!perf) return null;

    return {
      size: perf.decodedBodySize,
      encodedSize: perf.encodedBodySize,
      transferSize: perf.transferSize,
    };
  });

  return sizes || { size: null, encodedSize: null, transferSize: null };
}

function isSignalWorthyFailure(request) {
  if (!isCriticalResourceRequest(request)) {
    return false;
  }

  const errorText = request.failure()?.errorText || '';
  return !IGNORED_REQUEST_FAILURE_PATTERNS.some((pattern) => pattern.test(errorText));
}

function isSignalWorthyResponse(request, status) {
  if (status < 400 || !isCriticalResourceRequest(request)) {
    return false;
  }

  if (status === 404 && isFaviconRequest(request.url())) {
    return false;
  }

  return true;
}

function isCriticalResourceRequest(request) {
  if (request.isNavigationRequest() || !isTopLevelFrameRequest(request)) {
    return false;
  }

  return CRITICAL_RESOURCE_TYPES.has(request.resourceType());
}

function isFaviconRequest(url) {
  return /\/favicon(\.[a-z0-9]+)?(\?|$)/i.test(url);
}

module.exports = {
  detectBlankPage,
  classifyBlankPageMetrics,
  createResourceTracker,
  collectContentSize,
  isSignalWorthyFailure,
  isSignalWorthyResponse,
};

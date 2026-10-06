const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyCloudflare } = require('../lib/security/cloudflare');

const NO_MARKERS = {
  jsChallenge: false,
  titleJustAMoment: false,
  challengePlatform: false,
  challengeRunning: false,
  turnstileWidget: false,
  hCaptcha: false,
  cfErrorCode: false,
  titleAccessDenied: false,
  checkingBrowser: false,
  ddosProtection: false,
  rayId: null,
};

test('classifyCloudflare detects a clean non-Cloudflare page as unprotected', () => {
  const result = classifyCloudflare({}, NO_MARKERS, 200);

  assert.equal(result.detected, false);
  assert.equal(result.protected, false);
});

test('classifyCloudflare detects Cloudflare pass-through without marking a challenge', () => {
  const result = classifyCloudflare({ server: 'cloudflare', 'cf-ray': 'abc-AMS' }, NO_MARKERS, 200);

  assert.equal(result.detected, true);
  assert.equal(result.protected, false);
  assert.equal(result.rayId, 'abc-AMS');
});

test('classifyCloudflare treats Turnstile on a healthy page as a widget, not an interstitial', () => {
  const result = classifyCloudflare(
    { server: 'cloudflare' },
    { ...NO_MARKERS, turnstileWidget: true },
    200
  );

  assert.equal(result.detected, true);
  assert.equal(result.protected, false);
  assert.equal(result.details.turnstileWidget, true);
  assert.equal(result.details.captchaChallenge, false);
});

test('classifyCloudflare treats Turnstile with a challenge status as a challenge interstitial', () => {
  const result = classifyCloudflare(
    { server: 'cloudflare', 'cf-ray': 'ray-1' },
    { ...NO_MARKERS, turnstileWidget: true },
    403
  );

  assert.equal(result.detected, true);
  assert.equal(result.protected, true);
  assert.equal(result.details.captchaChallenge, true);
  assert.equal(result.details.blocked, false);
});

test('classifyCloudflare keeps explicit Cloudflare error pages as hard blocks', () => {
  const result = classifyCloudflare(
    { server: 'cloudflare' },
    { ...NO_MARKERS, cfErrorCode: true, titleAccessDenied: true },
    403
  );

  assert.equal(result.detected, true);
  assert.equal(result.protected, true);
  assert.equal(result.details.blocked, true);
  assert.equal(result.details.jsChallenge, false);
  assert.equal(result.details.captchaChallenge, false);
});

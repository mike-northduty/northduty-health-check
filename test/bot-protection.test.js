const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyBotProtection } = require('../lib/security/bot-protection');

const NO_MARKERS = {
  dataDomeChallenge: false,
  perimeterXChallenge: false,
  incapsulaChallenge: false,
  incapsulaBlocked: false,
  akamaiDenied: false,
};

test('classifyBotProtection detects nothing on a clean page', () => {
  const result = classifyBotProtection({}, NO_MARKERS);

  assert.deepEqual(result, {
    detected: false,
    vendor: null,
    challenged: false,
    blocked: false,
    vendors: [],
  });
});

test('classifyBotProtection flags a DataDome captcha as a passable challenge', () => {
  const result = classifyBotProtection(
    { 'x-datadome': 'protected' },
    { ...NO_MARKERS, dataDomeChallenge: true }
  );

  assert.equal(result.detected, true);
  assert.equal(result.vendor, 'datadome');
  assert.equal(result.challenged, true);
  assert.equal(result.blocked, false);
});

test('classifyBotProtection detects DataDome from headers without challenge markers', () => {
  const result = classifyBotProtection({ 'x-datadome': 'protected' }, NO_MARKERS);

  assert.equal(result.detected, true);
  assert.equal(result.challenged, false);
  assert.equal(result.blocked, false);
});

test('classifyBotProtection flags PerimeterX captcha pages as challenges', () => {
  const result = classifyBotProtection({}, { ...NO_MARKERS, perimeterXChallenge: true });

  assert.equal(result.vendor, 'perimeterx');
  assert.equal(result.challenged, true);
});

test('classifyBotProtection treats Imperva challenge resources as passable', () => {
  const result = classifyBotProtection(
    { 'x-iinfo': '1-2-3' },
    { ...NO_MARKERS, incapsulaChallenge: true }
  );

  assert.equal(result.vendor, 'imperva');
  assert.equal(result.challenged, true);
  assert.equal(result.blocked, false);
});

test('classifyBotProtection treats Imperva WAF block pages as hard blocks', () => {
  const result = classifyBotProtection(
    { 'x-iinfo': '1-2-3' },
    { ...NO_MARKERS, incapsulaChallenge: true, incapsulaBlocked: true }
  );

  assert.equal(result.vendor, 'imperva');
  assert.equal(result.challenged, false);
  assert.equal(result.blocked, true);
});

test('classifyBotProtection treats Akamai denials as hard blocks, never challenges', () => {
  const result = classifyBotProtection(
    { server: 'AkamaiGHost' },
    { ...NO_MARKERS, akamaiDenied: true }
  );

  assert.equal(result.vendor, 'akamai');
  assert.equal(result.challenged, false);
  assert.equal(result.blocked, true);
});

test('classifyBotProtection detects Akamai presence from the server header alone', () => {
  const result = classifyBotProtection({ server: 'AkamaiGHost' }, NO_MARKERS);

  assert.equal(result.detected, true);
  assert.equal(result.challenged, false);
  assert.equal(result.blocked, false);
});

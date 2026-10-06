const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createProtocolTracker } = require('../lib/network/protocol');

test('protocol tracker ignores iframe document responses after main-frame navigation', async () => {
  const cdpSession = new EventEmitter();
  cdpSession.send = async (method) => {
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'main-frame' } } };
    }

    return {};
  };
  cdpSession.detach = async () => {};

  const page = {
    context: () => ({
      newCDPSession: async () => cdpSession,
    }),
  };

  const tracker = createProtocolTracker();
  await tracker.setup(page, 'https://example.com');

  cdpSession.emit('Network.responseReceived', {
    frameId: 'main-frame',
    type: 'Document',
    response: { protocol: 'h2' },
  });
  cdpSession.emit('Network.responseReceived', {
    frameId: 'iframe',
    type: 'Document',
    response: { protocol: 'http/1.1' },
  });

  assert.deepEqual(tracker.getProtocol(), { version: 'h2' });

  await tracker.detach();
});

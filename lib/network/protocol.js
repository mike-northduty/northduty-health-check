function createProtocolTracker() {
  let httpVersion = null;
  let cdpSession = null;
  let mainFrameId = null;

  const setup = async (page) => {
    cdpSession = await page.context().newCDPSession(page);
    await cdpSession.send('Page.enable');
    await cdpSession.send('Network.enable');

    try {
      const { frameTree } = await cdpSession.send('Page.getFrameTree');
      mainFrameId = frameTree?.frame?.id || null;
    } catch {
      mainFrameId = null;
    }

    cdpSession.on('Page.frameNavigated', (params) => {
      if (!params.frame.parentId) {
        mainFrameId = params.frame.id;
      }
    });

    cdpSession.on('Network.responseReceived', (params) => {
      if (params.type === 'Document' && (!mainFrameId || params.frameId === mainFrameId)) {
        httpVersion = params.response.protocol || null;
      }
    });
  };

  const getProtocol = () => ({
    version: httpVersion,
  });

  const reset = () => { httpVersion = null; };

  const detach = async () => {
    if (cdpSession) {
      try { await cdpSession.detach(); } catch {}
      cdpSession = null;
    }
  };

  return { setup, getProtocol, reset, detach };
}

module.exports = { createProtocolTracker };

function isTopLevelFrameRequest(request) {
  try {
    const frame = request.frame();
    return Boolean(frame) && frame.parentFrame() === null;
  } catch {
    return false;
  }
}

module.exports = { isTopLevelFrameRequest };

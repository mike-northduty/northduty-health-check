const { LIMITS } = require('../constants');

function createErrorTracker() {
  const jsErrors = [];

  const handlers = {
    onPageError: (error) => {
      if (jsErrors.length >= LIMITS.MAX_JS_ERRORS) return;
      jsErrors.push({
        message: error.message,
        stack: error.stack?.split('\n').slice(0, 3).join('\n'),
      });
    },

    onConsoleError: (msg) => {
      if (jsErrors.length >= LIMITS.MAX_JS_ERRORS) return;
      const text = msg.text();

      if (msg.type() === 'error' && isActionableConsoleError(text)) {
        jsErrors.push({
          type: 'console.error',
          message: text,
        });
      }
    },
  };

  return {
    handlers,
    reset: () => { jsErrors.length = 0; },
    getErrors: () => [...jsErrors],
  };
}

function isActionableConsoleError(message) {
  if (!message) {
    return false;
  }

  return (
    /\buncaught\b/i.test(message) ||
    /\bunhandled\b/i.test(message) ||
    /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError):/i.test(message)
  );
}

module.exports = { createErrorTracker, isActionableConsoleError };

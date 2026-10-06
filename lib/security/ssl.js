const tls = require('tls');
const { TIMEOUTS } = require('../constants');

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
]);

const INCOMPLETE_CHAIN_ERROR_CODES = new Set([
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function buildSslErrorResult(error) {
  const code = error.code || null;
  const result = {
    valid: false,
    error: error.message,
    ...(code && { code }),
    transient: TRANSIENT_ERROR_CODES.has(code),
  };

  if (INCOMPLETE_CHAIN_ERROR_CODES.has(code)) {
    result.incompleteChain = true;
    result.hint = 'The server may be serving an incomplete certificate chain. '
      + 'Browsers that fetch missing intermediates can still load the site, '
      + 'but many other clients will reject the connection.';
  }

  return result;
}

async function checkSSL(hostname, port = 443) {
  return new Promise((resolve) => {
    let resolved = false;
    let socket = null;

    const done = (result) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(hardDeadline);
        resolve(result);
      }
    };

    const hardDeadline = setTimeout(() => {
      if (socket) socket.destroy();
      done({ valid: false, error: 'Connection timeout', transient: true });
    }, TIMEOUTS.SSL_CONNECTION);

    socket = tls.connect(
      {
        host: hostname,
        port,
        servername: hostname,
        rejectUnauthorized: true,
      },
      () => {
        const cert = socket.getPeerCertificate();
        socket.destroy();

        if (!cert || Object.keys(cert).length === 0) {
          done({ valid: false, error: 'No certificate found' });
          return;
        }

        const now = new Date();
        const validTo = new Date(cert.valid_to);

        done({
          valid: true,
          issuer: cert.issuer?.O || null,
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
          daysUntilExpiry: Math.ceil((validTo - now) / (1000 * 60 * 60 * 24)),
        });
      }
    );

    socket.on('error', (err) => {
      socket.destroy();
      done(buildSslErrorResult(err));
    });

    socket.on('close', () => {
      if (!resolved) {
        done({ valid: false, error: 'Connection closed unexpectedly', transient: true });
      }
    });
  });
}

module.exports = {
  checkSSL,

  buildSslErrorResult,
};

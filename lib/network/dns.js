const dns = require('dns').promises;
const { TIMEOUTS } = require('../constants');

async function checkDns(hostname) {
  const result = {
    resolved: false,
    hostname,
    ip: null,
  };

  let timer;
  try {
    const lookupPromise = dns.lookup(hostname);

    lookupPromise.catch(() => {});
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('DNS lookup timeout')), TIMEOUTS.DNS_LOOKUP);
    });

    const { address } = await Promise.race([lookupPromise, timeoutPromise]);
    result.resolved = true;
    result.ip = address;
  } catch (err) {
    result.error = err.code || err.message;
  } finally {
    clearTimeout(timer);
  }

  return result;
}

module.exports = { checkDns };

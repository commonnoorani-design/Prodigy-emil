'use strict';

/**
 * Where this process is actually listening.
 *
 * The MCP tools reach the rest of the app through its own HTTP API, so they
 * need a working address for it. `PORT` is what we asked for; this is what we
 * got, which is the only one worth dialling.
 */
let address = null;

module.exports = {
  set(value) {
    address = value;
  },
  port() {
    return address && typeof address === 'object' ? address.port : null;
  },
};

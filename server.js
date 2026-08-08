'use strict';

// Compatibility entrypoint retained for older deploy configurations.
// The active Cory application is retail-server.js; keeping this tiny shim
// prevents the retired wholesale prototype from being started accidentally.
require('./retail-server');

'use strict';

const { registerCoryCoreApi } = require('./api');
const { processOutbox } = require('./channels');
const { expireHolds } = require('./inventory');
const { ensureCoryCoreSchema } = require('./schema');

async function runWorkerCycle() {
  const results = await Promise.allSettled([expireHolds(), processOutbox()]);
  for (const result of results) {
    if (result.status === 'rejected') console.error('Cory core worker failed:', result.reason && result.reason.message ? result.reason.message : result.reason);
  }
}

function startCoryCoreWorkers() {
  const interval = Math.max(10000, Number(process.env.CORY_WORKER_INTERVAL_MS || 30000));
  const first = setTimeout(() => runWorkerCycle().catch(console.error), 3000);
  const timer = setInterval(() => runWorkerCycle().catch(console.error), interval);
  if (first.unref) first.unref();
  if (timer.unref) timer.unref();
}

module.exports = {
  ensureCoryCoreSchema,
  registerCoryCoreApi,
  startCoryCoreWorkers
};

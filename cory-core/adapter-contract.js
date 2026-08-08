'use strict';

const crypto = require('crypto');
const { CHANNELS } = require('./schema');
const { httpError, text } = require('./identity');

function normalizeChannel(value) {
  const channel = text(value, 30).toUpperCase();
  if (!CHANNELS.includes(channel)) throw httpError('Unsupported channel.', 400, 'UNSUPPORTED_CHANNEL');
  return channel;
}

function inboundEnvelope(input) {
  const channel = normalizeChannel(input.channel);
  const providerEventId = text(input.providerEventId, 300);
  if (!providerEventId) throw httpError('Channel events require a provider event ID.');
  return {
    schemaVersion: 1,
    eventId: text(input.eventId, 300) || crypto.randomUUID(),
    traceId: text(input.traceId, 100) || crypto.randomUUID(),
    channel,
    provider: text(input.provider, 100),
    providerEventId,
    providerThreadId: text(input.providerThreadId, 300),
    locationKey: text(input.locationKey || 'primary', 100),
    from: {
      address: text(input.from && input.from.address, 300),
      subject: text(input.from && input.from.subject, 300)
    },
    occurredAt: input.occurredAt || new Date().toISOString(),
    content: {
      kind: text(input.content && input.content.kind || 'TEXT', 30).toUpperCase(),
      text: text(input.content && input.content.text, 10000)
    },
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {}
  };
}

function validateAdapter(adapter) {
  const required = ['verifyWebhook', 'normalize', 'send', 'normalizeStatusCallback', 'capabilities'];
  for (const method of required) {
    if (!adapter || typeof adapter[method] !== 'function') throw new TypeError(`Channel adapter is missing ${method}().`);
  }
  if (typeof adapter.policyEnabled !== 'boolean') throw new TypeError('Channel adapter must declare policyEnabled.');
  return adapter;
}

module.exports = {
  inboundEnvelope,
  normalizeChannel,
  validateAdapter
};

'use strict';

const { text } = require('./identity');

function pickupPlan(body, now = new Date()) {
  const label = text(body && body.pickupWindow || 'ASAP', 100) || 'ASAP';
  const isAsap = label.toUpperCase() === 'ASAP';
  if (isAsap) {
    return {
      label,
      status: 'CONFIRMED',
      pickupAt: null,
      holdExpiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000)
    };
  }

  const parsed = body && body.pickupAt ? new Date(body.pickupAt) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() < now.getTime() - 5 * 60 * 1000) {
    return {
      label,
      status: 'NEEDS_CLARIFICATION',
      pickupAt: null,
      holdExpiresAt: null
    };
  }

  return {
    label,
    status: 'CONFIRMED',
    pickupAt: parsed,
    holdExpiresAt: new Date(parsed.getTime() + 60 * 60 * 1000)
  };
}

module.exports = { pickupPlan };

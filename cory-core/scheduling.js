'use strict';

const { text } = require('./identity');

const STORE_TIME_ZONE = 'America/Los_Angeles';

function storeDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: STORE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const pick = (type) => (parts.find((part) => part.type === type) || {}).value || '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

function sameStoreDay(left, right) {
  const leftKey = storeDateKey(left);
  return Boolean(leftKey && leftKey === storeDateKey(right));
}

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
      holdExpiresAt: null,
      clarificationReason: 'INVALID_OR_PAST'
    };
  }

  if (!sameStoreDay(parsed, now)) {
    return {
      label,
      status: 'NEEDS_CLARIFICATION',
      pickupAt: null,
      holdExpiresAt: null,
      clarificationReason: 'SAME_DAY_ONLY'
    };
  }

  return {
    label,
    status: 'CONFIRMED',
    pickupAt: parsed,
    holdExpiresAt: new Date(parsed.getTime() + 60 * 60 * 1000)
  };
}

module.exports = { STORE_TIME_ZONE, pickupPlan, sameStoreDay, storeDateKey };

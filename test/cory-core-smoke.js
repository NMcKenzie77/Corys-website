'use strict';

const assert = require('node:assert/strict');
const { classifyIdentityMatches, normalizeEmail, normalizePhone } = require('../cory-core/identity');
const { containsSensitiveData, extractReservationCode, inferIntent, normalizeInboundEmail, redactSensitiveText } = require('../cory-core/inbound');
const { explicitAgeAttestation, explicitConfirmation, parseExplicitStorePickupTime } = require('../cory-core/email-agent');
const { EXPIRABLE_STATUSES } = require('../cory-core/inventory');
const { waypoint } = require('../cory-core/maps');
const { TRANSITIONS, normalizeRequestedItems } = require('../cory-core/reservations');
const { pickupPlan } = require('../cory-core/scheduling');

const now = new Date('2026-08-08T16:00:00.000Z');

assert.equal(normalizeEmail('  Customer@Example.COM '), 'customer@example.com');
assert.equal(normalizePhone('(206) 555-0199'), '+12065550199');
assert.equal(normalizePhone('+1 206 555 0199'), '+12065550199');

const emailEvent = normalizeInboundEmail({
  provider: 'resend',
  messageId: 'email_123',
  threadId: 'thread_456',
  from: 'Customer <customer@example.com>',
  subject: 'Change CRY-20260808-A1B2C3',
  text: 'Please remove one item from CRY-20260808-A1B2C3.'
});
assert.equal(emailEvent.from, 'customer@example.com');
assert.equal(emailEvent.providerEventId, 'email_123');
assert.equal(emailEvent.providerThreadId, 'thread_456');
assert.equal(extractReservationCode(emailEvent.bodyText), 'CRY-20260808-A1B2C3');
assert.equal(inferIntent(emailEvent.bodyText, 'CRY-20260808-A1B2C3'), 'CHANGE_RESERVATION');
assert.equal(containsSensitiveData('card 4242 4242 4242 4242'), true);
assert.match(redactSensitiveText('card 4242 4242 4242 4242'), /PAYMENT DATA REDACTED/);

assert.equal(explicitConfirmation('CONFIRM'), true);
assert.equal(explicitConfirmation('I AM 21+ AND CONFIRM'), true);
assert.equal(explicitConfirmation('sounds good'), false);
assert.equal(explicitAgeAttestation('I am 21+'), true);
assert.equal(explicitAgeAttestation('I am not 21+'), false);
assert.equal(parseExplicitStorePickupTime('Pickup at 10:30 AM', now).toISOString(), '2026-08-08T17:30:00.000Z');
assert.equal(parseExplicitStorePickupTime('pickup later', now), null);

const asap = pickupPlan({ pickupWindow: 'ASAP' }, now);
assert.equal(asap.status, 'CONFIRMED');
assert.equal(asap.holdExpiresAt.toISOString(), '2026-08-08T18:00:00.000Z');

const scheduled = pickupPlan({ pickupWindow: '5:00 PM', pickupAt: '2026-08-08T17:00:00.000Z' }, now);
assert.equal(scheduled.status, 'CONFIRMED');
assert.equal(scheduled.holdExpiresAt.toISOString(), '2026-08-08T18:00:00.000Z');

const unclear = pickupPlan({ pickupWindow: 'Later today' }, now);
assert.equal(unclear.status, 'NEEDS_CLARIFICATION');
assert.equal(unclear.holdExpiresAt, null);

const nextDay = pickupPlan({ pickupWindow: 'Later today', pickupAt: '2026-08-09T17:00:00.000Z' }, now);
assert.equal(nextDay.status, 'NEEDS_CLARIFICATION');
assert.equal(nextDay.clarificationReason, 'SAME_DAY_ONLY');
assert.equal(nextDay.holdExpiresAt, null);

assert.deepEqual(normalizeRequestedItems([{ variantId: 7, quantity: 2 }]), [{ variantId: 7, quantity: 2 }]);
assert.throws(() => normalizeRequestedItems([{ variantId: 7, quantity: 0 }]), /whole number from 1 to 99/);
assert.throws(() => normalizeRequestedItems([{ variantId: 7, quantity: 1 }, { variantId: 7, quantity: 1 }]), /only once/);

assert.deepEqual(classifyIdentityMatches([10, 11], [{ identity_id: 10, customer_id: 3 }]), { customerIds: [3], partialMatch: true });
assert.deepEqual(classifyIdentityMatches([10, 11], [
  { identity_id: 10, customer_id: 3 },
  { identity_id: 11, customer_id: 3 }
]), { customerIds: [3], partialMatch: false });

assert.ok(EXPIRABLE_STATUSES.includes('PICKING'));
assert.ok(EXPIRABLE_STATUSES.includes('READY'));
assert.ok(TRANSITIONS.PICKING.includes('EXPIRED'));

assert.deepEqual(waypoint({ placeId: 'ChIJ-test' }), { placeId: 'ChIJ-test' });
assert.deepEqual(waypoint({ latitude: 47.61, longitude: -122.33 }), {
  location: { latLng: { latitude: 47.61, longitude: -122.33 } }
});
assert.deepEqual(waypoint({ address: '123 Main St, Seattle, WA' }), { address: '123 Main St, Seattle, WA' });

console.log('Cory core smoke tests passed.');

'use strict';

const assert = require('node:assert/strict');
const { classifyIdentityMatches, normalizeEmail, normalizePhone } = require('../cory-core/identity');
const { EXPIRABLE_STATUSES, assertAdjustmentRespectsHolds, stockStatus } = require('../cory-core/inventory');
const { waypoint } = require('../cory-core/maps');
const { TRANSITIONS, normalizeRequestedItems } = require('../cory-core/reservations');
const { pickupPlan } = require('../cory-core/scheduling');

const now = new Date('2026-08-08T16:00:00.000Z');

assert.equal(normalizeEmail('  Customer@Example.COM '), 'customer@example.com');
assert.equal(normalizePhone('(206) 555-0199'), '+12065550199');
assert.equal(normalizePhone('+1 206 555 0199'), '+12065550199');

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

assert.equal(stockStatus(6, 5), 'AVAILABLE');
assert.equal(stockStatus(5, 5), 'LOW STOCK');
assert.equal(stockStatus(0, 5), 'LOW STOCK');
assert.doesNotThrow(() => assertAdjustmentRespectsHolds(5, 5));
assert.throws(() => assertAdjustmentRespectsHolds(4, 5), /currently held for pickup reservations/);

assert.deepEqual(waypoint({ placeId: 'ChIJ-test' }), { placeId: 'ChIJ-test' });
assert.deepEqual(waypoint({ latitude: 47.61, longitude: -122.33 }), {
  location: { latLng: { latitude: 47.61, longitude: -122.33 } }
});
assert.deepEqual(waypoint({ address: '123 Main St, Seattle, WA' }), { address: '123 Main St, Seattle, WA' });

console.log('Cory core smoke tests passed.');

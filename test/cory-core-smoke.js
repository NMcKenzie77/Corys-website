'use strict';

const assert = require('node:assert/strict');
const { normalizeEmail, normalizePhone } = require('../cory-core/identity');
const { waypoint } = require('../cory-core/maps');
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

assert.deepEqual(waypoint({ placeId: 'ChIJ-test' }), { placeId: 'ChIJ-test' });
assert.deepEqual(waypoint({ latitude: 47.61, longitude: -122.33 }), {
  location: { latLng: { latitude: 47.61, longitude: -122.33 } }
});
assert.deepEqual(waypoint({ address: '123 Main St, Seattle, WA' }), { address: '123 Main St, Seattle, WA' });

console.log('Cory core smoke tests passed.');

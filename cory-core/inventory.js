'use strict';

const { pool, withTransaction } = require('../db');
const { httpError, text } = require('./identity');

async function loadVariantsForUpdate(client, locationId, requested) {
  const ids = [...new Set(requested.map((item) => Number(item.variantId)))];
  const result = await client.query(`
    SELECT
      v.*,
      p.id AS product_id,
      p.name AS product_name,
      p.active AS product_active,
      COALESCE((
        SELECT SUM(h.quantity)::int
        FROM retail_inventory_holds h
        WHERE h.location_id=$2 AND h.variant_id=v.id AND h.state='ACTIVE' AND h.expires_at>NOW()
      ),0) AS held_qty
    FROM product_variants v
    JOIN products p ON p.id=v.product_id
    WHERE v.id=ANY($1::bigint[])
    FOR UPDATE OF v
  `, [ids, locationId]);

  const byId = new Map(result.rows.map((row) => [Number(row.id), row]));
  return requested.map((item) => {
    const row = byId.get(Number(item.variantId));
    if (!row || !row.active || !row.product_active) {
      throw httpError('A selected product is no longer available.', 409, 'PRODUCT_UNAVAILABLE');
    }
    const quantity = Number(item.quantity);
    const available = Number(row.inventory_qty) - Number(row.held_qty || 0);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw httpError('Invalid reservation quantity.');
    if (available < quantity) {
      throw httpError(`${row.product_name} ${row.label} has only ${Math.max(0, available)} available to reserve.`, 409, 'INSUFFICIENT_STOCK');
    }
    const unitPrice = row.sale_price_cents == null
      ? Number(row.price_cents)
      : Math.min(Number(row.price_cents), Number(row.sale_price_cents));
    return { row, quantity, available, unitPrice, lineTotal: unitPrice * quantity };
  });
}

async function availableAfterHold(client, locationId, variantId) {
  const result = await client.query(`
    SELECT v.inventory_qty - COALESCE((
      SELECT SUM(h.quantity)::int FROM retail_inventory_holds h
      WHERE h.location_id=$1 AND h.variant_id=v.id AND h.state='ACTIVE' AND h.expires_at>NOW()
    ),0) AS available
    FROM product_variants v WHERE v.id=$2
  `, [locationId, variantId]);
  return result.rowCount ? Number(result.rows[0].available) : null;
}

async function createHolds(client, options) {
  const holds = [];
  for (const item of options.items) {
    const key = `${options.idempotencyKey}:hold:${item.row.id}`;
    const result = await client.query(`
      INSERT INTO retail_inventory_holds(
        location_id,order_id,variant_id,quantity,state,expires_at,source_message_id,idempotency_key
      ) VALUES($1,$2,$3,$4,'ACTIVE',$5,$6,$7)
      ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
      RETURNING *
    `, [options.locationId, options.orderId, item.row.id, item.quantity, options.expiresAt, options.sourceMessageId || null, key]);
    const hold = result.rows[0];
    const available = await availableAfterHold(client, options.locationId, item.row.id);
    await client.query(`
      INSERT INTO retail_inventory_ledger(
        location_id,variant_id,event_type,quantity_delta,quantity_after,order_id,hold_id,actor_type,actor_ref,reason,reference
      ) VALUES($1,$2,'HOLD',$3,$4,$5,$6,$7,$8,$9,$10)
    `, [
      options.locationId,
      item.row.id,
      -item.quantity,
      available,
      options.orderId,
      hold.id,
      options.actorType || 'CUSTOMER',
      text(options.actorRef, 200),
      'Pickup reservation inventory hold',
      options.idempotencyKey
    ]);
    holds.push(hold);
  }
  return holds;
}

async function releaseOrderHolds(client, orderId, actorRef, reason) {
  const holds = await client.query(`
    SELECT * FROM retail_inventory_holds
    WHERE order_id=$1 AND state='ACTIVE'
    ORDER BY id
    FOR UPDATE
  `, [orderId]);

  for (const hold of holds.rows) {
    await client.query(`
      UPDATE retail_inventory_holds SET state='RELEASED',released_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND state='ACTIVE'
    `, [hold.id]);
    const available = await availableAfterHold(client, hold.location_id, hold.variant_id);
    await client.query(`
      INSERT INTO retail_inventory_ledger(
        location_id,variant_id,event_type,quantity_delta,quantity_after,order_id,hold_id,actor_type,actor_ref,reason,reference
      ) VALUES($1,$2,'RELEASE',$3,$4,$5,$6,'SYSTEM',$7,$8,$9)
    `, [hold.location_id, hold.variant_id, hold.quantity, available, orderId, hold.id, text(actorRef, 200), text(reason, 1000), `release:${hold.id}`]);
  }
  return holds.rowCount;
}

async function consumeOrderHolds(client, orderId, actorRef, completionReference) {
  const holds = await client.query(`
    SELECT h.*,v.inventory_qty
    FROM retail_inventory_holds h
    JOIN product_variants v ON v.id=h.variant_id
    WHERE h.order_id=$1 AND h.state='ACTIVE'
    ORDER BY h.id
    FOR UPDATE OF h,v
  `, [orderId]);

  if (!holds.rowCount) throw httpError('No active inventory hold exists for this reservation.', 409, 'MISSING_HOLD');
  for (const hold of holds.rows) {
    if (Number(hold.inventory_qty) < Number(hold.quantity)) {
      throw httpError('Physical inventory is lower than the held quantity. Staff reconciliation is required.', 409, 'INVENTORY_MISMATCH');
    }
    await client.query('UPDATE product_variants SET inventory_qty=inventory_qty-$1,updated_at=NOW() WHERE id=$2', [hold.quantity, hold.variant_id]);
    await client.query(`
      UPDATE retail_inventory_holds SET state='CONSUMED',consumed_at=NOW(),updated_at=NOW()
      WHERE id=$1
    `, [hold.id]);
    const available = await availableAfterHold(client, hold.location_id, hold.variant_id);
    await client.query(`
      INSERT INTO retail_inventory_ledger(
        location_id,variant_id,event_type,quantity_delta,quantity_after,order_id,hold_id,actor_type,actor_ref,reason,reference
      ) VALUES($1,$2,'PICKUP_COMPLETE',0,$3,$4,$5,'STAFF',$6,'Pickup completed in store',$7)
    `, [hold.location_id, hold.variant_id, available, orderId, hold.id, text(actorRef, 200), text(completionReference, 200)]);
  }
  return holds.rowCount;
}

async function adjustInventory(options) {
  const quantityDelta = Number(options.quantityDelta);
  if (!Number.isInteger(quantityDelta) || quantityDelta === 0) throw httpError('Inventory adjustment must be a non-zero whole number.');
  const reason = text(options.reason, 1000);
  if (!reason) throw httpError('Inventory adjustments require a reason.');
  const requestedType = text(options.eventType || 'ADJUSTMENT', 30).toUpperCase();
  if (!['RECEIVE','ADJUSTMENT','DAMAGE'].includes(requestedType)) throw httpError('Inventory event type must be RECEIVE, ADJUSTMENT, or DAMAGE.');
  if (requestedType === 'RECEIVE' && quantityDelta < 1) throw httpError('Receiving inventory must increase on-hand quantity.');
  if (requestedType === 'DAMAGE' && quantityDelta > -1) throw httpError('Damage inventory events must reduce on-hand quantity.');

  return withTransaction(async (client) => {
    const variant = await client.query('SELECT * FROM product_variants WHERE id=$1 FOR UPDATE', [options.variantId]);
    if (!variant.rowCount) throw httpError('Package not found.', 404);
    const nextQty = Number(variant.rows[0].inventory_qty) + quantityDelta;
    if (nextQty < 0) throw httpError('Adjustment would make on-hand inventory negative.', 409);
    await client.query('UPDATE product_variants SET inventory_qty=$1,updated_at=NOW() WHERE id=$2', [nextQty, options.variantId]);
    const available = await availableAfterHold(client, options.locationId, options.variantId);
    const eventType = requestedType;
    await client.query(`
      INSERT INTO retail_inventory_ledger(
        location_id,variant_id,event_type,quantity_delta,quantity_after,actor_type,actor_ref,reason,reference
      ) VALUES($1,$2,$3,$4,$5,'STAFF',$6,$7,$8)
      RETURNING *
    `, [options.locationId, options.variantId, eventType, quantityDelta, available, text(options.actorRef, 200), reason, text(options.reference, 200)]);
    return { onHand: nextQty, available };
  });
}

async function expireHolds() {
  if (!process.env.DATABASE_URL) return { expired: 0 };
  const due = await pool.query(`
    SELECT DISTINCT order_id
    FROM retail_inventory_holds
    WHERE state='ACTIVE' AND expires_at<=NOW()
    ORDER BY order_id
    LIMIT 100
  `);
  let expired = 0;
  for (const row of due.rows) {
    await withTransaction(async (client) => {
      const order = await client.query('SELECT * FROM retail_orders WHERE id=$1 FOR UPDATE', [row.order_id]);
      if (!order.rowCount || !['CONFIRMED','NEW','NEEDS_CLARIFICATION'].includes(order.rows[0].status)) return;
      await releaseOrderHolds(client, row.order_id, 'hold-expiry-worker', 'Reservation hold expired');
      await client.query(`UPDATE retail_orders SET status='EXPIRED',version=version+1,updated_at=NOW() WHERE id=$1`, [row.order_id]);
      await client.query(`INSERT INTO retail_order_history(order_id,status,note,changed_by) VALUES($1,'EXPIRED','Inventory hold expired','system')`, [row.order_id]);
      await client.query(`INSERT INTO retail_audit_events(actor_type,actor_ref,action,entity_type,entity_id,after_json,reference)
        VALUES('SYSTEM','hold-expiry-worker','RESERVATION_EXPIRED','RESERVATION',$1,$2::jsonb,$3)`, [String(row.order_id), JSON.stringify({ status: 'EXPIRED' }), `order:${row.order_id}`]);
      expired += 1;
    });
  }
  return { expired };
}

module.exports = {
  adjustInventory,
  consumeOrderHolds,
  createHolds,
  expireHolds,
  loadVariantsForUpdate,
  releaseOrderHolds
};

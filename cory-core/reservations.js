'use strict';

const crypto = require('crypto');
const { pool, withTransaction } = require('../db');
const { httpError, resolveCustomer, text } = require('./identity');
const {
  consumeOrderHolds,
  createHolds,
  loadVariantsForUpdate,
  releaseOrderHolds
} = require('./inventory');

const TRANSITIONS = {
  NEW: ['NEEDS_CLARIFICATION','CONFIRMED','CANCELLED','REJECTED'],
  NEEDS_CLARIFICATION: ['CONFIRMED','CANCELLED','REJECTED'],
  CONFIRMED: ['PICKING','CANCELLED','EXPIRED'],
  PICKING: ['READY','CANCELLED'],
  READY: ['COMPLETED','CANCELLED','EXPIRED'],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
  REJECTED: []
};

function bool(value) {
  return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

function reservationCode() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `CRY-${date}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeRequestMetadata(meta) {
  return {
    clientIpHash: meta.ip ? sha256(meta.ip).slice(0, 24) : '',
    userAgent: text(meta.userAgent, 300),
    sourcePath: text(meta.sourcePath || '/pickup', 200)
  };
}

function pickupPlan(body) {
  const label = text(body.pickupWindow || 'ASAP', 100) || 'ASAP';
  const isAsap = label.toUpperCase() === 'ASAP';
  if (isAsap) {
    return {
      label,
      status: 'CONFIRMED',
      pickupAt: null,
      holdExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000)
    };
  }

  const parsed = body.pickupAt ? new Date(body.pickupAt) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() < Date.now() - 5 * 60 * 1000) {
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

async function primaryLocation(client) {
  const result = await client.query(`SELECT * FROM retail_locations WHERE location_key='primary' AND active=TRUE LIMIT 1`);
  if (!result.rowCount) throw httpError('Store location is not configured.', 503, 'STORE_NOT_CONFIGURED');
  return result.rows[0];
}

async function recordIngress(options) {
  const traceId = crypto.randomUUID();
  const payloadHash = sha256(JSON.stringify(options.body || {}));
  const result = await pool.query(`
    INSERT INTO retail_channel_events(
      trace_id,channel,provider,provider_event_id,provider_thread_id,location_id,payload_hash,safe_metadata,status
    )
    SELECT $1::uuid,'WEB','cory-web',$2,'',l.id,$3,$4::jsonb,'RECEIVED'
    FROM retail_locations l WHERE l.location_key='primary'
    ON CONFLICT(provider,channel,provider_event_id) DO UPDATE SET provider_event_id=EXCLUDED.provider_event_id
    RETURNING *
  `, [traceId, options.eventId, payloadHash, JSON.stringify(safeRequestMetadata(options.meta || {}))]);
  if (!result.rowCount) throw httpError('Store location is not configured.', 503);
  return result.rows[0];
}

async function priorResult(eventId) {
  const result = await pool.query(`
    SELECT result_json FROM retail_idempotency_keys
    WHERE scope='WEB_RESERVATION' AND idempotency_key=$1
    LIMIT 1
  `, [eventId]);
  return result.rowCount ? result.rows[0].result_json : null;
}

async function createWebsiteReservation(body, meta = {}) {
  if (!bool(body.ageConfirmed)) throw httpError('You must confirm that you are 21 or older.');
  if (!bool(body.privacyAccepted)) throw httpError('Review and accept the Privacy Notice and Terms.');
  if (!text(body.email, 200) || !text(body.phone, 80)) throw httpError('Website pickup requires both email and phone contact information.');
  const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
  if (!items.length) throw httpError('Choose at least one product.');

  const eventId = text(meta.idempotencyKey || body.clientRequestId, 200) || crypto.randomUUID();
  const ingress = await recordIngress({ eventId, body, meta });
  if (ingress.status === 'PROCESSED') {
    const previous = await priorResult(eventId);
    if (previous) return { ...previous, duplicate: true };
  }

  try {
    const result = await withTransaction(async (client) => {
      const event = await client.query('SELECT * FROM retail_channel_events WHERE id=$1 FOR UPDATE', [ingress.id]);
      if (!event.rowCount) throw httpError('Inbound reservation event disappeared.', 500);

      const already = await client.query(`
        SELECT result_json FROM retail_idempotency_keys
        WHERE scope='WEB_RESERVATION' AND idempotency_key=$1
      `, [eventId]);
      if (already.rowCount) return already.rows[0].result_json;

      const location = await primaryLocation(client);
      const identity = await resolveCustomer(client, {
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: body.phone,
        locationId: location.id,
        source: 'website'
      });

      const conversation = await client.query(`
        INSERT INTO retail_conversations(customer_id,location_id,source_channel,state,context_json)
        VALUES($1,$2,'WEB','OPEN',$3::jsonb)
        RETURNING *
      `, [identity.customer.id, location.id, JSON.stringify({ requestType: 'PICKUP_RESERVATION' })]);

      const incoming = await client.query(`
        INSERT INTO retail_messages(conversation_id,channel_event_id,channel,direction,normalized_body,intent,entities_json,confidence)
        VALUES($1,$2,'WEB','INBOUND',$3,'CREATE_RESERVATION',$4::jsonb,1.0)
        RETURNING *
      `, [
        conversation.rows[0].id,
        ingress.id,
        `Website pickup request with ${items.length} line item(s).`,
        JSON.stringify({
          itemCount: items.length,
          pickupWindow: text(body.pickupWindow || 'ASAP', 100),
          explicitlyConfirmed: true,
          age21Attested: true
        })
      ]);

      const requested = items.map((item) => ({
        variantId: Number(item.variantId),
        quantity: Math.max(1, Math.min(99, Number(item.quantity) || 0))
      }));
      if (requested.some((item) => !Number.isInteger(item.variantId) || item.variantId < 1)) throw httpError('Invalid product selection.');

      const resolved = await loadVariantsForUpdate(client, location.id, requested);
      const total = resolved.reduce((sum, item) => sum + item.lineTotal, 0);
      const plan = pickupPlan(body);
      const code = reservationCode();
      const order = await client.query(`
        INSERT INTO retail_orders(
          order_number,customer_id,status,subtotal_cents,total_cents,pickup_window,customer_notes,
          age_confirmed_at,kind,reservation_code,source_channel,location_id,pickup_window_start,
          pickup_window_end,expires_at,eligibility_attested_at,origin_conversation_id
        ) VALUES(
          $1,$2,$3,$4,$4,$5,$6,NOW(),'PICKUP_RESERVATION',$1,'WEB',$7,$8,$9,$10,NOW(),$11
        )
        RETURNING *
      `, [
        code,
        identity.customer.id,
        plan.status,
        total,
        plan.label,
        text(body.notes, 2000),
        location.id,
        plan.pickupAt,
        plan.pickupAt ? new Date(plan.pickupAt.getTime() + 30 * 60 * 1000) : null,
        plan.holdExpiresAt,
        conversation.rows[0].id
      ]);

      for (const item of resolved) {
        await client.query(`
          INSERT INTO retail_order_items(
            order_id,product_id,variant_id,product_name,variant_label,sku,quantity,unit_price_cents,line_total_cents
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `, [order.rows[0].id, item.row.product_id, item.row.id, item.row.product_name, item.row.label, item.row.sku, item.quantity, item.unitPrice, item.lineTotal]);
      }

      if (plan.status === 'CONFIRMED') {
        await createHolds(client, {
          locationId: location.id,
          orderId: order.rows[0].id,
          items: resolved,
          expiresAt: plan.holdExpiresAt,
          sourceMessageId: incoming.rows[0].id,
          idempotencyKey: eventId,
          actorType: 'CUSTOMER',
          actorRef: `customer:${identity.customer.id}`
        });
        await client.query(`
          INSERT INTO retail_picking_tasks(order_id,location_id,status)
          VALUES($1,$2,'OPEN') ON CONFLICT(order_id) DO NOTHING
        `, [order.rows[0].id, location.id]);
      } else {
        await client.query(`
          INSERT INTO retail_escalations(conversation_id,order_id,reason,details,priority)
          VALUES($1,$2,'PICKUP_TIME_REQUIRED','Scheduled pickup needs an exact pickup time before inventory can be held.','NORMAL')
        `, [conversation.rows[0].id, order.rows[0].id]);
      }

      await client.query(`
        INSERT INTO retail_conversation_orders(conversation_id,order_id,relationship)
        VALUES($1,$2,'CREATE')
      `, [conversation.rows[0].id, order.rows[0].id]);

      await client.query(`
        INSERT INTO retail_order_history(order_id,status,note,changed_by)
        VALUES($1,$2,$3,'customer')
      `, [order.rows[0].id, plan.status, plan.status === 'CONFIRMED' ? 'Website pickup reservation confirmed' : 'Exact scheduled pickup time required']);

      const emailIdentity = identity.identities.find((item) => item.identity_kind === 'EMAIL');
      await client.query(`
        INSERT INTO retail_consents(customer_id,identity_id,channel,purpose,status,source,evidence_ref,policy_version,granted_at)
        VALUES($1,$2,'WEB','TRANSACTIONAL','GRANTED','pickup-reservation',$3,'2026-08-08',NOW())
      `, [identity.customer.id, emailIdentity ? emailIdentity.id : null, `event:${ingress.id}`]);

      if (bool(body.marketingConsent)) {
        await client.query(`
          INSERT INTO retail_consents(customer_id,identity_id,channel,purpose,status,source,evidence_ref,policy_version,granted_at)
          VALUES($1,$2,'EMAIL','MARKETING','GRANTED','website-checkbox',$3,'2026-08-08',NOW())
        `, [identity.customer.id, emailIdentity ? emailIdentity.id : null, `event:${ingress.id}`]);
        await client.query(`UPDATE retail_customers SET marketing_opt_in=TRUE,marketing_opted_in_at=COALESCE(marketing_opted_in_at,NOW()),updated_at=NOW() WHERE id=$1 AND unsubscribed_at IS NULL`, [identity.customer.id]);
      }

      if (emailIdentity) {
        await client.query(`
          INSERT INTO retail_outbox(
            conversation_id,order_id,channel,recipient_identity_id,event_type,payload,idempotency_key
          ) VALUES($1,$2,'EMAIL',$3,$4,$5::jsonb,$6)
          ON CONFLICT(idempotency_key) DO NOTHING
        `, [
          conversation.rows[0].id,
          order.rows[0].id,
          emailIdentity.id,
          plan.status === 'CONFIRMED' ? 'RESERVATION_CONFIRMED' : 'RESERVATION_NEEDS_CLARIFICATION',
          JSON.stringify({
            to: identity.email,
            reservationCode: code,
            pickupWindow: plan.label,
            status: plan.status,
            holdExpiresAt: plan.holdExpiresAt ? plan.holdExpiresAt.toISOString() : null
          }),
          `${eventId}:confirmation-email`
        ]);
      }

      const response = {
        ok: true,
        reservationCode: code,
        orderNumber: code,
        status: plan.status,
        pickupWindow: plan.label,
        holdExpiresAt: plan.holdExpiresAt ? plan.holdExpiresAt.toISOString() : null,
        needsClarification: plan.status === 'NEEDS_CLARIFICATION',
        message: plan.status === 'CONFIRMED'
          ? 'Pickup reservation confirmed. Payment and final sale happen in the store.'
          : 'Tell us your exact pickup time so we can place the inventory hold.'
      };

      await client.query(`
        INSERT INTO retail_audit_events(
          trace_id,actor_type,actor_ref,action,entity_type,entity_id,after_json,reference,policy_version
        ) VALUES($1,'CUSTOMER',$2,'RESERVATION_CREATED','RESERVATION',$3,$4::jsonb,$5,'pickup-v1')
      `, [ingress.trace_id, `customer:${identity.customer.id}`, String(order.rows[0].id), JSON.stringify({ status: plan.status, sourceChannel: 'WEB' }), `event:${ingress.id}`]);

      await client.query(`
        INSERT INTO retail_idempotency_keys(scope,idempotency_key,action,entity_type,entity_id,result_json,expires_at)
        VALUES('WEB_RESERVATION',$1,'CREATE_RESERVATION','RESERVATION',$2,$3::jsonb,NOW()+INTERVAL '30 days')
      `, [eventId, order.rows[0].id, JSON.stringify(response)]);
      await client.query(`UPDATE retail_channel_events SET status='PROCESSED',processed_at=NOW() WHERE id=$1`, [ingress.id]);
      return response;
    });
    return result;
  } catch (error) {
    const eventStatus = error.code === 'IDENTITY_AMBIGUOUS' ? 'NEEDS_STAFF' : (error.status && error.status < 500 ? 'REJECTED' : 'FAILED');
    await pool.query(`UPDATE retail_channel_events SET status=$1,processed_at=NOW() WHERE id=$2`, [eventStatus, ingress.id]).catch(() => {});
    if (eventStatus === 'NEEDS_STAFF') {
      await pool.query(`
        INSERT INTO retail_escalations(reason,details,priority)
        VALUES('IDENTITY_AMBIGUOUS',$1,'HIGH')
      `, [text(error.message, 1000)]).catch(() => {});
    }
    throw error;
  }
}

async function legacyRestoreInventory(client, orderId) {
  const order = await client.query('SELECT inventory_restored FROM retail_orders WHERE id=$1 FOR UPDATE', [orderId]);
  if (!order.rowCount || order.rows[0].inventory_restored) return;
  const items = await client.query('SELECT variant_id,quantity FROM retail_order_items WHERE order_id=$1', [orderId]);
  for (const item of items.rows) {
    if (item.variant_id) await client.query('UPDATE product_variants SET inventory_qty=inventory_qty+$1,updated_at=NOW() WHERE id=$2', [item.quantity, item.variant_id]);
  }
  await client.query('UPDATE retail_orders SET inventory_restored=TRUE WHERE id=$1', [orderId]);
}

async function confirmExistingReservation(client, order, body, actorRef) {
  const itemRows = await client.query('SELECT variant_id,quantity FROM retail_order_items WHERE order_id=$1 ORDER BY id', [order.id]);
  const requested = itemRows.rows.map((row) => ({ variantId: Number(row.variant_id), quantity: Number(row.quantity) }));
  const resolved = await loadVariantsForUpdate(client, order.location_id, requested);
  const isAsap = text(body.pickupWindow || order.pickup_window, 100).toUpperCase() === 'ASAP';
  let pickupAt = body.pickupAt ? new Date(body.pickupAt) : (order.pickup_window_start ? new Date(order.pickup_window_start) : null);
  if (!isAsap && (!pickupAt || Number.isNaN(pickupAt.getTime()))) throw httpError('An exact scheduled pickup time is required before confirmation.');
  if (pickupAt && pickupAt.getTime() < Date.now() - 5 * 60 * 1000) throw httpError('Pickup time must be in the future.');
  const expiresAt = isAsap ? new Date(Date.now() + 2 * 60 * 60 * 1000) : new Date(pickupAt.getTime() + 60 * 60 * 1000);
  await createHolds(client, {
    locationId: order.location_id,
    orderId: order.id,
    items: resolved,
    expiresAt,
    idempotencyKey: `staff-confirm:${order.id}:v${order.version}`,
    actorType: 'STAFF',
    actorRef
  });
  await client.query(`
    INSERT INTO retail_picking_tasks(order_id,location_id,status)
    VALUES($1,$2,'OPEN') ON CONFLICT(order_id) DO NOTHING
  `, [order.id, order.location_id]);
  return { expiresAt, pickupAt, pickupWindow: isAsap ? 'ASAP' : text(body.pickupWindow || order.pickup_window, 100) };
}

async function transitionReservation(id, body, actorRef) {
  const target = text(body.status, 40).toUpperCase();
  return withTransaction(async (client) => {
    const current = await client.query('SELECT * FROM retail_orders WHERE id=$1 FOR UPDATE', [id]);
    if (!current.rowCount) throw httpError('Pickup reservation not found.', 404);
    const order = current.rows[0];
    const allowed = TRANSITIONS[order.status] || [];
    if (!allowed.includes(target)) throw httpError(`Cannot move ${order.status} to ${target}.`, 409, 'INVALID_TRANSITION');
    if (body.version != null && Number(body.version) !== Number(order.version)) throw httpError('This reservation changed in another session. Refresh and try again.', 409, 'VERSION_CONFLICT');

    let pickupPatch = null;
    if (target === 'CONFIRMED') pickupPatch = await confirmExistingReservation(client, order, body, actorRef);

    if (['CANCELLED','EXPIRED'].includes(target)) {
      const active = await client.query(`SELECT COUNT(*)::int count FROM retail_inventory_holds WHERE order_id=$1 AND state='ACTIVE'`, [id]);
      if (active.rows[0].count > 0) await releaseOrderHolds(client, id, actorRef, target === 'CANCELLED' ? 'Reservation cancelled' : 'Reservation expired');
      else if (!order.origin_conversation_id) await legacyRestoreInventory(client, id);
    }

    if (target === 'COMPLETED') {
      if (!bool(body.idVerified)) throw httpError('Verify an acceptable, unexpired government-issued ID before completing pickup.');
      const completionReference = text(body.completionReference || body.posReceiptNumber, 120);
      if (!completionReference) throw httpError('Record the in-store transaction or receipt reference before completing pickup.');
      const active = await client.query(`SELECT COUNT(*)::int count FROM retail_inventory_holds WHERE order_id=$1 AND state='ACTIVE'`, [id]);
      if (active.rows[0].count > 0) await consumeOrderHolds(client, id, actorRef, completionReference);
      else if (order.origin_conversation_id) throw httpError('This reservation has no active inventory hold. Staff reconciliation is required.', 409, 'MISSING_HOLD');
    }

    const updated = await client.query(`
      UPDATE retail_orders SET
        status=$1,
        internal_notes=COALESCE(NULLIF($2,''),internal_notes),
        completion_reference=CASE WHEN $1='COMPLETED' THEN $3 ELSE completion_reference END,
        id_verified_at=CASE WHEN $1='COMPLETED' THEN COALESCE(id_verified_at,NOW()) ELSE id_verified_at END,
        pickup_window=CASE WHEN $4<>'' THEN $4 ELSE pickup_window END,
        pickup_window_start=COALESCE($5,pickup_window_start),
        expires_at=COALESCE($6,expires_at),
        ready_at=CASE WHEN $1='READY' THEN COALESCE(ready_at,NOW()) ELSE ready_at END,
        completed_at=CASE WHEN $1='COMPLETED' THEN COALESCE(completed_at,NOW()) ELSE completed_at END,
        completed_in_store=CASE WHEN $1='COMPLETED' THEN TRUE ELSE completed_in_store END,
        version=version+1,
        updated_at=NOW()
      WHERE id=$7
      RETURNING *
    `, [
      target,
      text(body.internalNotes, 5000),
      text(body.completionReference || body.posReceiptNumber, 120),
      pickupPatch ? pickupPatch.pickupWindow : '',
      pickupPatch ? pickupPatch.pickupAt : null,
      pickupPatch ? pickupPatch.expiresAt : null,
      id
    ]);

    if (target === 'PICKING') {
      await client.query(`UPDATE retail_picking_tasks SET status='CLAIMED',claimed_at=NOW(),updated_at=NOW() WHERE order_id=$1`, [id]);
    }
    if (target === 'READY') {
      await client.query(`UPDATE retail_picking_tasks SET status='READY',ready_at=NOW(),updated_at=NOW() WHERE order_id=$1`, [id]);
    }
    if (['COMPLETED','CANCELLED','EXPIRED','REJECTED'].includes(target)) {
      await client.query(`UPDATE retail_picking_tasks SET status='CLOSED',updated_at=NOW() WHERE order_id=$1 AND status<>'CLOSED'`, [id]);
    }

    await client.query(`
      INSERT INTO retail_order_history(order_id,status,note,changed_by)
      VALUES($1,$2,$3,$4)
    `, [id, target, text(body.note, 1000), actorRef]);

    if (target === 'COMPLETED' && order.status !== 'COMPLETED') {
      await client.query(`UPDATE retail_customers SET order_count=order_count+1,total_spend_cents=total_spend_cents+$1,last_order_at=NOW(),updated_at=NOW() WHERE id=$2`, [order.total_cents, order.customer_id]);
    }

    await client.query(`
      INSERT INTO retail_audit_events(actor_type,actor_ref,action,entity_type,entity_id,before_json,after_json,reference)
      VALUES('STAFF',$1,'RESERVATION_STATUS_CHANGED','RESERVATION',$2,$3::jsonb,$4::jsonb,$5)
    `, [actorRef, String(id), JSON.stringify({ status: order.status, version: order.version }), JSON.stringify({ status: target, version: Number(order.version) + 1 }), `reservation:${id}`]);

    return updated.rows[0];
  });
}

module.exports = {
  TRANSITIONS,
  createWebsiteReservation,
  pickupPlan,
  transitionReservation
};

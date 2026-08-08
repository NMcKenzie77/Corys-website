'use strict';

const { pool } = require('../db');
const { requireAdmin } = require('../auth');
const { adjustInventory } = require('./inventory');
const { channelCapabilities } = require('./channels');
const { autocompletePlaces, computeDriveTime } = require('./maps');
const { createWebsiteReservation, transitionReservation } = require('./reservations');
const { httpError, text } = require('./identity');

const rateBuckets = new Map();
function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > max) return res.status(429).json({ ok: false, error: 'Too many requests. Try again shortly.' });
    next();
  };
}

async function adminRole(email) {
  const result = await pool.query(`SELECT * FROM retail_staff_users WHERE email=$1 AND active=TRUE LIMIT 1`, [String(email || '').toLowerCase()]);
  return result.rowCount ? result.rows[0] : null;
}

async function attachStaff(req, res, next) {
  try {
    const staff = await adminRole(req.admin && req.admin.email);
    if (!staff) return res.status(403).json({ ok: false, error: 'This admin account is not assigned an active Cory role.' });
    req.staff = staff;
    next();
  } catch (error) { next(error); }
}

function requireSuperAdmin(req, res, next) {
  if (!req.staff || req.staff.role !== 'SUPER_ADMIN') return res.status(403).json({ ok: false, error: 'Super Admin access required.' });
  next();
}

async function publicProducts() {
  const result = await pool.query(`
    SELECT p.*,
      COALESCE(JSON_AGG(JSON_BUILD_OBJECT(
        'id',v.id,
        'sku',v.sku,
        'label',v.label,
        'priceCents',v.price_cents,
        'salePriceCents',v.sale_price_cents,
        'inventoryQty',GREATEST(0,v.inventory_qty-COALESCE(h.held_qty,0)),
        'availableQty',GREATEST(0,v.inventory_qty-COALESCE(h.held_qty,0)),
        'barcode',v.barcode
      ) ORDER BY v.id) FILTER (WHERE v.id IS NOT NULL AND v.active=TRUE),'[]'::json) variants
    FROM products p
    LEFT JOIN product_variants v ON v.product_id=p.id
    LEFT JOIN LATERAL (
      SELECT SUM(ih.quantity)::int held_qty
      FROM retail_inventory_holds ih
      JOIN retail_locations l ON l.id=ih.location_id
      WHERE ih.variant_id=v.id AND ih.state='ACTIVE' AND l.location_key='primary'
    ) h ON TRUE
    WHERE p.active=TRUE
    GROUP BY p.id
    ORDER BY p.featured DESC,p.sort_order,p.updated_at DESC
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    slug: row.slug,
    category: row.category,
    brand: row.brand,
    strainType: row.strain_type,
    productForm: row.product_form,
    thcText: row.thc_text,
    cbdText: row.cbd_text,
    description: row.description,
    imageUrl: row.image_url,
    labUrl: row.lab_url,
    featured: row.featured,
    variants: row.variants || []
  }));
}

async function primaryLocation() {
  const result = await pool.query(`SELECT * FROM retail_locations WHERE location_key='primary' LIMIT 1`);
  if (!result.rowCount) throw httpError('Store location is not configured.', 503);
  return result.rows[0];
}

function registerCoryCoreApi(app) {
  // These routes intentionally register before the legacy retail handlers. The
  // legal-control middleware still runs first in retail-server.js.
  app.get('/api/retail/products', async (_req, res, next) => {
    try { res.json({ ok: true, products: await publicProducts() }); } catch (error) { next(error); }
  });

  app.post('/api/retail/orders', rateLimit(15 * 60 * 1000, 8), async (req, res, next) => {
    try {
      const result = await createWebsiteReservation(req.body || {}, {
        idempotencyKey: req.get('Idempotency-Key') || '',
        ip: req.ip,
        userAgent: req.get('User-Agent') || '',
        sourcePath: req.path
      });
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (error) { next(error); }
  });

  app.get('/api/retail/places/autocomplete', rateLimit(60 * 1000, 60), async (req, res, next) => {
    try {
      const suggestions = await autocompletePlaces(req.query.q, req.query.sessionToken);
      res.json({ ok: true, suggestions });
    } catch (error) { next(error); }
  });

  app.post('/api/retail/drive-time', rateLimit(60 * 1000, 20), async (req, res, next) => {
    try {
      const estimate = await computeDriveTime(req.body || {});
      res.json({ ok: true, estimate, privacy: 'Origin is used for this lookup and is not stored by Cory.' });
    } catch (error) { next(error); }
  });

  app.use('/api/admin/cory', requireAdmin, attachStaff);

  app.get('/api/admin/cory/me', (req, res) => {
    res.json({
      ok: true,
      user: {
        id: Number(req.staff.id),
        email: req.staff.email,
        displayName: req.staff.display_name,
        role: req.staff.role,
        mfaRequired: req.staff.mfa_required
      }
    });
  });

  app.get('/api/admin/cory/health', async (_req, res, next) => {
    try {
      const [database, integrations, queues] = await Promise.all([
        pool.query('SELECT NOW() server_time'),
        pool.query('SELECT * FROM retail_integration_health ORDER BY integration_key'),
        pool.query(`SELECT
          (SELECT COUNT(*)::int FROM retail_outbox WHERE status IN ('PENDING','FAILED','DEAD_LETTER')) outbox_issues,
          (SELECT COUNT(*)::int FROM retail_escalations WHERE state='OPEN') open_escalations,
          (SELECT COUNT(*)::int FROM retail_inventory_holds WHERE state='ACTIVE' AND expires_at<=NOW()) expired_holds`)
      ]);
      res.json({
        ok: true,
        database: { ok: true, serverTime: database.rows[0].server_time },
        integrations: integrations.rows,
        channelCapabilities: channelCapabilities(),
        queues: queues.rows[0]
      });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/cory/queues', async (_req, res, next) => {
    try {
      const [orders, escalations, expiring] = await Promise.all([
        pool.query(`
          SELECT o.id,o.reservation_code,o.order_number,o.status,o.pickup_window,o.pickup_window_start,o.expires_at,o.total_cents,
            o.source_channel,o.created_at,c.first_name,c.last_name,c.email,c.phone,
            (SELECT COUNT(*)::int FROM retail_order_items i WHERE i.order_id=o.id) line_count
          FROM retail_orders o
          JOIN retail_customers c ON c.id=o.customer_id
          WHERE o.status NOT IN ('COMPLETED','CANCELLED','EXPIRED','REJECTED')
          ORDER BY CASE o.status
            WHEN 'NEEDS_CLARIFICATION' THEN 1 WHEN 'NEW' THEN 2 WHEN 'CONFIRMED' THEN 3
            WHEN 'PICKING' THEN 4 WHEN 'READY' THEN 5 ELSE 6 END,o.created_at
          LIMIT 500
        `),
        pool.query(`SELECT e.*,c.source_channel,c.customer_id FROM retail_escalations e LEFT JOIN retail_conversations c ON c.id=e.conversation_id WHERE e.state='OPEN' ORDER BY CASE e.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END,e.created_at LIMIT 300`),
        pool.query(`SELECT id,reservation_code,status,expires_at FROM retail_orders WHERE status IN ('CONFIRMED','PICKING','READY') AND expires_at IS NOT NULL AND expires_at<NOW()+INTERVAL '45 minutes' ORDER BY expires_at LIMIT 200`)
      ]);
      res.json({ ok: true, reservations: orders.rows, needsAttention: escalations.rows, expiring: expiring.rows });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/cory/conversations/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const conversation = await pool.query(`
        SELECT c.*,cu.first_name,cu.last_name,cu.email,cu.phone
        FROM retail_conversations c
        LEFT JOIN retail_customers cu ON cu.id=c.customer_id
        WHERE c.id=$1
      `, [id]);
      if (!conversation.rowCount) throw httpError('Conversation not found.', 404);
      const [messages, reservations, escalations] = await Promise.all([
        pool.query('SELECT * FROM retail_messages WHERE conversation_id=$1 ORDER BY created_at,id', [id]),
        pool.query(`SELECT o.* FROM retail_conversation_orders co JOIN retail_orders o ON o.id=co.order_id WHERE co.conversation_id=$1 ORDER BY o.created_at DESC`, [id]),
        pool.query('SELECT * FROM retail_escalations WHERE conversation_id=$1 ORDER BY created_at DESC', [id])
      ]);
      res.json({ ok: true, conversation: conversation.rows[0], messages: messages.rows, reservations: reservations.rows, escalations: escalations.rows });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/cory/inventory', async (_req, res, next) => {
    try {
      const location = await primaryLocation();
      const rows = await pool.query(`
        SELECT p.id product_id,p.name,p.brand,p.category,v.id variant_id,v.sku,v.label,v.inventory_qty on_hand_qty,
          COALESCE(SUM(h.quantity) FILTER (WHERE h.state='ACTIVE'),0)::int held_qty,
          GREATEST(0,v.inventory_qty-COALESCE(SUM(h.quantity) FILTER (WHERE h.state='ACTIVE'),0))::int available_qty
        FROM products p
        JOIN product_variants v ON v.product_id=p.id
        LEFT JOIN retail_inventory_holds h ON h.variant_id=v.id AND h.location_id=$1
        WHERE p.active=TRUE AND v.active=TRUE
        GROUP BY p.id,v.id
        ORDER BY p.name,v.label
      `, [location.id]);
      res.json({ ok: true, location, inventory: rows.rows });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/cory/inventory/:variantId/adjust', async (req, res, next) => {
    try {
      const location = await primaryLocation();
      const result = await adjustInventory({
        locationId: location.id,
        variantId: Number(req.params.variantId),
        quantityDelta: Number(req.body && req.body.quantityDelta),
        reason: req.body && req.body.reason,
        reference: req.body && req.body.reference,
        eventType: text(req.body && req.body.eventType, 30).toUpperCase(),
        actorRef: req.staff.email
      });
      await pool.query(`
        INSERT INTO retail_audit_events(actor_type,actor_ref,action,entity_type,entity_id,after_json,reference)
        VALUES('STAFF',$1,'INVENTORY_ADJUSTED','VARIANT',$2,$3::jsonb,$4)
      `, [req.staff.email, String(req.params.variantId), JSON.stringify(result), text(req.body && req.body.reference, 200)]);
      res.json({ ok: true, inventory: result });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/cory/audit', requireSuperAdmin, async (req, res, next) => {
    try {
      const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 250));
      const result = await pool.query('SELECT * FROM retail_audit_events ORDER BY created_at DESC,id DESC LIMIT $1', [limit]);
      res.json({ ok: true, events: result.rows });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/cory/staff', requireSuperAdmin, async (_req, res, next) => {
    try {
      const result = await pool.query(`SELECT id,email,display_name,role,location_id,active,mfa_required,created_at,updated_at FROM retail_staff_users ORDER BY role,email`);
      res.json({ ok: true, staff: result.rows });
    } catch (error) { next(error); }
  });

  // Compatibility route: current admin UI already uses this endpoint. Registering
  // here ensures all new reservations use the hold ledger instead of the legacy
  // decrement/restore behavior.
  app.patch('/api/admin/retail/orders/:id', requireAdmin, attachStaff, async (req, res, next) => {
    try {
      const order = await transitionReservation(Number(req.params.id), req.body || {}, req.staff.email);
      res.json({ ok: true, order });
    } catch (error) { next(error); }
  });
}

module.exports = {
  registerCoryCoreApi
};

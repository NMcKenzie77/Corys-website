'use strict';

const crypto = require('crypto');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { pool, withTransaction } = require('./db');
const {
  verifyAdminCredentials,
  setSessionCookie,
  clearSessionCookie,
  requireAdmin
} = require('./auth');

const ORDER_STATUSES = ['NEW','NEEDS_CLARIFICATION','CONFIRMED','PICKING','READY','COMPLETED','CANCELLED','EXPIRED','REJECTED'];
const ORDER_TRANSITIONS = {
  NEW: ['NEW','NEEDS_CLARIFICATION','CONFIRMED','CANCELLED','REJECTED'],
  NEEDS_CLARIFICATION: ['NEEDS_CLARIFICATION','CONFIRMED','CANCELLED','REJECTED'],
  CONFIRMED: ['CONFIRMED','PICKING','CANCELLED','EXPIRED'],
  PICKING: ['PICKING','READY','CANCELLED'],
  READY: ['READY','COMPLETED','CANCELLED','EXPIRED'],
  COMPLETED: ['COMPLETED'],
  CANCELLED: ['CANCELLED'],
  EXPIRED: ['EXPIRED'],
  REJECTED: ['REJECTED']
};
const CAMPAIGN_SEGMENTS = ['ALL_SUBSCRIBERS','CUSTOMERS','LAPSED_60_DAYS','CATEGORY_BUYERS'];
const AUTOMATION_RULES = [
  { key: 'LOW_INVENTORY', name: 'Low inventory alerts', enabled: true, settings: { threshold: 5 } },
  { key: 'STALE_PICKUP_ORDER', name: 'Stalled pickup order alerts', enabled: true, settings: { hours: 2 } },
  { key: 'UNCLAIMED_READY_ORDER', name: 'Unclaimed ready-order alerts', enabled: true, settings: { hours: 4 } },
  { key: 'LAPSED_CUSTOMER_DRAFT', name: 'Lapsed-customer campaign drafts', enabled: true, settings: { days: 60 } },
  { key: 'DAILY_DIGEST', name: 'Daily operations digest', enabled: true, settings: { hour: 8 } }
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)
    ? cb(null, true)
    : cb(new Error('Only JPG, PNG, WEBP, and GIF images are accepted.'))
});

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

function text(value, max = 500) { return String(value == null ? '' : value).trim().slice(0, max); }
function bool(value) { return value === true || value === 'true' || value === 'on' || value === 1 || value === '1'; }
function email(value) {
  const normalized = text(value, 200).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : '';
}
function slug(value) {
  return text(value, 160).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function cents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : NaN;
}
function httpError(message, status = 400) { const error = new Error(message); error.status = status; return error; }
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function nowIsoDate() { return new Date().toISOString().slice(0, 10).replace(/-/g, ''); }
function orderNumber() { return `PU-${nowIsoDate()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; }
function tokenSecret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  return value;
}
function unsubscribeToken(customerId, recipientEmail) {
  const payload = Buffer.from(JSON.stringify({ customerId: Number(customerId), email: recipientEmail, purpose: 'retail-unsubscribe' })).toString('base64url');
  const signature = crypto.createHmac('sha256', tokenSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function verifyUnsubscribeToken(token) {
  if (!token || !String(token).includes('.')) return null;
  const [payload, signature] = String(token).split('.');
  const expected = crypto.createHmac('sha256', tokenSecret()).update(payload).digest('base64url');
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.purpose === 'retail-unsubscribe' ? data : null;
  } catch (_error) { return null; }
}

async function sendEmail(to, subject, html, headers = {}) {
  if (!to || !process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return { skipped: true };
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, html, headers })
  });
  if (!response.ok) throw new Error(`Resend ${response.status}: ${await response.text()}`);
  return response.json();
}

function storeConfig() {
  return {
    name: process.env.SITE_NAME || 'Dispensary',
    address: process.env.BUSINESS_ADDRESS || '',
    phone: process.env.BUSINESS_PHONE || '',
    email: process.env.BUSINESS_EMAIL || process.env.SALES_EMAIL || '',
    licenseNumber: process.env.BUSINESS_LICENSE_NUMBER || '',
    hours: process.env.STORE_HOURS || '',
    pickupWindows: text(process.env.PICKUP_WINDOWS || 'ASAP,Later today', 500).split(',').map((item) => item.trim()).filter(Boolean),
    pickupInstructions: process.env.PICKUP_INSTRUCTIONS || 'Bring a valid government-issued photo ID. Payment and final sale occur inside the licensed store.'
  };
}

async function ensureRetailSchema() {
  await pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS brand TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS strain_type TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS product_form TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS thc_text TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS cbd_text TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS lab_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS vendor_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS barcode TEXT NOT NULL DEFAULT '';

    CREATE TABLE IF NOT EXISTS retail_customers (
      id BIGSERIAL PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL DEFAULT '',
      marketing_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
      marketing_opted_in_at TIMESTAMPTZ,
      unsubscribed_at TIMESTAMPTZ,
      source TEXT NOT NULL DEFAULT 'pickup-order',
      order_count INTEGER NOT NULL DEFAULT 0,
      total_spend_cents BIGINT NOT NULL DEFAULT 0,
      last_order_at TIMESTAMPTZ,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS retail_orders (
      id BIGSERIAL PRIMARY KEY,
      order_number TEXT NOT NULL UNIQUE,
      customer_id BIGINT NOT NULL REFERENCES retail_customers(id),
      status TEXT NOT NULL DEFAULT 'NEW',
      subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents >= 0),
      total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
      pickup_window TEXT NOT NULL DEFAULT 'ASAP',
      customer_notes TEXT NOT NULL DEFAULT '',
      internal_notes TEXT NOT NULL DEFAULT '',
      payment_method TEXT NOT NULL DEFAULT 'PAY_AT_STORE',
      pos_receipt_number TEXT NOT NULL DEFAULT '',
      age_confirmed_at TIMESTAMPTZ NOT NULL,
      id_verified_at TIMESTAMPTZ,
      ready_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      inventory_restored BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (status IN ('NEW','CONFIRMED','PICKING','READY','COMPLETED','CANCELLED','EXPIRED'))
    );

    CREATE TABLE IF NOT EXISTS retail_order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES retail_orders(id) ON DELETE CASCADE,
      product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
      variant_id BIGINT REFERENCES product_variants(id) ON DELETE SET NULL,
      product_name TEXT NOT NULL,
      variant_label TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0)
    );

    CREATE TABLE IF NOT EXISTS retail_order_history (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES retail_orders(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      changed_by TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS retail_campaigns (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      headline TEXT NOT NULL,
      body_text TEXT NOT NULL,
      cta_label TEXT NOT NULL DEFAULT 'View menu',
      cta_url TEXT NOT NULL DEFAULT '/shop',
      segment TEXT NOT NULL DEFAULT 'ALL_SUBSCRIBERS',
      segment_value TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'DRAFT',
      recipient_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      CHECK (segment IN ('ALL_SUBSCRIBERS','CUSTOMERS','LAPSED_60_DAYS','CATEGORY_BUYERS')),
      CHECK (status IN ('DRAFT','SENDING','SENT','FAILED'))
    );

    CREATE TABLE IF NOT EXISTS retail_campaign_recipients (
      id BIGSERIAL PRIMARY KEY,
      campaign_id BIGINT NOT NULL REFERENCES retail_campaigns(id) ON DELETE CASCADE,
      customer_id BIGINT NOT NULL REFERENCES retail_customers(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      provider_message_id TEXT,
      error_message TEXT,
      sent_at TIMESTAMPTZ,
      UNIQUE(campaign_id, customer_id)
    );

    CREATE TABLE IF NOT EXISTS retail_automation_rules (
      rule_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_run_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS retail_automation_alerts (
      id BIGSERIAL PRIMARY KEY,
      alert_key TEXT NOT NULL UNIQUE,
      rule_key TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'NORMAL',
      title TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'OPEN',
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS retail_automation_runs (
      id BIGSERIAL PRIMARY KEY,
      rule_key TEXT NOT NULL,
      matched_count INTEGER NOT NULL DEFAULT 0,
      action_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT NOT NULL DEFAULT '',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_retail_orders_status_created ON retail_orders(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_retail_customers_last_order ON retail_customers(last_order_at DESC);
    CREATE INDEX IF NOT EXISTS idx_retail_campaigns_status ON retail_campaigns(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_retail_alerts_status ON retail_automation_alerts(status, created_at DESC);
  `);

  for (const rule of AUTOMATION_RULES) {
    await pool.query(`INSERT INTO retail_automation_rules(rule_key,name,enabled,settings)
      VALUES($1,$2,$3,$4::jsonb)
      ON CONFLICT(rule_key) DO NOTHING`, [rule.key, rule.name, rule.enabled, JSON.stringify(rule.settings)]);
  }
}

async function publicProducts() {
  const result = await pool.query(`
    SELECT p.*,
      COALESCE(JSON_AGG(JSON_BUILD_OBJECT(
        'id',v.id,'sku',v.sku,'label',v.label,'priceCents',v.price_cents,
        'salePriceCents',v.sale_price_cents,'inventoryQty',v.inventory_qty,'barcode',v.barcode
      ) ORDER BY v.id) FILTER (WHERE v.id IS NOT NULL AND v.active=TRUE),'[]'::json) variants
    FROM products p
    LEFT JOIN product_variants v ON v.product_id=p.id
    WHERE p.active=TRUE
    GROUP BY p.id
    ORDER BY p.featured DESC,p.sort_order,p.updated_at DESC
  `);
  return result.rows.map((row) => ({
    id: Number(row.id), name: row.name, slug: row.slug, category: row.category,
    brand: row.brand, strainType: row.strain_type, productForm: row.product_form,
    thcText: row.thc_text, cbdText: row.cbd_text, description: row.description,
    imageUrl: row.image_url, labUrl: row.lab_url, featured: row.featured,
    variants: row.variants || []
  }));
}

function productPayload(body) {
  const variants = Array.isArray(body.variants) ? body.variants.slice(0, 50) : [];
  const payload = {
    name: text(body.name, 160), slug: slug(body.slug || body.name), category: text(body.category, 100),
    brand: text(body.brand, 120), strainType: text(body.strainType, 80), productForm: text(body.productForm, 100),
    thcText: text(body.thcText, 80), cbdText: text(body.cbdText, 80), description: text(body.description, 5000),
    imageUrl: text(body.imageUrl, 1000), labUrl: text(body.labUrl, 1000), vendorName: text(body.vendorName, 160),
    featured: bool(body.featured), active: body.active !== false, sortOrder: Number(body.sortOrder || 0), variants
  };
  if (!payload.name || !payload.slug || !payload.category || !variants.length) throw httpError('Name, category, and at least one package are required.');
  payload.variants = variants.map((variant, index) => {
    const item = {
      sku: text(variant.sku, 100).toUpperCase(), label: text(variant.label, 100), barcode: text(variant.barcode, 100),
      priceCents: cents(variant.price), salePriceCents: text(variant.salePrice, 30) ? cents(variant.salePrice) : null,
      inventoryQty: Number(variant.inventoryQty), active: variant.active !== false
    };
    if (!item.sku || !item.label || !Number.isInteger(item.priceCents) || item.priceCents < 0 || !Number.isInteger(item.inventoryQty) || item.inventoryQty < 0) {
      throw httpError(`Package ${index + 1} is invalid.`);
    }
    if (item.salePriceCents != null && (!Number.isInteger(item.salePriceCents) || item.salePriceCents < 0 || item.salePriceCents > item.priceCents)) {
      throw httpError(`Package ${index + 1} sale price is invalid.`);
    }
    return item;
  });
  if (new Set(payload.variants.map((item) => item.sku)).size !== payload.variants.length) throw httpError('Each package must use a unique SKU.');
  return payload;
}

async function saveVariants(client, productId, variants) {
  for (const variant of variants) {
    await client.query(`INSERT INTO product_variants(product_id,sku,label,price_cents,sale_price_cents,inventory_qty,active,barcode)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(sku) DO UPDATE SET label=EXCLUDED.label,price_cents=EXCLUDED.price_cents,
        sale_price_cents=EXCLUDED.sale_price_cents,inventory_qty=EXCLUDED.inventory_qty,
        active=EXCLUDED.active,barcode=EXCLUDED.barcode,updated_at=NOW()
      WHERE product_variants.product_id=EXCLUDED.product_id`,
      [productId, variant.sku, variant.label, variant.priceCents, variant.salePriceCents, variant.inventoryQty, variant.active, variant.barcode]);
  }
  const skus = variants.map((item) => item.sku);
  const omitted = await client.query('SELECT id FROM product_variants WHERE product_id=$1 AND active=TRUE AND NOT (sku=ANY($2::text[]))', [productId, skus]);
  if (omitted.rowCount) {
    const ids = omitted.rows.map((row) => row.id);
    const open = await client.query(`SELECT 1 FROM retail_order_items i JOIN retail_orders o ON o.id=i.order_id
      WHERE i.variant_id=ANY($1::bigint[]) AND o.status NOT IN ('COMPLETED','CANCELLED','EXPIRED') LIMIT 1`, [ids]);
    if (open.rowCount) throw httpError('A package tied to an open pickup order cannot be removed.', 409);
    await client.query('UPDATE product_variants SET active=FALSE,updated_at=NOW() WHERE id=ANY($1::bigint[])', [ids]);
  }
}

async function restoreInventory(client, orderId) {
  const order = await client.query('SELECT inventory_restored FROM retail_orders WHERE id=$1 FOR UPDATE', [orderId]);
  if (!order.rowCount || order.rows[0].inventory_restored) return;
  const items = await client.query('SELECT variant_id,quantity FROM retail_order_items WHERE order_id=$1', [orderId]);
  for (const item of items.rows) if (item.variant_id) {
    await client.query('UPDATE product_variants SET inventory_qty=inventory_qty+$1,updated_at=NOW() WHERE id=$2', [item.quantity, item.variant_id]);
  }
  await client.query('UPDATE retail_orders SET inventory_restored=TRUE,updated_at=NOW() WHERE id=$1', [orderId]);
}

async function orderDetail(id) {
  const order = await pool.query(`SELECT o.*,c.first_name,c.last_name,c.email,c.phone
    FROM retail_orders o JOIN retail_customers c ON c.id=o.customer_id WHERE o.id=$1`, [id]);
  if (!order.rowCount) throw httpError('Pickup order not found.', 404);
  const [items, history] = await Promise.all([
    pool.query('SELECT * FROM retail_order_items WHERE order_id=$1 ORDER BY id', [id]),
    pool.query('SELECT * FROM retail_order_history WHERE order_id=$1 ORDER BY created_at,id', [id])
  ]);
  return { ...order.rows[0], items: items.rows, history: history.rows };
}

function campaignHtml(campaign, customer) {
  const base = String(process.env.SITE_URL || '').replace(/\/+$/, '');
  const unsubscribe = `${base}/api/retail/unsubscribe?token=${encodeURIComponent(unsubscribeToken(customer.id, customer.email))}`;
  const cta = /^https?:\/\//i.test(campaign.cta_url) ? campaign.cta_url : `${base}${campaign.cta_url.startsWith('/') ? '' : '/'}${campaign.cta_url}`;
  const warnings = [
    'This product has intoxicating effects and may be habit forming.',
    'Cannabis can impair concentration, coordination, and judgment. Do not operate a vehicle or machinery under the influence of this drug.',
    'There may be health risks associated with consumption of this product.',
    'For use only by adults 21 and older. Keep out of the reach of children.'
  ];
  return `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto">
    <p style="font-size:12px">ADVERTISEMENT • FOR WASHINGTON ADULTS 21+ ONLY</p>
    <h1>${esc(campaign.headline)}</h1><div>${esc(campaign.body_text).replace(/\n/g, '<br>')}</div>
    <p><a href="${esc(cta)}" style="display:inline-block;padding:12px 18px;background:#111;color:#fff;text-decoration:none">${esc(campaign.cta_label)}</a></p>
    <hr>${warnings.map((line) => `<p style="font-size:12px">${esc(line)}</p>`).join('')}
    <p style="font-size:12px">${esc(process.env.BUSINESS_POSTAL_ADDRESS || process.env.BUSINESS_ADDRESS || '')}</p>
    <p style="font-size:12px"><a href="${esc(unsubscribe)}">Unsubscribe</a></p></div>`;
}

async function campaignAudience(campaign) {
  const values = [];
  let condition = `c.marketing_opt_in=TRUE AND c.unsubscribed_at IS NULL`;
  if (campaign.segment === 'CUSTOMERS') condition += ' AND c.order_count>0';
  if (campaign.segment === 'LAPSED_60_DAYS') condition += ` AND c.order_count>0 AND c.last_order_at<NOW()-INTERVAL '60 days'`;
  if (campaign.segment === 'CATEGORY_BUYERS') {
    values.push(campaign.segment_value);
    condition += ` AND EXISTS(SELECT 1 FROM retail_orders o JOIN retail_order_items i ON i.order_id=o.id JOIN products p ON p.id=i.product_id WHERE o.customer_id=c.id AND o.status='COMPLETED' AND p.category=$1)`;
  }
  const result = await pool.query(`SELECT c.* FROM retail_customers c WHERE ${condition} ORDER BY c.id`, values);
  return result.rows;
}

async function upsertAlert(key, ruleKey, severity, title, details) {
  return pool.query(`INSERT INTO retail_automation_alerts(alert_key,rule_key,severity,title,details)
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(alert_key) DO UPDATE SET severity=EXCLUDED.severity,title=EXCLUDED.title,details=EXCLUDED.details,
      status='OPEN',resolved_at=NULL,updated_at=NOW() RETURNING *`, [key, ruleKey, severity, title, details]);
}

async function runRule(ruleKey) {
  const ruleResult = await pool.query('SELECT * FROM retail_automation_rules WHERE rule_key=$1', [ruleKey]);
  if (!ruleResult.rowCount) throw httpError('Automation rule not found.', 404);
  const rule = ruleResult.rows[0];
  const run = await pool.query('INSERT INTO retail_automation_runs(rule_key) VALUES($1) RETURNING id', [ruleKey]);
  let matched = 0; let actions = 0; let errorMessage = '';
  try {
    const settings = rule.settings || {};
    if (!rule.enabled) return { matched: 0, actions: 0, disabled: true };
    if (ruleKey === 'LOW_INVENTORY') {
      const threshold = Math.max(0, Number(settings.threshold || 5));
      const rows = await pool.query(`SELECT v.id,v.sku,v.label,v.inventory_qty,p.name FROM product_variants v JOIN products p ON p.id=v.product_id
        WHERE p.active=TRUE AND v.active=TRUE AND v.inventory_qty<=$1`, [threshold]);
      matched = rows.rowCount;
      for (const row of rows.rows) {
        await upsertAlert(`low-stock:${row.id}`, ruleKey, row.inventory_qty === 0 ? 'URGENT' : 'HIGH',
          `Low inventory: ${row.name} ${row.label}`, `${row.inventory_qty} units remain for SKU ${row.sku}.`); actions += 1;
      }
      await pool.query(`UPDATE retail_automation_alerts a SET status='RESOLVED',resolved_at=NOW(),updated_at=NOW()
        WHERE rule_key=$1 AND status='OPEN' AND NOT EXISTS(
          SELECT 1 FROM product_variants v WHERE a.alert_key='low-stock:'||v.id::text AND v.inventory_qty<=$2
        )`, [ruleKey, threshold]);
    }
    if (ruleKey === 'STALE_PICKUP_ORDER') {
      const hours = Math.max(1, Number(settings.hours || 2));
      const rows = await pool.query(`SELECT id,order_number,status,created_at FROM retail_orders
        WHERE status IN ('NEW','CONFIRMED','PICKING') AND updated_at<NOW()-($1||' hours')::interval`, [hours]);
      matched = rows.rowCount;
      for (const row of rows.rows) { await upsertAlert(`stale-order:${row.id}`, ruleKey, 'HIGH', `Pickup order ${row.order_number} is stalled`, `Current status: ${row.status}.`); actions += 1; }
    }
    if (ruleKey === 'UNCLAIMED_READY_ORDER') {
      const hours = Math.max(1, Number(settings.hours || 4));
      const rows = await pool.query(`SELECT id,order_number,ready_at FROM retail_orders WHERE status='READY' AND ready_at<NOW()-($1||' hours')::interval`, [hours]);
      matched = rows.rowCount;
      for (const row of rows.rows) { await upsertAlert(`unclaimed:${row.id}`, ruleKey, 'URGENT', `Ready order ${row.order_number} is unclaimed`, 'Contact the customer or expire the reservation after store policy permits.'); actions += 1; }
    }
    if (ruleKey === 'LAPSED_CUSTOMER_DRAFT') {
      const days = Math.max(30, Number(settings.days || 60));
      const count = await pool.query(`SELECT COUNT(*)::int count FROM retail_customers WHERE marketing_opt_in=TRUE AND unsubscribed_at IS NULL AND order_count>0 AND last_order_at<NOW()-($1||' days')::interval`, [days]);
      matched = count.rows[0].count;
      const existing = await pool.query(`SELECT 1 FROM retail_campaigns WHERE name=$1 AND status='DRAFT' LIMIT 1`, [`Lapsed customer return - ${new Date().toISOString().slice(0,7)}`]);
      if (matched && !existing.rowCount) {
        await pool.query(`INSERT INTO retail_campaigns(name,subject,headline,body_text,segment)
          VALUES($1,$2,$3,$4,'LAPSED_60_DAYS')`, [`Lapsed customer return - ${new Date().toISOString().slice(0,7)}`, 'See what is new on the menu', 'Your next pickup starts with the current menu', 'Browse current availability and reserve online for in-store pickup. Payment and final sale occur at the store.']);
        actions = 1;
      }
    }
    if (ruleKey === 'DAILY_DIGEST') {
      const timeZone = process.env.AUTOMATION_TIME_ZONE || 'America/Los_Angeles';
      const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      const dateKey = `${values.year}-${values.month}-${values.day}`;
      const hour = Number(values.hour);
      const targetHour = Number(settings.hour == null ? 8 : settings.hour);
      const existing = await pool.query('SELECT 1 FROM retail_automation_alerts WHERE alert_key=$1', [`digest:${dateKey}`]);
      if (hour >= targetHour && !existing.rowCount) {
        const [orders, alerts, stock] = await Promise.all([
          pool.query(`SELECT COUNT(*)::int count FROM retail_orders WHERE status IN ('NEW','NEEDS_CLARIFICATION','CONFIRMED','PICKING','READY')`),
          pool.query(`SELECT COUNT(*)::int count FROM retail_automation_alerts WHERE status='OPEN'`),
          pool.query(`SELECT COUNT(*)::int count FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.active=TRUE AND v.active=TRUE AND v.inventory_qty<=5`)
        ]);
        const recipient = process.env.AUTOMATION_ALERT_EMAIL || process.env.ADMIN_EMAIL || '';
        await sendEmail(recipient, `Dispensary operations digest ${dateKey}`, `<h2>Daily operations</h2><p>Open pickup orders: ${orders.rows[0].count}</p><p>Open alerts: ${alerts.rows[0].count}</p><p>Low-stock packages: ${stock.rows[0].count}</p>`);
        await upsertAlert(`digest:${dateKey}`, ruleKey, 'NORMAL', `Daily digest sent ${dateKey}`, `Sent to ${recipient || 'no recipient configured'}.`);
        matched = 1; actions = 1;
      }
    }
  } catch (error) { errorMessage = error.message; throw error; }
  finally {
    await pool.query('UPDATE retail_automation_runs SET matched_count=$1,action_count=$2,error_message=$3,completed_at=NOW() WHERE id=$4', [matched, actions, errorMessage, run.rows[0].id]);
    await pool.query('UPDATE retail_automation_rules SET last_run_at=NOW() WHERE rule_key=$1', [ruleKey]);
  }
  return { matched, actions };
}

async function runAutomationCycle() {
  if (!process.env.DATABASE_URL) return;
  const lock = await pool.query('SELECT pg_try_advisory_lock(7620260801) locked');
  if (!lock.rows[0].locked) return;
  try {
    const rules = await pool.query('SELECT rule_key FROM retail_automation_rules WHERE enabled=TRUE ORDER BY rule_key');
    for (const rule of rules.rows) {
      try { await runRule(rule.rule_key); } catch (error) { console.error(`Retail automation ${rule.rule_key} failed:`, error.message); }
    }
  } finally { await pool.query('SELECT pg_advisory_unlock(7620260801)'); }
}

function startRetailAutomationWorker() {
  const interval = Math.max(60000, Number(process.env.AUTOMATION_INTERVAL_MS || 300000));
  setTimeout(() => runAutomationCycle().catch(console.error), 15000);
  const timer = setInterval(() => runAutomationCycle().catch(console.error), interval);
  if (timer.unref) timer.unref();
}

function registerRetailApi(app) {
  app.get('/api/retail/store', (_req, res) => res.json({ ok: true, store: storeConfig() }));
  app.get('/api/retail/products', async (_req, res, next) => { try { res.json({ ok: true, products: await publicProducts() }); } catch (error) { next(error); } });

  app.post('/api/retail/orders', rateLimit(15 * 60 * 1000, 8), async (req, res, next) => {
    try {
      const body = req.body || {};
      const customer = { firstName: text(body.firstName, 100), lastName: text(body.lastName, 100), email: email(body.email), phone: text(body.phone, 50) };
      const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
      if (!customer.firstName || !customer.lastName || !customer.email || !customer.phone || !items.length) throw httpError('Complete the customer and product fields.');
      if (!bool(body.ageConfirmed)) throw httpError('You must confirm that you are 21 or older.');
      if (!bool(body.privacyAccepted)) throw httpError('Review and accept the Privacy Notice and Terms.');
      const allowedWindows = storeConfig().pickupWindows;
      const pickupWindow = allowedWindows.includes(text(body.pickupWindow, 100)) ? text(body.pickupWindow, 100) : allowedWindows[0] || 'ASAP';

      const saved = await withTransaction(async (client) => {
        const requested = items.map((item) => ({ variantId: Number(item.variantId), quantity: Math.max(1, Math.min(99, Number(item.quantity) || 0)) }));
        if (requested.some((item) => !Number.isInteger(item.variantId) || item.variantId < 1)) throw httpError('Invalid product selection.');
        const ids = [...new Set(requested.map((item) => item.variantId))];
        const variants = await client.query(`SELECT v.*,p.id product_id,p.name product_name,p.active product_active
          FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=ANY($1::bigint[]) FOR UPDATE`, [ids]);
        const map = new Map(variants.rows.map((row) => [Number(row.id), row]));
        let total = 0;
        const resolved = requested.map((item) => {
          const row = map.get(item.variantId);
          if (!row || !row.active || !row.product_active) throw httpError('A selected product is no longer available.', 409);
          if (row.inventory_qty < item.quantity) throw httpError(`${row.product_name} ${row.label} has only ${row.inventory_qty} available.`, 409);
          const unitPrice = row.sale_price_cents == null ? row.price_cents : Math.min(row.price_cents, row.sale_price_cents);
          const lineTotal = unitPrice * item.quantity; total += lineTotal;
          return { row, quantity: item.quantity, unitPrice, lineTotal };
        });
        const marketingOptIn = bool(body.marketingConsent);
        const customerResult = await client.query(`INSERT INTO retail_customers(first_name,last_name,email,phone,marketing_opt_in,marketing_opted_in_at,source)
          VALUES($1,$2,$3,$4,$5,CASE WHEN $5 THEN NOW() ELSE NULL END,'pickup-order')
          ON CONFLICT(email) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,phone=EXCLUDED.phone,
            marketing_opt_in=CASE WHEN retail_customers.unsubscribed_at IS NULL AND EXCLUDED.marketing_opt_in THEN TRUE ELSE retail_customers.marketing_opt_in END,
            marketing_opted_in_at=CASE WHEN retail_customers.unsubscribed_at IS NULL AND EXCLUDED.marketing_opt_in THEN COALESCE(retail_customers.marketing_opted_in_at,NOW()) ELSE retail_customers.marketing_opted_in_at END,
            updated_at=NOW() RETURNING *`, [customer.firstName, customer.lastName, customer.email, customer.phone, marketingOptIn]);
        const orderResult = await client.query(`INSERT INTO retail_orders(order_number,customer_id,subtotal_cents,total_cents,pickup_window,customer_notes,age_confirmed_at)
          VALUES($1,$2,$3,$3,$4,$5,NOW()) RETURNING *`, [orderNumber(), customerResult.rows[0].id, total, pickupWindow, text(body.notes, 2000)]);
        for (const item of resolved) {
          await client.query(`INSERT INTO retail_order_items(order_id,product_id,variant_id,product_name,variant_label,sku,quantity,unit_price_cents,line_total_cents)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [orderResult.rows[0].id, item.row.product_id, item.row.id, item.row.product_name, item.row.label, item.row.sku, item.quantity, item.unitPrice, item.lineTotal]);
          await client.query('UPDATE product_variants SET inventory_qty=inventory_qty-$1,updated_at=NOW() WHERE id=$2', [item.quantity, item.row.id]);
        }
        await client.query(`INSERT INTO retail_order_history(order_id,status,note,changed_by) VALUES($1,'NEW','Online pickup reservation submitted','customer')`, [orderResult.rows[0].id]);
        await client.query(`INSERT INTO consent_records(email,business_name,consent_type,notice_version,source_path,request_fingerprint,metadata)
          VALUES($1,'','RETAIL_PICKUP_ORDER','2026-08-01','/cart','',$2::jsonb)`, [customer.email, JSON.stringify({ marketingConsent: marketingOptIn, ageConfirmed: true })]);
        return { order: orderResult.rows[0], customer: customerResult.rows[0] };
      });
      const detail = await orderDetail(saved.order.id);
      const store = storeConfig();
      const html = `<h2>Pickup reservation ${esc(detail.order_number)}</h2><p>We received your reservation for ${esc(detail.pickup_window)}.</p><p>Payment and final sale take place at ${esc(store.name)}. Bring a valid government-issued photo ID.</p><p>${esc(store.address)}</p>`;
      sendEmail(customer.email, `Pickup reservation ${detail.order_number}`, html).catch(console.error);
      sendEmail(process.env.SALES_EMAIL || process.env.ADMIN_EMAIL || '', `New pickup reservation ${detail.order_number}`, html).catch(console.error);
      res.status(201).json({ ok: true, orderNumber: detail.order_number, status: detail.status, pickupWindow: detail.pickup_window });
    } catch (error) { next(error); }
  });

  app.get('/api/retail/unsubscribe', async (req, res) => {
    const parsed = verifyUnsubscribeToken(req.query.token);
    if (!parsed) return res.status(400).type('html').send('<h1>Invalid unsubscribe link</h1>');
    await pool.query('UPDATE retail_customers SET marketing_opt_in=FALSE,unsubscribed_at=NOW(),updated_at=NOW() WHERE id=$1 AND email=$2', [parsed.customerId, parsed.email]);
    res.type('html').send('<h1>You are unsubscribed.</h1><p>You will no longer receive marketing emails.</p>');
  });

  app.post('/api/admin/login', rateLimit(15 * 60 * 1000, 10), async (req, res, next) => {
    try {
      const adminEmail = email(req.body && req.body.email);
      if (!await verifyAdminCredentials(adminEmail, req.body && req.body.password)) return res.status(401).json({ ok: false, error: 'Invalid credentials.' });
      setSessionCookie(res, adminEmail); res.json({ ok: true, email: adminEmail });
    } catch (error) { next(error); }
  });
  app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true, email: req.admin.email }));
  app.post('/api/admin/logout', requireAdmin, (_req, res) => { clearSessionCookie(res); res.json({ ok: true }); });

  app.get('/api/admin/retail/summary', requireAdmin, async (_req, res, next) => {
    try {
      const result = await pool.query(`SELECT
        (SELECT COUNT(*)::int FROM products WHERE active=TRUE) active_products,
        (SELECT COALESCE(SUM(inventory_qty),0)::int FROM product_variants WHERE active=TRUE) units_available,
        (SELECT COUNT(*)::int FROM retail_orders WHERE status IN ('NEW','NEEDS_CLARIFICATION','CONFIRMED','PICKING','READY')) open_orders,
        (SELECT COUNT(*)::int FROM retail_customers) customers,
        (SELECT COALESCE(SUM(total_cents),0)::bigint FROM retail_orders WHERE status='COMPLETED' AND completed_at>=NOW()-INTERVAL '30 days') completed_30d_cents,
        (SELECT COUNT(*)::int FROM retail_automation_alerts WHERE status='OPEN') open_alerts`);
      res.json({ ok: true, summary: result.rows[0], store: storeConfig() });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/retail/products', requireAdmin, async (_req, res, next) => { try {
    const result = await pool.query(`SELECT p.*,COALESCE(JSON_AGG(JSON_BUILD_OBJECT('id',v.id,'sku',v.sku,'label',v.label,'barcode',v.barcode,'priceCents',v.price_cents,'salePriceCents',v.sale_price_cents,'inventoryQty',v.inventory_qty,'active',v.active) ORDER BY v.id) FILTER(WHERE v.id IS NOT NULL),'[]'::json) variants FROM products p LEFT JOIN product_variants v ON v.product_id=p.id GROUP BY p.id ORDER BY p.updated_at DESC`);
    res.json({ ok: true, products: result.rows });
  } catch (error) { next(error); } });

  app.post('/api/admin/retail/products', requireAdmin, async (req, res, next) => { try {
    const p = productPayload(req.body || {});
    const result = await withTransaction(async (client) => {
      const product = await client.query(`INSERT INTO products(name,slug,category,brand,strain_type,product_form,thc_text,cbd_text,description,image_url,lab_url,vendor_name,featured,active,sort_order)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`, [p.name,p.slug,p.category,p.brand,p.strainType,p.productForm,p.thcText,p.cbdText,p.description,p.imageUrl,p.labUrl,p.vendorName,p.featured,p.active,p.sortOrder]);
      await saveVariants(client, product.rows[0].id, p.variants); return product.rows[0];
    });
    res.status(201).json({ ok: true, product: result });
  } catch (error) { next(error); } });

  app.put('/api/admin/retail/products/:id', requireAdmin, async (req, res, next) => { try {
    const p = productPayload(req.body || {}); const id = Number(req.params.id);
    const result = await withTransaction(async (client) => {
      const product = await client.query(`UPDATE products SET name=$1,slug=$2,category=$3,brand=$4,strain_type=$5,product_form=$6,thc_text=$7,cbd_text=$8,description=$9,image_url=$10,lab_url=$11,vendor_name=$12,featured=$13,active=$14,sort_order=$15,updated_at=NOW() WHERE id=$16 RETURNING *`, [p.name,p.slug,p.category,p.brand,p.strainType,p.productForm,p.thcText,p.cbdText,p.description,p.imageUrl,p.labUrl,p.vendorName,p.featured,p.active,p.sortOrder,id]);
      if (!product.rowCount) throw httpError('Product not found.', 404); await saveVariants(client, id, p.variants); return product.rows[0];
    });
    res.json({ ok: true, product: result });
  } catch (error) { next(error); } });

  app.post('/api/admin/retail/upload', requireAdmin, upload.single('image'), async (req, res, next) => { try {
    if (!req.file) throw httpError('Choose an image.');
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) throw httpError('Cloudinary is not configured.', 503);
    cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ folder: process.env.CLOUDINARY_FOLDER || 'dispensary-products', resource_type: 'image' }, (error, response) => error ? reject(error) : resolve(response));
      stream.end(req.file.buffer);
    });
    res.json({ ok: true, url: result.secure_url });
  } catch (error) { next(error); } });

  app.get('/api/admin/retail/orders', requireAdmin, async (req, res, next) => { try {
    const values = []; let where = '';
    if (req.query.status && ORDER_STATUSES.includes(String(req.query.status).toUpperCase())) { values.push(String(req.query.status).toUpperCase()); where = 'WHERE o.status=$1'; }
    const result = await pool.query(`SELECT o.*,c.first_name,c.last_name,c.email,c.phone FROM retail_orders o JOIN retail_customers c ON c.id=o.customer_id ${where} ORDER BY o.created_at DESC LIMIT 500`, values);
    res.json({ ok: true, orders: result.rows });
  } catch (error) { next(error); } });
  app.get('/api/admin/retail/orders/:id', requireAdmin, async (req, res, next) => { try { res.json({ ok: true, order: await orderDetail(Number(req.params.id)) }); } catch (error) { next(error); } });
  app.patch('/api/admin/retail/orders/:id', requireAdmin, async (req, res, next) => { try {
    const id = Number(req.params.id); const target = text(req.body.status, 30).toUpperCase();
    const updated = await withTransaction(async (client) => {
      const current = await client.query('SELECT * FROM retail_orders WHERE id=$1 FOR UPDATE', [id]);
      if (!current.rowCount) throw httpError('Pickup order not found.', 404);
      if (!ORDER_STATUSES.includes(target) || !ORDER_TRANSITIONS[current.rows[0].status].includes(target)) throw httpError(`Cannot move ${current.rows[0].status} to ${target}.`, 409);
      if (['CANCELLED','EXPIRED'].includes(target)) await restoreInventory(client, id);
      const result = await client.query(`UPDATE retail_orders SET status=$1,internal_notes=$2,pos_receipt_number=$3,
        id_verified_at=CASE WHEN $4 THEN COALESCE(id_verified_at,NOW()) ELSE id_verified_at END,
        ready_at=CASE WHEN $1='READY' THEN COALESCE(ready_at,NOW()) ELSE ready_at END,
        completed_at=CASE WHEN $1='COMPLETED' THEN COALESCE(completed_at,NOW()) ELSE completed_at END,updated_at=NOW()
        WHERE id=$5 RETURNING *`, [target,text(req.body.internalNotes,5000),text(req.body.posReceiptNumber,120),bool(req.body.idVerified),id]);
      await client.query('INSERT INTO retail_order_history(order_id,status,note,changed_by) VALUES($1,$2,$3,$4)', [id,target,text(req.body.note,1000),req.admin.email]);
      if (target === 'COMPLETED' && current.rows[0].status !== 'COMPLETED') await client.query(`UPDATE retail_customers SET order_count=order_count+1,total_spend_cents=total_spend_cents+$1,last_order_at=NOW(),updated_at=NOW() WHERE id=$2`, [current.rows[0].total_cents,current.rows[0].customer_id]);
      return result.rows[0];
    });
    const detail = await orderDetail(id);
    if (target === 'READY') sendEmail(detail.email, `Pickup order ${detail.order_number} is ready`, `<h2>Your pickup is ready</h2><p>Bring a valid government-issued photo ID. Payment and final sale occur at the store.</p>`).catch(console.error);
    res.json({ ok: true, order: updated });
  } catch (error) { next(error); } });

  app.get('/api/admin/retail/customers', requireAdmin, async (req, res, next) => { try {
    const q = text(req.query.q, 100); const values = []; let where = '';
    if (q) { values.push(q); where = `WHERE c.first_name ILIKE '%'||$1||'%' OR c.last_name ILIKE '%'||$1||'%' OR c.email ILIKE '%'||$1||'%' OR c.phone ILIKE '%'||$1||'%'`; }
    const result = await pool.query(`SELECT c.* FROM retail_customers c ${where} ORDER BY c.last_order_at DESC NULLS LAST,c.updated_at DESC LIMIT 1000`, values);
    res.json({ ok: true, customers: result.rows });
  } catch (error) { next(error); } });
  app.get('/api/admin/retail/customers/:id', requireAdmin, async (req, res, next) => { try {
    const customer = await pool.query('SELECT * FROM retail_customers WHERE id=$1',[Number(req.params.id)]); if (!customer.rowCount) throw httpError('Customer not found.',404);
    const orders = await pool.query('SELECT * FROM retail_orders WHERE customer_id=$1 ORDER BY created_at DESC',[Number(req.params.id)]);
    res.json({ ok:true,customer:customer.rows[0],orders:orders.rows });
  } catch(error){next(error);} });
  app.patch('/api/admin/retail/customers/:id', requireAdmin, async (req,res,next)=>{try{
    const result=await pool.query(`UPDATE retail_customers SET notes=$1,marketing_opt_in=$2,
      unsubscribed_at=CASE WHEN $2 THEN NULL ELSE COALESCE(unsubscribed_at,NOW()) END,updated_at=NOW() WHERE id=$3 RETURNING *`,[text(req.body.notes,5000),bool(req.body.marketingOptIn),Number(req.params.id)]);
    if(!result.rowCount)throw httpError('Customer not found.',404);res.json({ok:true,customer:result.rows[0]});
  }catch(error){next(error);}});

  app.get('/api/admin/retail/campaigns', requireAdmin, async (_req,res,next)=>{try{const result=await pool.query('SELECT * FROM retail_campaigns ORDER BY created_at DESC LIMIT 500');res.json({ok:true,campaigns:result.rows});}catch(error){next(error);}});
  app.post('/api/admin/retail/campaigns', requireAdmin, async (req,res,next)=>{try{
    const segment=text(req.body.segment,50).toUpperCase();if(!CAMPAIGN_SEGMENTS.includes(segment))throw httpError('Invalid campaign segment.');
    const result=await pool.query(`INSERT INTO retail_campaigns(name,subject,headline,body_text,cta_label,cta_url,segment,segment_value)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[text(req.body.name,200),text(req.body.subject,200),text(req.body.headline,240),text(req.body.bodyText,10000),text(req.body.ctaLabel,120)||'View menu',text(req.body.ctaUrl,500)||'/shop',segment,text(req.body.segmentValue,120)]);
    res.status(201).json({ok:true,campaign:result.rows[0]});
  }catch(error){next(error);}});
  app.post('/api/admin/retail/campaigns/:id/send', requireAdmin, async (req,res,next)=>{try{
    if(!process.env.BUSINESS_POSTAL_ADDRESS&&!process.env.BUSINESS_ADDRESS)throw httpError('Business postal address is required before sending.',503);
    const campaignResult=await pool.query('SELECT * FROM retail_campaigns WHERE id=$1 FOR UPDATE',[Number(req.params.id)]);if(!campaignResult.rowCount)throw httpError('Campaign not found.',404);
    const campaign=campaignResult.rows[0];if(campaign.status!=='DRAFT')throw httpError('Only draft campaigns can be sent.',409);
    const audience=await campaignAudience(campaign);await pool.query(`UPDATE retail_campaigns SET status='SENDING',recipient_count=$1,updated_at=NOW() WHERE id=$2`,[audience.length,campaign.id]);
    let sent=0;let failed=0;
    for(const customer of audience){try{
      const unsubscribe=`${String(process.env.SITE_URL||'').replace(/\/+$/,'')}/api/retail/unsubscribe?token=${encodeURIComponent(unsubscribeToken(customer.id,customer.email))}`;
      const response=await sendEmail(customer.email,campaign.subject,campaignHtml(campaign,customer),{'List-Unsubscribe':`<${unsubscribe}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'});
      await pool.query(`INSERT INTO retail_campaign_recipients(campaign_id,customer_id,email,status,provider_message_id,sent_at) VALUES($1,$2,$3,'SENT',$4,NOW()) ON CONFLICT(campaign_id,customer_id) DO UPDATE SET status='SENT',provider_message_id=EXCLUDED.provider_message_id,sent_at=NOW()`,[campaign.id,customer.id,customer.email,response&&response.id||'']);sent++;
    }catch(error){failed++;await pool.query(`INSERT INTO retail_campaign_recipients(campaign_id,customer_id,email,status,error_message) VALUES($1,$2,$3,'FAILED',$4) ON CONFLICT(campaign_id,customer_id) DO UPDATE SET status='FAILED',error_message=EXCLUDED.error_message`,[campaign.id,customer.id,customer.email,text(error.message,1000)]);}}
    await pool.query(`UPDATE retail_campaigns SET status=$1,sent_count=$2,failed_count=$3,sent_at=NOW(),updated_at=NOW() WHERE id=$4`,[failed&&sent===0?'FAILED':'SENT',sent,failed,campaign.id]);res.json({ok:true,recipientCount:audience.length,sent,failed});
  }catch(error){next(error);}});

  app.get('/api/admin/retail/automations', requireAdmin, async (_req,res,next)=>{try{
    const [rules,alerts,runs]=await Promise.all([pool.query('SELECT * FROM retail_automation_rules ORDER BY name'),pool.query("SELECT * FROM retail_automation_alerts WHERE status='OPEN' ORDER BY created_at DESC LIMIT 200"),pool.query('SELECT * FROM retail_automation_runs ORDER BY started_at DESC LIMIT 100')]);
    res.json({ok:true,rules:rules.rows,alerts:alerts.rows,runs:runs.rows});
  }catch(error){next(error);}});
  app.patch('/api/admin/retail/automations/:key', requireAdmin, async (req,res,next)=>{try{
    const result=await pool.query(`UPDATE retail_automation_rules SET enabled=$1,settings=$2::jsonb,updated_at=NOW() WHERE rule_key=$3 RETURNING *`,[bool(req.body.enabled),JSON.stringify(req.body.settings||{}),req.params.key]);if(!result.rowCount)throw httpError('Rule not found.',404);res.json({ok:true,rule:result.rows[0]});
  }catch(error){next(error);}});
  app.post('/api/admin/retail/automations/:key/run', requireAdmin, async (req,res,next)=>{try{res.json({ok:true,result:await runRule(req.params.key)});}catch(error){next(error);}});
  app.patch('/api/admin/retail/alerts/:id', requireAdmin, async (req,res,next)=>{try{const status=text(req.body.status,20).toUpperCase();if(!['OPEN','DISMISSED','RESOLVED'].includes(status))throw httpError('Invalid alert status.');const result=await pool.query(`UPDATE retail_automation_alerts SET status=$1,resolved_at=CASE WHEN $1='RESOLVED' THEN NOW() ELSE resolved_at END,updated_at=NOW() WHERE id=$2 RETURNING *`,[status,Number(req.params.id)]);res.json({ok:true,alert:result.rows[0]});}catch(error){next(error);}});
}

module.exports = { ensureRetailSchema, registerRetailApi, startRetailAutomationWorker, storeConfig };

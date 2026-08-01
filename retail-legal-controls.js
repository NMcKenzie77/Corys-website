'use strict';

const { pool } = require('./db');

const NOTICE_VERSION = '2026-08-01-retail';
const LIMITS = {
  USABLE_CANNABIS_GRAMS: 28.3495,
  CONCENTRATE_GRAMS: 7,
  INFUSED_SOLID_OUNCES: 16,
  INFUSED_LIQUID_OUNCES: 72,
  INFUSED_LIQUID_LOW_DOSE_THC_MG: 200
};
const LIMIT_CATEGORIES = Object.keys(LIMITS);
const CLAIM_PATTERN = /\b(cure|cures|cured|curing|treat|treats|treated|treating|heal|heals|healed|healing|therapeutic|prevents?|diagnos(?:e|es|ed|ing)|medical benefit)\b/i;
const CHILD_APPEAL_PATTERN = /\b(kids?|children|child|cartoon|toy|candy[- ]?themed|school|teen|youth|mascot)\b/i;
const FORBIDDEN_ORDER_FIELDS = [
  'shippingAddress', 'shipAddress', 'deliveryAddress', 'address1', 'address2', 'city', 'state',
  'postalCode', 'delivery', 'deliveryMethod', 'carrier', 'trackingNumber', 'paymentToken',
  'cardNumber', 'cardToken', 'onlinePayment', 'chargeId', 'paymentIntent', 'paymentMethodId'
];

function text(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function bool(value) {
  return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function cents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : NaN;
}

function currentWashingtonHour() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  return Number(parts.find((part) => part.type === 'hour').value);
}

async function ensureRetailLegalSchema() {
  await pool.query(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS advertising_reviewed BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS acquisition_cost_cents INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS limit_category TEXT NOT NULL DEFAULT '';
    ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS limit_amount NUMERIC(12,4) NOT NULL DEFAULT 0;
    ALTER TABLE retail_customers ADD COLUMN IF NOT EXISTS marketing_state CHAR(2) NOT NULL DEFAULT '';
    ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS payment_provider TEXT NOT NULL DEFAULT '';
    ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS completed_in_store BOOLEAN NOT NULL DEFAULT FALSE;

    UPDATE retail_customers
    SET marketing_opt_in=FALSE,
        unsubscribed_at=COALESCE(unsubscribed_at,NOW()),
        updated_at=NOW()
    WHERE marketing_opt_in=TRUE AND marketing_state<>'WA';

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname='retail_customers_marketing_wa_check'
      ) THEN
        ALTER TABLE retail_customers ADD CONSTRAINT retail_customers_marketing_wa_check
          CHECK (marketing_opt_in=FALSE OR marketing_state='WA');
      END IF;
    END $$;
  `);
}

function validateProductCopy(body) {
  const combined = [body.name, body.brand, body.description, body.strainType, body.productForm]
    .map((value) => text(value, 5000))
    .join(' ');

  if (CLAIM_PATTERN.test(combined)) {
    throw httpError('Public cannabis product copy may not claim curative or therapeutic effects.');
  }
  if (CHILD_APPEAL_PATTERN.test(combined)) {
    throw httpError('Public cannabis advertising may not be designed to appeal to people under 21.');
  }
  if (body.active !== false && !bool(body.advertisingReviewed)) {
    throw httpError('Confirm that the product name, copy, and image were reviewed for Washington advertising compliance.');
  }

  const variants = Array.isArray(body.variants) ? body.variants : [];
  if (!variants.length) throw httpError('At least one package is required.');

  for (const [index, variant] of variants.entries()) {
    const price = cents(variant.price);
    const salePrice = text(variant.salePrice, 30) === '' ? null : cents(variant.salePrice);
    const acquisitionCost = cents(variant.acquisitionCost);
    const limitCategory = text(variant.limitCategory, 60).toUpperCase();
    const limitAmount = Number(variant.limitAmount);

    if (!Number.isInteger(acquisitionCost) || acquisitionCost < 0) {
      throw httpError(`Package ${index + 1} requires a valid acquisition cost.`);
    }
    if (price < acquisitionCost || (salePrice != null && salePrice < acquisitionCost)) {
      throw httpError(`Package ${index + 1} cannot be priced below its current acquisition cost.`);
    }
    if (!LIMIT_CATEGORIES.includes(limitCategory) || !Number.isFinite(limitAmount) || limitAmount <= 0) {
      throw httpError(`Package ${index + 1} requires a valid Washington purchase-limit category and amount.`);
    }
  }
}

async function persistProductCompliance(body) {
  const variants = Array.isArray(body.variants) ? body.variants : [];
  await pool.query('UPDATE products SET advertising_reviewed=$1 WHERE slug=$2', [
    bool(body.advertisingReviewed),
    text(body.slug || body.name, 160).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  ]);

  for (const variant of variants) {
    await pool.query(`
      UPDATE product_variants SET
        acquisition_cost_cents=$1,
        limit_category=$2,
        limit_amount=$3,
        updated_at=NOW()
      WHERE sku=$4
    `, [
      cents(variant.acquisitionCost),
      text(variant.limitCategory, 60).toUpperCase(),
      Number(variant.limitAmount),
      text(variant.sku, 100).toUpperCase()
    ]);
  }
}

async function augmentAdminProducts(payload) {
  if (!payload || !Array.isArray(payload.products) || !payload.products.length) return;
  const compliance = await pool.query(`
    SELECT p.id product_id,p.advertising_reviewed,v.id variant_id,v.sku,
      v.acquisition_cost_cents,v.limit_category,v.limit_amount
    FROM products p
    LEFT JOIN product_variants v ON v.product_id=p.id
  `);
  const productMap = new Map();
  const variantMap = new Map();
  for (const row of compliance.rows) {
    productMap.set(Number(row.product_id), Boolean(row.advertising_reviewed));
    if (row.variant_id) variantMap.set(Number(row.variant_id), row);
  }
  payload.products = payload.products.map((product) => ({
    ...product,
    advertisingReviewed: productMap.get(Number(product.id)) || false,
    variants: (product.variants || []).map((variant) => {
      const row = variantMap.get(Number(variant.id)) || {};
      return {
        ...variant,
        acquisitionCostCents: Number(row.acquisition_cost_cents || 0),
        limitCategory: row.limit_category || '',
        limitAmount: Number(row.limit_amount || 0)
      };
    })
  }));
}

async function validatePurchaseLimits(items) {
  const normalized = Array.isArray(items) ? items : [];
  if (!normalized.length) return;
  const ids = [...new Set(normalized.map((item) => Number(item.variantId)).filter(Number.isInteger))];
  const result = await pool.query(`
    SELECT id, limit_category, limit_amount
    FROM product_variants
    WHERE id=ANY($1::bigint[])
  `, [ids]);
  const variants = new Map(result.rows.map((row) => [Number(row.id), row]));
  const totals = {};

  for (const item of normalized) {
    const row = variants.get(Number(item.variantId));
    const quantity = Math.max(1, Number(item.quantity) || 0);
    if (!row || !LIMIT_CATEGORIES.includes(row.limit_category) || Number(row.limit_amount) <= 0) {
      throw httpError('A selected package is missing required purchase-limit data. Contact the store.');
    }
    totals[row.limit_category] = (totals[row.limit_category] || 0) + Number(row.limit_amount) * quantity;
  }

  for (const [category, total] of Object.entries(totals)) {
    if (total > LIMITS[category] + 0.0001) {
      throw httpError('This reservation exceeds Washington retail purchase limits. Reduce the quantity and try again.');
    }
  }
}

function rejectShippingAndOnlinePayment(body) {
  for (const field of FORBIDDEN_ORDER_FIELDS) {
    if (body[field] != null && String(body[field]).trim() !== '') {
      throw httpError('This store accepts pickup reservations only. Shipping, delivery, and online cannabis payment are not available.');
    }
  }
}

function wrapSuccessfulJson(res, callback) {
  const original = res.json.bind(res);
  res.json = function wrapped(payload) {
    if (res.statusCode >= 200 && res.statusCode < 300 && payload && payload.ok) {
      Promise.resolve(callback(payload)).catch((error) => console.error('Retail compliance persistence failed:', error.message));
    }
    return original(payload);
  };
}

function registerRetailLegalControls(app) {
  app.get('/api/admin/retail/products', (req, res, next) => {
    wrapSuccessfulJson(res, (payload) => augmentAdminProducts(payload));
    next();
  });

  app.use(['/api/admin/retail/products', '/api/admin/retail/products/:id'], async (req, res, next) => {
    try {
      if (!['POST', 'PUT'].includes(req.method)) return next();
      validateProductCopy(req.body || {});
      wrapSuccessfulJson(res, () => persistProductCompliance(req.body || {}));
      next();
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/retail/orders', async (req, _res, next) => {
    try {
      const body = req.body || {};
      rejectShippingAndOnlinePayment(body);
      await validatePurchaseLimits(body.items);
      if (bool(body.marketingConsent) && text(body.marketingState, 2).toUpperCase() !== 'WA') {
        throw httpError('Cannabis marketing signup is limited to Washington residents. You may still place a pickup reservation without marketing consent.');
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/retail/orders', (req, res, next) => {
    wrapSuccessfulJson(res, async () => {
      const customerEmail = text(req.body && req.body.email, 200).toLowerCase();
      await pool.query(`
        UPDATE retail_customers SET marketing_state=$1, updated_at=NOW()
        WHERE email=$2
      `, [bool(req.body.marketingConsent) ? 'WA' : '', customerEmail]);
      await pool.query(`
        UPDATE consent_records SET notice_version=$1
        WHERE id=(SELECT id FROM consent_records WHERE email=$2 AND consent_type='RETAIL_PICKUP_ORDER' ORDER BY id DESC LIMIT 1)
      `, [NOTICE_VERSION, customerEmail]);
    });
    next();
  });

  app.patch('/api/admin/retail/orders/:id', async (req, res, next) => {
    try {
      const target = text(req.body && req.body.status, 30).toUpperCase();
      if (target === 'COMPLETED') {
        if (!bool(req.body.idVerified)) throw httpError('Verify an acceptable, unexpired government-issued ID before completing the sale.');
        if (!text(req.body.posReceiptNumber, 120)) throw httpError('Record the in-store POS receipt number before completing the sale.');
        if (currentWashingtonHour() < 8) throw httpError('Washington cannabis retail sales may not be completed before 8:00 a.m.');
        const provider = text(req.body.paymentProvider || 'IN_STORE', 120);
        wrapSuccessfulJson(res, async () => {
          await pool.query(`
            UPDATE retail_orders SET payment_provider=$1, completed_in_store=TRUE
            WHERE id=$2
          `, [provider, Number(req.params.id)]);
        });
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/admin/retail/customers/:id', async (req, res, next) => {
    try {
      if (bool(req.body && req.body.marketingOptIn)) {
        const state = text(req.body.marketingState, 2).toUpperCase();
        if (state !== 'WA') throw httpError('Marketing consent may only be enabled for a documented Washington resident.');
        wrapSuccessfulJson(res, async () => {
          await pool.query('UPDATE retail_customers SET marketing_state=$1 WHERE id=$2', ['WA', Number(req.params.id)]);
        });
      }
      next();
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/retail/campaigns', (req, _res, next) => {
    try {
      const copy = [req.body && req.body.subject, req.body && req.body.headline, req.body && req.body.bodyText]
        .map((value) => text(value, 10000)).join(' ');
      if (CLAIM_PATTERN.test(copy)) throw httpError('Campaign copy may not claim curative or therapeutic effects.');
      if (CHILD_APPEAL_PATTERN.test(copy)) throw httpError('Campaign copy may not target or appeal to people under 21.');
      next();
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/retail/campaigns/:id/send', async (_req, _res, next) => {
    try {
      const invalid = await pool.query(`
        SELECT COUNT(*)::int count FROM retail_customers
        WHERE marketing_opt_in=TRUE AND unsubscribed_at IS NULL AND marketing_state<>'WA'
      `);
      if (invalid.rows[0].count > 0) {
        throw httpError('Campaign blocked because one or more opted-in contacts lack documented Washington residency.', 409);
      }
      next();
    } catch (error) {
      next(error);
    }
  });
}

module.exports = {
  LIMITS,
  NOTICE_VERSION,
  ensureRetailLegalSchema,
  registerRetailLegalControls
};

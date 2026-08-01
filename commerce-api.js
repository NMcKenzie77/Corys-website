'use strict';

const crypto = require('crypto');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const { pool, withTransaction } = require('./db');
const {
  verifyAdminCredentials,
  setSessionCookie,
  clearSessionCookie,
  requireAdmin,
  verifySession,
  COOKIE_NAME
} = require('./auth');

const STATUSES = [
  'NEW',
  'APPROVED',
  'PACKING',
  'READY_FOR_CARRIER',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED'
];

const ALLOWED_STATUS_TRANSITIONS = {
  NEW: ['NEW', 'APPROVED', 'CANCELLED'],
  APPROVED: ['APPROVED', 'PACKING', 'CANCELLED'],
  PACKING: ['PACKING', 'READY_FOR_CARRIER', 'CANCELLED'],
  READY_FOR_CARRIER: ['READY_FOR_CARRIER', 'SHIPPED', 'CANCELLED'],
  SHIPPED: ['SHIPPED', 'DELIVERED'],
  DELIVERED: ['DELIVERED'],
  CANCELLED: ['CANCELLED']
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPG, PNG, WEBP, and GIF images are accepted.'));
  }
});

function text(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function email(value) {
  const normalized = text(value, 200).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : '';
}

function slug(value) {
  return text(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : NaN;
}

function esc(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function orderNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `CB-${date}-${suffix}`;
}

const buckets = new Map();
function limit(windowMs, max) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || bucket.reset <= now) {
      bucket = { count: 0, reset: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({
        ok: false,
        error: 'Too many requests. Try again shortly.'
      });
    }

    next();
  };
}

async function sendEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM || !to) return;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [to],
      subject,
      html
    })
  });

  if (!response.ok) {
    throw new Error(`Resend ${response.status}: ${await response.text()}`);
  }
}

function orderHtml(order, items, heading) {
  const rows = items.map((item) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #ddd">
        ${esc(item.product_name)} — ${esc(item.variant_label)}
      </td>
      <td style="padding:8px;border-bottom:1px solid #ddd">${item.quantity}</td>
      <td style="padding:8px;border-bottom:1px solid #ddd">
        $${(item.line_total_cents / 100).toFixed(2)}
      </td>
    </tr>
  `).join('');

  return `
    <h2>${esc(heading)}</h2>
    <p><b>Order:</b> ${esc(order.order_number)}</p>
    <p><b>Status:</b> ${esc(order.status)}</p>
    <p><b>Retailer:</b> ${esc(order.ship_business_name)}</p>
    <p>
      <b>Destination:</b><br>
      ${esc(order.ship_address1)} ${esc(order.ship_address2)}<br>
      ${esc(order.ship_city)}, ${esc(order.ship_state)} ${esc(order.ship_postal_code)}
    </p>
    <table style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table>
    <p><b>Total:</b> $${(order.total_cents / 100).toFixed(2)}</p>
    <p>
      This wholesale request requires license verification, inventory confirmation,
      and lawful Washington business-to-business fulfillment.
    </p>
  `;
}

async function products(includeInactiveProducts = false, includeInactiveVariants = false) {
  const variantFilter = includeInactiveVariants ? '' : 'AND v.active=TRUE';
  const productFilter = includeInactiveProducts ? '' : 'WHERE p.active=TRUE';

  const result = await pool.query(`
    SELECT
      p.*,
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id', v.id,
            'sku', v.sku,
            'label', v.label,
            'priceCents', v.price_cents,
            'salePriceCents', v.sale_price_cents,
            'inventoryQty', v.inventory_qty,
            'active', v.active
          )
          ORDER BY v.id
        ) FILTER (WHERE v.id IS NOT NULL ${variantFilter}),
        '[]'::json
      ) AS variants
    FROM products p
    LEFT JOIN product_variants v ON v.product_id=p.id
    ${productFilter}
    GROUP BY p.id
    ORDER BY p.featured DESC, p.updated_at DESC
  `);

  return result.rows.map((product) => ({
    id: Number(product.id),
    name: product.name,
    slug: product.slug,
    category: product.category,
    description: product.description,
    imageUrl: product.image_url,
    featured: product.featured,
    active: product.active,
    variants: product.variants || []
  }));
}

function productPayload(body) {
  const payload = {
    name: text(body.name, 160),
    slug: slug(body.slug || body.name),
    category: text(body.category, 100),
    description: text(body.description, 5000),
    imageUrl: text(body.imageUrl, 1000),
    featured: body.featured === true,
    active: body.active !== false,
    variants: Array.isArray(body.variants) ? body.variants.slice(0, 50) : []
  };

  if (!payload.name || !payload.slug || !payload.category || !payload.variants.length) {
    throw httpError('Name, category, and at least one variant are required.');
  }

  payload.variants = payload.variants.map((variant, index) => {
    const normalized = {
      label: text(variant.label, 100),
      sku: text(variant.sku, 100).toUpperCase(),
      priceCents: cents(variant.price),
      salePriceCents: text(variant.salePrice, 30) === '' ? null : cents(variant.salePrice),
      inventoryQty: Number(variant.inventoryQty),
      active: variant.active !== false
    };

    if (
      !normalized.label ||
      !normalized.sku ||
      !Number.isInteger(normalized.priceCents) ||
      normalized.priceCents < 0 ||
      !Number.isInteger(normalized.inventoryQty) ||
      normalized.inventoryQty < 0
    ) {
      throw httpError(`Variant ${index + 1} is invalid.`);
    }

    if (
      normalized.salePriceCents != null &&
      (
        !Number.isInteger(normalized.salePriceCents) ||
        normalized.salePriceCents < 0 ||
        normalized.salePriceCents > normalized.priceCents
      )
    ) {
      throw httpError(`Variant ${index + 1} sale price is invalid.`);
    }

    return normalized;
  });

  const skuSet = new Set(payload.variants.map((variant) => variant.sku));
  if (skuSet.size !== payload.variants.length) {
    throw httpError('Each package variant must use a unique SKU.');
  }

  return payload;
}

async function saveProductVariants(client, productId, variants) {
  const skus = variants.map((variant) => variant.sku);

  const conflicting = await client.query(
    `
      SELECT sku
      FROM product_variants
      WHERE sku = ANY($1::text[])
        AND product_id <> $2
      LIMIT 1
    `,
    [skus, productId]
  );

  if (conflicting.rowCount) {
    throw httpError(`SKU ${conflicting.rows[0].sku} already belongs to another product.`, 409);
  }

  for (const variant of variants) {
    await client.query(
      `
        INSERT INTO product_variants(
          product_id,
          sku,
          label,
          price_cents,
          sale_price_cents,
          inventory_qty,
          active
        )
        VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (sku) DO UPDATE SET
          label=EXCLUDED.label,
          price_cents=EXCLUDED.price_cents,
          sale_price_cents=EXCLUDED.sale_price_cents,
          inventory_qty=EXCLUDED.inventory_qty,
          active=EXCLUDED.active,
          updated_at=NOW()
        WHERE product_variants.product_id=EXCLUDED.product_id
      `,
      [
        productId,
        variant.sku,
        variant.label,
        variant.priceCents,
        variant.salePriceCents,
        variant.inventoryQty,
        variant.active
      ]
    );
  }

  const omitted = await client.query(
    `
      SELECT id, sku
      FROM product_variants
      WHERE product_id=$1
        AND active=TRUE
        AND NOT (sku = ANY($2::text[]))
    `,
    [productId, skus]
  );

  if (!omitted.rowCount) return;

  const omittedIds = omitted.rows.map((row) => row.id);
  const pending = await client.query(
    `
      SELECT DISTINCT oi.sku
      FROM order_items oi
      JOIN orders o ON o.id=oi.order_id
      WHERE oi.variant_id = ANY($1::bigint[])
        AND o.status NOT IN ('DELIVERED','CANCELLED')
      LIMIT 1
    `,
    [omittedIds]
  );

  if (pending.rowCount) {
    throw httpError(
      `SKU ${pending.rows[0].sku} cannot be removed while it has an open order.`,
      409
    );
  }

  await client.query(
    `
      UPDATE product_variants
      SET active=FALSE, updated_at=NOW()
      WHERE id = ANY($1::bigint[])
    `,
    [omittedIds]
  );
}

function registerCommerce(app, options = {}) {
  const salesEmail = options.salesEmail || process.env.SALES_EMAIL || process.env.ADMIN_EMAIL || '';

  app.get('/api/products', async (_req, res, next) => {
    try {
      res.json({ ok: true, products: await products(false, false) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/orders', limit(15 * 60 * 1000, 8), async (req, res, next) => {
    try {
      const body = req.body || {};
      const state = text(body.state, 2).toUpperCase();
      const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];
      const customer = {
        businessName: text(body.businessName, 160),
        contactName: text(body.contactName, 160),
        email: email(body.email),
        phone: text(body.phone, 50),
        licenseNumber: text(body.licenseNumber, 100),
        ubiNumber: text(body.ubiNumber, 100),
        address1: text(body.address1, 200),
        address2: text(body.address2, 200),
        city: text(body.city, 100),
        state,
        postalCode: text(body.postalCode, 20),
        notes: text(body.notes, 2000)
      };

      if (
        !customer.businessName ||
        !customer.contactName ||
        !customer.email ||
        !customer.phone ||
        !customer.licenseNumber ||
        !customer.address1 ||
        !customer.city ||
        !customer.postalCode ||
        !items.length
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Complete all required retailer, delivery, and product fields.'
        });
      }

      if (state !== 'WA') {
        return res.status(400).json({
          ok: false,
          error: 'Only licensed Washington business destinations are supported.'
        });
      }

      if (body.licenseConfirmed !== true) {
        return res.status(400).json({
          ok: false,
          error: 'License confirmation is required.'
        });
      }

      const saved = await withTransaction(async (client) => {
        const requested = items.map((item) => ({
          variantId: Number(item.variantId),
          quantity: Math.max(1, Math.min(999, Number(item.quantity) || 0))
        }));

        if (
          requested.some((item) =>
            !Number.isInteger(item.variantId) || item.variantId < 1 || !item.quantity
          )
        ) {
          throw httpError('Invalid order item.');
        }

        const ids = [...new Set(requested.map((item) => item.variantId))];
        const variantResult = await client.query(
          `
            SELECT
              v.*,
              p.name AS product_name,
              p.id AS product_id,
              p.active AS product_active
            FROM product_variants v
            JOIN products p ON p.id=v.product_id
            WHERE v.id=ANY($1::bigint[])
            FOR UPDATE
          `,
          [ids]
        );

        const variantMap = new Map(
          variantResult.rows.map((row) => [Number(row.id), row])
        );

        let total = 0;
        const resolved = requested.map((item) => {
          const row = variantMap.get(item.variantId);

          if (!row || !row.active || !row.product_active) {
            throw httpError('A product is no longer available.', 409);
          }

          if (row.inventory_qty < item.quantity) {
            throw httpError(
              `${row.product_name} (${row.label}) has only ${row.inventory_qty} available.`,
              409
            );
          }

          const unitPrice = row.sale_price_cents == null
            ? row.price_cents
            : Math.min(row.price_cents, row.sale_price_cents);
          const lineTotal = unitPrice * item.quantity;
          total += lineTotal;

          return {
            row,
            quantity: item.quantity,
            unitPrice,
            lineTotal
          };
        });

        const customerResult = await client.query(
          `
            INSERT INTO customers(
              business_name,
              contact_name,
              email,
              phone,
              license_number,
              ubi_number,
              ship_address1,
              ship_address2,
              city,
              state,
              postal_code,
              delivery_notes
            )
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            ON CONFLICT(email) DO UPDATE SET
              business_name=EXCLUDED.business_name,
              contact_name=EXCLUDED.contact_name,
              phone=EXCLUDED.phone,
              license_number=EXCLUDED.license_number,
              ubi_number=EXCLUDED.ubi_number,
              ship_address1=EXCLUDED.ship_address1,
              ship_address2=EXCLUDED.ship_address2,
              city=EXCLUDED.city,
              state=EXCLUDED.state,
              postal_code=EXCLUDED.postal_code,
              delivery_notes=EXCLUDED.delivery_notes,
              updated_at=NOW()
            RETURNING *
          `,
          [
            customer.businessName,
            customer.contactName,
            customer.email,
            customer.phone,
            customer.licenseNumber,
            customer.ubiNumber,
            customer.address1,
            customer.address2,
            customer.city,
            customer.state,
            customer.postalCode,
            customer.notes
          ]
        );

        const orderResult = await client.query(
          `
            INSERT INTO orders(
              order_number,
              customer_id,
              subtotal_cents,
              total_cents,
              ship_business_name,
              ship_contact_name,
              ship_address1,
              ship_address2,
              ship_city,
              ship_state,
              ship_postal_code,
              customer_notes
            )
            VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            RETURNING *
          `,
          [
            orderNumber(),
            customerResult.rows[0].id,
            total,
            customer.businessName,
            customer.contactName,
            customer.address1,
            customer.address2,
            customer.city,
            customer.state,
            customer.postalCode,
            customer.notes
          ]
        );

        for (const item of resolved) {
          await client.query(
            `
              INSERT INTO order_items(
                order_id,
                product_id,
                variant_id,
                product_name,
                variant_label,
                sku,
                quantity,
                unit_price_cents,
                line_total_cents
              )
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
            `,
            [
              orderResult.rows[0].id,
              item.row.product_id,
              item.row.id,
              item.row.product_name,
              item.row.label,
              item.row.sku,
              item.quantity,
              item.unitPrice,
              item.lineTotal
            ]
          );

          await client.query(
            `
              UPDATE product_variants
              SET inventory_qty=inventory_qty-$1, updated_at=NOW()
              WHERE id=$2
            `,
            [item.quantity, item.row.id]
          );
        }

        await client.query(
          `
            INSERT INTO order_status_history(order_id,status,note)
            VALUES($1,'NEW','Order submitted by retailer.')
          `,
          [orderResult.rows[0].id]
        );

        const itemResult = await client.query(
          'SELECT * FROM order_items WHERE order_id=$1 ORDER BY id',
          [orderResult.rows[0].id]
        );

        return {
          order: orderResult.rows[0],
          customer: customerResult.rows[0],
          items: itemResult.rows
        };
      });

      Promise.allSettled([
        sendEmail(
          salesEmail,
          `New wholesale order ${saved.order.order_number}`,
          orderHtml(saved.order, saved.items, 'New wholesale order')
        ),
        sendEmail(
          saved.customer.email,
          `Order request received: ${saved.order.order_number}`,
          orderHtml(saved.order, saved.items, 'Your wholesale order request was received')
        )
      ]).then((results) => {
        results.forEach((result) => {
          if (result.status === 'rejected') console.error(result.reason);
        });
      });

      res.status(201).json({
        ok: true,
        orderNumber: saved.order.order_number,
        status: saved.order.status,
        totalCents: saved.order.total_cents
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/inquiry', limit(15 * 60 * 1000, 10), async (req, res, next) => {
    try {
      const body = req.body || {};
      const normalizedEmail = email(body.email);
      const businessName = text(body.businessName, 160);
      const contactName = text(body.contactName, 160);

      if (!businessName || !contactName || !normalizedEmail) {
        return res.status(400).json({
          ok: false,
          error: 'Business name, contact name, and email are required.'
        });
      }

      const result = await pool.query(
        `
          INSERT INTO inquiries(
            business_name,
            contact_name,
            license_number,
            email,
            phone,
            message
          )
          VALUES($1,$2,$3,$4,$5,$6)
          RETURNING id
        `,
        [
          businessName,
          contactName,
          text(body.licenseNumber, 100),
          normalizedEmail,
          text(body.phone, 50),
          text(body.message, 2000)
        ]
      );

      sendEmail(
        salesEmail,
        `New wholesale inquiry from ${businessName}`,
        `
          <h2>New wholesale inquiry</h2>
          <p><b>Business:</b> ${esc(businessName)}</p>
          <p><b>Contact:</b> ${esc(contactName)}</p>
          <p><b>Email:</b> ${esc(normalizedEmail)}</p>
          <p><b>Phone:</b> ${esc(text(body.phone, 50))}</p>
          <p><b>License:</b> ${esc(text(body.licenseNumber, 100))}</p>
          <p>${esc(text(body.message, 2000))}</p>
        `
      ).catch(console.error);

      res.status(201).json({ ok: true, id: result.rows[0].id });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/login', limit(15 * 60 * 1000, 8), async (req, res, next) => {
    try {
      const normalizedEmail = email(req.body.email);
      const valid = await verifyAdminCredentials(normalizedEmail, req.body.password);

      if (!valid) {
        return res.status(401).json({ ok: false, error: 'Invalid email or password.' });
      }

      setSessionCookie(res, normalizedEmail);
      res.json({ ok: true, admin: { email: normalizedEmail } });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/logout', (_req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/admin/me', (req, res) => {
    try {
      const session = verifySession(req.cookies && req.cookies[COOKIE_NAME]);
      if (!session) return res.status(401).json({ ok: false });
      res.json({ ok: true, admin: { email: session.email } });
    } catch (_error) {
      res.status(401).json({ ok: false });
    }
  });

  app.get('/api/admin/summary', requireAdmin, async (_req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT
          (SELECT COUNT(*) FROM products WHERE active=TRUE) AS active_products,
          (
            SELECT COALESCE(SUM(inventory_qty),0)
            FROM product_variants
            WHERE active=TRUE
          ) AS units_available,
          (SELECT COUNT(*) FROM orders WHERE status='NEW') AS new_orders,
          (
            SELECT COUNT(*)
            FROM orders
            WHERE created_at>=NOW()-INTERVAL '30 days'
          ) AS orders_30d,
          (
            SELECT COALESCE(SUM(total_cents),0)
            FROM orders
            WHERE status<>'CANCELLED'
              AND created_at>=NOW()-INTERVAL '30 days'
          ) AS gross_30d
      `);

      res.json({ ok: true, summary: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/products', requireAdmin, async (_req, res, next) => {
    try {
      res.json({ ok: true, products: await products(true, false) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/products', requireAdmin, async (req, res, next) => {
    try {
      const payload = productPayload(req.body || {});
      const saved = await withTransaction(async (client) => {
        const result = await client.query(
          `
            INSERT INTO products(
              name,
              slug,
              category,
              description,
              image_url,
              featured,
              active
            )
            VALUES($1,$2,$3,$4,$5,$6,$7)
            RETURNING *
          `,
          [
            payload.name,
            payload.slug,
            payload.category,
            payload.description,
            payload.imageUrl,
            payload.featured,
            payload.active
          ]
        );

        await saveProductVariants(client, result.rows[0].id, payload.variants);
        return result.rows[0];
      });

      res.status(201).json({ ok: true, product: saved });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/admin/products/:id', requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) throw httpError('Invalid product.', 400);

      const payload = productPayload(req.body || {});
      const saved = await withTransaction(async (client) => {
        const result = await client.query(
          `
            UPDATE products
            SET
              name=$1,
              slug=$2,
              category=$3,
              description=$4,
              image_url=$5,
              featured=$6,
              active=$7,
              updated_at=NOW()
            WHERE id=$8
            RETURNING *
          `,
          [
            payload.name,
            payload.slug,
            payload.category,
            payload.description,
            payload.imageUrl,
            payload.featured,
            payload.active,
            id
          ]
        );

        if (!result.rowCount) throw httpError('Product not found.', 404);
        await saveProductVariants(client, id, payload.variants);
        return result.rows[0];
      });

      res.json({ ok: true, product: saved });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    '/api/admin/upload',
    requireAdmin,
    upload.single('image'),
    async (req, res, next) => {
      try {
        if (!req.file) {
          return res.status(400).json({ ok: false, error: 'Choose an image.' });
        }

        if (
          !process.env.CLOUDINARY_CLOUD_NAME ||
          !process.env.CLOUDINARY_API_KEY ||
          !process.env.CLOUDINARY_API_SECRET
        ) {
          return res.status(503).json({
            ok: false,
            error: 'Cloudinary is not configured. Paste an image URL or add Cloudinary variables.'
          });
        }

        cloudinary.config({
          cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
          api_key: process.env.CLOUDINARY_API_KEY,
          api_secret: process.env.CLOUDINARY_API_SECRET,
          secure: true
        });

        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: process.env.CLOUDINARY_FOLDER || 'cory-wholesale-products',
              resource_type: 'image',
              transformation: [
                { width: 1400, height: 1400, crop: 'limit' },
                { quality: 'auto', fetch_format: 'auto' }
              ]
            },
            (error, uploaded) => error ? reject(error) : resolve(uploaded)
          );
          stream.end(req.file.buffer);
        });

        res.status(201).json({ ok: true, url: result.secure_url });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get('/api/admin/orders', requireAdmin, async (req, res, next) => {
    try {
      const status = text(req.query.status, 40).toUpperCase();
      const filterStatus = STATUSES.includes(status);
      const result = await pool.query(
        `
          SELECT
            o.*,
            c.email,
            c.phone,
            c.license_number,
            c.ubi_number,
            COALESCE(
              JSON_AGG(
                JSON_BUILD_OBJECT(
                  'id', oi.id,
                  'productName', oi.product_name,
                  'variantLabel', oi.variant_label,
                  'sku', oi.sku,
                  'quantity', oi.quantity,
                  'unitPriceCents', oi.unit_price_cents,
                  'lineTotalCents', oi.line_total_cents
                )
                ORDER BY oi.id
              ) FILTER(WHERE oi.id IS NOT NULL),
              '[]'::json
            ) AS items
          FROM orders o
          JOIN customers c ON c.id=o.customer_id
          LEFT JOIN order_items oi ON oi.order_id=o.id
          ${filterStatus ? 'WHERE o.status=$1' : ''}
          GROUP BY o.id,c.id
          ORDER BY o.created_at DESC
          LIMIT 500
        `,
        filterStatus ? [status] : []
      );

      res.json({ ok: true, orders: result.rows });
    } catch (error) {
      next(error);
    }
  });

  app.put('/api/admin/orders/:id', requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const nextStatus = text(req.body.status, 40).toUpperCase();

      if (!Number.isInteger(id) || !STATUSES.includes(nextStatus)) {
        return res.status(400).json({ ok: false, error: 'Invalid order or status.' });
      }

      const carrierName = text(req.body.carrierName, 160);
      const trackingNumber = text(req.body.trackingNumber, 160);
      const manifestNumber = text(req.body.manifestNumber, 160);

      if (
        ['SHIPPED', 'DELIVERED'].includes(nextStatus) &&
        (!carrierName || !manifestNumber)
      ) {
        return res.status(400).json({
          ok: false,
          error: 'Carrier and manifest number are required before an order can be marked shipped.'
        });
      }

      const saved = await withTransaction(async (client) => {
        const existingResult = await client.query(
          'SELECT * FROM orders WHERE id=$1 FOR UPDATE',
          [id]
        );

        if (!existingResult.rowCount) throw httpError('Order not found.', 404);
        const existing = existingResult.rows[0];
        const allowed = ALLOWED_STATUS_TRANSITIONS[existing.status] || [existing.status];

        if (!allowed.includes(nextStatus)) {
          throw httpError(
            `Order cannot move from ${existing.status} to ${nextStatus}.`,
            409
          );
        }

        if (
          nextStatus === 'CANCELLED' &&
          existing.status !== 'CANCELLED' &&
          !existing.inventory_restored
        ) {
          const itemResult = await client.query(
            'SELECT variant_id,quantity FROM order_items WHERE order_id=$1',
            [id]
          );

          for (const item of itemResult.rows) {
            if (!item.variant_id) continue;
            await client.query(
              `
                UPDATE product_variants
                SET inventory_qty=inventory_qty+$1, updated_at=NOW()
                WHERE id=$2
              `,
              [item.quantity, item.variant_id]
            );
          }
        }

        const orderResult = await client.query(
          `
            UPDATE orders
            SET
              status=$1,
              internal_notes=$2,
              carrier_name=$3,
              tracking_number=$4,
              manifest_number=$5,
              inventory_restored=CASE
                WHEN $1='CANCELLED' THEN TRUE
                ELSE inventory_restored
              END,
              updated_at=NOW()
            WHERE id=$6
            RETURNING *
          `,
          [
            nextStatus,
            text(req.body.internalNotes, 3000),
            carrierName,
            trackingNumber,
            manifestNumber,
            id
          ]
        );

        await client.query(
          `
            INSERT INTO order_status_history(order_id,status,note)
            VALUES($1,$2,$3)
          `,
          [id, nextStatus, text(req.body.statusNote, 1000)]
        );

        const customerResult = await client.query(
          'SELECT * FROM customers WHERE id=$1',
          [orderResult.rows[0].customer_id]
        );
        const itemResult = await client.query(
          'SELECT * FROM order_items WHERE order_id=$1 ORDER BY id',
          [id]
        );

        return {
          order: orderResult.rows[0],
          customer: customerResult.rows[0],
          items: itemResult.rows
        };
      });

      sendEmail(
        saved.customer.email,
        `Order ${saved.order.order_number}: ${saved.order.status.replace(/_/g, ' ')}`,
        orderHtml(
          saved.order,
          saved.items,
          `Order status: ${saved.order.status.replace(/_/g, ' ')}`
        )
      ).catch(console.error);

      res.json({ ok: true, order: saved.order });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/orders-export.csv', requireAdmin, async (_req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT
          o.order_number,
          o.created_at,
          o.status,
          o.ship_business_name,
          o.ship_contact_name,
          c.email,
          c.phone,
          c.license_number,
          o.total_cents,
          o.ship_address1,
          o.ship_address2,
          o.ship_city,
          o.ship_state,
          o.ship_postal_code,
          o.carrier_name,
          o.tracking_number,
          o.manifest_number
        FROM orders o
        JOIN customers c ON c.id=o.customer_id
        ORDER BY o.created_at DESC
      `);

      const headers = [
        'order_number',
        'created_at',
        'status',
        'ship_business_name',
        'ship_contact_name',
        'email',
        'phone',
        'license_number',
        'total_cents',
        'ship_address1',
        'ship_address2',
        'ship_city',
        'ship_state',
        'ship_postal_code',
        'carrier_name',
        'tracking_number',
        'manifest_number'
      ];

      const quote = (value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
      const csv = [
        headers.map(quote).join(','),
        ...result.rows.map((row) => headers.map((header) => quote(row[header])).join(','))
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="orders-${new Date().toISOString().slice(0, 10)}.csv"`
      );
      res.send(csv);
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { registerCommerce };

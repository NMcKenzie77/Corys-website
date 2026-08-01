'use strict';

const { pool } = require('./db');
const { requireAdmin } = require('./auth');

function registerRetailComplianceApi(app) {
  app.get('/api/admin/retail/product-compliance', requireAdmin, async (_req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT p.id product_id,p.advertising_reviewed,
          v.id variant_id,v.sku,v.acquisition_cost_cents,v.limit_category,v.limit_amount
        FROM products p
        LEFT JOIN product_variants v ON v.product_id=p.id
        ORDER BY p.id,v.id
      `);
      res.json({ ok: true, rows: result.rows });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/retail/legal-summary', requireAdmin, async (_req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE p.active=TRUE AND p.advertising_reviewed=FALSE)::int unreviewed_active_products,
          COUNT(*) FILTER (WHERE v.active=TRUE AND (v.limit_category='' OR v.limit_amount<=0))::int packages_missing_limits,
          COUNT(*) FILTER (WHERE v.active=TRUE AND (v.price_cents<v.acquisition_cost_cents OR (v.sale_price_cents IS NOT NULL AND v.sale_price_cents<v.acquisition_cost_cents)))::int packages_below_cost,
          (SELECT COUNT(*)::int FROM retail_orders WHERE status='COMPLETED' AND (id_verified_at IS NULL OR completed_in_store=FALSE OR pos_receipt_number='')) incomplete_completed_orders,
          (SELECT COUNT(*)::int FROM retail_customers WHERE marketing_opt_in=TRUE AND marketing_state<>'WA') invalid_marketing_contacts
        FROM products p
        LEFT JOIN product_variants v ON v.product_id=p.id
      `);
      res.json({ ok: true, summary: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });
}

module.exports = { registerRetailComplianceApi };

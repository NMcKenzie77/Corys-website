'use strict';

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('DATABASE_URL is not set. Database-backed routes will fail until PostgreSQL is configured.');
}

const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (error) => console.error('Unexpected PostgreSQL pool error:', error));

async function initDatabase() {
  if (!connectionString) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      featured BOOLEAN NOT NULL DEFAULT FALSE,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS product_variants (
      id BIGSERIAL PRIMARY KEY,
      product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      sku TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      sale_price_cents INTEGER CHECK (sale_price_cents IS NULL OR sale_price_cents >= 0),
      inventory_qty INTEGER NOT NULL DEFAULT 0 CHECK (inventory_qty >= 0),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_products_active_category ON products(active, category);
    CREATE INDEX IF NOT EXISTS idx_variants_product_active ON product_variants(product_id, active);
  `);

  // The original prototype also created wholesale customers/orders here.
  // They are intentionally frozen as legacy. Existing database tables and
  // records are left untouched; Cory's active retail system writes only to
  // retail_* reservation/customer tables created by retail-api/Cory core.
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDatabase, withTransaction };

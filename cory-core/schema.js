'use strict';

const { pool } = require('../db');

const ORDER_STATUSES = [
  'NEW',
  'NEEDS_CLARIFICATION',
  'CONFIRMED',
  'PICKING',
  'READY',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
  'REJECTED'
];

const CHANNELS = ['WEB', 'EMAIL', 'SMS', 'WHATSAPP', 'VOICE'];

function normalizedPhoneSql(column) {
  return `CASE
    WHEN LENGTH(REGEXP_REPLACE(${column}, '[^0-9]', '', 'g')) = 10
      THEN '+1' || REGEXP_REPLACE(${column}, '[^0-9]', '', 'g')
    WHEN LENGTH(REGEXP_REPLACE(${column}, '[^0-9]', '', 'g')) = 11
      AND REGEXP_REPLACE(${column}, '[^0-9]', '', 'g') LIKE '1%'
      THEN '+' || REGEXP_REPLACE(${column}, '[^0-9]', '', 'g')
    ELSE '+' || REGEXP_REPLACE(${column}, '[^0-9]', '', 'g')
  END`;
}

async function ensureCoryCoreSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS retail_locations (
      id BIGSERIAL PRIMARY KEY,
      location_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      license_number TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS retail_staff_users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'STAFF',
      location_id BIGINT REFERENCES retail_locations(id),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      mfa_required BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (role IN ('SUPER_ADMIN','STORE_ADMIN','STAFF','SYSTEM'))
    );

    ALTER TABLE retail_customers ALTER COLUMN email DROP NOT NULL;
    ALTER TABLE retail_customers ADD COLUMN IF NOT EXISTS primary_location_id BIGINT REFERENCES retail_locations(id);

    CREATE TABLE IF NOT EXISTS retail_channel_identities (
      id BIGSERIAL PRIMARY KEY,
      identity_kind TEXT NOT NULL,
      address_normalized TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      external_subject TEXT NOT NULL DEFAULT '',
      verified_at TIMESTAMPTZ,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(identity_kind, address_normalized, provider),
      CHECK (identity_kind IN ('EMAIL','PHONE','WHATSAPP'))
    );

    CREATE TABLE IF NOT EXISTS retail_customer_identity_links (
      customer_id BIGINT NOT NULL REFERENCES retail_customers(id) ON DELETE CASCADE,
      identity_id BIGINT NOT NULL REFERENCES retail_channel_identities(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      confidence TEXT NOT NULL DEFAULT 'UNVERIFIED',
      verification_method TEXT NOT NULL DEFAULT '',
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(customer_id, identity_id),
      CHECK (status IN ('ACTIVE','DISPUTED','REVOKED')),
      CHECK (confidence IN ('UNVERIFIED','CUSTOMER_CONFIRMED','STAFF_CONFIRMED','VERIFIED'))
    );

    CREATE TABLE IF NOT EXISTS retail_conversations (
      id BIGSERIAL PRIMARY KEY,
      customer_id BIGINT REFERENCES retail_customers(id) ON DELETE SET NULL,
      location_id BIGINT NOT NULL REFERENCES retail_locations(id),
      source_channel TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'OPEN',
      assigned_staff_id BIGINT REFERENCES retail_staff_users(id) ON DELETE SET NULL,
      ai_paused_at TIMESTAMPTZ,
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (source_channel IN ('WEB','EMAIL','SMS','WHATSAPP','VOICE')),
      CHECK (state IN ('OPEN','WAITING_CUSTOMER','HUMAN','CLOSED'))
    );

    CREATE TABLE IF NOT EXISTS retail_channel_events (
      id BIGSERIAL PRIMARY KEY,
      trace_id UUID NOT NULL,
      channel TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL DEFAULT '',
      location_id BIGINT NOT NULL REFERENCES retail_locations(id),
      payload_hash TEXT NOT NULL DEFAULT '',
      safe_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'RECEIVED',
      UNIQUE(provider, channel, provider_event_id),
      CHECK (channel IN ('WEB','EMAIL','SMS','WHATSAPP','VOICE')),
      CHECK (status IN ('RECEIVED','PROCESSED','NEEDS_STAFF','REJECTED','FAILED'))
    );

    CREATE TABLE IF NOT EXISTS retail_messages (
      id BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT NOT NULL REFERENCES retail_conversations(id) ON DELETE CASCADE,
      channel_event_id BIGINT REFERENCES retail_channel_events(id) ON DELETE SET NULL,
      channel TEXT NOT NULL,
      direction TEXT NOT NULL,
      normalized_body TEXT NOT NULL DEFAULT '',
      reply_to_message_id BIGINT REFERENCES retail_messages(id) ON DELETE SET NULL,
      intent TEXT NOT NULL DEFAULT '',
      entities_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      confidence NUMERIC(5,4),
      sensitive_redacted BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (channel IN ('WEB','EMAIL','SMS','WHATSAPP','VOICE')),
      CHECK (direction IN ('INBOUND','OUTBOUND','SYSTEM'))
    );

    ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'PICKUP_RESERVATION';
    ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS reservation_code TEXT;
    ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS source_channel TEXT NOT NULL DEFAULT 'WEB';
    ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS location_id BIGINT REFERENCES retail_locations(id);
    ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS pickup_window_start TIMESTAMPTZ;
    ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS pickup_window_end TIMESTAMPTZ;
    ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS eligibility_attested_at TIMESTAMPTZ;
    ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS origin_conversation_id BIGINT REFERENCES retail_conversations(id);
    ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS completion_reference TEXT NOT NULL DEFAULT '';
    ALTER TABLE retail_orders ADD COLUMN IF NOT EXISTS actual_total_cents INTEGER CHECK (actual_total_cents IS NULL OR actual_total_cents >= 0);
    ALTER TABLE retail_orders DROP CONSTRAINT IF EXISTS retail_orders_status_check;
    ALTER TABLE retail_orders ADD CONSTRAINT retail_orders_status_check
      CHECK (status IN ('NEW','NEEDS_CLARIFICATION','CONFIRMED','PICKING','READY','COMPLETED','CANCELLED','EXPIRED','REJECTED'));

    CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_orders_reservation_code
      ON retail_orders(reservation_code) WHERE reservation_code IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_retail_orders_location_status
      ON retail_orders(location_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS retail_conversation_orders (
      conversation_id BIGINT NOT NULL REFERENCES retail_conversations(id) ON DELETE CASCADE,
      order_id BIGINT NOT NULL REFERENCES retail_orders(id) ON DELETE CASCADE,
      relationship TEXT NOT NULL DEFAULT 'CREATE',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(conversation_id, order_id, relationship),
      CHECK (relationship IN ('CREATE','CHANGE','STATUS'))
    );

    CREATE TABLE IF NOT EXISTS retail_inventory_holds (
      id BIGSERIAL PRIMARY KEY,
      location_id BIGINT NOT NULL REFERENCES retail_locations(id),
      order_id BIGINT NOT NULL REFERENCES retail_orders(id) ON DELETE CASCADE,
      variant_id BIGINT NOT NULL REFERENCES product_variants(id),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      state TEXT NOT NULL DEFAULT 'ACTIVE',
      expires_at TIMESTAMPTZ NOT NULL,
      source_message_id BIGINT REFERENCES retail_messages(id) ON DELETE SET NULL,
      idempotency_key TEXT NOT NULL,
      released_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(idempotency_key),
      CHECK (state IN ('ACTIVE','RELEASED','CONSUMED'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_retail_inventory_holds_active_line
      ON retail_inventory_holds(order_id, variant_id) WHERE state='ACTIVE';
    CREATE INDEX IF NOT EXISTS idx_retail_inventory_holds_variant_active
      ON retail_inventory_holds(location_id, variant_id, state, expires_at);

    CREATE TABLE IF NOT EXISTS retail_inventory_ledger (
      id BIGSERIAL PRIMARY KEY,
      location_id BIGINT NOT NULL REFERENCES retail_locations(id),
      variant_id BIGINT NOT NULL REFERENCES product_variants(id),
      event_type TEXT NOT NULL,
      quantity_delta INTEGER NOT NULL,
      quantity_after INTEGER,
      order_id BIGINT REFERENCES retail_orders(id) ON DELETE SET NULL,
      hold_id BIGINT REFERENCES retail_inventory_holds(id) ON DELETE SET NULL,
      actor_type TEXT NOT NULL,
      actor_ref TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      reference TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (event_type IN ('OPENING_BALANCE','RECEIVE','HOLD','RELEASE','PICKUP_COMPLETE','DAMAGE','ADJUSTMENT','MIGRATION')),
      CHECK (actor_type IN ('CUSTOMER','STAFF','AI','SYSTEM'))
    );

    CREATE INDEX IF NOT EXISTS idx_retail_inventory_ledger_variant
      ON retail_inventory_ledger(location_id, variant_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS retail_picking_tasks (
      id BIGSERIAL PRIMARY KEY,
      order_id BIGINT NOT NULL UNIQUE REFERENCES retail_orders(id) ON DELETE CASCADE,
      location_id BIGINT NOT NULL REFERENCES retail_locations(id),
      status TEXT NOT NULL DEFAULT 'OPEN',
      claimed_by BIGINT REFERENCES retail_staff_users(id) ON DELETE SET NULL,
      claimed_at TIMESTAMPTZ,
      ready_at TIMESTAMPTZ,
      exception_note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (status IN ('OPEN','CLAIMED','READY','EXCEPTION','CLOSED'))
    );

    CREATE TABLE IF NOT EXISTS retail_consents (
      id BIGSERIAL PRIMARY KEY,
      customer_id BIGINT REFERENCES retail_customers(id) ON DELETE CASCADE,
      identity_id BIGINT REFERENCES retail_channel_identities(id) ON DELETE SET NULL,
      channel TEXT NOT NULL,
      purpose TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      evidence_ref TEXT NOT NULL DEFAULT '',
      policy_version TEXT NOT NULL DEFAULT '',
      granted_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (channel IN ('WEB','EMAIL','SMS','WHATSAPP','VOICE')),
      CHECK (purpose IN ('TRANSACTIONAL','MARKETING')),
      CHECK (status IN ('GRANTED','REVOKED','NOT_REQUIRED'))
    );

    CREATE TABLE IF NOT EXISTS retail_idempotency_keys (
      id BIGSERIAL PRIMARY KEY,
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id BIGINT,
      result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      UNIQUE(scope, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS retail_outbox (
      id BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT REFERENCES retail_conversations(id) ON DELETE SET NULL,
      order_id BIGINT REFERENCES retail_orders(id) ON DELETE SET NULL,
      channel TEXT NOT NULL,
      recipient_identity_id BIGINT REFERENCES retail_channel_identities(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      provider_message_id TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      CHECK (channel IN ('WEB','EMAIL','SMS','WHATSAPP','VOICE')),
      CHECK (status IN ('PENDING','SENDING','SENT','FAILED','DEAD_LETTER'))
    );

    CREATE INDEX IF NOT EXISTS idx_retail_outbox_pending
      ON retail_outbox(status, next_attempt_at);
    ALTER TABLE retail_outbox ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS retail_escalations (
      id BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT REFERENCES retail_conversations(id) ON DELETE CASCADE,
      order_id BIGINT REFERENCES retail_orders(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      priority TEXT NOT NULL DEFAULT 'NORMAL',
      assigned_to BIGINT REFERENCES retail_staff_users(id) ON DELETE SET NULL,
      state TEXT NOT NULL DEFAULT 'OPEN',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      CHECK (priority IN ('LOW','NORMAL','HIGH','URGENT')),
      CHECK (state IN ('OPEN','CLAIMED','RESOLVED','DISMISSED'))
    );

    CREATE INDEX IF NOT EXISTS idx_retail_escalations_open
      ON retail_escalations(state, priority, created_at);

    CREATE TABLE IF NOT EXISTS retail_audit_events (
      id BIGSERIAL PRIMARY KEY,
      trace_id UUID,
      actor_type TEXT NOT NULL,
      actor_ref TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json JSONB,
      after_json JSONB,
      reference TEXT NOT NULL DEFAULT '',
      model_version TEXT NOT NULL DEFAULT '',
      policy_version TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (actor_type IN ('CUSTOMER','STAFF','AI','SYSTEM'))
    );

    CREATE INDEX IF NOT EXISTS idx_retail_audit_entity
      ON retail_audit_events(entity_type, entity_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS retail_integration_health (
      integration_key TEXT PRIMARY KEY,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
      details TEXT NOT NULL DEFAULT '',
      checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (status IN ('OK','DEGRADED','DOWN','BLOCKED','NOT_CONFIGURED'))
    );
  `);

  const location = await pool.query(`
    INSERT INTO retail_locations(location_key,name,address,phone,email,license_number)
    VALUES('primary',$1,$2,$3,$4,$5)
    ON CONFLICT(location_key) DO UPDATE SET
      name=EXCLUDED.name,
      address=EXCLUDED.address,
      phone=EXCLUDED.phone,
      email=EXCLUDED.email,
      license_number=EXCLUDED.license_number,
      updated_at=NOW()
    RETURNING id
  `, [
    process.env.SITE_NAME || 'Dispensary',
    process.env.BUSINESS_ADDRESS || '',
    process.env.BUSINESS_PHONE || '',
    process.env.BUSINESS_EMAIL || process.env.SALES_EMAIL || '',
    process.env.BUSINESS_LICENSE_NUMBER || ''
  ]);

  const locationId = location.rows[0].id;

  await pool.query('UPDATE retail_customers SET primary_location_id=$1 WHERE primary_location_id IS NULL', [locationId]);
  await pool.query('UPDATE retail_orders SET location_id=$1 WHERE location_id IS NULL', [locationId]);
  await pool.query(`UPDATE retail_orders SET
    reservation_code=COALESCE(reservation_code, order_number),
    eligibility_attested_at=COALESCE(eligibility_attested_at, age_confirmed_at)
    WHERE reservation_code IS NULL OR eligibility_attested_at IS NULL`);

  await pool.query(`
    INSERT INTO retail_channel_identities(identity_kind,address_normalized,provider,verified_at)
    SELECT 'EMAIL',LOWER(TRIM(email)),'',NULL
    FROM retail_customers
    WHERE COALESCE(TRIM(email),'')<>''
    ON CONFLICT(identity_kind,address_normalized,provider) DO NOTHING
  `);

  await pool.query(`
    INSERT INTO retail_customer_identity_links(customer_id,identity_id,status,confidence)
    SELECT c.id,i.id,'ACTIVE','UNVERIFIED'
    FROM retail_customers c
    JOIN retail_channel_identities i
      ON i.identity_kind='EMAIL' AND i.provider='' AND i.address_normalized=LOWER(TRIM(c.email))
    WHERE COALESCE(TRIM(c.email),'')<>''
    ON CONFLICT(customer_id,identity_id) DO NOTHING
  `);

  const phoneExpression = normalizedPhoneSql('c.phone');
  await pool.query(`
    INSERT INTO retail_channel_identities(identity_kind,address_normalized,provider,verified_at)
    SELECT 'PHONE',${normalizedPhoneSql('phone')},'',NULL
    FROM retail_customers
    WHERE COALESCE(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'),'')<>''
    ON CONFLICT(identity_kind,address_normalized,provider) DO NOTHING
  `);

  await pool.query(`
    INSERT INTO retail_customer_identity_links(customer_id,identity_id,status,confidence)
    SELECT c.id,i.id,'ACTIVE','UNVERIFIED'
    FROM retail_customers c
    JOIN retail_channel_identities i
      ON i.identity_kind='PHONE' AND i.provider='' AND i.address_normalized=${phoneExpression}
    WHERE COALESCE(REGEXP_REPLACE(c.phone, '[^0-9]', '', 'g'),'')<>''
    ON CONFLICT(customer_id,identity_id) DO NOTHING
  `);

  const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (adminEmail) {
    await pool.query(`
      INSERT INTO retail_staff_users(email,display_name,role,location_id,active,mfa_required)
      VALUES($1,$2,'SUPER_ADMIN',$3,TRUE,TRUE)
      ON CONFLICT(email) DO UPDATE SET
        role='SUPER_ADMIN',active=TRUE,mfa_required=TRUE,updated_at=NOW()
    `, [adminEmail, process.env.SUPER_ADMIN_NAME || 'Super Admin', locationId]);
  }

  const integrationRows = [
    ['WEB', true, 'OK', 'Core website adapter enabled'],
    ['EMAIL', Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM), process.env.RESEND_API_KEY && process.env.EMAIL_FROM ? 'OK' : 'NOT_CONFIGURED', 'Transactional email via Resend'],
    ['VOICE', false, 'NOT_CONFIGURED', 'Voice adapter ready; provider not configured'],
    ['SMS', false, 'BLOCKED', 'Provider must explicitly permit US cannabis messaging and expose inbound API/webhook'],
    ['WHATSAPP', false, 'BLOCKED', 'Disabled by current WhatsApp Business policy for recreational drug transaction facilitation'],
    ['GOOGLE_ROUTES', Boolean(process.env.GOOGLE_MAPS_API_KEY), process.env.GOOGLE_MAPS_API_KEY ? 'OK' : 'NOT_CONFIGURED', 'Drive-time service']
  ];

  for (const row of integrationRows) {
    await pool.query(`
      INSERT INTO retail_integration_health(integration_key,enabled,status,details)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(integration_key) DO UPDATE SET
        enabled=EXCLUDED.enabled,status=EXCLUDED.status,details=EXCLUDED.details,checked_at=NOW()
    `, row);
  }

  return { locationId: Number(locationId) };
}

module.exports = {
  CHANNELS,
  ORDER_STATUSES,
  ensureCoryCoreSchema
};

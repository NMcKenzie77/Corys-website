'use strict';

const { pool } = require('./db');
const { requireAdmin } = require('./auth');

const WORKER_LOCK_ID = 742611903;
const DEFAULT_TIME_ZONE = 'America/Los_Angeles';

const CATALOG = {
  stale_orders: {
    name: 'Stalled order alerts',
    description: 'Flag wholesale orders that are waiting too long at each fulfillment stage.',
    category: 'Orders',
    intervalMinutes: 10,
    defaultEnabled: true,
    defaultConfig: { newHours: 2, approvedHours: 12, packingHours: 24, readyHours: 8 },
    fields: [
      { key: 'newHours', label: 'NEW alert after hours', type: 'number', min: 1, max: 168 },
      { key: 'approvedHours', label: 'APPROVED alert after hours', type: 'number', min: 1, max: 168 },
      { key: 'packingHours', label: 'PACKING alert after hours', type: 'number', min: 1, max: 168 },
      { key: 'readyHours', label: 'READY alert after hours', type: 'number', min: 1, max: 168 }
    ]
  },
  low_inventory: {
    name: 'Low inventory alerts',
    description: 'Create an alert when an active package variant reaches the inventory threshold.',
    category: 'Inventory',
    intervalMinutes: 15,
    defaultEnabled: true,
    defaultConfig: { threshold: 10 },
    fields: [{ key: 'threshold', label: 'Alert at or below units', type: 'number', min: 0, max: 10000 }]
  },
  sample_followup: {
    name: 'Sample follow-up tasks',
    description: 'Create a dated CRM task after a sample activity is logged.',
    category: 'CRM',
    intervalMinutes: 15,
    defaultEnabled: true,
    defaultConfig: { daysAfter: 3, priority: 'HIGH' },
    fields: [
      { key: 'daysAfter', label: 'Follow up after days', type: 'number', min: 1, max: 30 },
      { key: 'priority', label: 'Task priority', type: 'select', options: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] }
    ]
  },
  missing_next_step: {
    name: 'Missing next-step tasks',
    description: 'Create follow-up tasks when an active sales opportunity has no next action.',
    category: 'CRM',
    intervalMinutes: 60,
    defaultEnabled: true,
    defaultConfig: { dueInDays: 2, maxPerRun: 25 },
    fields: [
      { key: 'dueInDays', label: 'Task due in days', type: 'number', min: 0, max: 30 },
      { key: 'maxPerRun', label: 'Maximum tasks per run', type: 'number', min: 1, max: 200 }
    ]
  },
  lapsed_customers: {
    name: 'Lapsed-customer follow-up',
    description: 'Create a reorder task when a customer has not placed an order recently.',
    category: 'CRM',
    intervalMinutes: 360,
    defaultEnabled: true,
    defaultConfig: { inactiveDays: 60, dueInDays: 3, maxPerRun: 25 },
    fields: [
      { key: 'inactiveDays', label: 'No order for days', type: 'number', min: 14, max: 365 },
      { key: 'dueInDays', label: 'Task due in days', type: 'number', min: 0, max: 30 },
      { key: 'maxPerRun', label: 'Maximum tasks per run', type: 'number', min: 1, max: 200 }
    ]
  },
  new_product_campaign_draft: {
    name: 'New-product campaign drafts',
    description: 'Build a compliant campaign draft when a new active product is added. Cory still approves the send.',
    category: 'Marketing',
    intervalMinutes: 15,
    defaultEnabled: true,
    defaultConfig: { lookbackDays: 30 },
    fields: [{ key: 'lookbackDays', label: 'Recognize products added within days', type: 'number', min: 1, max: 365 }]
  },
  restock_campaign_draft: {
    name: 'Restock campaign drafts',
    description: 'Build a campaign draft when an out-of-stock package is replenished. Cory still approves the send.',
    category: 'Marketing',
    intervalMinutes: 15,
    defaultEnabled: true,
    defaultConfig: { minimumStock: 5 },
    fields: [{ key: 'minimumStock', label: 'Minimum restocked units', type: 'number', min: 1, max: 10000 }]
  },
  license_review: {
    name: 'License-data review alert',
    description: 'Flag CRM account records whose license source date is missing or stale.',
    category: 'Compliance',
    intervalMinutes: 1440,
    defaultEnabled: true,
    defaultConfig: { staleDays: 30 },
    fields: [{ key: 'staleDays', label: 'Review source data after days', type: 'number', min: 7, max: 365 }]
  },
  daily_digest: {
    name: 'Daily operations digest',
    description: 'Email Cory a daily summary of orders, alerts, follow-ups, inventory, and campaign drafts.',
    category: 'Reporting',
    intervalMinutes: 5,
    defaultEnabled: true,
    defaultConfig: { hour: 8, minute: 0 },
    fields: [
      { key: 'hour', label: 'Local send hour (0-23)', type: 'number', min: 0, max: 23 },
      { key: 'minute', label: 'Local send minute', type: 'number', min: 0, max: 59 }
    ]
  },
  new_account_first_touch: {
    name: 'New-account prospecting batch',
    description: 'Create a limited daily batch of first-touch tasks for active uncontacted retailers.',
    category: 'CRM',
    intervalMinutes: 1440,
    defaultEnabled: false,
    defaultConfig: { dailyLimit: 10, dueInDays: 1 },
    fields: [
      { key: 'dailyLimit', label: 'New prospect tasks per day', type: 'number', min: 1, max: 100 },
      { key: 'dueInDays', label: 'Task due in days', type: 'number', min: 0, max: 14 }
    ]
  }
};

function text(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function number(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function esc(value) {
  return String(value == null ? '' : value)
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

function timeZone() {
  return process.env.AUTOMATION_TIME_ZONE || DEFAULT_TIME_ZONE;
}

function localParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function normalizeConfig(ruleKey, incoming) {
  const definition = CATALOG[ruleKey];
  if (!definition) throw httpError('Unknown automation rule.', 404);
  const source = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  const output = { ...definition.defaultConfig };
  for (const field of definition.fields) {
    if (field.type === 'number') output[field.key] = number(source[field.key], output[field.key], field.min, field.max);
    if (field.type === 'select') output[field.key] = field.options.includes(text(source[field.key], 50).toUpperCase()) ? text(source[field.key], 50).toUpperCase() : output[field.key];
  }
  return output;
}

function automationReadiness() {
  const emailTo = process.env.AUTOMATION_ALERT_EMAIL || process.env.ADMIN_EMAIL || process.env.SALES_EMAIL || '';
  const missing = [];
  if (!process.env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
  if (!process.env.EMAIL_FROM) missing.push('EMAIL_FROM');
  if (!emailTo) missing.push('AUTOMATION_ALERT_EMAIL or ADMIN_EMAIL');
  return { emailReady: missing.length === 0, missing, emailTo, timeZone: timeZone() };
}

async function sendInternalEmail(subject, html) {
  const readiness = automationReadiness();
  if (!readiness.emailReady) throw new Error(`Automation email is not configured: ${readiness.missing.join(', ')}`);
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [readiness.emailTo], subject, html })
  });
  if (!response.ok) throw new Error(`Resend ${response.status}: ${await response.text()}`);
}

async function ensureAutomationSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS automation_rules (
      id BIGSERIAL PRIMARY KEY,
      rule_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_run_at TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      last_result JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS automation_runs (
      id BIGSERIAL PRIMARY KEY,
      rule_id BIGINT REFERENCES automation_rules(id) ON DELETE SET NULL,
      rule_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'RUNNING',
      matched_count INTEGER NOT NULL DEFAULT 0,
      action_count INTEGER NOT NULL DEFAULT 0,
      error_message TEXT NOT NULL DEFAULT '',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      CHECK (status IN ('RUNNING','SUCCESS','FAILED','SKIPPED'))
    );

    CREATE TABLE IF NOT EXISTS automation_events (
      id BIGSERIAL PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      rule_key TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS automation_alerts (
      id BIGSERIAL PRIMARY KEY,
      rule_key TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'NORMAL',
      title TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      dedupe_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ,
      CHECK (severity IN ('LOW','NORMAL','HIGH','URGENT')),
      CHECK (status IN ('OPEN','DISMISSED','RESOLVED'))
    );

    CREATE TABLE IF NOT EXISTS automation_state (
      state_key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE crm_tasks ADD COLUMN IF NOT EXISTS automation_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS crm_tasks_automation_key_idx ON crm_tasks(automation_key);
    ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS automation_key TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS marketing_campaigns_automation_key_idx ON marketing_campaigns(automation_key);
    CREATE INDEX IF NOT EXISTS automation_runs_started_idx ON automation_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS automation_alerts_status_idx ON automation_alerts(status, severity, created_at DESC);
  `);

  for (const [ruleKey, definition] of Object.entries(CATALOG)) {
    await pool.query(`
      INSERT INTO automation_rules(rule_key,name,description,category,enabled,config)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)
      ON CONFLICT(rule_key) DO UPDATE SET
        name=EXCLUDED.name,description=EXCLUDED.description,category=EXCLUDED.category,updated_at=NOW()
    `, [ruleKey, definition.name, definition.description, definition.category, definition.defaultEnabled, JSON.stringify(definition.defaultConfig)]);
  }
}

async function upsertAlert(client, input) {
  const inserted = await client.query(`
    INSERT INTO automation_alerts(rule_key,severity,title,details,entity_type,entity_id,dedupe_key)
    VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(dedupe_key) DO NOTHING RETURNING *
  `, [input.ruleKey, input.severity || 'NORMAL', input.title, input.details || '', input.entityType || '', String(input.entityId || ''), input.dedupeKey]);
  if (inserted.rowCount) return { created: true, alert: inserted.rows[0] };
  const updated = await client.query(`
    UPDATE automation_alerts SET severity=$1,title=$2,details=$3,entity_type=$4,entity_id=$5,
      status=CASE WHEN status='RESOLVED' THEN 'OPEN' ELSE status END,
      resolved_at=CASE WHEN status='RESOLVED' THEN NULL ELSE resolved_at END,updated_at=NOW()
    WHERE dedupe_key=$6 RETURNING *
  `, [input.severity || 'NORMAL', input.title, input.details || '', input.entityType || '', String(input.entityId || ''), input.dedupeKey]);
  return { created: false, alert: updated.rows[0] };
}

async function resolveMissingAlerts(client, ruleKey, activeKeys) {
  if (!activeKeys.length) {
    await client.query("UPDATE automation_alerts SET status='RESOLVED',resolved_at=NOW(),updated_at=NOW() WHERE rule_key=$1 AND status='OPEN'", [ruleKey]);
    return;
  }
  await client.query("UPDATE automation_alerts SET status='RESOLVED',resolved_at=NOW(),updated_at=NOW() WHERE rule_key=$1 AND status='OPEN' AND NOT(dedupe_key=ANY($2::text[]))", [ruleKey, activeKeys]);
}

async function createTask(client, input) {
  const result = await client.query(`
    INSERT INTO crm_tasks(account_id,contact_id,title,details,due_at,status,priority,assigned_to,automation_key)
    VALUES($1,$2,$3,$4,$5,'OPEN',$6,$7,$8)
    ON CONFLICT(automation_key) DO NOTHING RETURNING id
  `, [input.accountId, input.contactId || null, input.title, input.details || '', input.dueAt || null, input.priority || 'NORMAL', input.assignedTo || '', input.automationKey]);
  return result.rowCount > 0;
}

async function createCampaignDraft(client, input) {
  const result = await client.query(`
    INSERT INTO marketing_campaigns(name,subject,preview_text,headline,body_text,cta_label,cta_url,audience_type,audience_value,product_id,status,automation_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT',$11)
    ON CONFLICT(automation_key) DO NOTHING RETURNING id
  `, [input.name, input.subject, input.previewText || '', input.headline, input.bodyText, input.ctaLabel || 'View wholesale products', input.ctaUrl || '/shop', input.audienceType || 'ALL_SUBSCRIBERS', input.audienceValue || '', input.productId || null, input.automationKey]);
  return result.rowCount > 0;
}

async function eventOnce(client, eventKey, ruleKey, entityType = '', entityId = '', payload = {}) {
  const result = await client.query(`
    INSERT INTO automation_events(event_key,rule_key,entity_type,entity_id,payload)
    VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(event_key) DO NOTHING RETURNING id
  `, [eventKey, ruleKey, entityType, String(entityId || ''), JSON.stringify(payload)]);
  return result.rowCount > 0;
}

function dueDate(days) {
  return new Date(Date.now() + Number(days || 0) * 86400000);
}

async function runStaleOrders(client, config) {
  const result = await client.query(`
    SELECT o.id,o.order_number,o.status,o.updated_at,o.ship_business_name,o.total_cents,c.license_number
    FROM orders o JOIN customers c ON c.id=o.customer_id
    WHERE (o.status='NEW' AND o.updated_at < NOW()-($1::int*INTERVAL '1 hour'))
       OR (o.status='APPROVED' AND o.updated_at < NOW()-($2::int*INTERVAL '1 hour'))
       OR (o.status='PACKING' AND o.updated_at < NOW()-($3::int*INTERVAL '1 hour'))
       OR (o.status='READY_FOR_CARRIER' AND o.updated_at < NOW()-($4::int*INTERVAL '1 hour'))
    ORDER BY o.updated_at
  `, [config.newHours, config.approvedHours, config.packingHours, config.readyHours]);
  const activeKeys = [];
  let actions = 0;
  for (const order of result.rows) {
    const key = `stale-order:${order.id}:${order.status}`;
    activeKeys.push(key);
    const ageHours = Math.max(1, Math.floor((Date.now() - new Date(order.updated_at).getTime()) / 3600000));
    const alert = await upsertAlert(client, {
      ruleKey: 'stale_orders', severity: order.status === 'NEW' ? 'URGENT' : 'HIGH',
      title: `${order.order_number} has been ${order.status.replace(/_/g, ' ')} for ${ageHours} hours`,
      details: `${order.ship_business_name} · $${(Number(order.total_cents) / 100).toFixed(2)} · License ${order.license_number}`,
      entityType: 'order', entityId: order.id, dedupeKey: key
    });
    if (alert.created) actions += 1;
  }
  await resolveMissingAlerts(client, 'stale_orders', activeKeys);
  return { matched: result.rowCount, actions };
}

async function runLowInventory(client, config) {
  const result = await client.query(`
    SELECT v.id,v.sku,v.label,v.inventory_qty,p.name product_name,p.id product_id
    FROM product_variants v JOIN products p ON p.id=v.product_id
    WHERE p.active=TRUE AND v.active=TRUE AND v.inventory_qty<=$1
    ORDER BY v.inventory_qty,p.name
  `, [config.threshold]);
  const activeKeys = [];
  let actions = 0;
  for (const variant of result.rows) {
    const key = `low-inventory:${variant.id}`;
    activeKeys.push(key);
    const alert = await upsertAlert(client, {
      ruleKey: 'low_inventory', severity: Number(variant.inventory_qty) === 0 ? 'URGENT' : 'HIGH',
      title: `${variant.product_name} ${variant.label} has ${variant.inventory_qty} units left`,
      details: `SKU ${variant.sku}. Update inventory or deactivate this package if it is unavailable.`,
      entityType: 'variant', entityId: variant.id, dedupeKey: key
    });
    if (alert.created) actions += 1;
  }
  await resolveMissingAlerts(client, 'low_inventory', activeKeys);
  return { matched: result.rowCount, actions };
}

async function runSampleFollowup(client, config) {
  const result = await client.query(`
    SELECT a.id activity_id,a.account_id,a.contact_id,a.occurred_at,ca.trade_name,ca.assigned_to
    FROM crm_activities a JOIN crm_accounts ca ON ca.id=a.account_id
    WHERE a.activity_type='SAMPLE' AND ca.do_not_contact=FALSE AND ca.stage NOT IN ('CUSTOMER','NOT_A_FIT','DO_NOT_CONTACT')
    ORDER BY a.occurred_at DESC LIMIT 1000
  `);
  let actions = 0;
  for (const row of result.rows) {
    const created = await createTask(client, {
      accountId: row.account_id, contactId: row.contact_id,
      title: `Follow up on sample with ${row.trade_name}`,
      details: 'Confirm receipt, collect buyer feedback, discuss placement, pricing, and the next order step.',
      dueAt: new Date(new Date(row.occurred_at).getTime() + Number(config.daysAfter) * 86400000),
      priority: config.priority, assignedTo: row.assigned_to,
      automationKey: `sample-followup:${row.activity_id}`
    });
    if (created) actions += 1;
  }
  return { matched: result.rowCount, actions };
}

async function runMissingNextStep(client, config) {
  const result = await client.query(`
    SELECT a.id,a.trade_name,a.stage,a.assigned_to
    FROM crm_accounts a
    WHERE a.license_active=TRUE AND a.do_not_contact=FALSE
      AND a.stage IN ('CONTACTED','FOLLOW_UP','SAMPLE_REQUESTED','NEGOTIATING')
      AND (a.next_action='' OR a.next_action_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM crm_tasks t WHERE t.account_id=a.id AND t.status='OPEN')
    ORDER BY CASE a.stage WHEN 'NEGOTIATING' THEN 1 WHEN 'SAMPLE_REQUESTED' THEN 2 ELSE 3 END,a.updated_at
    LIMIT $1
  `, [config.maxPerRun]);
  const weekBucket = Math.floor(Date.now() / (7 * 86400000));
  let actions = 0;
  for (const account of result.rows) {
    const created = await createTask(client, {
      accountId: account.id, title: `Set the next step with ${account.trade_name}`,
      details: `The account is in ${account.stage.replace(/_/g, ' ')} but has no open follow-up or dated next action.`,
      dueAt: dueDate(config.dueInDays), priority: account.stage === 'NEGOTIATING' ? 'HIGH' : 'NORMAL',
      assignedTo: account.assigned_to,
      automationKey: `missing-next-step:${account.id}:${account.stage}:${weekBucket}`
    });
    if (created) actions += 1;
  }
  return { matched: result.rowCount, actions };
}

async function runLapsedCustomers(client, config) {
  const result = await client.query(`
    SELECT a.id,a.trade_name,a.assigned_to,MAX(o.created_at) last_order_at
    FROM crm_accounts a
    JOIN customers c ON c.license_number=a.license_number
    JOIN orders o ON o.customer_id=c.id AND o.status<>'CANCELLED'
    WHERE a.stage='CUSTOMER' AND a.do_not_contact=FALSE
    GROUP BY a.id
    HAVING MAX(o.created_at) < NOW()-($1::int*INTERVAL '1 day')
      AND NOT EXISTS(SELECT 1 FROM crm_tasks t WHERE t.account_id=a.id AND t.status='OPEN' AND t.automation_key LIKE 'lapsed-customer:%')
    ORDER BY MAX(o.created_at) LIMIT $2
  `, [config.inactiveDays, config.maxPerRun]);
  const month = localParts().date.slice(0, 7);
  let actions = 0;
  for (const account of result.rows) {
    const created = await createTask(client, {
      accountId: account.id, title: `Reorder check-in with ${account.trade_name}`,
      details: `No wholesale order has been recorded since ${new Date(account.last_order_at).toLocaleDateString('en-US')}. Review inventory needs and current availability.`,
      dueAt: dueDate(config.dueInDays), priority: 'HIGH', assignedTo: account.assigned_to,
      automationKey: `lapsed-customer:${account.id}:${month}`
    });
    if (created) actions += 1;
  }
  return { matched: result.rowCount, actions };
}

async function runNewProductDraft(client, config) {
  const result = await client.query(`
    SELECT id,name,category,description FROM products
    WHERE active=TRUE AND created_at>=NOW()-($1::int*INTERVAL '1 day') ORDER BY created_at
  `, [config.lookbackDays]);
  let actions = 0;
  for (const product of result.rows) {
    const created = await createCampaignDraft(client, {
      name: `New product: ${product.name}`,
      subject: `New wholesale availability: ${product.name}`,
      previewText: `${product.name} is now available for licensed Washington retailers.`,
      headline: `${product.name} is now available`,
      bodyText: `${product.description || `${product.name} has been added to the wholesale catalog.`}\n\nReview current package options and availability, then place an order or contact Cory for details.`,
      productId: product.id, audienceType: 'ALL_SUBSCRIBERS', automationKey: `new-product:${product.id}`
    });
    if (created) actions += 1;
  }
  return { matched: result.rowCount, actions };
}

async function runRestockDraft(client, config) {
  const current = await client.query(`
    SELECT v.id,v.inventory_qty,v.updated_at,p.id product_id,p.name,p.category
    FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.active=TRUE AND v.active=TRUE
  `);
  const snapshotResult = await client.query("SELECT value FROM automation_state WHERE state_key='inventory-snapshot'");
  const snapshot = snapshotResult.rowCount ? snapshotResult.rows[0].value : null;
  const nextSnapshot = Object.fromEntries(current.rows.map((row) => [String(row.id), { qty: Number(row.inventory_qty), updatedAt: new Date(row.updated_at).toISOString() }]));
  if (!snapshot) {
    await client.query("INSERT INTO automation_state(state_key,value) VALUES('inventory-snapshot',$1::jsonb) ON CONFLICT(state_key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()", [JSON.stringify(nextSnapshot)]);
    return { matched: current.rowCount, actions: 0, initialized: true };
  }
  let actions = 0;
  for (const row of current.rows) {
    const previous = snapshot[String(row.id)];
    if (previous && Number(previous.qty) <= 0 && Number(row.inventory_qty) >= Number(config.minimumStock)) {
      const created = await createCampaignDraft(client, {
        name: `Restock: ${row.name}`,
        subject: `${row.name} is back in wholesale inventory`,
        previewText: `Restocked availability for licensed Washington retailers.`,
        headline: `${row.name} is back in stock`,
        bodyText: `${row.name} has returned to the wholesale catalog. Review current package options and available quantities before inventory moves.`,
        productId: row.product_id, audienceType: 'CATEGORY_BUYERS', audienceValue: row.category,
        automationKey: `restock:${row.id}:${new Date(row.updated_at).toISOString()}`
      });
      if (created) actions += 1;
    }
  }
  await client.query("INSERT INTO automation_state(state_key,value) VALUES('inventory-snapshot',$1::jsonb) ON CONFLICT(state_key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()", [JSON.stringify(nextSnapshot)]);
  return { matched: current.rowCount, actions };
}

async function runLicenseReview(client, config) {
  const result = await client.query(`
    SELECT COUNT(*)::int count FROM crm_accounts
    WHERE license_active=TRUE AND (source_as_of IS NULL OR source_as_of < CURRENT_DATE-$1::int OR privilege_status='Unknown')
  `, [config.staleDays]);
  const count = Number(result.rows[0].count);
  if (!count) {
    await resolveMissingAlerts(client, 'license_review', []);
    return { matched: 0, actions: 0 };
  }
  const alert = await upsertAlert(client, {
    ruleKey: 'license_review', severity: 'HIGH', title: `${count} active retailer records need license-source review`,
    details: `Their source date is missing, older than ${config.staleDays} days, or the privilege status is unknown. Refresh from a lawful source and verify important records individually.`,
    entityType: 'crm', entityId: 'license-review', dedupeKey: 'license-review:active-accounts'
  });
  return { matched: count, actions: alert.created ? 1 : 0 };
}

async function runDailyDigest(client, config) {
  const local = localParts();
  const targetMinutes = Number(config.hour) * 60 + Number(config.minute);
  const currentMinutes = local.hour * 60 + local.minute;
  if (currentMinutes < targetMinutes) return { matched: 0, actions: 0, skipped: 'before-send-time' };
  const eventKey = `daily-digest:${local.date}`;
  const existing = await client.query('SELECT 1 FROM automation_events WHERE event_key=$1', [eventKey]);
  if (existing.rowCount) return { matched: 0, actions: 0, skipped: 'already-sent' };
  const [orders, tasks, alerts, inventory, campaigns] = await Promise.all([
    client.query("SELECT COUNT(*)::int count,COALESCE(SUM(total_cents),0)::bigint value FROM orders WHERE created_at>=NOW()-INTERVAL '24 hours' AND status<>'CANCELLED'"),
    client.query("SELECT COUNT(*)::int count FROM crm_tasks WHERE status='OPEN' AND due_at IS NOT NULL AND due_at<=NOW()"),
    client.query("SELECT COUNT(*)::int count FROM automation_alerts WHERE status='OPEN'"),
    client.query("SELECT COUNT(*)::int count FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.active=TRUE AND v.active=TRUE AND v.inventory_qty<=10"),
    client.query("SELECT COUNT(*)::int count FROM marketing_campaigns WHERE status='DRAFT'")
  ]);
  const orderCount = Number(orders.rows[0].count);
  const html = `
    <h2>Daily wholesale operations digest</h2>
    <p><b>Date:</b> ${esc(local.date)} · <b>Time zone:</b> ${esc(timeZone())}</p>
    <table style="border-collapse:collapse;width:100%;max-width:680px">
      <tr><td style="padding:10px;border-bottom:1px solid #ddd">Orders in the last 24 hours</td><td style="padding:10px;border-bottom:1px solid #ddd"><b>${orderCount}</b> · $${(Number(orders.rows[0].value) / 100).toFixed(2)}</td></tr>
      <tr><td style="padding:10px;border-bottom:1px solid #ddd">CRM follow-ups due</td><td style="padding:10px;border-bottom:1px solid #ddd"><b>${tasks.rows[0].count}</b></td></tr>
      <tr><td style="padding:10px;border-bottom:1px solid #ddd">Open automation alerts</td><td style="padding:10px;border-bottom:1px solid #ddd"><b>${alerts.rows[0].count}</b></td></tr>
      <tr><td style="padding:10px;border-bottom:1px solid #ddd">Low-stock package variants</td><td style="padding:10px;border-bottom:1px solid #ddd"><b>${inventory.rows[0].count}</b></td></tr>
      <tr><td style="padding:10px;border-bottom:1px solid #ddd">Campaign drafts awaiting approval</td><td style="padding:10px;border-bottom:1px solid #ddd"><b>${campaigns.rows[0].count}</b></td></tr>
    </table>
    <p><a href="${esc(String(process.env.SITE_URL || '').replace(/\/+$/, ''))}/admin/automations">Open automation center</a></p>
  `;
  await sendInternalEmail(`Wholesale operations digest — ${local.date}`, html);
  await eventOnce(client, eventKey, 'daily_digest', 'date', local.date, { orderCount });
  return { matched: 1, actions: 1 };
}

async function runNewAccountFirstTouch(client, config) {
  const result = await client.query(`
    SELECT a.id,a.trade_name,a.assigned_to
    FROM crm_accounts a
    WHERE a.license_active=TRUE AND a.stage='UNCONTACTED' AND a.do_not_contact=FALSE
      AND NOT EXISTS(SELECT 1 FROM crm_tasks t WHERE t.account_id=a.id AND t.status='OPEN')
    ORDER BY CASE a.priority WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END,a.created_at
    LIMIT $1
  `, [config.dailyLimit]);
  let actions = 0;
  for (const account of result.rows) {
    const created = await createTask(client, {
      accountId: account.id, title: `Research and contact ${account.trade_name}`,
      details: 'Identify the buyer or inventory manager, confirm lawful contact information, and record the first outreach outcome.',
      dueAt: dueDate(config.dueInDays), priority: 'NORMAL', assignedTo: account.assigned_to,
      automationKey: `first-touch:${account.id}`
    });
    if (created) actions += 1;
  }
  return { matched: result.rowCount, actions };
}

const RUNNERS = {
  stale_orders: runStaleOrders,
  low_inventory: runLowInventory,
  sample_followup: runSampleFollowup,
  missing_next_step: runMissingNextStep,
  lapsed_customers: runLapsedCustomers,
  new_product_campaign_draft: runNewProductDraft,
  restock_campaign_draft: runRestockDraft,
  license_review: runLicenseReview,
  daily_digest: runDailyDigest,
  new_account_first_touch: runNewAccountFirstTouch
};

async function executeRule(client, rule, manual = false) {
  const definition = CATALOG[rule.rule_key];
  if (!definition || !RUNNERS[rule.rule_key]) throw new Error(`Automation runner not found for ${rule.rule_key}`);
  if (!manual && rule.last_run_at && Date.now() - new Date(rule.last_run_at).getTime() < definition.intervalMinutes * 60000) {
    return { skipped: true };
  }
  const run = await client.query("INSERT INTO automation_runs(rule_id,rule_key,status) VALUES($1,$2,'RUNNING') RETURNING id", [rule.id, rule.rule_key]);
  try {
    const config = normalizeConfig(rule.rule_key, rule.config);
    const result = await RUNNERS[rule.rule_key](client, config);
    await client.query("UPDATE automation_runs SET status='SUCCESS',matched_count=$1,action_count=$2,finished_at=NOW() WHERE id=$3", [Number(result.matched || 0), Number(result.actions || 0), run.rows[0].id]);
    await client.query("UPDATE automation_rules SET last_run_at=NOW(),last_success_at=NOW(),last_result=$1::jsonb,updated_at=NOW() WHERE id=$2", [JSON.stringify(result), rule.id]);
    return result;
  } catch (error) {
    await client.query("UPDATE automation_runs SET status='FAILED',error_message=$1,finished_at=NOW() WHERE id=$2", [text(error.message, 2000), run.rows[0].id]);
    await client.query("UPDATE automation_rules SET last_run_at=NOW(),last_result=$1::jsonb,updated_at=NOW() WHERE id=$2", [JSON.stringify({ error: error.message }), rule.id]);
    await upsertAlert(client, {
      ruleKey: rule.rule_key, severity: 'URGENT', title: `${rule.name} failed`, details: text(error.message, 2000),
      entityType: 'automation', entityId: rule.id, dedupeKey: `automation-failure:${rule.rule_key}`
    });
    throw error;
  }
}

let workerBusy = false;
async function runAutomationCycle() {
  if (workerBusy || !process.env.DATABASE_URL) return;
  workerBusy = true;
  const client = await pool.connect();
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) acquired', [WORKER_LOCK_ID]);
    if (!lock.rows[0].acquired) return;
    try {
      const rules = await client.query('SELECT * FROM automation_rules WHERE enabled=TRUE ORDER BY id');
      for (const rule of rules.rows) {
        try { await executeRule(client, rule, false); }
        catch (error) { console.error(`Automation ${rule.rule_key} failed:`, error.message); }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [WORKER_LOCK_ID]);
    }
  } finally {
    client.release();
    workerBusy = false;
  }
}

function startAutomationWorker() {
  const interval = number(process.env.AUTOMATION_INTERVAL_MS, 300000, 60000, 3600000);
  const timer = setInterval(() => runAutomationCycle().catch((error) => console.error('Automation worker error:', error)), interval);
  timer.unref();
  setTimeout(() => runAutomationCycle().catch((error) => console.error('Automation startup cycle error:', error)), 15000).unref();
}

function registerAutomations(app) {
  app.get('/api/admin/automations/summary', requireAdmin, async (_req, res, next) => {
    try {
      const [rules, alerts, runs, metrics] = await Promise.all([
        pool.query('SELECT * FROM automation_rules ORDER BY category,name'),
        pool.query("SELECT * FROM automation_alerts WHERE status='OPEN' ORDER BY CASE severity WHEN 'URGENT' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'NORMAL' THEN 3 ELSE 4 END,created_at DESC LIMIT 250"),
        pool.query('SELECT * FROM automation_runs ORDER BY started_at DESC LIMIT 100'),
        pool.query(`SELECT
          (SELECT COUNT(*)::int FROM automation_rules WHERE enabled=TRUE) enabled_rules,
          (SELECT COUNT(*)::int FROM automation_alerts WHERE status='OPEN') open_alerts,
          (SELECT COALESCE(SUM(action_count),0)::int FROM automation_runs WHERE status='SUCCESS' AND started_at>=NOW()-INTERVAL '7 days') actions_7d,
          (SELECT MAX(started_at) FROM automation_runs) last_run_at`)
      ]);
      const ruleRows = rules.rows.map((rule) => ({
        ...rule,
        definition: { ...CATALOG[rule.rule_key], defaultConfig: undefined },
        config: normalizeConfig(rule.rule_key, rule.config)
      }));
      res.json({ ok: true, rules: ruleRows, alerts: alerts.rows, runs: runs.rows, metrics: metrics.rows[0], readiness: automationReadiness() });
    } catch (error) { next(error); }
  });

  app.put('/api/admin/automations/rules/:ruleKey', requireAdmin, async (req, res, next) => {
    try {
      const ruleKey = text(req.params.ruleKey, 100);
      if (!CATALOG[ruleKey]) throw httpError('Unknown automation rule.', 404);
      const config = normalizeConfig(ruleKey, req.body && req.body.config);
      const enabled = req.body && req.body.enabled === true;
      const result = await pool.query('UPDATE automation_rules SET enabled=$1,config=$2::jsonb,updated_at=NOW() WHERE rule_key=$3 RETURNING *', [enabled, JSON.stringify(config), ruleKey]);
      res.json({ ok: true, rule: result.rows[0] });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/automations/rules/:ruleKey/run', requireAdmin, async (req, res, next) => {
    const client = await pool.connect();
    try {
      const ruleKey = text(req.params.ruleKey, 100);
      const rule = await client.query('SELECT * FROM automation_rules WHERE rule_key=$1', [ruleKey]);
      if (!rule.rowCount) throw httpError('Automation rule not found.', 404);
      const result = await executeRule(client, rule.rows[0], true);
      res.json({ ok: true, result });
    } catch (error) { next(error); }
    finally { client.release(); }
  });

  app.post('/api/admin/automations/run-all', requireAdmin, async (_req, res, next) => {
    try {
      await runAutomationCycle();
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.put('/api/admin/automations/alerts/:id', requireAdmin, async (req, res, next) => {
    try {
      const status = text(req.body && req.body.status, 20).toUpperCase();
      if (!['DISMISSED', 'RESOLVED'].includes(status)) throw httpError('Invalid alert status.');
      const result = await pool.query("UPDATE automation_alerts SET status=$1,resolved_at=NOW(),updated_at=NOW() WHERE id=$2 RETURNING *", [status, Number(req.params.id)]);
      if (!result.rowCount) throw httpError('Alert not found.', 404);
      res.json({ ok: true, alert: result.rows[0] });
    } catch (error) { next(error); }
  });
}

module.exports = { ensureAutomationSchema, registerAutomations, startAutomationWorker, runAutomationCycle };

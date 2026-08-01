'use strict';

const crypto = require('crypto');
const { pool, withTransaction } = require('./db');
const { requireAdmin } = require('./auth');

const AUDIENCE_TYPES = ['ALL_SUBSCRIBERS', 'CUSTOMERS', 'CATEGORY_BUYERS', 'LAPSED_90_DAYS'];
const WARNING_LINES = [
  'This product has intoxicating effects and may be habit forming.',
  'Cannabis can impair concentration, coordination, and judgment. Do not operate a vehicle or machinery under the influence of this drug.',
  'There may be health risks associated with consumption of this product.',
  'For use only by adults 21 and older. Keep out of the reach of children.'
];

function text(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function email(value) {
  const normalized = text(value, 200).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : '';
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

function tokenSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
  return secret;
}

function signToken(contactId, recipientEmail) {
  const payload = Buffer.from(JSON.stringify({
    contactId: Number(contactId),
    email: String(recipientEmail).toLowerCase(),
    purpose: 'marketing-unsubscribe'
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', tokenSecret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyToken(token) {
  if (!token || !String(token).includes('.')) return null;
  const [payload, signature] = String(token).split('.');
  const expected = crypto.createHmac('sha256', tokenSecret()).update(payload).digest('base64url');
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (parsed.purpose !== 'marketing-unsubscribe' || !parsed.contactId || !parsed.email) return null;
    return parsed;
  } catch (_error) {
    return null;
  }
}

function siteUrl() {
  return String(process.env.SITE_URL || '').replace(/\/+$/, '');
}

function marketingReady() {
  const missing = [];
  if (!process.env.RESEND_API_KEY) missing.push('RESEND_API_KEY');
  if (!process.env.EMAIL_FROM) missing.push('EMAIL_FROM');
  if (!process.env.BUSINESS_POSTAL_ADDRESS) missing.push('BUSINESS_POSTAL_ADDRESS');
  if (!siteUrl()) missing.push('SITE_URL');
  return { ready: missing.length === 0, missing };
}

async function ensureMarketingSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketing_contacts (
      id BIGSERIAL PRIMARY KEY,
      customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
      business_name TEXT NOT NULL,
      contact_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL UNIQUE,
      state CHAR(2) NOT NULL DEFAULT 'WA',
      license_number TEXT NOT NULL DEFAULT '',
      email_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
      opted_in_at TIMESTAMPTZ,
      unsubscribed_at TIMESTAMPTZ,
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (state = 'WA')
    );

    CREATE INDEX IF NOT EXISTS marketing_contacts_opted_in_idx
      ON marketing_contacts(email_opt_in, unsubscribed_at);

    CREATE TABLE IF NOT EXISTS marketing_campaigns (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL,
      preview_text TEXT NOT NULL DEFAULT '',
      headline TEXT NOT NULL,
      body_text TEXT NOT NULL,
      cta_label TEXT NOT NULL DEFAULT 'View wholesale products',
      cta_url TEXT NOT NULL DEFAULT '/shop',
      audience_type TEXT NOT NULL DEFAULT 'ALL_SUBSCRIBERS',
      audience_value TEXT NOT NULL DEFAULT '',
      product_id BIGINT REFERENCES products(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      recipient_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      CHECK (status IN ('DRAFT','SENDING','SENT','FAILED')),
      CHECK (audience_type IN ('ALL_SUBSCRIBERS','CUSTOMERS','CATEGORY_BUYERS','LAPSED_90_DAYS'))
    );

    CREATE TABLE IF NOT EXISTS marketing_campaign_recipients (
      id BIGSERIAL PRIMARY KEY,
      campaign_id BIGINT NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
      contact_id BIGINT NOT NULL REFERENCES marketing_contacts(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      provider_message_id TEXT,
      error_message TEXT,
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(campaign_id, contact_id),
      CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED'))
    );

    CREATE INDEX IF NOT EXISTS marketing_recipient_queue_idx
      ON marketing_campaign_recipients(campaign_id, status);
  `);
}

async function upsertContact(input, source = 'manual', allowResubscribe = false) {
  const normalizedEmail = email(input.email);
  const state = text(input.state || 'WA', 2).toUpperCase();
  if (!normalizedEmail) throw httpError('A valid email is required.');
  if (state !== 'WA') throw httpError('Marketing contacts must be Washington recipients.');
  const optIn = input.emailOptIn === true;
  const businessName = text(input.businessName, 160);
  if (!businessName) throw httpError('Business name is required.');

  const result = await pool.query(`
    INSERT INTO marketing_contacts(
      customer_id,business_name,contact_name,email,state,license_number,email_opt_in,
      opted_in_at,unsubscribed_at,source
    )
    VALUES($1,$2,$3,$4,'WA',$5,$6,CASE WHEN $6 THEN NOW() ELSE NULL END,NULL,$7)
    ON CONFLICT(email) DO UPDATE SET
      customer_id=COALESCE(EXCLUDED.customer_id,marketing_contacts.customer_id),
      business_name=EXCLUDED.business_name,
      contact_name=EXCLUDED.contact_name,
      state='WA',
      license_number=EXCLUDED.license_number,
      email_opt_in=CASE
        WHEN EXCLUDED.email_opt_in AND ($8 OR marketing_contacts.unsubscribed_at IS NULL) THEN TRUE
        ELSE marketing_contacts.email_opt_in
      END,
      opted_in_at=CASE
        WHEN EXCLUDED.email_opt_in AND ($8 OR marketing_contacts.unsubscribed_at IS NULL) THEN COALESCE(marketing_contacts.opted_in_at,NOW())
        ELSE marketing_contacts.opted_in_at
      END,
      unsubscribed_at=CASE
        WHEN EXCLUDED.email_opt_in AND $8 THEN NULL
        ELSE marketing_contacts.unsubscribed_at
      END,
      source=EXCLUDED.source,
      updated_at=NOW()
    RETURNING *
  `, [
    input.customerId || null,
    businessName,
    text(input.contactName, 160),
    normalizedEmail,
    text(input.licenseNumber, 100),
    optIn,
    text(source, 80) || 'manual',
    allowResubscribe
  ]);
  return result.rows[0];
}

function audienceSql(type, value) {
  const base = `
    SELECT DISTINCT mc.*
    FROM marketing_contacts mc
    LEFT JOIN customers c ON LOWER(c.email)=mc.email
    LEFT JOIN orders o ON o.customer_id=c.id AND o.status<>'CANCELLED'
    LEFT JOIN order_items oi ON oi.order_id=o.id
    LEFT JOIN products p ON p.id=oi.product_id
    WHERE mc.email_opt_in=TRUE AND mc.unsubscribed_at IS NULL AND mc.state='WA'
  `;
  if (type === 'CUSTOMERS') return { sql: `${base} AND c.id IS NOT NULL ORDER BY mc.id`, params: [] };
  if (type === 'CATEGORY_BUYERS') {
    if (!text(value, 100)) throw httpError('Choose a product category for this audience.');
    return { sql: `${base} AND LOWER(p.category)=LOWER($1) ORDER BY mc.id`, params: [text(value, 100)] };
  }
  if (type === 'LAPSED_90_DAYS') {
    return {
      sql: `${base} AND c.id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM orders recent
        WHERE recent.customer_id=c.id AND recent.status<>'CANCELLED'
          AND recent.created_at>=NOW()-INTERVAL '90 days'
      ) ORDER BY mc.id`,
      params: []
    };
  }
  return { sql: `${base} ORDER BY mc.id`, params: [] };
}

async function audienceContacts(type, value) {
  const normalizedType = AUDIENCE_TYPES.includes(type) ? type : 'ALL_SUBSCRIBERS';
  const query = audienceSql(normalizedType, value);
  const result = await pool.query(query.sql, query.params);
  return result.rows;
}

function fullCtaUrl(campaign) {
  const raw = text(campaign.cta_url, 1000) || '/shop';
  if (/^https:\/\//i.test(raw)) return raw;
  return `${siteUrl()}${raw.startsWith('/') ? raw : `/${raw}`}`;
}

function bodyParagraphs(value) {
  return text(value, 10000)
    .split(/\n{2,}/)
    .map((paragraph) => `<p style="margin:0 0 18px;line-height:1.65;color:#d9e5da">${esc(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function renderCampaignEmail(campaign, contact, product) {
  const unsubscribeToken = signToken(contact.id, contact.email);
  const unsubscribeUrl = `${siteUrl()}/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`;
  const productBlock = product ? `
    <div style="margin:28px 0;padding:20px;border:1px solid #314338;border-radius:16px;background:#111713">
      ${product.image_url ? `<img src="${esc(product.image_url)}" alt="${esc(product.name)}" style="display:block;width:100%;max-height:320px;object-fit:cover;border-radius:12px;margin-bottom:16px">` : ''}
      <p style="margin:0 0 6px;color:#b8ff3d;font-size:12px;text-transform:uppercase;letter-spacing:.12em">${esc(product.category)}</p>
      <h2 style="margin:0;color:#ffffff;font-size:24px">${esc(product.name)}</h2>
      ${product.description ? `<p style="margin:10px 0 0;color:#b7c5b9;line-height:1.55">${esc(product.description)}</p>` : ''}
    </div>
  ` : '';
  const warnings = WARNING_LINES.map((line) => `<div style="margin:4px 0">${esc(line)}</div>`).join('');

  return `<!doctype html>
  <html><body style="margin:0;background:#090c09;font-family:Arial,sans-serif;color:#ffffff">
    <div style="display:none;max-height:0;overflow:hidden">${esc(campaign.preview_text)}</div>
    <div style="max-width:680px;margin:0 auto;padding:34px 22px">
      <p style="margin:0 0 22px;color:#39ff6a;font-weight:700;letter-spacing:.08em;text-transform:uppercase">${esc(process.env.SITE_NAME || 'Wholesale Cannabis')}</p>
      <div style="padding:34px;background:#0f140f;border:1px solid #28352b;border-radius:22px">
        <p style="margin:0 0 12px;color:#b8ff3d;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.14em">Advertisement · Washington licensed retailers · 21+</p>
        <h1 style="margin:0 0 22px;font-size:38px;line-height:1.05;color:#ffffff">${esc(campaign.headline)}</h1>
        ${bodyParagraphs(campaign.body_text)}
        ${productBlock}
        <a href="${esc(fullCtaUrl(campaign))}" style="display:inline-block;margin-top:8px;padding:15px 22px;border-radius:999px;background:#39ff6a;color:#06110a;text-decoration:none;font-weight:800">${esc(campaign.cta_label)}</a>
      </div>
      <div style="padding:24px 10px;color:#93a89a;font-size:12px;line-height:1.55">
        <p style="margin:0 0 12px">This commercial email was sent to a Washington business contact. ${esc(process.env.BUSINESS_POSTAL_ADDRESS || '')}</p>
        <div style="margin:0 0 14px">${warnings}</div>
        <p style="margin:0"><a href="${esc(unsubscribeUrl)}" style="color:#b8ff3d">Unsubscribe from marketing emails</a></p>
      </div>
    </div>
  </body></html>`;
}

async function sendResendEmail(contact, campaign, html) {
  const unsubscribeUrl = `${siteUrl()}/unsubscribe?token=${encodeURIComponent(signToken(contact.id, contact.email))}`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [contact.email],
      subject: campaign.subject,
      html,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
      }
    })
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(responseBody.message || `Resend returned ${response.status}`);
  return responseBody.id || null;
}

let workerActive = false;
async function processCampaignQueue() {
  if (workerActive) return;
  workerActive = true;
  try {
    const campaignResult = await pool.query(`
      SELECT * FROM marketing_campaigns
      WHERE status='SENDING'
      ORDER BY started_at NULLS FIRST,id
      LIMIT 1
    `);
    const campaign = campaignResult.rows[0];
    if (!campaign) return;

    const productResult = campaign.product_id
      ? await pool.query('SELECT * FROM products WHERE id=$1', [campaign.product_id])
      : { rows: [] };
    const product = productResult.rows[0] || null;

    const recipients = await pool.query(`
      SELECT mcr.id recipient_id,mcr.contact_id,mc.*
      FROM marketing_campaign_recipients mcr
      JOIN marketing_contacts mc ON mc.id=mcr.contact_id
      WHERE mcr.campaign_id=$1 AND mcr.status='PENDING'
      ORDER BY mcr.id
      LIMIT 20
    `, [campaign.id]);

    for (const contact of recipients.rows) {
      if (!contact.email_opt_in || contact.unsubscribed_at) {
        await pool.query(`UPDATE marketing_campaign_recipients SET status='SKIPPED',error_message='Unsubscribed' WHERE id=$1`, [contact.recipient_id]);
        continue;
      }
      try {
        const providerId = await sendResendEmail(contact, campaign, renderCampaignEmail(campaign, contact, product));
        await pool.query(`
          UPDATE marketing_campaign_recipients
          SET status='SENT',provider_message_id=$1,sent_at=NOW(),error_message=NULL
          WHERE id=$2
        `, [providerId, contact.recipient_id]);
      } catch (error) {
        await pool.query(`
          UPDATE marketing_campaign_recipients
          SET status='FAILED',error_message=$1
          WHERE id=$2
        `, [text(error.message, 1000), contact.recipient_id]);
      }
    }

    const counts = await pool.query(`
      SELECT
        COUNT(*) FILTER(WHERE status='PENDING') pending,
        COUNT(*) FILTER(WHERE status='SENT') sent,
        COUNT(*) FILTER(WHERE status='FAILED') failed,
        COUNT(*) FILTER(WHERE status='SKIPPED') skipped
      FROM marketing_campaign_recipients WHERE campaign_id=$1
    `, [campaign.id]);
    const count = counts.rows[0];
    const finished = Number(count.pending) === 0;
    await pool.query(`
      UPDATE marketing_campaigns
      SET sent_count=$1,failed_count=$2,
          status=CASE WHEN $3 THEN CASE WHEN $1=0 AND $2>0 THEN 'FAILED' ELSE 'SENT' END ELSE 'SENDING' END,
          sent_at=CASE WHEN $3 THEN NOW() ELSE sent_at END,
          updated_at=NOW()
      WHERE id=$4
    `, [Number(count.sent), Number(count.failed), finished, campaign.id]);
  } catch (error) {
    console.error('Marketing worker error:', error);
  } finally {
    workerActive = false;
  }
}

function startMarketingWorker() {
  const timer = setInterval(() => processCampaignQueue().catch(console.error), 5000);
  if (timer.unref) timer.unref();
  setImmediate(() => processCampaignQueue().catch(console.error));
}

function campaignPayload(body) {
  const audienceType = AUDIENCE_TYPES.includes(body.audienceType) ? body.audienceType : 'ALL_SUBSCRIBERS';
  const payload = {
    name: text(body.name, 160),
    subject: text(body.subject, 200),
    previewText: text(body.previewText, 240),
    headline: text(body.headline, 240),
    bodyText: text(body.bodyText, 10000),
    ctaLabel: text(body.ctaLabel, 100) || 'View wholesale products',
    ctaUrl: text(body.ctaUrl, 1000) || '/shop',
    audienceType,
    audienceValue: text(body.audienceValue, 100),
    productId: body.productId ? Number(body.productId) : null
  };
  if (!payload.name || !payload.subject || !payload.headline || !payload.bodyText) {
    throw httpError('Campaign name, subject, headline, and message are required.');
  }
  if (payload.audienceType === 'CATEGORY_BUYERS' && !payload.audienceValue) {
    throw httpError('Choose a category for a category-buyer campaign.');
  }
  if (payload.productId && !Number.isInteger(payload.productId)) throw httpError('Invalid featured product.');
  return payload;
}

function unsubscribePage(success) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Marketing preferences</title></head><body style="margin:0;background:#0b0d0b;color:#eaf2e6;font-family:Arial,sans-serif"><main style="max-width:620px;margin:80px auto;padding:32px"><p style="color:#39ff6a;font-weight:700;text-transform:uppercase;letter-spacing:.1em">Marketing preferences</p><h1>${success ? 'You are unsubscribed.' : 'This unsubscribe link is invalid.'}</h1><p>${success ? 'You will no longer receive commercial campaign emails. Transactional order and fulfillment emails may still be sent when necessary.' : 'Contact the sender directly to update your marketing preferences.'}</p><a href="/" style="color:#b8ff3d">Return to website</a></main></body></html>`;
}

function registerMarketing(app) {
  app.post('/api/marketing/subscribe', async (req, res, next) => {
    try {
      if (req.body.emailOptIn !== true) return res.status(400).json({ ok: false, error: 'Marketing consent is required.' });
      const contact = await upsertContact(req.body || {}, 'checkout', true);
      res.status(201).json({ ok: true, contactId: contact.id });
    } catch (error) { next(error); }
  });

  app.get('/unsubscribe', async (req, res) => {
    const parsed = verifyToken(req.query.token);
    if (!parsed) return res.status(400).type('html').send(unsubscribePage(false));
    const result = await pool.query(`
      UPDATE marketing_contacts
      SET email_opt_in=FALSE,unsubscribed_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND email=$2 RETURNING id
    `, [parsed.contactId, parsed.email]);
    res.type('html').send(unsubscribePage(result.rowCount > 0));
  });

  app.post('/unsubscribe', async (req, res) => {
    const parsed = verifyToken(req.query.token || req.body.token);
    if (!parsed) return res.status(400).json({ ok: false });
    await pool.query(`
      UPDATE marketing_contacts
      SET email_opt_in=FALSE,unsubscribed_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND email=$2
    `, [parsed.contactId, parsed.email]);
    res.json({ ok: true });
  });

  app.get('/api/admin/marketing/summary', requireAdmin, async (_req, res, next) => {
    try {
      const [counts, categories] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*) FILTER(WHERE email_opt_in=TRUE AND unsubscribed_at IS NULL) subscribers,
            COUNT(*) FILTER(WHERE unsubscribed_at IS NOT NULL) unsubscribed,
            (SELECT COUNT(*) FROM marketing_campaigns WHERE status='DRAFT') drafts,
            (SELECT COUNT(*) FROM marketing_campaigns WHERE status='SENDING') sending,
            (SELECT COALESCE(SUM(sent_count),0) FROM marketing_campaigns) emails_sent
          FROM marketing_contacts
        `),
        pool.query('SELECT DISTINCT category FROM products WHERE active=TRUE ORDER BY category')
      ]);
      res.json({
        ok: true,
        summary: counts.rows[0],
        categories: categories.rows.map((row) => row.category),
        delivery: marketingReady()
      });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/marketing/contacts', requireAdmin, async (req, res, next) => {
    try {
      const q = text(req.query.q, 100);
      const result = await pool.query(`
        SELECT * FROM marketing_contacts
        WHERE $1='' OR business_name ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%'
        ORDER BY updated_at DESC LIMIT 500
      `, [q]);
      res.json({ ok: true, contacts: result.rows });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/marketing/contacts', requireAdmin, async (req, res, next) => {
    try {
      const contact = await upsertContact({ ...req.body, emailOptIn: true }, 'admin');
      res.status(201).json({ ok: true, contact });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/marketing/contacts/import', requireAdmin, async (req, res, next) => {
    try {
      const rows = Array.isArray(req.body.contacts) ? req.body.contacts.slice(0, 2000) : [];
      if (!rows.length) throw httpError('No contacts were provided.');
      let imported = 0;
      const errors = [];
      for (let index = 0; index < rows.length; index += 1) {
        try {
          await upsertContact({ ...rows[index], emailOptIn: true }, 'csv-import');
          imported += 1;
        } catch (error) {
          errors.push({ row: index + 2, error: error.message });
        }
      }
      res.json({ ok: true, imported, rejected: errors.length, errors: errors.slice(0, 50) });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/marketing/campaigns', requireAdmin, async (_req, res, next) => {
    try {
      const result = await pool.query(`
        SELECT mc.*,p.name product_name,p.category product_category
        FROM marketing_campaigns mc
        LEFT JOIN products p ON p.id=mc.product_id
        ORDER BY mc.created_at DESC LIMIT 250
      `);
      res.json({ ok: true, campaigns: result.rows });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/marketing/campaigns', requireAdmin, async (req, res, next) => {
    try {
      const c = campaignPayload(req.body || {});
      const result = await pool.query(`
        INSERT INTO marketing_campaigns(
          name,subject,preview_text,headline,body_text,cta_label,cta_url,
          audience_type,audience_value,product_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
      `, [c.name,c.subject,c.previewText,c.headline,c.bodyText,c.ctaLabel,c.ctaUrl,c.audienceType,c.audienceValue,c.productId]);
      res.status(201).json({ ok: true, campaign: result.rows[0] });
    } catch (error) { next(error); }
  });

  app.put('/api/admin/marketing/campaigns/:id', requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const c = campaignPayload(req.body || {});
      const result = await pool.query(`
        UPDATE marketing_campaigns SET
          name=$1,subject=$2,preview_text=$3,headline=$4,body_text=$5,
          cta_label=$6,cta_url=$7,audience_type=$8,audience_value=$9,product_id=$10,updated_at=NOW()
        WHERE id=$11 AND status='DRAFT' RETURNING *
      `, [c.name,c.subject,c.previewText,c.headline,c.bodyText,c.ctaLabel,c.ctaUrl,c.audienceType,c.audienceValue,c.productId,id]);
      if (!result.rowCount) throw httpError('Only draft campaigns can be edited.', 409);
      res.json({ ok: true, campaign: result.rows[0] });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/marketing/audience-count', requireAdmin, async (req, res, next) => {
    try {
      const type = AUDIENCE_TYPES.includes(req.body.audienceType) ? req.body.audienceType : 'ALL_SUBSCRIBERS';
      const contacts = await audienceContacts(type, req.body.audienceValue);
      res.json({ ok: true, count: contacts.length });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/marketing/campaigns/:id/send', requireAdmin, async (req, res, next) => {
    try {
      const readiness = marketingReady();
      if (!readiness.ready) throw httpError(`Marketing delivery is not configured: ${readiness.missing.join(', ')}`, 503);
      const id = Number(req.params.id);
      const campaignResult = await pool.query('SELECT * FROM marketing_campaigns WHERE id=$1', [id]);
      const campaign = campaignResult.rows[0];
      if (!campaign) throw httpError('Campaign not found.', 404);
      if (campaign.status !== 'DRAFT') throw httpError('Only draft campaigns can be sent.', 409);
      const contacts = await audienceContacts(campaign.audience_type, campaign.audience_value);
      if (!contacts.length) throw httpError('This audience has no eligible subscribers.', 409);

      await withTransaction(async (client) => {
        const locked = await client.query('SELECT status FROM marketing_campaigns WHERE id=$1 FOR UPDATE', [id]);
        if (!locked.rowCount || locked.rows[0].status !== 'DRAFT') throw httpError('Campaign is no longer available to send.', 409);
        for (const contact of contacts) {
          await client.query(`
            INSERT INTO marketing_campaign_recipients(campaign_id,contact_id,email)
            VALUES($1,$2,$3) ON CONFLICT(campaign_id,contact_id) DO NOTHING
          `, [id, contact.id, contact.email]);
        }
        await client.query(`
          UPDATE marketing_campaigns
          SET status='SENDING',recipient_count=$1,started_at=NOW(),updated_at=NOW()
          WHERE id=$2
        `, [contacts.length, id]);
      });
      setImmediate(() => processCampaignQueue().catch(console.error));
      res.status(202).json({ ok: true, campaignId: id, recipients: contacts.length, status: 'SENDING' });
    } catch (error) { next(error); }
  });
}

module.exports = {
  ensureMarketingSchema,
  registerMarketing,
  startMarketingWorker
};

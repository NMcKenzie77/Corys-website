'use strict';

const crypto = require('crypto');
const { pool } = require('./db');
const { requireAdmin } = require('./auth');

const PRIVACY_NOTICE_VERSION = '2026-08-01';
const REQUEST_TYPES = ['ACCESS', 'CORRECTION', 'DELETION', 'MARKETING_OPT_OUT', 'OTHER'];
const REQUEST_STATUSES = ['OPEN', 'VERIFYING', 'IN_PROGRESS', 'COMPLETED', 'DENIED'];

function text(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function validEmail(value) {
  const normalized = text(value, 200).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : '';
}

function bool(value) {
  return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function fingerprint(req) {
  const secret = process.env.SESSION_SECRET || 'development-only-compliance-key';
  return crypto
    .createHmac('sha256', secret)
    .update(`${req.ip || ''}|${req.get('user-agent') || ''}`)
    .digest('hex');
}

async function ensureComplianceSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS consent_records (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL DEFAULT '',
      business_name TEXT NOT NULL DEFAULT '',
      consent_type TEXT NOT NULL,
      notice_version TEXT NOT NULL,
      source_path TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL DEFAULT '',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_consent_records_email
      ON consent_records(email, consented_at DESC);

    CREATE INDEX IF NOT EXISTS idx_consent_records_type
      ON consent_records(consent_type, consented_at DESC);

    CREATE TABLE IF NOT EXISTS privacy_requests (
      id BIGSERIAL PRIMARY KEY,
      request_number TEXT NOT NULL UNIQUE,
      request_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      name TEXT NOT NULL,
      business_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      verification_notes TEXT NOT NULL DEFAULT '',
      resolution_notes TEXT NOT NULL DEFAULT '',
      request_fingerprint TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      CHECK (request_type IN ('ACCESS','CORRECTION','DELETION','MARKETING_OPT_OUT','OTHER')),
      CHECK (status IN ('OPEN','VERIFYING','IN_PROGRESS','COMPLETED','DENIED'))
    );

    CREATE INDEX IF NOT EXISTS idx_privacy_requests_status
      ON privacy_requests(status, created_at DESC);
  `);
}

function requestNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `PR-${date}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function sendPrivacyNotification(request) {
  const recipient = process.env.PRIVACY_EMAIL || process.env.ADMIN_EMAIL || '';
  if (!recipient || !process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [recipient],
      subject: `Privacy request ${request.request_number}: ${request.request_type}`,
      html: `
        <h2>Privacy request received</h2>
        <p><strong>Request:</strong> ${request.request_number}</p>
        <p><strong>Type:</strong> ${request.request_type}</p>
        <p><strong>Name:</strong> ${request.name}</p>
        <p><strong>Business:</strong> ${request.business_name || 'Not provided'}</p>
        <p><strong>Email:</strong> ${request.email}</p>
        <p><strong>Details:</strong><br>${request.details || 'None provided'}</p>
        <p>Verify the requester's identity before disclosing, correcting, or deleting records.</p>
      `
    })
  });

  if (!response.ok) {
    console.error('Privacy notification email failed:', response.status, await response.text());
  }
}

async function recordConsent(req, consentType, metadata = {}) {
  const email = validEmail(req.body && req.body.email);
  const businessName = text(req.body && req.body.businessName, 200);
  await pool.query(
    `INSERT INTO consent_records(
      email,business_name,consent_type,notice_version,source_path,request_fingerprint,metadata
    ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [
      email,
      businessName,
      consentType,
      PRIVACY_NOTICE_VERSION,
      req.path,
      fingerprint(req),
      JSON.stringify(metadata)
    ]
  );
}

function consentGuard(req, res, next) {
  if (!bool(req.body && req.body.privacyAccepted)) {
    return res.status(400).json({
      ok: false,
      error: 'Review and accept the Privacy Notice and Terms before submitting.'
    });
  }

  const originalJson = res.json.bind(res);
  res.json = function complianceJson(payload) {
    if (res.statusCode >= 200 && res.statusCode < 300 && payload && payload.ok) {
      const consentType = req.path === '/api/orders' ? 'WHOLESALE_ORDER' : 'BUSINESS_INQUIRY';
      recordConsent(req, consentType, {
        marketingConsent: bool(req.body && req.body.marketingConsent),
        licenseConfirmed: bool(req.body && req.body.licenseConfirmed)
      }).catch((error) => console.error('Consent record failed:', error.message));
    }
    return originalJson(payload);
  };

  next();
}

function registerCompliance(app) {
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

    if (req.path.startsWith('/admin') || req.path.startsWith('/api/') || req.path === '/healthz') {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
      res.setHeader('Cache-Control', 'no-store');
    }

    next();
  });

  app.post('/api/inquiry', consentGuard);
  app.post('/api/orders', consentGuard);

  app.post('/api/privacy-requests', async (req, res, next) => {
    try {
      const requestType = text(req.body && req.body.requestType, 40).toUpperCase();
      const name = text(req.body && req.body.name, 200);
      const businessName = text(req.body && req.body.businessName, 200);
      const email = validEmail(req.body && req.body.email);
      const details = text(req.body && req.body.details, 5000);

      if (!REQUEST_TYPES.includes(requestType)) throw httpError('Choose a valid request type.');
      if (!name || !email) throw httpError('Name and a valid email are required.');
      if (!bool(req.body && req.body.confirmed)) throw httpError('Confirm that the information is accurate.');

      const result = await pool.query(
        `INSERT INTO privacy_requests(
          request_number,request_type,name,business_name,email,details,request_fingerprint
        ) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [requestNumber(), requestType, name, businessName, email, details, fingerprint(req)]
      );

      sendPrivacyNotification(result.rows[0]).catch((error) => console.error(error));
      res.status(201).json({
        ok: true,
        requestNumber: result.rows[0].request_number,
        message: 'Request received. We will verify your identity before acting on the request.'
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/compliance/summary', requireAdmin, async (_req, res, next) => {
    try {
      const [requests, consents] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*) FILTER (WHERE status IN ('OPEN','VERIFYING','IN_PROGRESS'))::int open_requests,
            COUNT(*) FILTER (WHERE status='COMPLETED')::int completed_requests,
            COUNT(*)::int total_requests
          FROM privacy_requests
        `),
        pool.query(`
          SELECT COUNT(*)::int consent_records,
            COUNT(DISTINCT NULLIF(email,''))::int unique_people
          FROM consent_records
        `)
      ]);

      const required = {
        siteName: Boolean(process.env.SITE_NAME && process.env.SITE_NAME !== 'YOUR BRAND'),
        siteUrl: Boolean(process.env.SITE_URL),
        businessEmail: Boolean(process.env.BUSINESS_EMAIL),
        businessPhone: Boolean(process.env.BUSINESS_PHONE),
        businessAddress: Boolean(process.env.BUSINESS_ADDRESS),
        licenseNumber: Boolean(process.env.BUSINESS_LICENSE_NUMBER),
        privacyEmail: Boolean(process.env.PRIVACY_EMAIL || process.env.ADMIN_EMAIL)
      };

      res.json({
        ok: true,
        summary: { ...requests.rows[0], ...consents.rows[0] },
        readiness: required,
        indexingRequested: process.env.ENABLE_INDEXING === 'true',
        indexingReady: Object.values(required).every(Boolean)
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/compliance/requests', requireAdmin, async (_req, res, next) => {
    try {
      const result = await pool.query('SELECT * FROM privacy_requests ORDER BY created_at DESC LIMIT 500');
      res.json({ ok: true, requests: result.rows });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/admin/compliance/requests/:id', requireAdmin, async (req, res, next) => {
    try {
      const status = text(req.body && req.body.status, 40).toUpperCase();
      if (!REQUEST_STATUSES.includes(status)) throw httpError('Invalid request status.');

      const result = await pool.query(
        `UPDATE privacy_requests SET
          status=$1,
          verification_notes=$2,
          resolution_notes=$3,
          completed_at=CASE WHEN $1 IN ('COMPLETED','DENIED') THEN COALESCE(completed_at,NOW()) ELSE NULL END,
          updated_at=NOW()
        WHERE id=$4 RETURNING *`,
        [
          status,
          text(req.body && req.body.verificationNotes, 5000),
          text(req.body && req.body.resolutionNotes, 5000),
          Number(req.params.id)
        ]
      );

      if (!result.rowCount) throw httpError('Privacy request not found.', 404);
      res.json({ ok: true, request: result.rows[0] });
    } catch (error) {
      next(error);
    }
  });
}

module.exports = {
  PRIVACY_NOTICE_VERSION,
  ensureComplianceSchema,
  registerCompliance
};

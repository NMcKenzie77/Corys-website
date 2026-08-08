'use strict';

const { setPlatformSessionCookie } = require('../auth');
const { httpError, text } = require('./identity');

function cleanBaseUrl(value) {
  return text(value, 500).replace(/\/+$/, '');
}

async function exchangePlatformAdminToken(token) {
  const platformUrl = cleanBaseUrl(process.env.ARKON_PLATFORM_URL);
  const serviceKey = text(process.env.ARKON_PLATFORM_SERVICE_KEY, 1000);
  const runtimeKey = text(process.env.CORY_RUNTIME_KEY, 100);
  const configuredClientCompanyId = text(process.env.CORY_PLATFORM_CLIENT_COMPANY_ID, 160);

  if (!platformUrl || !serviceKey || !runtimeKey) {
    throw httpError('ARKON Platform admin handoff is not configured.', 503);
  }
  if (process.env.NODE_ENV === 'production' && !configuredClientCompanyId) {
    throw httpError('CORY_PLATFORM_CLIENT_COMPANY_ID is required in production.', 503);
  }

  let response;
  try {
    response = await fetch(`${platformUrl}/api/internal/vertical-admin/exchange`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'x-arkon-runtime-key': runtimeKey
      },
      body: JSON.stringify({ token })
    });
  } catch (_error) {
    throw httpError('ARKON Platform admin handoff is temporarily unavailable.', 503);
  }

  const responseText = await response.text();
  let body = null;
  try { body = JSON.parse(responseText); } catch (_error) {}

  if (!response.ok || !body || body.ok !== true || !body.data) {
    const message = body && body.error ? text(body.error, 300) : 'Platform admin handoff was rejected.';
    throw httpError(message, response.status >= 400 && response.status < 500 ? response.status : 503);
  }

  const claims = body.data;
  if (claims.role !== 'SUPER_ADMIN' || text(claims.runtimeKey, 100) !== runtimeKey) {
    throw httpError('Platform admin handoff returned invalid runtime claims.', 403);
  }
  if (configuredClientCompanyId && text(claims.clientCompanyId, 160) !== configuredClientCompanyId) {
    throw httpError('Platform admin handoff is not authorized for this Cory tenant.', 403);
  }

  return {
    role: 'SUPER_ADMIN',
    clientCompanyId: text(claims.clientCompanyId, 160),
    runtimeKey
  };
}

async function platformAdminHandoff(req, res, next) {
  try {
    const token = text(req.query && req.query.token, 300);
    if (!token) return res.status(400).json({ ok: false, error: 'Platform admin handoff token is required.' });

    if (token === 'arkon-runtime-discovery') {
      return res.status(401).json({ ok: false, error: 'Platform admin handoff token required.' });
    }

    const claims = await exchangePlatformAdminToken(token);
    setPlatformSessionCookie(res, claims);
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(303, '/admin');
  } catch (error) {
    next(error);
  }
}

module.exports = {
  exchangePlatformAdminToken,
  platformAdminHandoff
};

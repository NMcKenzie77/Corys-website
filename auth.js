'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const COOKIE_NAME = 'cory_admin_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const PLATFORM_SESSION_TTL_SECONDS = 60 * 60;

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be set to at least 32 characters.');
  return secret;
}

function sign(value) {
  return crypto.createHmac('sha256', getSecret()).update(value).digest('base64url');
}

function issueSignedSession(claims, ttlSeconds) {
  const payload = Buffer.from(JSON.stringify({
    ...claims,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function issueSession(email) {
  return issueSignedSession({
    kind: 'LOCAL_STAFF',
    email: String(email).toLowerCase()
  }, SESSION_TTL_SECONDS);
}

function issuePlatformSession(claims) {
  return issueSignedSession({
    kind: 'PLATFORM_SUPER_ADMIN',
    platform: true,
    role: 'SUPER_ADMIN',
    actorRef: 'ARKON_PLATFORM_SUPER_ADMIN',
    clientCompanyId: String(claims.clientCompanyId || ''),
    runtimeKey: String(claims.runtimeKey || '')
  }, PLATFORM_SESSION_TTL_SECONDS);
}

function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
    if (parsed.kind === 'PLATFORM_SUPER_ADMIN') {
      if (parsed.platform !== true || parsed.role !== 'SUPER_ADMIN' || !parsed.clientCompanyId || !parsed.runtimeKey) return null;
      return parsed;
    }
    if (!parsed.email) return null;
    return parsed;
  } catch (_error) {
    return null;
  }
}

async function verifyAdminCredentials(email, password) {
  const expectedEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  if (!expectedEmail || String(email || '').trim().toLowerCase() !== expectedEmail) return false;
  if (process.env.ADMIN_PASSWORD_HASH) return bcrypt.compare(String(password || ''), process.env.ADMIN_PASSWORD_HASH);
  const plain = process.env.ADMIN_PASSWORD;
  if (!plain) return false;
  const supplied = Buffer.from(String(password || ''));
  const expected = Buffer.from(String(plain));
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function cookieOptions(maxAgeSeconds) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: maxAgeSeconds * 1000,
    path: '/'
  };
}

function setSessionCookie(res, email) {
  res.cookie(COOKIE_NAME, issueSession(email), cookieOptions(SESSION_TTL_SECONDS));
}

function setPlatformSessionCookie(res, claims) {
  res.cookie(COOKIE_NAME, issuePlatformSession(claims), cookieOptions(PLATFORM_SESSION_TTL_SECONDS));
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function requireAdmin(req, res, next) {
  try {
    const session = verifySession(req.cookies && req.cookies[COOKIE_NAME]);
    if (!session) return res.status(401).json({ ok: false, error: 'Authentication required.' });
    req.admin = session;
    next();
  } catch (error) {
    console.error('Admin session error:', error.message);
    res.status(401).json({ ok: false, error: 'Authentication required.' });
  }
}

module.exports = {
  COOKIE_NAME,
  verifySession,
  verifyAdminCredentials,
  setSessionCookie,
  setPlatformSessionCookie,
  clearSessionCookie,
  requireAdmin
};

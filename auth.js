'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const COOKIE_NAME = 'cory_admin_session';
const SESSION_TTL_SECONDS = 60 * 60 * 12;

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be set to at least 32 characters.');
  return secret;
}

function sign(value) {
  return crypto.createHmac('sha256', getSecret()).update(value).digest('base64url');
}

function issueSession(email) {
  const payload = Buffer.from(JSON.stringify({
    email: String(email).toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed.email || parsed.exp < Math.floor(Date.now() / 1000)) return null;
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

function setSessionCookie(res, email) {
  res.cookie(COOKIE_NAME, issueSession(email), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/'
  });
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
  clearSessionCookie,
  requireAdmin
};

const { createHmac, timingSafeEqual } = require('node:crypto');
const { getPool } = require('./db');

const COOKIE_NAME = 'alphaverse_session';
const SESSION_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

function requestCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').map((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return ['', ''];
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      return [name, decodeURIComponent(value)];
    } catch {
      return [name, ''];
    }
  }).filter(([name]) => name));
}

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error('SESSION_SECRET must be configured with at least 32 characters.');
  }
  return value;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verify(token) {
  if (typeof token !== 'string') return null;
  const [body, signature] = token.split('.');
  if (!body || !signature) return null;
  const expected = createHmac('sha256', secret()).update(body).digest();
  let actual;
  try {
    actual = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.exp > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

function setSessionCookie(res, user) {
  const token = sign({ sub: user.id, ver: user.session_version || 0, exp: Date.now() + SESSION_MAX_AGE });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });
}

async function authenticate(req, res, next) {
  try {
    const payload = verify(requestCookies(req)[COOKIE_NAME]);
    if (!payload) return res.status(401).json({ error: 'Please sign in to continue.' });

    const { rows } = await getPool().query(
      `SELECT id, full_name, email, contact_number, role, status, session_version
       FROM users WHERE id = $1`,
      [payload.sub]
    );
    const user = rows[0];
    if (!user || user.status !== 'active' || Number(user.session_version) !== payload.ver) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'This account is not active.' });
    }

    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Administrator access is required.' });
  }
  return next();
}

module.exports = {
  COOKIE_NAME,
  SESSION_MAX_AGE,
  authenticate,
  clearSessionCookie,
  requireAdmin,
  setSessionCookie,
  verify
};

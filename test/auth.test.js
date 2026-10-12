const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'test-only-session-secret-with-more-than-32-characters';
const { setSessionCookie, verify } = require('../server/auth');

test('session cookies contain a signed user identifier', () => {
  let cookie;
  const response = {
    cookie(name, value, options) {
      cookie = { name, value, options };
    }
  };

  setSessionCookie(response, { id: '42', session_version: 3 });
  const payload = verify(cookie.value);

  assert.equal(cookie.name, 'alphaverse_session');
  assert.equal(cookie.options.httpOnly, true);
  assert.equal(cookie.options.sameSite, 'lax');
  assert.equal(payload.sub, '42');
  assert.equal(payload.ver, 3);
});

test('tampered and expired session cookies are rejected', () => {
  assert.equal(verify('not.a.valid.token'), null);

  const { createHmac } = require('node:crypto');
  const body = Buffer.from(JSON.stringify({ sub: '1', exp: Date.now() - 1000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url');
  assert.equal(verify(`${body}.${signature}`), null);
});

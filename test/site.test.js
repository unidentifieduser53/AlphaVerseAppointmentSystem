const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SESSION_SECRET = 'test-only-session-secret-with-more-than-32-characters';

const { app } = require('../server/app');

test('static pages are served by the JavaScript application', async (context) => {
  const server = app.listen(0);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const [homeResponse, projectsResponse, recoveryResponse, imageResponse] = await Promise.all([
    fetch(`${origin}/`),
    fetch(`${origin}/projects.html`),
    fetch(`${origin}/forgot-password.html`),
    fetch(`${origin}/images/AVLogoNew-removebg-preview.png`)
  ]);
  const home = await homeResponse.text();
  const projects = await projectsResponse.text();
  const recovery = await recoveryResponse.text();

  assert.equal(homeResponse.status, 200);
  assert.match(home, /Build your future with trust/);
  assert.equal(projectsResponse.status, 200);
  assert.match(projects, /Tropical-Themed Dream Home/);
  assert.equal(recoveryResponse.status, 200);
  assert.match(recovery, /password-reset-request/);
  assert.match(recovery, /password-reset-complete/);
  assert.equal(imageResponse.status, 200);
  assert.match(imageResponse.headers.get('content-type'), /image\/png/);
});

test('registration validates missing user details before database access', async (context) => {
  const server = app.listen(0);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /full name is required/i);
});

test('protected API endpoints reject anonymous requests', async (context) => {
  const server = app.listen(0);
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/dashboard`);
  assert.equal(response.status, 401);
  assert.match((await response.json()).error, /sign in/i);
});

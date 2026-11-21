const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aurapay-smoke-'));
const port = 33000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let server;

async function request(endpoint, init) {
  const res = await fetch(base + endpoint, init);
  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await res.json() : await res.text();
  return { res, body };
}

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), MONGODB_URI: '', GMAIL_APP_PASS: '',
      AURAPAY_STORE_PATH: path.join(temp, 'store.json') },
    stdio: 'ignore'
  });
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) throw new Error('AuraPay server exited before startup');
    try {
      const { res } = await request('/api/health');
      if (res.status === 200) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('AuraPay health endpoint did not start');
});

after(() => {
  if (server) server.kill();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('health and home page', async () => {
  const health = await request('/api/health');
  assert.equal(health.res.status, 200);
  assert.equal(health.body.status, 'online');
  const home = await request('/');
  assert.equal(home.res.status, 200);
  assert.match(home.body, /AuraPay/);
});

test('QR asset and checkout page', async () => {
  const qr = await fetch(base + '/qr-code.jpeg');
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/jpeg/);
  const paywall = await request('/pay/demo-order');
  assert.equal(paywall.res.status, 200);
  assert.match(paywall.body, /<html/i);
});

test('registration and login do not leak stored passwords', async () => {
  const email = `test-${Date.now()}@example.invalid`;
  const credentials = { name: 'Test Merchant', email, password: 'test-only-password',
    businessName: 'Demo Shop' };
  const registered = await request('/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials)
  });
  assert.equal(registered.res.status, 200);
  assert.equal(registered.body.success, true);
  assert.equal(registered.body.merchant.password, undefined);
  assert.equal(registered.body.merchant.gmailAppPass, undefined);
  const loggedIn = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: credentials.password })
  });
  assert.equal(loggedIn.res.status, 200);
  assert.equal(loggedIn.body.merchant.password, undefined);
  assert.equal(loggedIn.body.merchant.gmailAppPass, undefined);
});

test('unknown API and unauthorized checkout fail correctly', async () => {
  const missing = await request('/api/this-route-does-not-exist');
  assert.equal(missing.res.status, 404);
  assert.ok(missing.body.error);
  const unauthorized = await request('/api/v1/checkout/create', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: 10 })
  });
  assert.equal(unauthorized.res.status, 401);
});

test('merchant session rejects spoofed IDs and disables money before verification', async () => {
  const anon = await request('/api/merchant/dashboard', { headers: { 'x-merchant-id': 'merch_default' } });
  assert.equal(anon.res.status, 401);
  const email = 'session-' + Date.now() + '@example.invalid';
  const registered = await request('/api/auth/register', {
    method: 'POST', headers: { 'content-type':'application/json' },
    body: JSON.stringify({ name:'Merchant A', businessName:'Demo Store', email, password:'secure-testing-password' })
  });
  assert.equal(registered.res.status, 200);
  const cookie = (registered.res.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie.startsWith('aurapay_session='));
  const unauthMe = await request('/api/auth/me');
  assert.equal(unauthMe.res.status, 401);
  const own = await request('/api/auth/me', { headers: { cookie } });
  assert.equal(own.res.status, 200);
  assert.equal(own.body.merchant.email, email);
  const dashboard = await request('/api/merchant/dashboard', {
    headers: { cookie, 'x-merchant-id': 'merch_default' }
  });
  assert.equal(dashboard.res.status, 200);
  assert.equal(dashboard.body.merchant.email, email);
  const fakeSimulation = await request('/api/v1/simulate-payment', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ amount: 5 })
  });
  assert.equal(fakeSimulation.res.status, 403);
  const invalidUpi = await request('/api/merchant/update-upi', {
    method: 'POST', headers: { cookie, 'content-type':'application/json' },
    body: JSON.stringify({ upiId: 'not-an-address' })
  });
  assert.equal(invalidUpi.res.status, 400);
  const updatedUpi = await request('/api/merchant/update-upi', {
    method: 'POST', headers: { cookie, 'content-type':'application/json' },
    body: JSON.stringify({ upiId: 'myshop@okaxis' })
  });
  assert.equal(updatedUpi.res.status, 200);
  assert.equal(updatedUpi.body.merchant.upiId, 'myshop@okaxis');
  assert.equal(updatedUpi.body.merchant.isOnboarded, true);
  const blockedPayment = await request('/api/merchant/create-paywall-link', {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ amount: 5 })
  });
  assert.equal(blockedPayment.res.status, 503);
  const logout = await request('/api/auth/logout', { method:'POST', headers:{ cookie } });
  assert.equal(logout.res.status, 200);
});

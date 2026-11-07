import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

// Simulate a trusted ingress that overwrites X-Forwarded-For for each client.
process.env.TRUST_PROXY = '1';
const { isValidEmail, startServer, stopServer } = await import('../server.js');
let dataDir;
let baseUrl;
let requestCount = 0;

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexterm-http-limit-test-'));
  const server = await startServer({ dataDir, dataKey: Buffer.alloc(32, 9), host: '127.0.0.1', port: 0 });
  baseUrl = server.url;
});

after(async () => {
  await stopServer();
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

async function request(route, ip, options = {}) {
  requestCount++;
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { 'x-forwarded-for': ip, ...options.headers }
  });
  await response.arrayBuffer();
  return response;
}

async function repeat(count, callback) {
  for (let start = 0; start < count; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, count - start) }, (_, offset) => callback(start + offset)));
  }
}

test('email validation preserves accepted addresses and rejects ambiguous or oversized input', () => {
  for (const email of ['person@example.com', 'a+b@example.invalid', 'üser@beispiel.at', 'a@.b.c', 'a@b.c.', `${'a'.repeat(250)}@b.c`]) {
    assert.equal(isValidEmail(email), true, email);
  }
  for (const email of ['', null, 123, '@b.c', 'a@@b.c', 'a@.b', 'a@b.', 'a b@example.com', 'a@b.c\n', `!@!.${'!.'.repeat(124)}@`, `${'a'.repeat(251)}@b.c`]) {
    assert.equal(isValidEmail(email), false, String(email));
  }
});

test('HTTP budgets protect API, body parsing, static files, and shared ingress without breaking ordinary access', async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await request('/api/auth/register', '2001:db8:1111:2200::1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
    })).status, 400);
  }
  assert.equal((await request('/api/auth/register', '2001:db8:1111:22ff::2', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
  })).status, 429, 'IPv6 rotation must not reset the stricter registration budget');
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.equal((await request('/api/auth/login', '2001:db8:1111:3300::1', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'unknown-user', password: 'wrong-password' })
    })).status, 401);
  }
  assert.equal((await request('/api/auth/login', '2001:db8:1111:33ff::2', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'unknown-user', password: 'wrong-password' })
  })).status, 429, 'IPv6 rotation must not reset the failed-password lockout');

  const ipv4 = '203.0.113.10';
  assert.equal((await request('/api/auth/status', ipv4)).status, 200);
  assert.equal((await request('/favicon.png', ipv4)).status, 200);
  assert.equal((await request('/api/auth/me', ipv4)).status, 401);
  await repeat(597, async () => {
    assert.equal((await request('/api/not-a-route', ipv4)).status, 404);
  });
  for (const route of ['/', '/favicon.png', '/api/auth/status', '/api/auth/me']) {
    const blocked = await request(route, ipv4);
    assert.equal(blocked.status, 429, route);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  }
  const blockedMalformedBody = await request('/api/auth/login', ipv4, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{'
  });
  assert.equal(blockedMalformedBody.status, 429, 'limiting precedes JSON parsing');
  assert.equal((await request('/api/auth/status', '203.0.113.11')).status, 200);

  await repeat(600, async () => {
    assert.equal((await request('/api/not-a-route', '2001:db8:1234:5600::1')).status, 404);
  });
  assert.equal((await request('/api/auth/status', '2001:db8:1234:56ff::2')).status, 429, 'rotating IPv6 addresses in the same /56 cannot bypass the limit');
  assert.equal((await request('/api/auth/status', '2001:db8:1234:5700::1')).status, 200);

  // A flood with distinct client addresses must still hit a constant-key server budget.
  await repeat(6000 - requestCount, async index => {
    const ip = `198.18.${Math.floor(index / 256)}.${index % 256}`;
    assert.equal((await request('/api/not-a-route', ip)).status, 404);
  });
  const serverBlocked = await request('/favicon.png', '192.0.2.20');
  assert.equal(serverBlocked.status, 429);
  assert.ok(Number(serverBlocked.headers.get('retry-after')) > 0);
});

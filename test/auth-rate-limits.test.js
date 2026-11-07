import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { startServer, stopServer } from '../server.js';

const password = 'correct-horse-battery-staple';
const salt = crypto.randomBytes(16);
const totpSecret = 'JBSWY3DPEHPK3PXP';
const credentialId = 'ZmFrZS1jcmVkZW50aWFs';
let dataDir;
let baseUrl;
let userId;
let sessionCookie;
let challengeCookie;

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let current = 0;
  const output = [];
  for (const char of value) {
    current = (current << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      output.push((current >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function totpFor(secretValue, time = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 30_000)));
  const digest = crypto.createHmac('sha1', decodeBase32(secretValue)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

function wrongTotp(secretValue) {
  const validCodes = new Set([-30_000, 0, 30_000].map(offset => totpFor(secretValue, Date.now() + offset)));
  for (let candidate = 0; candidate < 1_000_000; candidate++) {
    const code = String(candidate).padStart(6, '0');
    if (!validCodes.has(code)) return code;
  }
  throw new Error('Could not generate an invalid OTP code.');
}

function currentTotp() { return totpFor(totpSecret); }

function cookieValue(response, name) {
  return response.headers.getSetCookie().find(value => value.startsWith(`${name}=`))?.split(';', 1)[0];
}

async function request(route, body, cookie) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body)
  });
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexterm-auth-limit-test-'));
  userId = crypto.randomUUID();
  const passwordHash = crypto.scryptSync(password, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  const workspace = { id: crypto.randomUUID(), name: 'Test Workspace', hosts: [] };
  const user = {
    id: userId,
    name: 'Security test',
    username: 'security-test',
    email: 'security-test@example.invalid',
    role: 'admin',
    passwordSalt: salt.toString('hex'),
    passwordHash,
    theme: 'material-dark',
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    totpEnabled: true,
    totpSecret,
    passkeys: [{ id: crypto.randomUUID(), name: 'Test passkey', enabled: true, credential: { id: credentialId, publicKey: Buffer.alloc(65, 1).toString('base64'), counter: 0, transports: [] } }],
    recoveryCodes: []
  };
  const regularWorkspace = { id: crypto.randomUUID(), name: 'Regular Workspace', hosts: [] };
  const regularUser = {
    ...structuredClone(user),
    id: crypto.randomUUID(),
    name: 'Regular test',
    username: 'regular-test',
    email: 'regular-test@example.invalid',
    role: 'user',
    workspaces: [regularWorkspace],
    activeWorkspaceId: regularWorkspace.id,
    totpEnabled: false,
    passkeys: [],
    recoveryCodes: []
  };
  delete regularUser.totpSecret;
  await fs.writeFile(path.join(dataDir, 'users.json'), JSON.stringify({ users: [user, regularUser] }));
  const server = await startServer({ dataDir, dataKey: Buffer.alloc(32, 7), host: '127.0.0.1', port: 0 });
  baseUrl = server.url;
});

after(async () => {
  await stopServer();
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

test('MFA and account security endpoints enforce bounded, single-use operations', async () => {
  const login = await request('/api/auth/login', { username: 'security-test', password });
  assert.equal(login.status, 200);
  challengeCookie = cookieValue(login, 'nexterm_challenge');
  assert.ok(challengeCookie);

  let passkeyOptions;
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await request('/api/auth/passkeys/login/options', {}, challengeCookie);
    assert.equal(response.status, 200);
    passkeyOptions = await response.json();
  }
  const malformedCredential = { id: credentialId, rawId: credentialId, type: 'public-key', response: {} };
  const rejectedPasskey = await request('/api/auth/passkeys/login/verify', malformedCredential, challengeCookie);
  assert.equal(rejectedPasskey.status, 401);
  const replayedPasskey = await request('/api/auth/passkeys/login/verify', malformedCredential, challengeCookie);
  assert.equal(replayedPasskey.status, 400);
  const exhaustedPasskeyOptions = await request('/api/auth/passkeys/login/options', {}, challengeCookie);
  assert.equal(exhaustedPasskeyOptions.status, 429);
  assert.ok(passkeyOptions.challenge);

  const nextLogin = await request('/api/auth/login', { username: 'security-test', password });
  assert.equal(nextLogin.status, 200);
  challengeCookie = cookieValue(nextLogin, 'nexterm_challenge');
  assert.ok(challengeCookie);
  const factor = await request('/api/auth/verify-factor', { code: currentTotp() }, challengeCookie);
  assert.equal(factor.status, 200);
  sessionCookie = cookieValue(factor, 'nexterm_session');
  assert.ok(sessionCookie);

  const concurrentSetups = await Promise.all([
    request('/api/auth/totp/setup', { currentPassword: password }, sessionCookie),
    request('/api/auth/totp/setup', { currentPassword: password }, sessionCookie)
  ]);
  assert.deepEqual(concurrentSetups.map(response => response.status).sort(), [200, 429]);
  const setupData = await concurrentSetups.find(response => response.status === 200).json();
  const prepared = await request('/api/auth/totp/prepare-enable', { code: totpFor(setupData.secret) }, sessionCookie);
  assert.equal(prepared.status, 200);
  assert.equal((await prepared.json()).codes.length, 10);
  const replayedRecoveryCodes = await request('/api/auth/totp/prepare-enable', { code: '000000' }, sessionCookie);
  assert.equal(replayedRecoveryCodes.status, 409);
  const enabled = await request('/api/auth/totp/enable', { codesSaved: true }, sessionCookie);
  assert.equal(enabled.status, 200);

  const retrySetup = await request('/api/auth/totp/setup', { currentPassword: password }, sessionCookie);
  assert.equal(retrySetup.status, 200);
  const invalidSetupCode = wrongTotp((await retrySetup.json()).secret);
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await request('/api/auth/totp/prepare-enable', { code: invalidSetupCode }, sessionCookie);
    assert.equal(response.status, attempt === 4 ? 429 : 400);
  }
  const exhaustedTotpSetup = await request('/api/auth/totp/prepare-enable', { code: invalidSetupCode }, sessionCookie);
  assert.equal(exhaustedTotpSetup.status, 400);

  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await request('/api/auth/change-password', { currentPassword: 'wrong-password', newPassword: 'new-temporary-password-123' }, sessionCookie);
    assert.equal(response.status, 403);
  }
  const exhaustedPasswordChanges = await request('/api/auth/change-password', { currentPassword: password, newPassword: 'new-temporary-password-123' }, sessionCookie);
  assert.equal(exhaustedPasswordChanges.status, 429);

  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await request('/api/auth/change-email', { email: 'next@example.invalid', currentPassword: 'wrong-password' }, sessionCookie);
    assert.equal(response.status, 403);
  }
  const exhaustedEmailChanges = await request('/api/auth/change-email', { email: 'next@example.invalid', currentPassword: password }, sessionCookie);
  assert.equal(exhaustedEmailChanges.status, 429);

  for (let attempt = 0; attempt < 7; attempt++) {
    const response = await request('/api/auth/totp/setup', { currentPassword: 'wrong-password' }, sessionCookie);
    assert.equal(response.status, 403);
  }
  const exhaustedTotpSetupRequests = await request('/api/auth/totp/setup', { currentPassword: password }, sessionCookie);
  assert.equal(exhaustedTotpSetupRequests.status, 429);

  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await request('/api/auth/passkeys/register/options', { currentPassword: password }, sessionCookie);
    assert.equal(response.status, 200);
  }
  const exhaustedRegistrationOptions = await request('/api/auth/passkeys/register/options', { currentPassword: password }, sessionCookie);
  assert.equal(exhaustedRegistrationOptions.status, 429);

  const rejectedRegistration = await request('/api/auth/passkeys/register/verify', {}, sessionCookie);
  assert.equal(rejectedRegistration.status, 400);
  const consumedRegistrationChallenge = await request('/api/auth/passkeys/register/verify', {}, sessionCookie);
  assert.equal(consumedRegistrationChallenge.status, 400);
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await request('/api/auth/passkeys/register/verify', {}, sessionCookie);
    assert.equal(response.status, 400);
  }
  const exhaustedRegistrationVerification = await request('/api/auth/passkeys/register/verify', {}, sessionCookie);
  assert.equal(exhaustedRegistrationVerification.status, 429);

  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await request('/api/auth/security/disable', { password: 'wrong-password', code: '000000' }, sessionCookie);
    assert.equal(response.status, 403);
  }
  const exhaustedSecurityDisable = await request('/api/auth/security/disable', { password, code: currentTotp() }, sessionCookie);
  assert.equal(exhaustedSecurityDisable.status, 429);

  const regularLogin = await request('/api/auth/login', { username: 'regular-test', password });
  assert.equal(regularLogin.status, 200);
  const regularSessionCookie = cookieValue(regularLogin, 'nexterm_session');
  assert.ok(regularSessionCookie);
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await request(`/api/admin/users/${crypto.randomUUID()}/reset-password`, { adminPassword: password, password: 'temporary-password-123' }, regularSessionCookie);
    assert.equal(response.status, 403);
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await request(`/api/admin/users/${crypto.randomUUID()}/reset-password`, { adminPassword: 'wrong-password', password: 'temporary-password-123' }, sessionCookie);
    assert.equal(response.status, 403);
  }
  const exhaustedAdminReset = await request(`/api/admin/users/${crypto.randomUUID()}/reset-password`, { adminPassword: password, password: 'temporary-password-123' }, sessionCookie);
  assert.equal(exhaustedAdminReset.status, 429);

  for (let attempt = 0; attempt < 120; attempt++) {
    const response = await fetch(`${baseUrl}/health-check-route-${attempt}`);
    assert.equal(response.status, 200);
  }
  const exhaustedSpaFallback = await fetch(`${baseUrl}/health-check-route-over-limit`);
  assert.equal(exhaustedSpaFallback.status, 429);
  const missingApi = await fetch(`${baseUrl}/api/not-a-route`);
  assert.equal(missingApi.status, 404);
});

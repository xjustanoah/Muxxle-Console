import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';
import { startServer, stopServer } from '../server.js';

const { Server: SshServer } = ssh2;

let app;
let sshServer;
let dataDir;
let cookie;
let hostId;
let trustFingerprint;
let pauseAuthentication = false;
let pendingAuthentications = [];
const sshClients = new Set();

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexterm-ssh-session-test-'));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const hostKey = privateKey.export({ format: 'pem', type: 'pkcs1' });

  sshServer = new SshServer({ hostKeys: [hostKey] }, client => {
    sshClients.add(client);
    client.once('close', () => sshClients.delete(client));
    client.on('error', () => {});
    client.on('authentication', context => {
      if (pauseAuthentication) {
        pendingAuthentications.push(context);
        return;
      }
      if (context.method === 'password' && context.password === 'correct-password') context.accept();
      else context.reject();
    });
    client.on('ready', () => {
      client.on('session', accept => {
        const session = accept();
        session.on('pty', acceptPty => acceptPty());
        session.on('shell', acceptShell => {
          const shell = acceptShell();
          shell.write('test shell ready\r\n');
        });
        session.on('exec', acceptExec => {
          const stream = acceptExec();
          stream.write('/home/nexterm');
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  await new Promise((resolve, reject) => {
    sshServer.once('error', reject);
    sshServer.listen(0, '127.0.0.1', () => {
      sshServer.off('error', reject);
      resolve();
    });
  });

  app = await startServer({ dataDir, dataKey: Buffer.alloc(32, 7), host: '127.0.0.1', port: 0, localDesktop: true });
  cookie = `nexterm_session=${encodeURIComponent(app.localSessionToken)}`;
  const hostResponse = await request('/api/hosts', {
    method: 'POST',
    body: { name: 'Test SSH', host: '127.0.0.1', port: sshServer.address().port, username: 'test' }
  });
  assert.equal(hostResponse.status, 201);
  hostId = (await hostResponse.json()).id;

  const fingerprintResponse = await createSshSession('correct-password');
  assert.equal(fingerprintResponse.status, 409);
  const fingerprintBody = await fingerprintResponse.json();
  assert.equal(fingerprintBody.error, 'HOST_KEY');
  trustFingerprint = fingerprintBody.fingerprint;
  const trustedSession = await createSshSession('correct-password');
  assert.equal(trustedSession.status, 201);
  const trustedSessionBody = await trustedSession.json();
  const closedTrustedSession = await request(`/api/sessions/${trustedSessionBody.id}`, { method: 'DELETE' });
  assert.equal(closedTrustedSession.status, 204);
});

after(async () => {
  await stopServer();
  for (const client of sshClients) client.end();
  if (sshServer?.address()) {
    await new Promise(resolve => sshServer.close(resolve));
  }
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

test('limits active and in-flight SSH connections, then allows reconnect after release', { timeout: 30000 }, async () => {
  pauseAuthentication = true;
  pendingAuthentications = [];
  const inFlightRequests = Array.from({ length: 5 }, () => createSshSession('correct-password'));
  await waitFor(() => pendingAuthentications.length === 5);

  const overflowWhileConnecting = await createSshSession('correct-password');
  assert.equal(overflowWhileConnecting.status, 429);
  assert.match((await overflowWhileConnecting.json()).error, /Zu viele gleichzeitige SSH-Sitzungen/);

  pauseAuthentication = false;
  for (const context of pendingAuthentications.splice(0)) context.accept();
  const establishedResponses = await Promise.all(inFlightRequests);
  const established = await Promise.all(establishedResponses.map(async response => ({ status: response.status, body: await response.json() })));
  assert.deepEqual(established.map(result => result.status), [201, 201, 201, 201, 201], JSON.stringify(established));

  const overflowWhileActive = await createSshSession('correct-password');
  assert.equal(overflowWhileActive.status, 429);

  const deleted = await request(`/api/sessions/${established[0].body.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 204);

  const failedAuthentication = await createSshSession('wrong-password');
  assert.equal(failedAuthentication.status, 422);
  const reconnect = await createSshSession('correct-password');
  assert.equal(reconnect.status, 201);
  const reconnectBody = await reconnect.json();
  for (const session of [...established.slice(1).map(result => result.body), reconnectBody]) {
    const response = await request(`/api/sessions/${session.id}`, { method: 'DELETE' });
    assert.equal(response.status, 204);
  }
});

async function createSshSession(password) {
  return request('/api/sessions', {
    method: 'POST',
    body: { hostId, auth: { method: 'password', password, trustFingerprint } }
  });
}

async function request(route, { method = 'GET', body } = {}) {
  return fetch(`${app.url}${route}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out while waiting for pending SSH authentication attempts.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

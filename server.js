import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import { Client } from 'ssh2';
import { WebSocketServer, WebSocket } from 'ws';

const DEFAULT_PORT = Number(process.env.PORT || 4783);
const DEFAULT_HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
let DATA_DIR = process.env.NEXTERM_DATA_DIR || path.join(os.homedir(), '.nexterm');
let USERS_FILE = path.join(DATA_DIR, 'users.json');
let HOSTS_FILE = path.join(DATA_DIR, 'hosts.json');
let DATA_KEY = process.env.NEXTERM_DATA_KEY ? Buffer.from(process.env.NEXTERM_DATA_KEY, 'hex') : null;
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const sessions = new Map();
const loginSessions = new Map();
const loginAttempts = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const STORE_FORMAT = 'nexterm-encrypted-json';
let activeHost = DEFAULT_HOST;
let activePort = DEFAULT_PORT;
let serverStarted = false;

if (DATA_KEY && DATA_KEY.length !== 32) throw new Error('NEXTERM_DATA_KEY muss ein 32-Byte-Hexschlüssel sein.');

function encodeStoredJson(value) {
  const plaintext = JSON.stringify(value, null, 2);
  if (!DATA_KEY) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', DATA_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return JSON.stringify({
    format: STORE_FORMAT,
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64')
  });
}

function decodeStoredJson(content) {
  const parsed = JSON.parse(content);
  if (parsed?.format !== STORE_FORMAT) return parsed;
  if (!DATA_KEY || parsed.version !== 1) throw new Error('Der verschlüsselte lokale Tresor kann mit diesem Schlüssel nicht geöffnet werden.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', DATA_KEY, Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final()
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

async function writeStoredJson(filePath, value) {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(DATA_DIR, 0o700);
  const tempFile = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempFile, encodeStoredJson(value), { mode: 0o600 });
  await fs.rename(tempFile, filePath);
  if (process.platform !== 'win32') await fs.chmod(filePath, 0o600);
}

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.use(express.json({ limit: '1mb' }));
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

async function readData() {
  try {
    const content = await fs.readFile(USERS_FILE, 'utf8');
    const parsed = decodeStoredJson(content);
    return parsed && Array.isArray(parsed.users) ? parsed : { users: [] };
  } catch (error) {
    if (error.code === 'ENOENT') return { users: [] };
    throw error;
  }
}

async function writeData(data) {
  await writeStoredJson(USERS_FILE, data);
}

function derivePassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derived) => error ? reject(error) : resolve(derived));
  });
}

function publicUser(user) {
  return { id: user.id, username: user.username, name: user.name };
}

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(cookieHeader.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const separator = part.indexOf('=');
    if (separator < 0) return [part, ''];
    const value = part.slice(separator + 1);
    try { return [part.slice(0, separator), decodeURIComponent(value)]; }
    catch { return [part.slice(0, separator), '']; }
  }));
}

function issueLoginSession(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  loginSessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `nexterm_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
  return publicUser(user);
}

function requireSameOrigin(req, res, next) {
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    const originUrl = new URL(origin);
    const requestHost = req.get('host');
    if (originUrl.host !== requestHost || originUrl.protocol !== `${req.protocol}:`) {
      return res.status(403).json({ error: 'Anfrageursprung wurde abgelehnt.' });
    }
    next();
  } catch {
    res.status(403).json({ error: 'Anfrageursprung wurde abgelehnt.' });
  }
}

async function requireAuth(req, res, next) {
  const token = parseCookies(req.headers.cookie).nexterm_session;
  const session = token && loginSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) loginSessions.delete(token);
    if (session) closeUserSshSessionsIfLoggedOut(session.userId);
    res.setHeader('Set-Cookie', 'nexterm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return res.status(401).json({ error: 'Bitte melde dich erneut an.' });
  }
  try {
    const data = await readData();
    const user = data.users.find(entry => entry.id === session.userId);
    if (!user) {
      loginSessions.delete(token);
      closeUserSshSessionsIfLoggedOut(session.userId);
      return res.status(401).json({ error: 'Konto wurde nicht gefunden.' });
    }
    req.loginToken = token;
    req.loginSession = session;
    req.data = data;
    req.user = user;
    next();
  } catch {
    res.status(500).json({ error: 'Kontodaten konnten nicht gelesen werden.' });
  }
}

function closeUserSshSessions(userId) {
  for (const sshSession of sessions.values()) {
    if (sshSession.userId !== userId) continue;
    sessions.delete(sshSession.id);
    sshSession.closed = true;
    sshSession.client.end();
  }
}

function closeUserSshSessionsIfLoggedOut(userId) {
  const stillLoggedIn = [...loginSessions.values()].some(session => session.userId === userId && session.expiresAt > Date.now());
  if (!stillLoggedIn) closeUserSshSessions(userId);
}

const authExpiryTimer = setInterval(() => {
  for (const [token, session] of loginSessions) {
    if (session.expiresAt > Date.now()) continue;
    loginSessions.delete(token);
    closeUserSshSessionsIfLoggedOut(session.userId);
  }
  for (const [key, attempt] of loginAttempts) {
    if (attempt.updatedAt && Date.now() - attempt.updatedAt > 24 * 60 * 60 * 1000) loginAttempts.delete(key);
  }
}, 60_000);
authExpiryTimer.unref();

async function readLegacyHosts() {
  try {
    const content = await fs.readFile(HOSTS_FILE, 'utf8');
    const hosts = decodeStoredJson(content);
    return Array.isArray(hosts) ? hosts : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function encryptExistingLocalFiles() {
  if (!DATA_KEY) return;
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  for (const filePath of [USERS_FILE, HOSTS_FILE]) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed?.format === STORE_FORMAT) {
        decodeStoredJson(content);
        continue;
      }
      await writeStoredJson(filePath, parsed);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function importLegacyLocalFiles(legacyDir) {
  if (!legacyDir || path.resolve(legacyDir) === path.resolve(DATA_DIR)) return;
  for (const filename of ['users.json', 'hosts.json']) {
    const target = path.join(DATA_DIR, filename);
    try { await fs.access(target); continue; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try {
      const value = JSON.parse(await fs.readFile(path.join(legacyDir, filename), 'utf8'));
      if (value?.format === STORE_FORMAT) continue;
      await writeStoredJson(target, value);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function publicHost(host) {
  const { id, name, host: address, port, username, fingerprint } = host;
  return { id, name, host: address, port, username, fingerprint: fingerprint || null };
}

function getSession(id, res, userId) {
  const session = sessions.get(id);
  if (!session || session.closed || session.userId !== userId) {
    res.status(404).json({ error: 'Die SSH-Sitzung ist nicht mehr aktiv.' });
    return null;
  }
  return session;
}

function sshExec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let output = '';
      let stderr = '';
      stream.on('data', chunk => { output += chunk.toString(); });
      stream.stderr.on('data', chunk => { stderr += chunk.toString(); });
      stream.on('close', code => {
        if (code !== 0) reject(new Error(stderr.trim() || `Remote command exited with ${code}`));
        else resolve(output.trim());
      });
    });
  });
}

function fingerprintOf(key) {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function sshOptions(profile, auth, onCandidate) {
  const options = {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    readyTimeout: 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
    hostVerifier: key => {
      const fingerprint = fingerprintOf(key);
      onCandidate(fingerprint);
      if (auth.trustFingerprint && auth.trustFingerprint === fingerprint) return true;
      return Boolean(profile.fingerprint && profile.fingerprint === fingerprint);
    }
  };
  if (auth.method === 'key') {
    if (!auth.privateKey) throw new Error('Bitte wähle einen privaten SSH-Schlüssel aus.');
    options.privateKey = auth.privateKey;
    if (auth.passphrase) options.passphrase = auth.passphrase;
  } else {
    if (!auth.password) throw new Error('Bitte gib dein SSH-Passwort ein.');
    options.password = auth.password;
  }
  return options;
}

function connectSsh(profile, auth) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let candidateFingerprint = null;
    let settled = false;
    const finishError = error => {
      if (settled) return;
      settled = true;
      client.end();
      if (candidateFingerprint && candidateFingerprint !== profile.fingerprint && candidateFingerprint !== auth.trustFingerprint) {
        const hostKeyError = new Error('HOST_KEY');
        hostKeyError.fingerprint = candidateFingerprint;
        hostKeyError.changed = Boolean(profile.fingerprint);
        reject(hostKeyError);
      } else reject(error);
    };

    try {
      client.connect(sshOptions(profile, auth, value => { candidateFingerprint = value; }));
    } catch (error) {
      finishError(error);
      return;
    }

    client.once('ready', () => {
      client.shell({ term: 'xterm-256color', cols: 110, rows: 30 }, async (shellError, shell) => {
        if (shellError) return finishError(shellError);
        let home = '/';
        try { home = (await sshExec(client, 'printf %s "$HOME"')) || '/'; } catch {}
        if (settled) return;
        settled = true;
        resolve({ client, shell, home, fingerprint: candidateFingerprint });
      });
    });
    client.once('error', finishError);
    client.once('close', () => {
      if (!settled) finishError(new Error('Die Verbindung wurde geschlossen.'));
    });
  });
}

app.use('/api/auth', requireSameOrigin);

app.get('/api/auth/status', async (_req, res) => {
  try { res.json({ hasAccounts: (await readData()).users.length > 0 }); }
  catch { res.status(500).json({ error: 'Kontostatus konnte nicht gelesen werden.' }); }
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json(publicUser(req.user)));

app.post('/api/auth/register', async (req, res) => {
  const { name, username, password } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) {
    return res.status(400).json({ error: 'Bitte gib einen Namen mit maximal 60 Zeichen ein.' });
  }
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,32}$/.test(username.trim())) {
    return res.status(400).json({ error: 'Der Benutzername muss 3–32 Zeichen lang sein und darf Buchstaben, Zahlen, Punkt, Bindestrich oder Unterstrich enthalten.' });
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    return res.status(400).json({ error: 'Das Passwort muss mindestens 12 Zeichen lang sein.' });
  }
  try {
    const data = await readData();
    const normalizedUsername = username.trim().toLowerCase();
    if (data.users.some(user => user.username === normalizedUsername)) {
      return res.status(409).json({ error: 'Dieser Benutzername ist bereits vergeben.' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = (await derivePassword(password, Buffer.from(salt, 'hex'))).toString('hex');
    let hosts = [];
    if (data.users.length === 0) hosts = await readLegacyHosts();
    const user = {
      id: crypto.randomUUID(),
      name: name.trim(),
      username: normalizedUsername,
      passwordSalt: salt,
      passwordHash,
      hosts
    };
    data.users.push(user);
    await writeData(data);
    res.status(201).json({ user: issueLoginSession(req, res, user) });
  } catch {
    res.status(500).json({ error: 'Konto konnte nicht angelegt werden.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const identifier = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (password.length > 256) return res.status(400).json({ error: 'Das Passwort ist zu lang.' });
  const attemptKey = `${req.ip || 'local'}:${identifier}`;
  const attempt = loginAttempts.get(attemptKey);
  if (attempt?.blockedUntil > Date.now()) {
    return res.status(429).json({ error: 'Zu viele Versuche. Bitte warte 15 Minuten und versuche es erneut.' });
  }
  try {
    const data = await readData();
    const user = data.users.find(entry => entry.username === identifier);
    const salt = user?.passwordSalt ? Buffer.from(user.passwordSalt, 'hex') : Buffer.alloc(16);
    const candidate = await derivePassword(password, salt);
    const expected = user?.passwordHash ? Buffer.from(user.passwordHash, 'hex') : Buffer.alloc(64);
    const valid = Boolean(user && expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected));
    if (!valid) {
      const next = loginAttempts.get(attemptKey) || { count: 0, blockedUntil: 0 };
      next.count++;
      next.updatedAt = Date.now();
      if (next.count >= LOGIN_MAX_ATTEMPTS) {
        next.count = 0;
        next.blockedUntil = Date.now() + LOGIN_LOCK_MS;
      }
      loginAttempts.set(attemptKey, next);
      return res.status(401).json({ error: 'Benutzername oder Passwort stimmen nicht.' });
    }
    loginAttempts.delete(attemptKey);
    res.json({ user: issueLoginSession(req, res, user) });
  } catch {
    res.status(500).json({ error: 'Anmeldung gerade nicht möglich.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).nexterm_session;
  const session = token && loginSessions.get(token);
  if (session) {
    loginSessions.delete(token);
    closeUserSshSessions(session.userId);
  }
  res.setHeader('Set-Cookie', 'nexterm_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.status(204).end();
});

app.use(['/api/hosts', '/api/sessions'], requireSameOrigin, requireAuth);

app.get('/api/hosts', (req, res) => res.json((req.user.hosts || []).map(publicHost)));

app.post('/api/hosts', async (req, res) => {
  const { name, host, port, username } = req.body || {};
  if (![name, host, username].every(value => typeof value === 'string' && value.trim())) {
    return res.status(400).json({ error: 'Name, Host und Benutzername sind erforderlich.' });
  }
  const parsedPort = Number(port || 22);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    return res.status(400).json({ error: 'Der SSH-Port muss zwischen 1 und 65535 liegen.' });
  }
  try {
    const hostProfile = {
      id: crypto.randomUUID(), name: name.trim(), host: host.trim(),
      port: parsedPort, username: username.trim(), fingerprint: null
    };
    req.user.hosts ||= [];
    req.user.hosts.push(hostProfile);
    await writeData(req.data);
    res.status(201).json(publicHost(hostProfile));
  } catch {
    res.status(500).json({ error: 'Der Server konnte nicht gespeichert werden.' });
  }
});

app.delete('/api/hosts/:id', async (req, res) => {
  try {
    const hosts = req.user.hosts || [];
    const next = hosts.filter(host => host.id !== req.params.id);
    if (next.length === hosts.length) return res.status(404).json({ error: 'Server nicht gefunden.' });
    req.user.hosts = next;
    await writeData(req.data);
    for (const session of sessions.values()) {
      if (session.userId === req.user.id && session.host.id === req.params.id) {
        sessions.delete(session.id);
        session.closed = true;
        session.client.end();
      }
    }
    res.status(204).end();
  } catch { res.status(500).json({ error: 'Der Server konnte nicht entfernt werden.' }); }
});

app.post('/api/sessions', async (req, res) => {
  const { hostId, auth = {} } = req.body || {};
  if (!hostId || !['password', 'key'].includes(auth.method)) {
    return res.status(400).json({ error: 'Server oder Anmeldemethode fehlt.' });
  }
  let connected;
  try {
    const profile = (req.user.hosts || []).find(host => host.id === hostId);
    if (!profile) return res.status(404).json({ error: 'Serverprofil nicht gefunden.' });
    try { connected = await connectSsh(profile, auth); }
    catch (error) {
      if (error.fingerprint) return res.status(409).json({ error: 'HOST_KEY', fingerprint: error.fingerprint, changed: error.changed });
      return res.status(401).json({ error: error.message || 'SSH-Verbindung fehlgeschlagen.' });
    }

    if (connected.fingerprint && profile.fingerprint !== connected.fingerprint) {
      profile.fingerprint = connected.fingerprint;
      await writeData(req.data);
    }
    const id = crypto.randomUUID();
    const session = { id, userId: req.user.id, host: publicHost(profile), ...connected, socket: null, buffer: [], closed: false, previousMetrics: null };
    sessions.set(id, session);
    session.shell.on('data', data => {
      if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(data);
      else {
        session.buffer.push(data);
        let bufferedBytes = session.buffer.reduce((total, chunk) => total + chunk.length, 0);
        while (bufferedBytes > 1024 * 1024 && session.buffer.length) bufferedBytes -= session.buffer.shift().length;
      }
    });
    session.shell.on('close', () => {
      if (session.socket?.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: 'closed' }));
    });
    session.client.on('close', () => {
      session.closed = true;
      sessions.delete(id);
      if (session.socket?.readyState === WebSocket.OPEN) {
        session.socket.send(JSON.stringify({ type: 'closed' }));
        session.socket.close();
      }
    });
    res.status(201).json({ id, host: session.host, home: session.home });
  } catch (error) {
    connected?.client.end();
    res.status(500).json({ error: error.message || 'Verbindung konnte nicht eingerichtet werden.' });
  }
});

app.get('/api/sessions', (req, res) => {
  res.json([...sessions.values()].filter(session => !session.closed && session.userId === req.user.id).map(session => ({ id: session.id, host: session.host, home: session.home })));
});

app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (session && session.userId !== req.user.id) return res.status(404).json({ error: 'SSH-Sitzung nicht gefunden.' });
  if (session) {
    sessions.delete(session.id);
    session.closed = true;
    session.client.end();
  }
  res.status(204).end();
});

app.get('/api/sessions/:id/files', async (req, res) => {
  const session = getSession(req.params.id, res, req.user.id);
  if (!session) return;
  const remotePath = typeof req.query.path === 'string' ? req.query.path : session.home;
  session.client.sftp((error, sftp) => {
    if (error) return res.status(502).json({ error: 'SFTP konnte nicht gestartet werden.' });
    sftp.readdir(remotePath, (listError, entries) => {
      if (listError) return res.status(400).json({ error: listError.message });
      const files = entries.filter(entry => entry.filename !== '.' && entry.filename !== '..').map(entry => ({
        name: entry.filename,
        type: (entry.attrs.mode & 0o170000) === 0o040000 ? 'directory' : 'file',
        size: entry.attrs.size,
        modified: entry.attrs.mtime
      })).sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
      sftp.end();
      res.json({ path: remotePath, parent: path.posix.dirname(remotePath), files });
    });
  });
});

app.get('/api/sessions/:id/download', (req, res) => {
  const session = getSession(req.params.id, res, req.user.id);
  if (!session) return;
  const remotePath = typeof req.query.path === 'string' ? req.query.path : '';
  if (!remotePath) return res.status(400).json({ error: 'Dateipfad fehlt.' });
  session.client.sftp((error, sftp) => {
    if (error) return res.status(502).json({ error: 'SFTP konnte nicht gestartet werden.' });
    const stream = sftp.createReadStream(remotePath);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(remotePath))}`);
    stream.on('error', streamError => {
      if (!res.headersSent) res.status(404).json({ error: streamError.message });
      else res.destroy(streamError);
      sftp.end();
    });
    stream.on('close', () => sftp.end());
    stream.pipe(res);
  });
});

app.post('/api/sessions/:id/upload', (req, res) => {
  const session = getSession(req.params.id, res, req.user.id);
  if (!session) return;
  const remotePath = typeof req.query.path === 'string' ? req.query.path : '';
  if (!remotePath) return res.status(400).json({ error: 'Zielpfad fehlt.' });
  session.client.sftp((error, sftp) => {
    if (error) return res.status(502).json({ error: 'SFTP konnte nicht gestartet werden.' });
    const stream = sftp.createWriteStream(remotePath, { flags: 'w', mode: 0o644 });
    stream.on('error', streamError => {
      sftp.end();
      if (!res.headersSent) res.status(400).json({ error: streamError.message });
    });
    stream.on('close', () => {
      sftp.end();
      if (!res.headersSent) res.status(201).json({ ok: true });
    });
    req.on('aborted', () => { stream.destroy(); sftp.end(); });
    req.pipe(stream);
  });
});

function parseMetrics(raw) {
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const [key, ...parts] = line.trim().split(/\s+/);
    if (key) values[key] = parts.map(Number);
  }
  const cpu = values.cpu || [];
  const total = cpu.reduce((sum, part) => sum + part, 0);
  const idle = (cpu[3] || 0) + (cpu[4] || 0);
  const memTotal = values.mem?.[0] || 0;
  const memAvailable = values.mem?.[1] || 0;
  const disk = values.disk || [0, 0, 0];
  const network = values.net || [0, 0];
  return { total, idle, memory: { total: memTotal * 1024, used: Math.max(0, (memTotal - memAvailable) * 1024) }, disk: { total: disk[0] * 1024, used: disk[1] * 1024 }, network };
}

app.get('/api/sessions/:id/metrics', async (req, res) => {
  const session = getSession(req.params.id, res, req.user.id);
  if (!session) return;
  const command = "printf 'cpu '; awk '$1==\"cpu\"{for(i=2;i<=9;i++) printf \"%s \",$i; print \"\"}' /proc/stat; awk '/MemTotal:/{t=$2}/MemAvailable:/{a=$2}END{printf \"mem %s %s\\n\",t,a}' /proc/meminfo; df -Pk / | awk 'END{printf \"disk %s %s %s\\n\",$2,$3,$4}'; awk 'NR>2{gsub(/:/,\"\",$1);if($1!=\"lo\"){rx+=$2;tx+=$10}}END{printf \"net %.0f %.0f\\n\",rx,tx}' /proc/net/dev";
  try {
    const raw = await sshExec(session.client, command);
    const now = Date.now();
    const current = parseMetrics(raw);
    const previous = session.previousMetrics;
    let cpu = null;
    let rxRate = null;
    let txRate = null;
    if (previous) {
      const totalDelta = current.total - previous.total;
      const idleDelta = current.idle - previous.idle;
      if (totalDelta > 0) cpu = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
      const seconds = Math.max(0.25, (now - previous.at) / 1000);
      rxRate = Math.max(0, (current.network[0] - previous.network[0]) / seconds);
      txRate = Math.max(0, (current.network[1] - previous.network[1]) / seconds);
    }
    session.previousMetrics = { ...current, at: now };
    const diskPercent = current.disk.total ? current.disk.used / current.disk.total * 100 : 0;
    const memoryPercent = current.memory.total ? current.memory.used / current.memory.total * 100 : 0;
    res.json({ at: now, cpu, memory: { ...current.memory, percent: memoryPercent }, disk: { ...current.disk, percent: diskPercent }, network: { rx: rxRate, tx: txRate } });
  } catch {
    res.status(501).json({ error: 'Linux-Statistiken über /proc sind auf diesem Server nicht verfügbar.' });
  }
});

const distPath = path.join(ROOT, 'dist');
try {
  await fs.access(distPath);
  app.use(express.static(distPath));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
} catch {}

server.on('upgrade', (request, socket, head) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || `${activeHost}:${activePort}`}`);
  if (requestUrl.pathname !== '/terminal') return socket.destroy();
  const origin = request.headers.origin;
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const forwardedProtocol = process.env.TRUST_PROXY === '1' ? String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
      const expectedProtocol = forwardedProtocol ? `${forwardedProtocol}:` : 'http:';
      if (originUrl.host !== request.headers.host || originUrl.protocol !== expectedProtocol) return socket.destroy();
    } catch { return socket.destroy(); }
  }
  const token = parseCookies(request.headers.cookie).nexterm_session;
  const loginSession = token && loginSessions.get(token);
  if (!loginSession || loginSession.expiresAt <= Date.now()) return socket.destroy();
  const session = sessions.get(requestUrl.searchParams.get('id'));
  if (!session || session.closed || session.userId !== loginSession.userId) return socket.destroy();
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request, session));
});

wss.on('connection', (ws, _request, session) => {
  if (session.socket?.readyState === WebSocket.OPEN) session.socket.close();
  session.socket = ws;
  for (const chunk of session.buffer.splice(0)) if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  ws.on('message', (data, isBinary) => {
    const message = data.toString();
    if (!isBinary && message.startsWith('{')) {
      try {
        const payload = JSON.parse(message);
        if (payload.type === 'resize' && Number.isInteger(payload.cols) && Number.isInteger(payload.rows)) {
          session.shell.setWindow(payload.rows, payload.cols, 0, 0);
        }
        return;
      } catch {}
    }
    session.shell.write(data);
  });
  ws.on('close', () => { if (session.socket === ws) session.socket = null; });
});

export async function startServer(options = {}) {
  if (serverStarted) throw new Error('Der NexTerm-Dienst wurde bereits gestartet.');
  if (options.dataDir) DATA_DIR = options.dataDir;
  USERS_FILE = path.join(DATA_DIR, 'users.json');
  HOSTS_FILE = path.join(DATA_DIR, 'hosts.json');
  if (options.dataKey !== undefined) {
    DATA_KEY = Buffer.isBuffer(options.dataKey) ? Buffer.from(options.dataKey) : Buffer.from(String(options.dataKey), 'hex');
    if (DATA_KEY.length !== 32) throw new Error('Der lokale Tresorschlüssel muss 32 Byte lang sein.');
  }
  activeHost = options.host || DEFAULT_HOST;
  activePort = options.port ?? DEFAULT_PORT;
  await importLegacyLocalFiles(options.legacyDataDir);
  await encryptExistingLocalFiles();
  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(activePort, activeHost, () => {
      server.off('error', onError);
      resolve();
    });
  });
  serverStarted = true;
  const address = server.address();
  return { host: activeHost, port: address.port, url: `http://${activeHost}:${address.port}` };
}

export async function stopServer() {
  if (!serverStarted) return;
  for (const session of sessions.values()) session.client.end();
  sessions.clear();
  loginSessions.clear();
  await new Promise(resolve => server.close(resolve));
  serverStarted = false;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer()
    .then(({ url }) => console.log(`NexTerm Desk läuft auf ${url}`))
    .catch(error => { console.error(error); process.exitCode = 1; });
  const shutdown = () => stopServer().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

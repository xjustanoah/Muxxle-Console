import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import express from 'express';
import { Client } from 'ssh2';
import { WebSocketServer, WebSocket } from 'ws';
import nodemailer from 'nodemailer';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from '@simplewebauthn/server';

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
const loginChallenges = new Map();
const webAuthnChallenges = new Map();
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const STORE_FORMAT = 'nexterm-encrypted-json';
const ACCOUNT_THEMES = new Set(['material-dark', 'material-white', 'muxxle']);
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
    const data = parsed && Array.isArray(parsed.users) ? parsed : { users: [] };
    let changed = false;
    const configuredAdmin = String(process.env.NEXTERM_ADMIN_USERNAME || '').trim().toLowerCase();
    for (let index = 0; index < data.users.length; index++) {
      const user = data.users[index];
      if (!Array.isArray(user.workspaces)) {
        const hosts = Array.isArray(user.hosts) ? user.hosts : [];
        user.workspaces = [{ id: crypto.randomUUID(), name: 'Mein Workspace', hosts }];
        user.activeWorkspaceId = user.workspaces[0].id;
        delete user.hosts;
        changed = true;
      }
      if (!user.workspaces.length) {
        user.workspaces.push({ id: crypto.randomUUID(), name: 'Mein Workspace', hosts: [] });
        changed = true;
      }
      for (const workspace of user.workspaces) {
        workspace.hosts = Array.isArray(workspace.hosts) ? workspace.hosts : [];
        workspace.id ||= crypto.randomUUID();
        workspace.name ||= 'Workspace';
      }
      if (!user.workspaces.some(workspace => workspace.id === user.activeWorkspaceId)) {
        user.activeWorkspaceId = user.workspaces[0].id;
        changed = true;
      }
      if (!user.role && ((configuredAdmin && user.username === configuredAdmin) || (!configuredAdmin && index === 0))) {
        user.role = 'admin';
        changed = true;
      }
      user.role ||= 'user';
      user.email ||= '';
      if (!ACCOUNT_THEMES.has(user.theme)) {
        user.theme = 'material-dark';
        changed = true;
      }
      user.passkeys ||= [];
      user.recoveryCodes ||= [];
    }
    if (configuredAdmin && data.users.length && !data.users.some(user => user.username === configuredAdmin) && !data.users.some(user => user.role === 'admin')) {
      data.users[0].role = 'admin';
      changed = true;
    }
    if (changed) await writeData(data);
    return data;
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

async function verifyAccountPassword(user, password) {
  const value = String(password || '');
  if (!value || value.length > 256) return false;
  const candidate = await derivePassword(value, Buffer.from(user.passwordSalt, 'hex'));
  const stored = Buffer.from(user.passwordHash, 'hex');
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

function publicUser(user) {
  return { id: user.id, username: user.username, name: user.name, email: user.email || '', role: user.role || 'user', mustChangePassword: Boolean(user.mustChangePassword), theme: ACCOUNT_THEMES.has(user.theme) ? user.theme : 'material-dark' };
}

function activeWorkspace(user) {
  user.workspaces ||= [{ id: crypto.randomUUID(), name: 'Mein Workspace', hosts: [] }];
  user.activeWorkspaceId ||= user.workspaces[0].id;
  return user.workspaces.find(workspace => workspace.id === user.activeWorkspaceId) || user.workspaces[0];
}

function setCookie(req, res, name, value, maxAge) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearCookie(res, name) {
  res.append('Set-Cookie', `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
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
  setCookie(req, res, 'nexterm_session', token, Math.floor(SESSION_TTL_MS / 1000));
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
    clearCookie(res, 'nexterm_session');
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

function closeSshSession(sshSession) {
  sessions.delete(sshSession.id);
  sshSession.closed = true;
  sshSession.client.end();
}

function closeUserSshSessions(userId) {
  for (const sshSession of sessions.values()) if (sshSession.userId === userId) closeSshSession(sshSession);
}

function closeUserSshSessionsExcept(userId, loginToken) {
  for (const sshSession of sessions.values()) if (sshSession.userId === userId && sshSession.loginToken !== loginToken) closeSshSession(sshSession);
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

function getSession(id, res, userId, workspaceId, loginToken) {
  const session = sessions.get(id);
  if (!session || session.closed || session.userId !== userId || (workspaceId && session.workspaceId !== workspaceId) || (loginToken && session.loginToken !== loginToken)) {
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

const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buffer) {
  let bits = 0, value = 0, output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { output += base32Alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(value) {
  let bits = 0, current = 0;
  const output = [];
  for (const char of String(value).toUpperCase().replace(/=+$/, '').replace(/\s/g, '')) {
    const index = base32Alphabet.indexOf(char);
    if (index < 0) throw new Error('Ungültiger TOTP-Schlüssel.');
    current = (current << 5) | index;
    bits += 5;
    if (bits >= 8) { output.push((current >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}

function totpCode(secret, time = Date.now()) {
  const counter = BigInt(Math.floor(time / 30000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

function verifyTotp(secret, code) {
  if (!secret || !/^\d{6}$/.test(String(code || ''))) return false;
  for (const drift of [-30000, 0, 30000]) {
    const expected = Buffer.from(totpCode(secret, Date.now() + drift));
    const supplied = Buffer.from(String(code));
    if (expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied)) return true;
  }
  return false;
}

function normalizeRecoveryCode(value) { return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase(); }
function hashRecoveryCode(value) { return crypto.createHash('sha256').update(normalizeRecoveryCode(value)).digest('hex'); }
function makeRecoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const raw = crypto.randomBytes(8).toString('hex');
    return { code: `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12)}`, hash: hashRecoveryCode(raw) };
  });
}

function consumeRecoveryCode(user, supplied) {
  const hash = hashRecoveryCode(supplied);
  const index = (user.recoveryCodes || []).findIndex(candidate => {
    const stored = Buffer.from(candidate, 'hex');
    const actual = Buffer.from(hash, 'hex');
    return stored.length === actual.length && crypto.timingSafeEqual(stored, actual);
  });
  if (index < 0) return false;
  user.recoveryCodes.splice(index, 1);
  return true;
}

function authChallengeFromRequest(req, res) {
  const token = parseCookies(req.headers.cookie).nexterm_challenge;
  const challenge = token && loginChallenges.get(token);
  if (!challenge || challenge.expiresAt <= Date.now()) {
    if (token) loginChallenges.delete(token);
    clearCookie(res, 'nexterm_challenge');
    return null;
  }
  return { token, challenge };
}

function setLoginChallenge(req, res, user) {
  const token = crypto.randomBytes(32).toString('base64url');
  const activePasskeys = (user.passkeys || []).filter(entry => entry.enabled);
  loginChallenges.set(token, { userId: user.id, attempts: 0, expiresAt: Date.now() + 5 * 60 * 1000 });
  setCookie(req, res, 'nexterm_challenge', token, 300);
  return { factorRequired: true, methods: { otp: Boolean(user.totpEnabled), passkey: activePasskeys.length > 0, recovery: Boolean(user.totpEnabled || activePasskeys.length) } };
}

function getWebAuthnContext(req) {
  const host = req.get('host');
  const protocol = req.protocol;
  const origin = process.env.NEXTERM_WEBAUTHN_ORIGIN || `${protocol}://${host}`;
  const parsed = new URL(origin);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' && !local) throw new Error('Passkeys benötigen eine HTTPS-Verbindung.');
  return { rpID: process.env.NEXTERM_WEBAUTHN_RP_ID || parsed.hostname, origin };
}

async function sendPasswordResetMail(user, link) {
  const { SMTP_HOST, SMTP_PORT = '587', SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_FROM) throw new Error('SMTP_HOST und SMTP_FROM müssen für den E-Mail-Versand gesetzt sein.');
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: SMTP_SECURE === '1',
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS || '' } : undefined
  });
  await transporter.sendMail({ from: SMTP_FROM, to: user.email, subject: 'NexTerm Desk Passwort zurücksetzen', text: `Hallo ${user.name},\n\nüber diesen Link kannst du dein Passwort zurücksetzen. Der Link ist 30 Minuten gültig:\n${link}\n\nWenn du diese Anfrage nicht gestellt hast, ignoriere diese Nachricht.` });
}

function passwordResetEnabled() {
  return process.env.NEXTERM_PASSWORD_RESET_ENABLED === '1' && Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

async function finishPasswordLogin(req, res, user) {
  const hasActivePasskey = (user.passkeys || []).some(entry => entry.enabled);
  if (user.totpEnabled || hasActivePasskey) return res.json(setLoginChallenge(req, res, user));
  res.json({ user: issueLoginSession(req, res, user) });
}

app.get('/api/auth/status', async (_req, res) => {
  try { res.json({ hasAccounts: (await readData()).users.length > 0, passwordResetEnabled: passwordResetEnabled() }); }
  catch { res.status(500).json({ error: 'Kontostatus konnte nicht gelesen werden.' }); }
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json(publicUser(req.user)));

app.post('/api/auth/register', async (req, res) => {
  const { name, username, password, email } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) {
    return res.status(400).json({ error: 'Bitte gib einen Namen mit maximal 60 Zeichen ein.' });
  }
  if (typeof username !== 'string' || !/^[a-zA-Z0-9._-]{3,32}$/.test(username.trim())) {
    return res.status(400).json({ error: 'Der Benutzername muss 3–32 Zeichen lang sein und darf Buchstaben, Zahlen, Punkt, Bindestrich oder Unterstrich enthalten.' });
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    return res.status(400).json({ error: 'Das Passwort muss mindestens 12 Zeichen lang sein.' });
  }
  if (typeof email !== 'string' || email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Bitte gib eine gültige E-Mail-Adresse ein.' });
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
    const workspace = { id: crypto.randomUUID(), name: 'Mein Workspace', hosts };
    const user = {
      id: crypto.randomUUID(),
      name: name.trim(),
      username: normalizedUsername,
      email: email.trim().toLowerCase(),
      passwordSalt: salt,
      passwordHash,
      role: data.users.length === 0 ? 'admin' : 'user',
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
      passkeys: [],
      recoveryCodes: []
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
    return finishPasswordLogin(req, res, user);
  } catch {
    res.status(500).json({ error: 'Anmeldung gerade nicht möglich.' });
  }
});

app.post('/api/auth/verify-factor', async (req, res) => {
  const current = authChallengeFromRequest(req, res);
  if (!current) return res.status(401).json({ error: 'Die Anmeldebestätigung ist abgelaufen. Bitte melde dich erneut an.' });
  if (current.challenge.attempts >= 5) { loginChallenges.delete(current.token); clearCookie(res, 'nexterm_challenge'); return res.status(429).json({ error: 'Zu viele falsche Codes. Melde dich erneut an.' }); }
  try {
    const data = await readData();
    const user = data.users.find(entry => entry.id === current.challenge.userId);
    if (!user) return res.status(401).json({ error: 'Konto wurde nicht gefunden.' });
    const code = String(req.body?.code || '').trim();
    let valid = user.totpEnabled && verifyTotp(user.totpSecret, code);
    if (!valid && consumeRecoveryCode(user, code)) { valid = true; await writeData(data); }
    if (!valid) {
      current.challenge.attempts++;
      if (current.challenge.attempts >= 5) { loginChallenges.delete(current.token); clearCookie(res, 'nexterm_challenge'); }
      return res.status(401).json({ error: 'Code ist ungültig oder wurde bereits verwendet.' });
    }
    loginChallenges.delete(current.token);
    clearCookie(res, 'nexterm_challenge');
    res.json({ user: issueLoginSession(req, res, user) });
  } catch { res.status(500).json({ error: 'Anmeldung gerade nicht möglich.' }); }
});

app.post('/api/auth/request-reset', async (req, res) => {
  const generic = { message: 'Wenn das Konto existiert und die E-Mail-Funktion aktiv ist, wurde ein Link versendet.' };
  if (!passwordResetEnabled()) return res.json(generic);
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const data = await readData();
    const user = data.users.find(entry => entry.email === email && email);
    if (user) {
      const token = crypto.randomBytes(32).toString('base64url');
      user.passwordResetHash = crypto.createHash('sha256').update(token).digest('hex');
      user.passwordResetExpiresAt = Date.now() + 30 * 60 * 1000;
      await writeData(data);
      const link = `${req.protocol}://${req.get('host')}/?reset=${encodeURIComponent(token)}`;
      await sendPasswordResetMail(user, link);
    }
    res.json(generic);
  } catch { res.json(generic); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  if (!passwordResetEnabled()) return res.status(404).json({ error: 'Passwortzurücksetzung ist deaktiviert.' });
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (password.length < 12 || password.length > 256) return res.status(400).json({ error: 'Das neue Passwort muss mindestens 12 Zeichen lang sein.' });
  try {
    const data = await readData();
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const user = data.users.find(entry => entry.passwordResetHash === hash && entry.passwordResetExpiresAt > Date.now());
    if (!user) return res.status(400).json({ error: 'Der Reset-Link ist ungültig oder abgelaufen.' });
    user.passwordSalt = crypto.randomBytes(16).toString('hex');
    user.passwordHash = (await derivePassword(password, Buffer.from(user.passwordSalt, 'hex'))).toString('hex');
    user.passwordResetHash = null;
    user.passwordResetExpiresAt = null;
    user.mustChangePassword = false;
    await writeData(data);
    closeUserSshSessions(user.id);
    for (const [sessionToken, session] of loginSessions) if (session.userId === user.id) loginSessions.delete(sessionToken);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Passwort konnte nicht zurückgesetzt werden.' }); }
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (newPassword.length < 12 || newPassword.length > 256) return res.status(400).json({ error: 'Das neue Passwort muss mindestens 12 Zeichen lang sein.' });
  const currentHash = await derivePassword(currentPassword, Buffer.from(req.user.passwordSalt, 'hex'));
  const storedHash = Buffer.from(req.user.passwordHash, 'hex');
  if (storedHash.length !== currentHash.length || !crypto.timingSafeEqual(currentHash, storedHash)) return res.status(403).json({ error: 'Das aktuelle Passwort stimmt nicht.' });
  req.user.passwordSalt = crypto.randomBytes(16).toString('hex');
  req.user.passwordHash = (await derivePassword(newPassword, Buffer.from(req.user.passwordSalt, 'hex'))).toString('hex');
  req.user.mustChangePassword = false;
  req.user.passwordResetHash = null;
  req.user.passwordResetExpiresAt = null;
  await writeData(req.data);
  for (const [token, session] of loginSessions) if (session.userId === req.user.id && token !== req.loginToken) loginSessions.delete(token);
  closeUserSshSessionsExcept(req.user.id, req.loginToken);
  res.json({ ok: true, user: publicUser(req.user) });
});

app.post('/api/auth/change-email', requireAuth, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const currentPassword = String(req.body?.currentPassword || '');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Bitte gib eine gültige E-Mail-Adresse ein.' });
  const candidate = await derivePassword(currentPassword, Buffer.from(req.user.passwordSalt, 'hex'));
  const stored = Buffer.from(req.user.passwordHash, 'hex');
  if (stored.length !== candidate.length || !crypto.timingSafeEqual(stored, candidate)) return res.status(403).json({ error: 'Das Passwort stimmt nicht.' });
  req.user.email = email;
  req.user.passwordResetHash = null;
  req.user.passwordResetExpiresAt = null;
  await writeData(req.data);
  res.json({ ok: true, user: publicUser(req.user) });
});

app.patch('/api/auth/preferences', requireAuth, async (req, res) => {
  const theme = String(req.body?.theme || '');
  if (!ACCOUNT_THEMES.has(theme)) return res.status(400).json({ error: 'Bitte wähle ein verfügbares Theme.' });
  req.user.theme = theme;
  await writeData(req.data);
  res.json({ ok: true, user: publicUser(req.user) });
});

app.get('/api/auth/security', requireAuth, async (req, res) => {
  res.json({ totpEnabled: Boolean(req.user.totpEnabled), passkeys: (req.user.passkeys || []).filter(entry => entry.enabled).map(entry => ({ id: entry.id, name: entry.name || 'Passkey' })), recoveryCodesRemaining: (req.user.recoveryCodes || []).length });
});

app.post('/api/auth/totp/setup', requireAuth, async (req, res) => {
  if (!await verifyAccountPassword(req.user, req.body?.currentPassword)) return res.status(403).json({ error: 'Bestätige die OTP-Einrichtung mit deinem aktuellen NexTerm-Passwort.' });
  const secret = base32Encode(crypto.randomBytes(20));
  req.user.totpPendingSecret = secret;
  req.user.totpPendingAt = Date.now();
  delete req.user.totpPendingRecoveryHashes;
  await writeData(req.data);
  const issuer = 'NexTerm Desk';
  const label = encodeURIComponent(`${issuer}:${req.user.username}`);
  res.json({ secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30` });
});

app.post('/api/auth/totp/prepare-enable', requireAuth, async (req, res) => {
  if (!req.user.totpPendingSecret || Date.now() - (req.user.totpPendingAt || 0) > 10 * 60 * 1000) return res.status(400).json({ error: 'Starte die OTP-Einrichtung bitte erneut.' });
  if (!verifyTotp(req.user.totpPendingSecret, req.body?.code)) return res.status(400).json({ error: 'Der Authenticator-Code stimmt nicht.' });
  const generated = makeRecoveryCodes();
  req.user.totpPendingRecoveryHashes = generated.map(item => item.hash);
  await writeData(req.data);
  res.json({ codes: generated.map(item => item.code) });
});

app.post('/api/auth/totp/enable', requireAuth, async (req, res) => {
  if (req.body?.codesSaved !== true || !req.user.totpPendingSecret || Date.now() - (req.user.totpPendingAt || 0) > 10 * 60 * 1000 || !Array.isArray(req.user.totpPendingRecoveryHashes)) return res.status(400).json({ error: 'Die Einrichtung ist abgelaufen. Starte sie erneut und speichere die neuen Codes.' });
  req.user.totpSecret = req.user.totpPendingSecret;
  req.user.totpEnabled = true;
  req.user.recoveryCodes = req.user.totpPendingRecoveryHashes;
  delete req.user.totpPendingSecret;
  delete req.user.totpPendingAt;
  delete req.user.totpPendingRecoveryHashes;
  await writeData(req.data);
  res.json({ ok: true });
});

app.post('/api/auth/passkeys/register/options', requireAuth, async (req, res) => {
  try {
    if (!await verifyAccountPassword(req.user, req.body?.currentPassword)) return res.status(403).json({ error: 'Bestätige die Passkey-Einrichtung mit deinem aktuellen NexTerm-Passwort.' });
    req.user.passkeys = (req.user.passkeys || []).filter(entry => entry.enabled);
    delete req.user.pendingPasskeyId;
    delete req.user.pendingRecoveryHashes;
    await writeData(req.data);
    const { rpID } = getWebAuthnContext(req);
    const options = await generateRegistrationOptions({
      rpName: 'NexTerm Desk', rpID, userName: req.user.username, userID: Buffer.from(req.user.id), userDisplayName: req.user.name,
      attestationType: 'none', authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      excludeCredentials: (req.user.passkeys || []).map(entry => ({ id: entry.credential.id, transports: entry.credential.transports }))
    });
    webAuthnChallenges.set(`register:${req.loginToken}`, { challenge: options.challenge, expiresAt: Date.now() + 5 * 60 * 1000 });
    res.json(options);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/auth/passkeys/register/verify', requireAuth, async (req, res) => {
  const pending = webAuthnChallenges.get(`register:${req.loginToken}`);
  if (!pending || pending.expiresAt <= Date.now()) return res.status(400).json({ error: 'Die Passkey-Einrichtung ist abgelaufen. Bitte erneut starten.' });
  try {
    const { rpID, origin } = getWebAuthnContext(req);
    const verification = await verifyRegistrationResponse({ response: req.body, expectedChallenge: pending.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
    webAuthnChallenges.delete(`register:${req.loginToken}`);
    if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ error: 'Passkey konnte nicht bestätigt werden.' });
    const generated = makeRecoveryCodes();
    const credential = verification.registrationInfo.credential;
    req.user.passkeys ||= [];
    const item = { id: crypto.randomUUID(), name: String(req.body?.name || 'Passkey').slice(0, 60), enabled: false, credential: { id: credential.id, publicKey: Buffer.from(credential.publicKey).toString('base64'), counter: credential.counter, transports: req.body?.response?.transports || [] } };
    req.user.passkeys.push(item);
    req.user.pendingPasskeyId = item.id;
    req.user.pendingRecoveryHashes = generated.map(entry => entry.hash);
    await writeData(req.data);
    res.json({ codes: generated.map(entry => entry.code), passkeyId: item.id });
  } catch { res.status(400).json({ error: 'Passkey konnte nicht registriert werden. Prüfe HTTPS und den verwendeten Browser.' }); }
});

app.post('/api/auth/passkeys/enable', requireAuth, async (req, res) => {
  if (req.body?.codesSaved !== true || !req.user.pendingPasskeyId || !Array.isArray(req.user.pendingRecoveryHashes)) return res.status(400).json({ error: 'Speichere zuerst die Wiederherstellungscodes.' });
  const passkey = req.user.passkeys.find(entry => entry.id === req.user.pendingPasskeyId);
  if (!passkey) return res.status(400).json({ error: 'Passkey wurde nicht gefunden.' });
  passkey.enabled = true;
  req.user.recoveryCodes = req.user.pendingRecoveryHashes;
  delete req.user.pendingPasskeyId;
  delete req.user.pendingRecoveryHashes;
  await writeData(req.data);
  res.json({ ok: true });
});

app.post('/api/auth/passkeys/login/options', async (req, res) => {
  const current = authChallengeFromRequest(req, res);
  if (!current) return res.status(401).json({ error: 'Die Anmeldung ist abgelaufen.' });
  try {
    const data = await readData();
    const user = data.users.find(entry => entry.id === current.challenge.userId);
    const credentials = (user?.passkeys || []).filter(entry => entry.enabled).map(entry => entry.credential);
    if (!user || !credentials.length) return res.status(400).json({ error: 'Für dieses Konto ist kein Passkey aktiviert.' });
    const { rpID } = getWebAuthnContext(req);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: credentials.map(credential => ({ id: credential.id, transports: credential.transports })) });
    webAuthnChallenges.set(`login:${current.token}`, { challenge: options.challenge, expiresAt: Date.now() + 5 * 60 * 1000 });
    res.json(options);
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/auth/passkeys/login/verify', async (req, res) => {
  const current = authChallengeFromRequest(req, res);
  if (!current) return res.status(401).json({ error: 'Die Anmeldung ist abgelaufen.' });
  const pending = webAuthnChallenges.get(`login:${current.token}`);
  if (!pending || pending.expiresAt <= Date.now()) return res.status(400).json({ error: 'Die Passkey-Anfrage ist abgelaufen.' });
  try {
    const data = await readData();
    const user = data.users.find(entry => entry.id === current.challenge.userId);
    const credentialId = String(req.body?.id || '');
    const passkey = (user?.passkeys || []).find(entry => entry.enabled && entry.credential.id === credentialId);
    if (!user || !passkey) return res.status(401).json({ error: 'Passkey wurde nicht erkannt.' });
    const { rpID, origin } = getWebAuthnContext(req);
    const verification = await verifyAuthenticationResponse({ response: req.body, expectedChallenge: pending.challenge, expectedOrigin: origin, expectedRPID: rpID, credential: { id: passkey.credential.id, publicKey: Buffer.from(passkey.credential.publicKey, 'base64'), counter: passkey.credential.counter, transports: passkey.credential.transports }, requireUserVerification: true });
    webAuthnChallenges.delete(`login:${current.token}`);
    if (!verification.verified) return res.status(401).json({ error: 'Passkey-Anmeldung fehlgeschlagen.' });
    passkey.credential.counter = verification.authenticationInfo.newCounter;
    await writeData(data);
    loginChallenges.delete(current.token);
    clearCookie(res, 'nexterm_challenge');
    res.json({ user: issueLoginSession(req, res, user) });
  } catch { res.status(401).json({ error: 'Passkey-Anmeldung fehlgeschlagen.' }); }
});

app.post('/api/auth/security/disable', requireAuth, async (req, res) => {
  const password = String(req.body?.password || '');
  const code = String(req.body?.code || '');
  const candidate = await derivePassword(password, Buffer.from(req.user.passwordSalt, 'hex'));
  const stored = Buffer.from(req.user.passwordHash, 'hex');
  if (candidate.length !== stored.length || !crypto.timingSafeEqual(candidate, stored)) return res.status(403).json({ error: 'Das Passwort stimmt nicht.' });
  const codeValid = (req.user.totpEnabled && verifyTotp(req.user.totpSecret, code)) || consumeRecoveryCode(req.user, code);
  if (!codeValid) return res.status(403).json({ error: 'Bestätige die Änderung mit deinem OTP- oder Wiederherstellungscode.' });
  req.user.totpEnabled = false;
  delete req.user.totpSecret;
  req.user.passkeys = [];
  req.user.recoveryCodes = [];
  await writeData(req.data);
  res.json({ ok: true });
});

app.use('/api/admin', requireSameOrigin, requireAuth);
app.get('/api/admin/users', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Nur das Admin-Konto kann Passwörter zurücksetzen.' });
  res.json((req.data.users || []).map(user => ({ id: user.id, username: user.username, name: user.name, email: user.email || '', mustChangePassword: Boolean(user.mustChangePassword) })));
});

app.post('/api/admin/users/:id/reset-password', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Nur das Admin-Konto kann Passwörter zurücksetzen.' });
  if (!await verifyAccountPassword(req.user, req.body?.adminPassword)) return res.status(403).json({ error: 'Bestätige das Zurücksetzen mit deinem aktuellen Admin-Passwort.' });
  const password = String(req.body?.password || '');
  if (password.length < 12 || password.length > 256) return res.status(400).json({ error: 'Das neue Passwort muss mindestens 12 Zeichen lang sein.' });
  const target = req.data.users.find(user => user.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Konto wurde nicht gefunden.' });
  target.passwordSalt = crypto.randomBytes(16).toString('hex');
  target.passwordHash = (await derivePassword(password, Buffer.from(target.passwordSalt, 'hex'))).toString('hex');
  target.mustChangePassword = true;
  target.passwordResetHash = null;
  target.passwordResetExpiresAt = null;
  await writeData(req.data);
  for (const [token, session] of loginSessions) if (session.userId === target.id) loginSessions.delete(token);
  closeUserSshSessions(target.id);
  res.json({ ok: true });
});

app.use('/api/workspaces', requireSameOrigin, requireAuth);
app.get('/api/workspaces', (req, res) => {
  const active = activeWorkspace(req.user);
  res.json({ workspaces: req.user.workspaces.map(({ id, name }) => ({ id, name })), activeWorkspaceId: active.id });
});

app.post('/api/workspaces', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 60) return res.status(400).json({ error: 'Der Workspace-Name muss 1 bis 60 Zeichen lang sein.' });
  if (req.user.workspaces.length >= 30) return res.status(400).json({ error: 'Du kannst höchstens 30 Workspaces anlegen.' });
  const workspace = { id: crypto.randomUUID(), name, hosts: [] };
  req.user.workspaces.push(workspace);
  req.user.activeWorkspaceId = workspace.id;
  await writeData(req.data);
  res.status(201).json({ workspace: { id: workspace.id, name: workspace.name }, activeWorkspaceId: workspace.id });
});

app.post('/api/workspaces/:id/activate', async (req, res) => {
  if (!req.user.workspaces.some(workspace => workspace.id === req.params.id)) return res.status(404).json({ error: 'Workspace wurde nicht gefunden.' });
  req.user.activeWorkspaceId = req.params.id;
  await writeData(req.data);
  res.json({ activeWorkspaceId: req.params.id });
});

app.patch('/api/workspaces/:id', async (req, res) => {
  const workspace = req.user.workspaces.find(item => item.id === req.params.id);
  const name = String(req.body?.name || '').trim();
  if (!workspace) return res.status(404).json({ error: 'Workspace wurde nicht gefunden.' });
  if (!name || name.length > 60) return res.status(400).json({ error: 'Der Workspace-Name muss 1 bis 60 Zeichen lang sein.' });
  workspace.name = name;
  await writeData(req.data);
  res.json({ id: workspace.id, name: workspace.name });
});

app.delete('/api/workspaces/:id', async (req, res) => {
  if (req.user.workspaces.length <= 1) return res.status(400).json({ error: 'Der letzte Workspace kann nicht entfernt werden.' });
  const workspace = req.user.workspaces.find(item => item.id === req.params.id);
  if (!workspace) return res.status(404).json({ error: 'Workspace wurde nicht gefunden.' });
  req.user.workspaces = req.user.workspaces.filter(item => item.id !== workspace.id);
  if (req.user.activeWorkspaceId === workspace.id) req.user.activeWorkspaceId = req.user.workspaces[0].id;
  for (const session of sessions.values()) if (session.userId === req.user.id && session.workspaceId === workspace.id) { sessions.delete(session.id); session.closed = true; session.client.end(); }
  await writeData(req.data);
  res.json({ activeWorkspaceId: req.user.activeWorkspaceId });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).nexterm_session;
  const session = token && loginSessions.get(token);
  if (session) {
    loginSessions.delete(token);
    closeUserSshSessions(session.userId);
  }
  clearCookie(res, 'nexterm_session');
  clearCookie(res, 'nexterm_challenge');
  res.status(204).end();
});

app.use(['/api/hosts', '/api/sessions'], requireSameOrigin, requireAuth);

app.get('/api/hosts', (req, res) => res.json((activeWorkspace(req.user).hosts || []).map(publicHost)));

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
    const workspace = activeWorkspace(req.user);
    workspace.hosts.push(hostProfile);
    await writeData(req.data);
    res.status(201).json(publicHost(hostProfile));
  } catch {
    res.status(500).json({ error: 'Der Server konnte nicht gespeichert werden.' });
  }
});

app.delete('/api/hosts/:id', async (req, res) => {
  try {
    const workspace = activeWorkspace(req.user);
    const hosts = workspace.hosts || [];
    const next = hosts.filter(host => host.id !== req.params.id);
    if (next.length === hosts.length) return res.status(404).json({ error: 'Server nicht gefunden.' });
    workspace.hosts = next;
    await writeData(req.data);
    for (const session of sessions.values()) {
      if (session.userId === req.user.id && session.workspaceId === workspace.id && session.host.id === req.params.id) {
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
    const workspace = activeWorkspace(req.user);
    const profile = workspace.hosts.find(host => host.id === hostId);
    if (!profile) return res.status(404).json({ error: 'Serverprofil nicht gefunden.' });
    try { connected = await connectSsh(profile, auth); }
    catch (error) {
      if (error.fingerprint) return res.status(409).json({ error: 'HOST_KEY', fingerprint: error.fingerprint, changed: error.changed });
      return res.status(422).json({ error: error.message || 'SSH-Verbindung fehlgeschlagen.' });
    }

    if (connected.fingerprint && profile.fingerprint !== connected.fingerprint) {
      profile.fingerprint = connected.fingerprint;
      await writeData(req.data);
    }
    const id = crypto.randomUUID();
    const session = { id, userId: req.user.id, loginToken: req.loginToken, workspaceId: workspace.id, host: publicHost(profile), ...connected, socket: null, buffer: [], closed: false, previousMetrics: null };
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
  const workspaceId = activeWorkspace(req.user).id;
  res.json([...sessions.values()].filter(session => !session.closed && session.userId === req.user.id && session.loginToken === req.loginToken && session.workspaceId === workspaceId).map(session => ({ id: session.id, host: session.host, home: session.home })));
});

app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (session && (session.userId !== req.user.id || session.loginToken !== req.loginToken || session.workspaceId !== activeWorkspace(req.user).id)) return res.status(404).json({ error: 'SSH-Sitzung nicht gefunden.' });
  if (session) {
    sessions.delete(session.id);
    session.closed = true;
    session.client.end();
  }
  res.status(204).end();
});

app.get('/api/sessions/:id/files', async (req, res) => {
  const session = getSession(req.params.id, res, req.user.id, activeWorkspace(req.user).id, req.loginToken);
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
  const session = getSession(req.params.id, res, req.user.id, activeWorkspace(req.user).id, req.loginToken);
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
  const session = getSession(req.params.id, res, req.user.id, activeWorkspace(req.user).id, req.loginToken);
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
  const session = getSession(req.params.id, res, req.user.id, activeWorkspace(req.user).id, req.loginToken);
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

const distCandidates = [path.join(ROOT, 'dist')];
if (process.resourcesPath) distCandidates.push(path.join(process.resourcesPath, 'dist'));
let distPath = null;
for (const candidate of distCandidates) {
  try {
    await fs.access(path.join(candidate, 'index.html'));
    distPath = candidate;
    break;
  } catch {}
}
if (distPath) {
  app.use(express.static(distPath));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
} else {
  console.error('NexTerm: dist/index.html wurde nicht gefunden.');
  app.get('/{*splat}', (_req, res) => res.status(503).type('text/plain').send('Die NexTerm-Oberfläche fehlt in dieser Installation. Bitte aktualisiere die App.'));
}

server.on('upgrade', async (request, socket, head) => {
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
  if (!session || session.closed || session.userId !== loginSession.userId || session.loginToken !== token) return socket.destroy();
  try {
    const data = await readData();
    const user = data.users.find(entry => entry.id === loginSession.userId);
    if (!user || activeWorkspace(user).id !== session.workspaceId) return socket.destroy();
  } catch { return socket.destroy(); }
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

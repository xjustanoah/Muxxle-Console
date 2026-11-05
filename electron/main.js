import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer, stopServer } from '../server.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER_FILE = path.join(ROOT, 'connect.html');
const APP_DATA_DIR = path.join(app.getPath('userData'), 'vault');
const LEGACY_DATA_DIR = path.join(os.homedir(), '.nexterm');
const VAULT_KEY_FILE = 'vault-key.dpapi';
let launcherWindow = null;
let appWindow = null;
let localServerStarted = false;
let shuttingDown = false;

app.setAppUserModelId('com.nexterm.desk');
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

function assertLauncherSender(event) {
  if (!launcherWindow || event.sender !== launcherWindow.webContents) throw new Error('Ungültige Startfenster-Anfrage.');
  if (event.senderFrame?.url !== pathToFileURL(LAUNCHER_FILE).href) throw new Error('Ungültige Startfenster-Adresse.');
}

function validateServerUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Gib eine gültige Server-Adresse ein.');
  let target;
  try { target = new URL(value.trim()); }
  catch { throw new Error('Die Server-Adresse ist ungültig. Beispiel: https://ssh.example.com'); }
  if (target.username || target.password || target.search || target.hash) throw new Error('Die Adresse darf keine Zugangsdaten, Suchparameter oder Fragmente enthalten.');
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname.toLowerCase());
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && isLoopback)) {
    throw new Error('Für Webserver wird HTTPS benötigt. HTTP ist nur für localhost erlaubt.');
  }
  if (target.pathname !== '/') throw new Error('Die NexTerm-Weboberfläche muss unter der Stammadresse des Webservers erreichbar sein.');
  return target.origin;
}

async function loadLauncherSettings() {
  try {
    const settings = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'launcher.json'), 'utf8'));
    return { serverUrl: typeof settings.serverUrl === 'string' ? settings.serverUrl : '' };
  } catch { return { serverUrl: '' }; }
}

async function saveLauncherSettings(serverUrl) {
  const directory = app.getPath('userData');
  await fs.mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `launcher.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tempPath, JSON.stringify({ serverUrl }, null, 2), { mode: 0o600 });
  await fs.rename(tempPath, path.join(directory, 'launcher.json'));
}

async function getVaultKey() {
  if (process.platform !== 'win32') throw new Error('Der verschlüsselte lokale Tresor ist aktuell nur in der Windows-App verfügbar.');
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Windows-Datenschutzverschlüsselung ist nicht verfügbar. Der Tresor wurde nicht geöffnet.');
  const directory = app.getPath('userData');
  const keyPath = path.join(directory, VAULT_KEY_FILE);
  await fs.mkdir(directory, { recursive: true });
  try {
    const encryptedKey = await fs.readFile(keyPath);
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(encryptedKey);
    const key = Buffer.from(result, 'hex');
    if (key.length !== 32) throw new Error('Der lokale Tresorschlüssel ist beschädigt.');
    if (shouldReEncrypt) {
      const refreshed = await safeStorage.encryptStringAsync(result);
      const tempPath = `${keyPath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, refreshed, { mode: 0o600 });
      await fs.rename(tempPath, keyPath);
    }
    return key;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Lokaler Tresor konnte nicht geöffnet werden: ${error.message}`);
    const key = crypto.randomBytes(32);
    const encryptedKey = await safeStorage.encryptStringAsync(key.toString('hex'));
    await fs.writeFile(keyPath, encryptedKey, { flag: 'wx', mode: 0o600 });
    return key;
  }
}

function restrictWindowNavigation(window, baseUrl) {
  const trustedOrigin = new URL(baseUrl).origin;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, nextUrl) => {
    try {
      if (new URL(nextUrl).origin !== trustedOrigin) event.preventDefault();
    } catch { event.preventDefault(); }
  });
}

async function createAppWindow(baseUrl) {
  appWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 1160,
    minHeight: 740,
    backgroundColor: '#10131a',
    title: 'NexTerm Desk',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged
    }
  });
  restrictWindowNavigation(appWindow, baseUrl);
  try {
    await appWindow.loadURL(baseUrl);
  } catch (error) {
    appWindow.destroy();
    appWindow = null;
    throw error;
  }
  appWindow.on('closed', () => { appWindow = null; });
}

async function createLauncher() {
  launcherWindow = new BrowserWindow({
    width: 1160,
    height: 860,
    minWidth: 900,
    minHeight: 700,
    useContentSize: true,
    resizable: true,
    backgroundColor: '#10131a',
    title: 'NexTerm Desk · Verbindung wählen',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  launcherWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  launcherWindow.webContents.on('will-navigate', (event, nextUrl) => {
    if (nextUrl !== pathToFileURL(LAUNCHER_FILE).href) event.preventDefault();
  });
  await launcherWindow.loadFile(LAUNCHER_FILE);
  launcherWindow.on('closed', () => { launcherWindow = null; });
}

ipcMain.handle('launcher:get-settings', async event => {
  assertLauncherSender(event);
  return loadLauncherSettings();
});

ipcMain.handle('launcher:local', async event => {
  assertLauncherSender(event);
  event.sender.send('launcher:status', 'Tresor wird vorbereitet …');
  let startedHere = false;
  try {
    const key = await getVaultKey();
    const localServer = await startServer({ host: 'localhost', port: 0, dataDir: APP_DATA_DIR, legacyDataDir: LEGACY_DATA_DIR, dataKey: key, localDesktop: true });
    localServerStarted = true;
    startedHere = true;
    await session.defaultSession.cookies.set({
      url: localServer.url,
      name: 'nexterm_session',
      value: localServer.localSessionToken,
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      expirationDate: Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 60 * 60
    });
    await createAppWindow(`${localServer.url}/?desktop=local`);
    launcherWindow?.close();
    launcherWindow = null;
    return { ok: true };
  } catch (error) {
    if (startedHere) {
      await stopServer().catch(() => {});
      localServerStarted = false;
    }
    event.sender.send('launcher:error', error.message || 'Lokaler Tresor konnte nicht gestartet werden.');
    return { ok: false };
  }
});

ipcMain.handle('launcher:remote', async (event, rawUrl) => {
  assertLauncherSender(event);
  let serverUrl;
  try { serverUrl = validateServerUrl(rawUrl); }
  catch (error) {
    event.sender.send('launcher:error', error.message);
    return { ok: false };
  }
  event.sender.send('launcher:status', 'Webserver wird geöffnet …');
  try {
    await createAppWindow(serverUrl);
    await saveLauncherSettings(serverUrl);
    launcherWindow?.close();
    launcherWindow = null;
    return { ok: true };
  } catch (error) {
    event.sender.send('launcher:error', `Webserver konnte nicht geöffnet werden: ${error.message}`);
    return { ok: false };
  }
});

app.on('second-instance', () => {
  if (launcherWindow) launcherWindow.focus();
  else appWindow?.focus();
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  try { await createLauncher(); }
  catch (error) { await dialog.showMessageBox({ type: 'error', title: 'NexTerm Desk', message: 'Die Startauswahl konnte nicht geöffnet werden.', detail: error.message }); app.quit(); }
});

app.on('before-quit', event => {
  if (!localServerStarted || shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  stopServer().finally(() => { localServerStarted = false; app.quit(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

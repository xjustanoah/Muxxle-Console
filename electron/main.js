import { app, BrowserWindow, dialog, ipcMain, safeStorage, screen, session } from 'electron';
import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startServer, stopServer } from '../server.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LAUNCHER_FILE = path.join(ROOT, 'connect.html');
// Keep the Electron profile and its encrypted vault accessible after a package rename.
const PROFILE_DIR = path.join(app.getPath('appData'), 'nexterm-desk');
mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
app.setPath('userData', PROFILE_DIR);
const APP_DATA_DIR = path.join(PROFILE_DIR, 'vault');
const LEGACY_DATA_DIR = path.join(os.homedir(), '.nexterm');
const VAULT_KEY_FILE = 'vault-key.dpapi';
const TITLE_BAR_THEMES = Object.freeze({
  'material-dark': { color: '#080c25', symbolColor: '#eef2ff' },
  'material-white': { color: '#f5f8f8', symbolColor: '#172020' },
  muxxle: { color: '#140b0c', symbolColor: '#f2dfe0' }
});
let launcherWindow = null;
let appWindow = null;
let launcherDragState = null;
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
  if (target.pathname !== '/') throw new Error('Muxxle Console muss unter der Stammadresse des Webservers erreichbar sein.');
  return target.origin;
}

async function loadLauncherSettings() {
  try {
    const settings = JSON.parse(await fs.readFile(path.join(PROFILE_DIR, 'launcher.json'), 'utf8'));
    return { serverUrl: typeof settings.serverUrl === 'string' ? settings.serverUrl : '' };
  } catch { return { serverUrl: '' }; }
}

async function saveLauncherSettings(serverUrl) {
  const tempPath = path.join(PROFILE_DIR, `launcher.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tempPath, JSON.stringify({ serverUrl }, null, 2), { mode: 0o600 });
  await fs.rename(tempPath, path.join(PROFILE_DIR, 'launcher.json'));
}

async function getVaultKey() {
  if (process.platform !== 'win32') throw new Error('Der verschlüsselte lokale Tresor ist aktuell nur in der Windows-App verfügbar.');
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Windows-Datenschutzverschlüsselung ist nicht verfügbar. Der Tresor wurde nicht geöffnet.');
  const keyPath = path.join(PROFILE_DIR, VAULT_KEY_FILE);
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

function getWindowChromeOptions() {
  if (process.platform === 'darwin') return {};
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...TITLE_BAR_THEMES['material-dark'], height: 40 }
  };
}

function assertAppWindowSender(event) {
  if (!appWindow || event.sender !== appWindow.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Ungültige Fenster-Anfrage.');
  }
  try {
    if (new URL(event.senderFrame.url).origin !== new URL(event.sender.getURL()).origin) throw new Error();
  } catch {
    throw new Error('Ungültige Fenster-Adresse.');
  }
}

function getDraggableLauncher(event) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow !== launcherWindow || event.senderFrame !== event.sender.mainFrame) return null;
  return senderWindow;
}

ipcMain.on('window:drag', (event, action, rawPoint) => {
  const window = getDraggableLauncher(event);
  if (!window || window.isDestroyed()) return;
  const point = Number.isFinite(rawPoint?.x) && Number.isFinite(rawPoint?.y)
    ? { x: rawPoint.x, y: rawPoint.y }
    : null;

  if (action === 'start') {
    const bounds = window.getBounds();
    const scaleFactor = screen.getDisplayMatching(bounds).scaleFactor || 1;
    const cursor = point
      ? { x: point.x / scaleFactor, y: point.y / scaleFactor }
      : screen.getCursorScreenPoint();
    launcherDragState = {
      window,
      origin: { x: bounds.x, y: bounds.y },
      size: { width: bounds.width, height: bounds.height },
      cursor,
      scaleFactor
    };
    return;
  }
  if (action === 'move' && launcherDragState?.window === window) {
    const cursor = point
      ? { x: point.x / launcherDragState.scaleFactor, y: point.y / launcherDragState.scaleFactor }
      : screen.getCursorScreenPoint();
    window.setBounds({
      x: Math.round(launcherDragState.origin.x + cursor.x - launcherDragState.cursor.x),
      y: Math.round(launcherDragState.origin.y + cursor.y - launcherDragState.cursor.y),
      ...launcherDragState.size
    }, false);
    return;
  }
  if (action === 'end' && launcherDragState?.window === window) launcherDragState = null;
});

async function createAppWindow(baseUrl) {
  const { width: workWidth, height: workHeight } = screen.getPrimaryDisplay().workAreaSize;
  const windowWidth = Math.max(1000, Math.min(3200, Math.floor(workWidth * 0.96)));
  const windowHeight = Math.max(640, Math.min(1800, Math.floor(workHeight * 0.96)));
  appWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: 1000,
    minHeight: 640,
    center: true,
    backgroundColor: '#080c25',
    icon: path.join(ROOT, 'muxxle-console-app-icon.ico'),
    title: 'Muxxle Console',
    autoHideMenuBar: true,
    ...getWindowChromeOptions(),
    webPreferences: {
      preload: path.join(ROOT, 'app-preload.cjs'),
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
    minWidth: 760,
    minHeight: 600,
    useContentSize: true,
    resizable: true,
    backgroundColor: '#080c25',
    icon: path.join(ROOT, 'muxxle-console-app-icon.ico'),
    title: 'Muxxle Console · Verbindung wählen',
    autoHideMenuBar: true,
    ...getWindowChromeOptions(),
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
  launcherWindow.on('closed', () => {
    if (launcherDragState?.window === launcherWindow) launcherDragState = null;
    launcherWindow = null;
  });
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

ipcMain.handle('window:set-theme', (event, theme) => {
  assertAppWindowSender(event);
  const colors = TITLE_BAR_THEMES[theme];
  if (!colors) return false;
  appWindow.setTitleBarOverlay({ ...colors, height: 40 });
  return true;
});

app.on('second-instance', () => {
  if (launcherWindow) launcherWindow.focus();
  else appWindow?.focus();
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  try { await createLauncher(); }
  catch (error) { await dialog.showMessageBox({ type: 'error', title: 'Muxxle Console', message: 'Die Startauswahl konnte nicht geöffnet werden.', detail: error.message }); app.quit(); }
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

import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import packageInfo from '../package.json';
import './style.css';

// Mark the native renderer before app styles are laid out. The preload repeats
// this as a fallback, while the browser build stays free of Electron chrome.
if (window.nextermDesktop) document.documentElement.classList.add('nexterm-electron');

const icons = {
  brand: '<img src="/favicon.png" alt="" />',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4 4"/></svg>',
  server: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="8" rx="2"/><rect x="4" y="13" width="16" height="8" rx="2"/><path d="M8 7h.01M8 17h.01M12 7h4M12 17h4"/></svg>',
  terminal: '<svg viewBox="0 0 24 24"><path d="m4 6 6 6-6 6"/><path d="M12 18h8"/></svg>',
  files: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5h7l2 2h8v10h-17z"/><path d="M3.5 7.5v-2h7l2 2"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 19V5M4 19h17"/><path d="m7 15 4-4 3 2 5-7"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9M9 20v-7h6v7"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.4"/><path d="M12 2.8v2.1m0 14.2v2.1M2.8 12h2.1m14.2 0h2.1M5.5 5.5 7 7m10 10 1.5 1.5m0-13L17 7M7 17l-1.5 1.5"/><circle cx="12" cy="12" r="8.1"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m11 12 8-8 2 2-2 2 2 2-3 3-2-2-2 2"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg>',
  cloud: '<svg viewBox="0 0 24 24"><path d="M7 18h10a4 4 0 0 0 .4-8 6 6 0 0 0-11-1A4.5 4.5 0 0 0 7 18Z"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4m-4 4 4-4 4 4"/><path d="M5 14v5h14v-5"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v12m-4-4 4 4 4-4"/><path d="M5 14v5h14v-5"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v10H3z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 3h8l5 5v13H6z"/><path d="M14 3v6h5M9 14h6M9 17h6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
  dots: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 11.9-3"/></svg>',
  circle: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3 20 6v5c0 5-3.4 8.2-8 10-4.6-1.8-8-5-8-10V6z"/><path d="m9 12 2 2 4-4"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>'
};

const state = {
  user: null, workspaces: [], activeWorkspaceId: null, passwordResetEnabled: false,
  adminBootstrapRequired: false, adminBootstrapConfigured: false,
  hosts: [], sessions: [], activeId: null, selectedHostId: null, closedTerminalHost: null, route: 'overview', query: '',
  metrics: [], metricsSession: null, latestMetrics: null,
  filePath: '', fileSession: null, files: [],
  terminalEntries: new Map(), monitorTimer: null
};

const ACCOUNT_THEMES = ['material-dark', 'material-white', 'muxxle'];
let themeSaveQueue = Promise.resolve();

const root = document.querySelector('#app');
document.documentElement.dataset.theme = 'material-dark';
const isLocalInstance = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname.toLowerCase());
const isLocalDesktopVault = isLocalInstance && new URLSearchParams(location.search).get('desktop') === 'local';
const appMarkup = `
  <div class="app-shell">
    <aside class="sidebar" id="appSidebar">
      <div class="brand-row"><div class="brand-mark">${icons.brand}</div><div class="brand-name">Termxxle</div></div>
      <button class="workspace-switch" id="workspaceSwitch" aria-haspopup="true" aria-expanded="false"><span class="workspace-avatar" id="workspaceAvatar">W</span><span class="workspace-copy"><b id="workspaceName">Mein Workspace</b><small id="workspaceContext">${isLocalInstance ? 'Lokaler Tresor' : 'Webserver-Workspace'}</small></span><span class="workspace-caret">⌄</span></button>
      <button class="add-connection" id="addHost">${icons.plus}<span>Server hinzufügen</span><kbd>⌘ K</kbd></button>
      <label class="search-box">${icons.search}<input id="hostSearch" placeholder="Server suchen…" autocomplete="off"><kbd>/</kbd></label>
      <div class="side-section"><div class="section-heading"><span>VERBINDUNGEN</span><span id="hostCount" class="count-pill">0</span></div><div id="hostList" class="host-list"></div></div>
      <div class="side-spacer"></div>
      <div class="sidebar-bottom">
        <div class="local-secure">${icons.lock}<span><b>${isLocalInstance ? 'Lokal verschlüsselt' : 'Webserver-Konto'}</b><small>SSH-Zugänge bleiben flüchtig</small></span><i></i></div>
        <div class="profile-row"><div class="profile-avatar" id="accountAvatar">S</div><div class="profile-copy"><b id="accountName">Lokales Konto</b><small id="accountUsername">Persönliches Konto</small></div><button class="logout-button" id="logoutButton">Abmelden</button></div>
        <div class="app-version">Termxxle · v${packageInfo.version}</div>
      </div>
    </aside>
    <main class="main-area">
      <header class="topbar"><button type="button" class="icon-button mobile-menu" id="mobileMenu" aria-label="Servermenü öffnen" aria-controls="appSidebar" aria-expanded="false">${icons.menu}</button><div class="breadcrumb"><span>WORKSPACE</span><b>/</b><span id="breadcrumbName">ÜBERSICHT</span></div><div class="topbar-actions"><div class="local-badge"><span></span>${isLocalInstance ? 'Nur auf diesem Gerät' : 'Webserver'}</div><label class="theme-picker"><span>THEME</span><select id="themeSelect" aria-label="Farbschema"><option value="material-dark">Darkmode · Material Dark</option><option value="material-white">Whitemode · Material White</option><option value="muxxle">Muxxle · Dark Red</option></select></label><button class="help-button" id="helpButton">Hilfe</button><button class="help-button" id="documentationButton">Dokumentation</button><button class="help-button" id="settingsButton" hidden>Einstellungen</button><div class="mobile-more-wrap"><button type="button" class="icon-button mobile-more-button" id="mobileMoreButton" aria-label="Weitere Menüpunkte" aria-haspopup="true" aria-expanded="false">${icons.dots}</button><div class="mobile-more-menu" id="mobileMoreMenu" hidden><button type="button" data-mobile-action="help">${icons.shield}Hilfe</button><button type="button" data-mobile-action="documentation">${icons.file}Dokumentation</button><button type="button" id="mobileAdminSettings" data-mobile-action="settings" hidden>${icons.settings}Einstellungen</button></div></div><button class="avatar-small" id="headerAvatar" title="Angemeldetes Konto">S</button></div></header>
      <div class="page-content">
        <div class="page-heading"><div><div class="eyebrow" id="pageEyebrow">DEIN SERVER-WORKSPACE</div><h1 id="pageTitle">Alles an einem Ort.</h1><p id="pageSubtitle">Verbinde dich sicher mit deinen Servern und behalte den Überblick.</p></div><div class="heading-actions"><button class="button button-secondary" id="quickTerminal" disabled>${icons.terminal}Terminal öffnen</button><button class="button button-primary" id="headingAdd">${icons.plus}Server verbinden</button></div></div>
        <div class="route-tabs" id="routeTabs">
          <button class="route-tab active" data-route="overview">${icons.home}<span>Übersicht</span></button>
          <button class="route-tab" data-route="terminal">${icons.terminal}<span>Terminal</span><span id="termTabDot" class="tab-live-dot"></span></button>
          <button class="route-tab" data-route="files">${icons.files}<span>Dateien</span></button>
          <button class="route-tab" data-route="monitoring">${icons.chart}<span>Monitoring</span></button>
          <button class="route-tab" data-route="settings">${icons.settings}<span>Einstellungen</span></button>
          <div class="tabs-spacer"></div><div class="connection-indicator" id="connectionIndicator"><span></span>Keine aktive Verbindung</div>
        </div>

        <section class="route-view active" id="view-overview">
          <div class="welcome-grid">
            <div class="welcome-card"><div class="welcome-content"><div class="welcome-kicker"><span class="welcome-spark">✦</span> DEIN SECURE WORKSPACE</div><h2>Ein klarer Blick.<br><em>Volle Kontrolle.</em></h2><p>SSH, Dateiübertragung und Live-Serverdaten in einem ruhigen Arbeitsbereich.</p><button class="button button-primary" id="welcomeAdd">${icons.plus}Ersten Server hinzufügen</button><div class="trust-note">${icons.shield}<span>SSH-Schlüssel-Fingerabdrücke werden geprüft</span></div></div><div class="welcome-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="art-core">${icons.server}<span class="art-core-dot"></span></div><div class="art-node node-a">CPU <b>24%</b></div><div class="art-node node-b"><span></span> SSH <b>AKTIV</b></div><div class="art-node node-c">${icons.files}<b>SFTP</b></div><div class="art-dots"></div></div></div>
            <div class="overview-side"><div class="overview-stat-card"><div class="stat-label">GESPEICHERTE SERVER <span>${icons.server}</span></div><div class="stat-number" id="overviewHostCount">0</div><div class="stat-foot"><span class="stat-accent"></span>Alle Verbindungen an einem Ort</div></div><div class="overview-stat-card"><div class="stat-label">AKTIVE SITZUNGEN <span>${icons.terminal}</span></div><div class="stat-number" id="overviewSessionCount">0</div><div class="stat-foot"><span class="stat-neutral"></span>Zurzeit verbundene Server</div></div><div class="quick-tip"><div class="tip-icon">${icons.key}</div><div><b>Deine Schlüssel bleiben bei dir</b><p>Private Schlüssel und Passwörter werden nur zum Verbindungsaufbau verwendet.</p></div></div></div>
          </div>
          <div class="section-title-row"><div><div class="eyebrow">DEINE UMGEBUNG</div><h2>Server & Verbindungen</h2></div><button class="text-button" id="overviewAdd">${icons.plus}Server hinzufügen</button></div>
          <div class="server-cards" id="serverCards"></div>
          <div class="feature-strip"><div class="feature-item"><span class="feature-icon purple">${icons.terminal}</span><div><b>Interaktives SSH-Terminal</b><small>Arbeite direkt auf deinem Server</small></div></div><div class="feature-item"><span class="feature-icon blue">${icons.files}</span><div><b>SFTP-Dateimanager</b><small>Ziehe Dateien sicher hin und her</small></div></div><div class="feature-item"><span class="feature-icon green">${icons.chart}</span><div><b>Live-Monitoring</b><small>CPU, RAM, Speicher und Netzwerk</small></div></div></div>
        </section>

        <section class="route-view terminal-view" id="view-terminal"><div class="terminal-toolbar"><div class="terminal-host-label"><span class="status-dot"></span><span id="terminalHostName">Kein Server verbunden</span><small id="terminalHostAddress"></small></div><div class="terminal-actions"><span class="terminal-type">SSH · xterm-256color</span><button class="icon-button" id="clearTerminal" title="Terminal leeren">${icons.refresh}</button><button class="icon-button danger-hover" id="disconnectButton" title="Verbindung trennen">${icons.close}</button></div></div><div class="terminal-stage" id="terminalHost"><div class="terminal-empty" id="terminalEmpty"><div class="empty-terminal-icon">${icons.terminal}</div><h3>Dein Terminal wartet</h3><p>Wähle links einen Server und stelle eine SSH-Verbindung her.</p><button class="button button-primary" id="terminalAdd">${icons.plus}Server hinzufügen</button></div></div><div class="terminal-footer"><span><i class="green-led"></i>UTF-8</span><span>Shell wird über SSH übertragen</span><span id="terminalSize">— × —</span></div></section>

        <section class="route-view files-view" id="view-files"><div class="files-toolbar"><div class="file-location">${icons.files}<span id="fileHostName">Server auswählen</span><span class="location-divider">/</span><code id="filePathLabel">—</code></div><div class="file-actions"><button class="button button-secondary" id="refreshFiles">${icons.refresh}Aktualisieren</button><button class="button button-primary" id="uploadButton">${icons.upload}Hochladen</button><input type="file" id="filePicker" hidden></div></div><div class="file-table-wrap"><table class="file-table"><thead><tr><th>Name</th><th>Typ</th><th>Größe</th><th>Geändert</th><th></th></tr></thead><tbody id="fileTableBody"><tr><td colspan="5"><div class="inline-empty">${icons.files}<b>Keine Verbindung ausgewählt</b><span>Verbinde dich mit einem Server, um Dateien zu durchsuchen.</span></div></td></tr></tbody></table></div><div class="file-footer"><span id="fileCount">SFTP-Dateimanager</span><span>Über verschlüsselte SSH-Verbindung</span></div></section>

        <section class="route-view monitor-view" id="view-monitoring"><div class="monitor-toolbar"><div><div class="eyebrow">LIVE-TELEMETRIE</div><div class="monitor-server-label"><span class="status-dot"></span><b id="monitorHostName">Server auswählen</b><span id="monitorUpdated">Warte auf Verbindung</span></div></div><div class="monitor-toolbar-right"><div class="uptime-chip"><span>LAUFZEIT</span><b id="uptimeValue">—</b></div><div class="monitor-refresh">${icons.refresh}<span>Aktualisierung alle 3 Sekunden</span></div></div></div><div id="monitorEmpty" class="monitor-empty"><div class="empty-monitor-icon">${icons.chart}</div><h3>Deine Serverdaten, live.</h3><p>Verbinde dich mit einem Linux-Server, um CPU, Arbeitsspeicher, Festplatte, Netzwerk und Laufzeit zu sehen.</p><button class="button button-primary" id="monitorAdd">${icons.plus}Server verbinden</button></div><div id="monitorDashboard" class="monitor-dashboard" hidden><div class="metric-grid"><article class="metric-card"><div class="metric-top"><span>CPU-AUSLASTUNG</span><span class="metric-icon purple">${icons.chart}</span></div><div class="metric-reading"><b id="cpuValue">—</b><span>%</span></div><div class="metric-sub" id="cpuSub">Gesamtauslastung</div><canvas class="sparkline" id="cpuChart" height="48"></canvas><div class="metric-bottom"><span><i class="legend-dot purple"></i>Auslastung</span><b id="cpuTrend">Live</b></div></article><article class="metric-card"><div class="metric-top"><span>ARBEITSSPEICHER</span><span class="metric-icon blue">${icons.server}</span></div><div class="metric-reading"><b id="memoryValue">—</b><span>%</span></div><div class="metric-sub" id="memorySub">— von — belegt</div><div class="metric-progress"><span id="memoryBar" class="blue"></span></div><div class="metric-bottom"><span><i class="legend-dot blue"></i>Verwendung</span><b id="memoryTotal">—</b></div></article><article class="metric-card"><div class="metric-top"><span>FESTPLATTE · /</span><span class="metric-icon amber">${icons.files}</span></div><div class="metric-reading"><b id="diskValue">—</b><span>%</span></div><div class="metric-sub" id="diskSub">— von — belegt</div><div class="metric-progress"><span id="diskBar" class="amber"></span></div><div class="metric-bottom"><span><i class="legend-dot amber"></i>Root-Dateisystem</span><b id="diskTotal">—</b></div></article><article class="metric-card network-card"><div class="metric-top"><span>NETZWERK · DURCHSATZ</span><span class="metric-icon green">${icons.cloud}</span></div><div class="network-readings"><div><span class="network-direction">↓ EMPFANGEN</span><b id="rxValue">—</b></div><div><span class="network-direction">↑ GESENDET</span><b id="txValue">—</b></div></div><canvas class="sparkline" id="networkChart" height="48"></canvas><div class="metric-bottom"><span><i class="legend-dot green"></i>Über alle Interfaces</span><b id="netTrend">Live</b></div></article></div><div class="monitor-note">${icons.shield}<span>Messwerte werden direkt vom Server gelesen und nicht gespeichert.</span><span class="monitor-legend"><i></i>Live-Daten</span></div></div></section>
        <section class="route-view settings-view" id="view-settings"><div class="settings-page-heading"><div><div class="eyebrow">SERVER-PROFIL</div><h2>Einstellungen</h2><p>Beschreibungen und Tags helfen dir, deine Maschinen zu organisieren. Hier kannst du außerdem einen Neustart auslösen.</p></div></div><div id="hostSettingsContent"></div></section>
        <div class="upload-progress" id="uploadProgress" hidden><div class="upload-progress-icon">${icons.upload}</div><div class="upload-progress-copy"><b id="uploadName">Datei wird übertragen</b><span id="uploadPercent">0%</span></div><div class="upload-track"><span id="uploadBar"></span></div><button class="icon-button" id="cancelUpload">${icons.close}</button></div>
      </div>
    </main>
  </div>
  <button type="button" class="sidebar-backdrop" id="sidebarBackdrop" aria-label="Servermenü schließen" hidden></button>
  <div class="modal-root" id="modalRoot"></div>
  <div class="toast-stack" id="toastStack"></div>
`;
root.classList.add('auth-checking');

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

async function api(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...(options.body && !(options.body instanceof File) ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(body?.error || `Anfrage fehlgeschlagen (${response.status})`);
    error.status = response.status;
    error.data = body;
    if (response.status === 401 && !url.startsWith('/api/auth/')) showAuthScreen('login', 'Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.');
    throw error;
  }
  return body;
}

function terminalThemeFor(theme) {
  const common = { black: '#242731', red: '#ff777f', green: '#61d99d', yellow: '#eacb77', blue: '#7faeff', magenta: '#7ce9df', cyan: '#6bd5df', white: '#dce2ed', brightBlack: '#646d80', brightRed: '#ff969c', brightGreen: '#83e6b1', brightYellow: '#f5d88d', brightBlue: '#9bc0ff', brightMagenta: '#b7f3ed', brightCyan: '#8ce3ea', brightWhite: '#ffffff' };
  const palettes = {
    'material-dark': { background: '#080c25', foreground: '#eef2ff', cursor: '#8c83ff', cursorAccent: '#080c25', selectionBackground: '#8c83ff55', magenta: '#8c83ff', brightMagenta: '#b5a0ff', blue: '#6176ff', brightBlue: '#91a0ff', cyan: '#44e2ff', brightCyan: '#8deeff' },
    'material-white': { background: '#ffffff', foreground: '#172020', cursor: '#167c76', cursorAccent: '#ffffff', selectionBackground: '#167c7633', magenta: '#167c76', brightMagenta: '#2f9e97', white: '#172020', brightWhite: '#38343b' },
    muxxle: { background: '#140b0c', foreground: '#f2dfe0', cursor: '#7ce9df', cursorAccent: '#140b0c', selectionBackground: '#7ce9df55', magenta: '#7ce9df', brightMagenta: '#b7f3ed' }
  };
  return { ...common, ...(palettes[theme] || palettes['material-dark']) };
}

function applyTheme(theme) {
  const selected = ACCOUNT_THEMES.includes(theme) ? theme : 'material-dark';
  document.documentElement.dataset.theme = selected;
  const overlayUpdate = window.nextermDesktop?.setWindowTheme?.(selected);
  overlayUpdate?.catch?.(() => {});
  for (const entry of state.terminalEntries.values()) entry.terminal.options.theme = terminalThemeFor(selected);
  return selected;
}

function saveTheme(theme) {
  const selected = applyTheme(theme);
  drawCharts();
  const userId = state.user?.id;
  if (!userId) return;
  themeSaveQueue = themeSaveQueue.catch(() => {}).then(async () => {
    const result = await api('/api/auth/preferences', { method: 'PATCH', body: JSON.stringify({ theme: selected }) });
    if (state.user?.id === userId) state.user = result.user;
  }).catch(error => {
    if (state.user?.id === userId && $('#themeSelect')?.value === selected) {
      const savedTheme = applyTheme(state.user.theme);
      $('#themeSelect').value = savedTheme;
      toast(`Theme konnte nicht gespeichert werden: ${error.message}`, 'error');
    }
  });
}

function showAuthScreen(mode = 'login', errorMessage = '') {
  const registering = mode === 'register';
  root.classList.remove('auth-checking');
  root.classList.add('auth-screen');
  root.innerHTML = `
    <div class="auth-layout">
      <aside class="auth-aside">
        <div class="auth-brand"><span class="brand-mark">${icons.brand}</span><span>Termxxle</span></div>
        <div class="auth-pitch"><span class="auth-local-tag"><i></i> ${isLocalInstance ? 'PRIVATER SERVER-WORKSPACE' : 'VERBINDUNG ZUM WEBSERVER'}</span><h1>Deine Server.<br><em>Dein Zugang.</em></h1><p>Ein persönliches Konto für deine SSH-Verbindungen, Dateien und Live-Serverdaten.</p><div class="auth-feature-list"><div>${icons.shield}<span><b>Deine eigenen Clients</b><small>Serverprofile bleiben deinem Konto zugeordnet.</small></span></div><div>${icons.key}<span><b>Passwort oder SSH-Key</b><small>Wähle den passenden Weg für jeden Server.</small></span></div><div>${icons.lock}<span><b>${isLocalInstance ? 'Lokal auf diesem Gerät' : 'Auf deinem Webserver'}</b><small>${isLocalInstance ? 'Keine Cloud-Synchronisierung.' : 'Anmeldung mit deinem Serverkonto.'}</small></span></div></div></div>
        <div class="auth-aside-bottom"><span>SSH · SFTP · MONITORING</span><span>${isLocalInstance ? 'LOKALER TRESOR' : 'WEBSERVER'}</span></div>
      </aside>
      <main class="auth-main"><section class="auth-card"><div class="auth-mobile-brand"><span class="brand-mark">${icons.brand}</span><span>Termxxle</span></div><div class="auth-card-kicker">${registering ? 'NEUES LOKALES KONTO' : 'SICHERER ZUGANG'}</div><h2>${registering ? 'Konto anlegen' : 'Willkommen zurück'}</h2><p class="auth-card-intro">${registering ? 'Erstelle dein persönliches Konto und verwalte deine eigenen Server.' : 'Melde dich an, um deine Server und Verbindungen zu öffnen.'}</p>
        <form id="appAuthForm" novalidate>${registering ? `<label class="form-field"><span>Anzeigename</span><input name="name" placeholder="Dein Name" autocomplete="name" maxlength="60" required></label><label class="form-field"><span>E-Mail-Adresse</span><input name="email" type="email" placeholder="name@example.com" autocomplete="email" maxlength="254" required></label>${state.adminBootstrapRequired ? `<label class="form-field"><span>Einmaliger Administrator-Startcode</span><input name="adminBootstrapToken" type="password" placeholder="Startcode aus der Serverkonfiguration" autocomplete="off" maxlength="512" required></label><p class="auth-bootstrap-note">${state.adminBootstrapConfigured ? 'Dieser einmalige Code wird nur für das erste Administratorkonto benötigt.' : 'Die Erstregistrierung ist noch gesperrt. Der Betreiber muss TERMXXLE_ADMIN_BOOTSTRAP_TOKEN mit mindestens 32 Zeichen in der Serverkonfiguration setzen.'}</p>` : ''}` : ''}<label class="form-field"><span>Benutzername</span><input name="username" placeholder="z. B. alex" autocomplete="username" minlength="3" maxlength="32" required></label><label class="form-field"><span>Passwort${registering ? ' · mindestens 12 Zeichen' : ''}</span><input name="password" type="password" placeholder="${registering ? 'Mindestens 12 Zeichen' : 'Dein Passwort'}" autocomplete="${registering ? 'new-password' : 'current-password'}" ${registering ? 'minlength="12"' : ''} maxlength="256" required></label><div class="auth-form-error" id="authError" ${errorMessage ? '' : 'hidden'}>${escapeHtml(errorMessage)}</div><button class="button button-primary auth-submit" id="authSubmit" type="submit" ${registering && state.adminBootstrapRequired && !state.adminBootstrapConfigured ? 'disabled' : ''}>${registering ? 'Konto erstellen' : 'Anmelden'}${icons.arrow}</button></form>
        ${!registering && state.passwordResetEnabled ? '<button type="button" class="auth-reset-link" id="requestReset">Passwort vergessen?</button>' : ''}<div class="auth-switch">${registering ? 'Schon ein Konto?' : 'Noch kein Konto?'} <button type="button" id="authSwitch">${registering ? 'Anmelden' : 'Konto anlegen'}</button></div><div class="auth-card-security">${icons.lock}<span>Passwörter werden nur als gesalzener Hash gespeichert. Serverzugänge gehören jeweils zu deinem Konto.</span></div>
      </section><div class="auth-main-foot">${isLocalInstance ? 'Deine Kontodaten bleiben verschlüsselt auf diesem Gerät.' : 'Melde dich mit dem Konto dieser Serverinstanz an.'}<br>Termxxle · v${packageInfo.version}</div></main>
    </div>`;

  $('#authSwitch').addEventListener('click', () => showAuthScreen(registering ? 'login' : 'register'));
  $('#requestReset')?.addEventListener('click', requestPasswordReset);
  $('#appAuthForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const username = String(form.get('username') || '').trim();
    const password = String(form.get('password') || '');
    const name = String(form.get('name') || '').trim();
    const email = String(form.get('email') || '').trim();
    const adminBootstrapToken = String(form.get('adminBootstrapToken') || '');
    const error = $('#authError');
    const submit = $('#authSubmit');
    error.hidden = true;
    if (registering && !name) { error.textContent = 'Bitte gib deinen Anzeigenamen ein.'; error.hidden = false; return; }
    if (registering && !email) { error.textContent = 'Bitte gib deine E-Mail-Adresse ein.'; error.hidden = false; return; }
    if (registering && state.adminBootstrapRequired && !adminBootstrapToken) { error.textContent = 'Für das erste Administratorkonto ist der Startcode erforderlich.'; error.hidden = false; return; }
    if (!username || !password) { error.textContent = 'Benutzername und Passwort sind erforderlich.'; error.hidden = false; return; }
    if (registering && password.length < 12) { error.textContent = 'Wähle ein Passwort mit mindestens 12 Zeichen.'; error.hidden = false; return; }
    submit.disabled = true;
    submit.innerHTML = '<span class="spinner"></span>Wird verarbeitet…';
    try {
      const result = registering
        ? await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ name, username, email, password, adminBootstrapToken }) })
        : await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      if (result.factorRequired) showFactorScreen(result.methods, username);
      else await mountWorkspace(result.user);
    } catch (authError) {
      const currentError = $('#authError');
      const currentSubmit = $('#authSubmit');
      if (!currentError || !currentSubmit) return;
      currentError.textContent = authError.message;
      currentError.hidden = false;
      currentSubmit.disabled = false;
      currentSubmit.innerHTML = `${registering ? 'Konto erstellen' : 'Anmelden'}${icons.arrow}`;
    }
  });
  setTimeout(() => $('#appAuthForm input[name="username"]')?.focus(), 30);
}

async function requestPasswordReset() {
  const email = prompt('E-Mail-Adresse deines Kontos:');
  if (!email) return;
  try {
    const result = await api('/api/auth/request-reset', { method: 'POST', body: JSON.stringify({ email }) });
    toast(result.message || 'Wenn das Konto existiert, wurde ein Link versendet.');
  } catch (error) { toast(error.message, 'error'); }
}

function showFactorScreen(methods, username) {
  root.classList.remove('auth-checking');
  root.classList.add('auth-screen');
  root.innerHTML = `<div class="auth-layout"><aside class="auth-aside"><div class="auth-brand"><span class="brand-mark">${icons.brand}</span><span>Termxxle</span></div><div class="auth-pitch"><span class="auth-local-tag"><i></i> ZWEITER FAKTOR</span><h1>Bestätige<br><em>deine Anmeldung.</em></h1><p>Gib den Code aus deiner Authenticator-App ein oder verwende einen gespeicherten Wiederherstellungscode.</p></div><div class="auth-aside-bottom"><span>SSH · SFTP · MONITORING</span><span>${isLocalInstance ? 'LOKALER TRESOR' : 'WEBSERVER'}</span></div></aside><main class="auth-main"><section class="auth-card"><div class="auth-card-kicker">ZUSÄTZLICHE BESTÄTIGUNG</div><h2>Anmeldung schützen</h2><p class="auth-card-intro">Konto <b>${escapeHtml(username)}</b></p><form id="factorForm"><label class="form-field"><span>Authenticator- oder Wiederherstellungscode</span><input name="code" autocomplete="one-time-code" inputmode="text" maxlength="32" required></label><div class="auth-form-error" id="factorError" hidden></div><button class="button button-primary auth-submit" type="submit">Bestätigen${icons.arrow}</button></form>${methods.passkey ? `<button type="button" class="button button-secondary factor-passkey" id="factorPasskey">Mit Passkey bestätigen</button>` : ''}<button type="button" class="auth-reset-link" id="factorBack">Zurück zur Anmeldung</button><div class="auth-card-security">${icons.lock}<span>Wiederherstellungscodes können jeweils nur einmal verwendet werden.</span></div></section></main></div>`;
  $('#factorForm').addEventListener('submit', async event => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') || '').trim();
    try {
      const result = await api('/api/auth/verify-factor', { method: 'POST', body: JSON.stringify({ code }) });
      await mountWorkspace(result.user);
    } catch (error) { const box = $('#factorError'); box.textContent = error.message; box.hidden = false; }
  });
  $('#factorPasskey')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      const options = await api('/api/auth/passkeys/login/options', { method: 'POST', body: '{}' });
      const credential = await startAuthentication({ optionsJSON: options });
      const result = await api('/api/auth/passkeys/login/verify', { method: 'POST', body: JSON.stringify(credential) });
      await mountWorkspace(result.user);
    } catch (error) { const box = $('#factorError'); box.textContent = error.message; box.hidden = false; event.currentTarget.disabled = false; }
  });
  $('#factorBack').addEventListener('click', () => showAuthScreen('login', 'Bitte melde dich erneut an.'));
}

function showResetScreen(token) {
  root.classList.remove('auth-checking');
  root.classList.add('auth-screen');
  root.innerHTML = `<div class="auth-layout reset-layout"><main class="auth-main"><section class="auth-card"><div class="auth-card-kicker">PASSWORT ZURÜCKSETZEN</div><h2>Neues Passwort</h2><p class="auth-card-intro">Wähle ein neues Passwort mit mindestens 12 Zeichen.</p><form id="resetForm"><label class="form-field"><span>Neues Passwort</span><input type="password" name="password" minlength="12" maxlength="256" autocomplete="new-password" required></label><div class="auth-form-error" id="resetError" hidden></div><button class="button button-primary auth-submit" type="submit">Passwort speichern${icons.arrow}</button></form></section></main></div>`;
  $('#resetForm').addEventListener('submit', async event => {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get('password') || '');
    try {
      await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) });
      history.replaceState({}, '', location.pathname);
      showAuthScreen('login', 'Passwort gespeichert. Du kannst dich jetzt anmelden.');
    } catch (error) { const box = $('#resetError'); box.textContent = error.message; box.hidden = false; }
  });
}

function showLocalVaultError(message) {
  root.classList.remove('auth-checking', 'auth-screen');
  root.innerHTML = `<main class="local-vault-error"><div class="local-vault-error-mark">${icons.lock}</div><div class="eyebrow">WINDOWS-TRESOR</div><h1>Lokaler Tresor nicht verfügbar</h1><p>${escapeHtml(message || 'Der lokale Tresor konnte nicht geöffnet werden.')}</p><button type="button" class="button button-primary" id="retryLocalVault">Erneut versuchen</button></main>`;
  $('#retryLocalVault').addEventListener('click', () => location.reload());
}

async function mountWorkspace(user) {
  state.user = user;
  user.theme = applyTheme(user.theme);
  root.classList.remove('auth-screen', 'auth-checking');
  root.innerHTML = appMarkup;
  $('#themeSelect').value = user.theme;
  $('#accountName').textContent = user.name;
  $('#accountUsername').textContent = `@${user.username}`;
  if (isLocalDesktopVault) {
    $('#accountName').textContent = 'Lokaler Tresor';
    $('#accountUsername').textContent = 'Verschlüsselt auf diesem Gerät';
    $('#headerAvatar').hidden = true;
    $('#logoutButton').hidden = true;
  }
  $('#accountAvatar').textContent = user.name.slice(0, 1).toUpperCase();
  $('#headerAvatar').textContent = user.name.slice(0, 1).toUpperCase();
  $('#settingsButton').hidden = isLocalDesktopVault || user.role !== 'admin';
  $('#mobileAdminSettings').hidden = isLocalDesktopVault || user.role !== 'admin';
  bindEvents();
  await loadWorkspace();
  if (!isLocalDesktopVault && (user.mustChangePassword || !user.email)) openAccountModal(Boolean(user.mustChangePassword), !user.email);
}

async function logoutUser() {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  if (state.monitorTimer) clearInterval(state.monitorTimer);
  for (const entry of state.terminalEntries.values()) {
    entry.resizeObserver.disconnect();
    entry.socket.close();
    entry.terminal.dispose();
  }
  state.terminalEntries.clear();
  state.user = null;
  applyTheme('material-dark');
  state.hosts = [];
  state.sessions = [];
  state.activeId = null;
  state.selectedHostId = null;
  state.metrics = [];
  state.metricsSession = null;
  state.latestMetrics = null;
  state.filePath = '';
  state.fileSession = null;
  state.files = [];
  state.query = '';
  state.monitorTimer = null;
  showAuthScreen('login', 'Du wurdest abgemeldet.');
}

function toast(message, kind = 'success') {
  if (!$('#toastStack')) return;
  const item = document.createElement('div');
  item.className = `toast ${kind}`;
  item.innerHTML = `<span class="toast-icon">${kind === 'error' ? icons.close : icons.shield}</span><span>${escapeHtml(message)}</span>`;
  $('#toastStack').append(item);
  setTimeout(() => { item.classList.add('leaving'); setTimeout(() => item.remove(), 220); }, 3600);
}

function sessionFor(hostId) { return state.sessions.find(session => session.host.id === hostId); }
function activeSession() { return state.sessions.find(session => session.id === state.activeId); }

function renderHosts() {
  const query = state.query.trim().toLowerCase();
  const hosts = state.hosts.filter(host => !query || `${host.name} ${host.host} ${host.username} ${host.description || ''} ${(host.tags || []).join(' ')}`.toLowerCase().includes(query));
  $('#hostCount').textContent = String(state.hosts.length);
  $('#hostList').innerHTML = hosts.length ? hosts.map(host => {
    const session = sessionFor(host.id);
    const active = host.id === state.selectedHostId || session?.id === state.activeId;
    return `<div class="host-row ${active ? 'selected' : ''} ${session ? 'is-connected' : ''}"><button class="host-row-main" data-host-id="${escapeHtml(host.id)}"><span class="host-glyph">${icons.server}<i class="${session ? 'online' : ''}"></i></span><span class="host-row-copy"><b>${escapeHtml(host.name)}</b><small>${escapeHtml(host.username)}@${escapeHtml(host.host)}</small></span><span class="host-row-actions"><span class="host-state-dot ${session ? 'on' : ''}"></span>${!session ? `<span class="host-chevron">${icons.chevron}</span>` : ''}</span></button><button type="button" class="host-row-menu" data-menu="${escapeHtml(host.id)}" aria-label="Optionen für ${escapeHtml(host.name)}">${icons.dots}</button></div>`;
  }).join('') : `<div class="side-empty">${query ? 'Keine Treffer.' : 'Noch keine Server gespeichert.'}</div>`;
  $('#hostList').querySelectorAll('[data-host-id]').forEach(row => row.addEventListener('click', () => openHostOverview(row.dataset.hostId)));
  $('#hostList').querySelectorAll('[data-menu]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); openHostMenu(button.dataset.menu, button); }));
  renderOverview();
}

function renderOverview() {
  $('#overviewHostCount').textContent = String(state.hosts.length).padStart(2, '0');
  $('#overviewSessionCount').textContent = String(state.sessions.length).padStart(2, '0');
  $('#serverCards').innerHTML = state.hosts.length ? state.hosts.map(host => {
    const session = sessionFor(host.id);
    const tags = Array.isArray(host.tags) ? host.tags : [];
    return `<article class="server-card"><div class="server-card-top"><div class="server-card-avatar">${icons.server}</div><button class="icon-button host-menu-button" data-menu="${escapeHtml(host.id)}" aria-label="Serveroptionen">${icons.dots}</button></div><button type="button" class="server-card-info" data-overview="${escapeHtml(host.id)}" aria-label="Übersicht für ${escapeHtml(host.name)} öffnen"><span class="server-card-name"><span class="server-card-title">${escapeHtml(host.name)}</span><span class="server-status ${session ? 'online' : ''}"><i></i>${session ? 'Verbunden' : 'Getrennt'}</span></span><span class="server-address">${escapeHtml(host.username)}<span>@</span>${escapeHtml(host.host)}<span>:</span>${host.port}</span>${host.description ? `<span class="server-card-description">${escapeHtml(host.description)}</span>` : ''}${tags.length ? `<span class="server-card-tags">${tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</span>` : ''}<span class="server-card-meta"><span>${icons.key}${host.fingerprint ? 'Schlüssel bestätigt' : 'Fingerabdruck beim Erstkontakt'}</span><span>Port ${host.port}</span></span></button><div class="server-card-bottom"><button class="button ${session ? 'button-secondary' : 'button-primary'} card-connect" data-connect="${escapeHtml(host.id)}">${session ? icons.terminal : icons.arrow}${session ? 'Terminal öffnen' : 'Verbinden'}</button><button class="button icon-square" data-open-files="${escapeHtml(host.id)}" title="Dateien" aria-label="Dateien">${icons.files}</button><button class="button icon-square" data-open-monitor="${escapeHtml(host.id)}" title="Monitoring" aria-label="Monitoring">${icons.chart}</button></div></article>`;
  }).join('') : `<div class="empty-server-card"><div class="empty-server-icon">${icons.server}</div><div><b>Hier erscheinen deine Server</b><span>Füge eine Verbindung hinzu, um SSH, SFTP und Monitoring zu starten.</span></div><button class="button button-secondary" id="emptyAdd">${icons.plus}Server hinzufügen</button></div>`;
  $('#serverCards').querySelectorAll('[data-connect]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); selectHost(button.dataset.connect); }));
  $('#serverCards').querySelectorAll('[data-open-files]').forEach(button => button.addEventListener('click', () => selectHost(button.dataset.openFiles, 'files')));
  $('#serverCards').querySelectorAll('[data-open-monitor]').forEach(button => button.addEventListener('click', () => selectHost(button.dataset.openMonitor, 'monitoring')));
  $('#serverCards').querySelectorAll('[data-overview]').forEach(button => button.addEventListener('click', () => openHostOverview(button.dataset.overview)));
  $('#serverCards').querySelectorAll('[data-menu]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); openHostMenu(button.dataset.menu, button); }));
  $('#emptyAdd')?.addEventListener('click', openHostModal);
}

function openHostMenu(hostId, button) {
  document.querySelector('.host-popover')?.remove();
  const host = state.hosts.find(item => item.id === hostId);
  if (!host) return;
  const menu = document.createElement('div');
  menu.className = 'host-popover';
  menu.innerHTML = `<button data-action="connect">${icons.terminal}Verbinden</button><button data-action="settings">${icons.settings}Einstellungen</button><button data-action="delete" class="delete-action">${icons.close}Server entfernen</button>`;
  const anchor = button.closest('.server-card, .host-row');
  anchor.append(menu);
  menu.querySelector('[data-action="connect"]').onclick = () => { menu.remove(); selectHost(hostId); };
  menu.querySelector('[data-action="settings"]').onclick = () => { menu.remove(); selectHostProfile(hostId, 'settings'); };
  menu.querySelector('[data-action="delete"]').onclick = () => { menu.remove(); void deleteHost(hostId); };
  setTimeout(() => document.addEventListener('click', function closeMenu(event) { if (!menu.contains(event.target)) { menu.remove(); document.removeEventListener('click', closeMenu); } }, { once: true }), 0);
}

async function deleteHost(hostId) {
  const host = state.hosts.find(item => item.id === hostId);
  if (!host || !confirm(`Server „${host.name}“ aus deinen gespeicherten Verbindungen entfernen?`)) return;
  try {
    const session = sessionFor(hostId);
    if (session) await disconnectSession(session.id);
    await api(`/api/hosts/${encodeURIComponent(hostId)}`, { method: 'DELETE' });
    state.hosts = state.hosts.filter(item => item.id !== hostId);
    if (state.selectedHostId === hostId) state.selectedHostId = state.hosts[0]?.id || null;
    renderHosts();
    $('#modalRoot').innerHTML = '';
    toast('Server entfernt.');
  } catch (error) { toast(error.message, 'error'); }
}

function openHostOverview(hostId) {
  const host = state.hosts.find(item => item.id === hostId);
  if (!host) return;
  setMobileSidebarOpen(false);
  state.selectedHostId = hostId;
  renderHosts();
  const session = sessionFor(hostId);
  const tags = Array.isArray(host.tags) ? host.tags : [];
  const modalRoot = $('#modalRoot');
  modalRoot.innerHTML = `<div class="modal-backdrop host-overview-backdrop"><section class="modal-card host-overview-modal" role="dialog" aria-modal="true" aria-labelledby="hostOverviewTitle"><div class="modal-top"><div><div class="eyebrow">SERVER-ÜBERSICHT</div><h2 id="hostOverviewTitle">${escapeHtml(host.name)}</h2></div><button type="button" class="icon-button modal-close" aria-label="Übersicht schließen">${icons.close}</button></div><p class="host-overview-address">${escapeHtml(host.username)}@${escapeHtml(host.host)}:${host.port}</p><div class="host-overview-status"><span class="server-status ${session ? 'online' : ''}"><i></i>${session ? 'Verbunden' : 'Getrennt'}</span><span>${session ? 'Aktive SSH-Sitzung' : 'Noch keine aktive Sitzung'}</span></div><section class="host-overview-section"><h3>Beschreibung</h3><p>${host.description ? escapeHtml(host.description) : '<span class="host-overview-empty">Keine Beschreibung hinterlegt.</span>'}</p></section><section class="host-overview-section"><h3>Tags</h3><div class="server-card-tags">${tags.length ? tags.map(tag => `<span>${escapeHtml(tag)}</span>`).join('') : '<span class="host-overview-empty">Keine Tags hinterlegt.</span>'}</div></section><dl class="host-overview-details"><div><dt>SSH-Port</dt><dd>${host.port}</dd></div><div><dt>Protokoll</dt><dd>SSH</dd></div><div><dt>Host-Schlüssel</dt><dd>${host.fingerprint ? 'Bestätigt' : 'Beim Erstkontakt zu prüfen'}</dd></div></dl><div class="host-overview-actions"><button type="button" class="button button-primary" data-host-action="connect">${session ? icons.terminal : icons.arrow}${session ? 'Terminal öffnen' : 'Verbinden'}</button><button type="button" class="button button-secondary" data-host-action="files">${icons.files}Dateien</button><button type="button" class="button button-secondary" data-host-action="monitoring">${icons.chart}Monitoring</button><button type="button" class="button button-secondary" data-host-action="settings">${icons.settings}Einstellungen</button></div><div class="host-overview-footer"><button type="button" class="button button-danger" data-host-action="delete">${icons.close}Server entfernen</button><button type="button" class="button button-secondary modal-close">Schließen</button></div></section></div>`;
  const close = () => { modalRoot.innerHTML = ''; };
  modalRoot.querySelectorAll('.modal-close').forEach(button => button.addEventListener('click', close));
  modalRoot.querySelector('.host-overview-backdrop').addEventListener('click', event => { if (event.target === event.currentTarget) close(); });
  modalRoot.querySelectorAll('[data-host-action]').forEach(button => button.addEventListener('click', () => {
    const action = button.dataset.hostAction;
    close();
    if (action === 'delete') void deleteHost(hostId);
    else selectHost(hostId, action === 'connect' ? null : action);
  }));
  modalRoot.querySelector('.modal-close')?.focus();
}

function setMobileSidebarOpen(open) {
  const sidebar = $('#appSidebar');
  const button = $('#mobileMenu');
  const backdrop = $('#sidebarBackdrop');
  sidebar?.classList.toggle('mobile-open', open);
  if (button) {
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Servermenü schließen' : 'Servermenü öffnen');
  }
  if (backdrop) backdrop.hidden = !open;
}

function setRoute(route) {
  if (!['overview', 'terminal', 'files', 'monitoring', 'settings'].includes(route)) return;
  state.route = route;
  document.querySelectorAll('.route-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.route === route));
  document.querySelectorAll('.route-view').forEach(view => view.classList.toggle('active', view.id === `view-${route}`));
  const routeNames = { overview: 'ÜBERSICHT', terminal: 'TERMINAL', files: 'DATEIEN', monitoring: 'MONITORING', settings: 'EINSTELLUNGEN' };
  $('#breadcrumbName').textContent = routeNames[route];
  updateConnectionChrome();
  if (route === 'terminal' && activeSession()) ensureTerminal(activeSession());
  if (route === 'files') loadFiles();
  if (route === 'monitoring') {
    drawCharts();
    refreshMetrics();
  }
  if (route === 'settings') renderHostSettings();
}

function updateConnectionChrome() {
  const session = activeSession();
  const closedHost = !session && state.route === 'terminal' ? state.closedTerminalHost : null;
  const indicator = $('#connectionIndicator');
  indicator.classList.toggle('connected', Boolean(session));
  indicator.innerHTML = session ? `<span></span>${escapeHtml(session.host.name)} verbunden` : '<span></span>Keine aktive Verbindung';
  $('#termTabDot').classList.toggle('visible', Boolean(session));
  $('#quickTerminal').disabled = !session;
  $('#disconnectButton').disabled = !session;
  $('.terminal-toolbar .status-dot').classList.toggle('disconnected', !session);
  if (session) {
    state.closedTerminalHost = null;
    $('#terminalHostName').textContent = session.host.name;
    $('#terminalHostAddress').textContent = `${session.host.username}@${session.host.host}`;
    $('#terminalHostName').classList.remove('connection-lost');
    $('#fileHostName').textContent = session.host.name;
    $('#monitorHostName').textContent = session.host.name;
    $('#filePathLabel').textContent = state.fileSession === session.id ? state.filePath : session.home;
  } else {
    $('#terminalHostName').textContent = closedHost ? `${closedHost.name} · Sitzung beendet` : 'Kein Server verbunden';
    $('#terminalHostAddress').textContent = closedHost ? `${closedHost.username}@${closedHost.host}` : '';
    $('#terminalHostName').classList.toggle('connection-lost', Boolean(closedHost));
    $('#fileHostName').textContent = 'Server auswählen';
    $('#monitorHostName').textContent = 'Server auswählen';
    $('#filePathLabel').textContent = '—';
  }
}

async function selectHost(hostId, targetRoute = null) {
  setMobileSidebarOpen(false);
  const host = state.hosts.find(item => item.id === hostId);
  if (!host) return;
  state.selectedHostId = hostId;
  const existing = sessionFor(hostId);
  if (existing) {
    state.closedTerminalHost = null;
    state.activeId = existing.id;
    if (state.metricsSession !== existing.id) resetMetrics(existing.id);
    updateConnectionChrome();
    renderHosts();
    setRoute(targetRoute || 'terminal');
    return;
  }
  openAuthModal(host, targetRoute);
}

function selectHostProfile(hostId, route = 'settings') {
  if (!state.hosts.some(host => host.id === hostId)) return;
  state.selectedHostId = hostId;
  setMobileSidebarOpen(false);
  renderHosts();
  setRoute(route);
}

function renderHostSettings() {
  const root = $('#hostSettingsContent');
  if (!root) return;
  const host = state.hosts.find(item => item.id === state.selectedHostId);
  if (!host) {
    root.innerHTML = `<div class="host-settings-empty"><div class="empty-server-icon">${icons.settings}</div><h3>Wähle eine Maschine</h3><p>Öffne das Servermenü oder die Einstellungen auf einer Serverkarte, um Beschreibung, Tags und Neustartoptionen zu verwalten.</p><button type="button" class="button button-primary" id="settingsAddHost">${icons.plus}Server hinzufügen</button></div>`;
    $('#settingsAddHost').addEventListener('click', openHostModal);
    return;
  }
  const session = sessionFor(host.id);
  root.innerHTML = `<div class="host-settings-grid"><form class="host-settings-card" id="hostDetailsForm"><div class="settings-section-heading"><div><span class="eyebrow">MASCHINENPROFIL</span><h3>${escapeHtml(host.name)}</h3></div><span class="server-status ${session ? 'online' : ''}"><i></i>${session ? 'Verbunden' : 'Getrennt'}</span></div><p class="settings-help">${escapeHtml(host.username)}@${escapeHtml(host.host)}:${host.port}</p><label class="form-field"><span>Beschreibung</span><textarea name="description" rows="4" maxlength="500" placeholder="Wofür wird diese Maschine verwendet?">${escapeHtml(host.description || '')}</textarea></label><label class="form-field"><span>Tags</span><input name="tags" maxlength="400" value="${escapeHtml((host.tags || []).join(', '))}" placeholder="z. B. Produktion, EU, Datenbank"><small>Mehrere Tags mit Kommas trennen (maximal 12).</small></label><div class="settings-form-footer"><span class="settings-help">Nur in diesem Workspace gespeichert.</span><button type="submit" class="button button-primary">Änderungen speichern</button></div></form><section class="host-settings-card reboot-card"><div class="settings-section-heading"><div><span class="eyebrow">WARTUNG</span><h3>Maschine neu starten</h3></div><span class="reboot-icon">${icons.refresh}</span></div><p>Sendet den Befehl <code>reboot</code> über die aktive SSH-Terminalsitzung. Die Maschine und Verbindung werden dabei neu gestartet.</p><button type="button" class="button button-danger" id="rebootHost" ${session ? '' : 'disabled'}>${icons.refresh}Jetzt neu starten</button><small>${session ? 'Die Sitzung ist verbunden. Der angemeldete SSH-Benutzer muss Neustarts ausführen dürfen.' : 'Verbinde dich zuerst mit dieser Maschine über SSH.'}</small>${!session ? `<button type="button" class="button button-secondary" id="connectForSettings">${icons.terminal}SSH verbinden</button>` : ''}</section></div>`;
  $('#hostDetailsForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submit = event.currentTarget.querySelector('[type="submit"]');
    const tags = String(form.get('tags') || '').split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 12);
    submit.disabled = true;
    try {
      const updated = await api(`/api/hosts/${encodeURIComponent(host.id)}`, { method: 'PATCH', body: JSON.stringify({ description: form.get('description'), tags }) });
      state.hosts = state.hosts.map(item => item.id === updated.id ? updated : item);
      state.sessions = state.sessions.map(item => item.host.id === updated.id ? { ...item, host: updated } : item);
      renderHosts();
      renderHostSettings();
      toast('Maschinenprofil gespeichert.');
    } catch (error) { toast(error.message, 'error'); submit.disabled = false; }
  });
  $('#rebootHost')?.addEventListener('click', async event => {
    const reboot = event.currentTarget;
    const currentSession = sessionFor(host.id);
    if (!currentSession || !confirm(`Maschine „${host.name}“ jetzt mit dem Befehl reboot neu starten?`)) return;
    reboot.disabled = true;
    try {
      await api(`/api/sessions/${encodeURIComponent(currentSession.id)}/reboot`, { method: 'POST', body: '{}' });
      toast('Neustartbefehl ans SSH-Terminal gesendet. Die Sitzung kann abbrechen.');
    } catch (error) { toast(error.message, 'error'); reboot.disabled = false; }
  });
  $('#connectForSettings')?.addEventListener('click', () => selectHost(host.id, 'settings'));
}

function resetMetrics(sessionId) {
  state.metricsSession = sessionId;
  state.metrics = [];
  state.latestMetrics = null;
  updateMetricDisplay(null);
  if (state.monitorTimer) clearInterval(state.monitorTimer);
  if (sessionId) {
    state.monitorTimer = setInterval(() => { if (state.activeId === sessionId) refreshMetrics(); }, 3000);
    refreshMetrics();
  } else if (state.monitorTimer) {
    clearInterval(state.monitorTimer);
    state.monitorTimer = null;
  }
}

function openHostModal() {
  $('#modalRoot').innerHTML = `<div class="modal-backdrop"><form class="modal-card" id="hostForm"><div class="modal-top"><div><div class="eyebrow">NEUE VERBINDUNG</div><h2>Server hinzufügen</h2></div><button type="button" class="icon-button modal-close" aria-label="Schließen">${icons.close}</button></div><p class="modal-description">Speichere die Verbindungsdaten. Zugangsdaten werden erst beim Verbinden abgefragt.</p><label class="form-field"><span>Bezeichnung</span><input name="name" placeholder="z. B. Production · Frankfurt" required maxlength="80" autocomplete="off"></label><div class="form-row"><label class="form-field grow"><span>Hostname oder IP-Adresse</span><input name="host" placeholder="server.example.com" required autocomplete="off" spellcheck="false"></label><label class="form-field port-field"><span>Port</span><input name="port" type="number" min="1" max="65535" value="22" required></label></div><label class="form-field"><span>Benutzername</span><input name="username" placeholder="root" required autocomplete="off" spellcheck="false"></label><label class="form-field"><span>Beschreibung <small>(optional)</small></span><textarea name="description" rows="3" maxlength="500" placeholder="Wofür wird diese Maschine verwendet?"></textarea></label><label class="form-field"><span>Tags <small>(optional)</small></span><input name="tags" maxlength="400" placeholder="Produktion, EU, Datenbank"><small>Mehrere Tags mit Kommas trennen.</small></label><div class="secure-inline">${icons.lock}<span>Deine Serverliste wird verschlüsselt in diesem Workspace gespeichert.</span></div><div class="modal-footer"><button type="button" class="button button-secondary modal-cancel">Abbrechen</button><button type="submit" class="button button-primary">Server speichern${icons.arrow}</button></div></form></div>`;
  const close = () => { $('#modalRoot').innerHTML = ''; };
  $('#modalRoot').querySelectorAll('.modal-close, .modal-cancel, .modal-backdrop').forEach(element => element.addEventListener('click', event => { if (event.target === element || element.classList.contains('modal-close') || element.classList.contains('modal-cancel')) close(); }));
  $('#hostForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submit = event.currentTarget.querySelector('[type="submit"]');
    submit.disabled = true;
    submit.innerHTML = '<span class="spinner"></span>Wird gespeichert…';
    try {
      const tags = String(form.get('tags') || '').split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 12);
      const host = await api('/api/hosts', { method: 'POST', body: JSON.stringify({ name: form.get('name'), host: form.get('host'), port: form.get('port'), username: form.get('username'), description: form.get('description'), tags }) });
      state.hosts.push(host);
      renderHosts();
      close();
      toast('Server gespeichert. Jetzt kannst du dich verbinden.');
      selectHost(host.id);
    } catch (error) { toast(error.message, 'error'); submit.disabled = false; submit.innerHTML = `Server speichern${icons.arrow}`; }
  });
  setTimeout(() => $('#hostForm input[name="name"]')?.focus(), 60);
}

function openAuthModal(host, targetRoute) {
  $('#modalRoot').innerHTML = `<div class="modal-backdrop"><form class="modal-card auth-modal" id="authForm"><div class="modal-top"><div><div class="eyebrow">SICHERE SSH-VERBINDUNG</div><h2>Verbinden mit ${escapeHtml(host.name)}</h2></div><button type="button" class="icon-button modal-close" aria-label="Schließen">${icons.close}</button></div><div class="auth-host"><span class="auth-host-icon">${icons.server}</span><div><b>${escapeHtml(host.username)}@${escapeHtml(host.host)}</b><small>Port ${host.port} · SSH</small></div><span class="auth-lock">${icons.lock}</span></div><div class="auth-methods"><label class="auth-method active"><input type="radio" name="method" value="password" checked><span class="auth-method-icon">${icons.lock}</span><span><b>Passwort</b><small>SSH-Passwort verwenden</small></span><i></i></label><label class="auth-method"><input type="radio" name="method" value="key"><span class="auth-method-icon">${icons.key}</span><span><b>SSH-Schlüssel</b><small>Privaten Schlüssel auswählen</small></span><i></i></label></div><div id="passwordPane" class="auth-pane"><label class="form-field"><span>Passwort für ${escapeHtml(host.username)}</span><div class="password-input"><input type="password" name="password" placeholder="SSH-Passwort" autocomplete="current-password"><button type="button" class="reveal-password">Anzeigen</button></div></label></div><div id="keyPane" class="auth-pane" hidden><label class="form-field"><span>Privater Schlüssel</span><div class="key-file-row"><input type="file" id="keyPicker" accept=".pem,.key,.ppk,id_rsa,id_ed25519,id_ecdsa" hidden><button type="button" class="button button-secondary key-choose">${icons.upload}Schlüsseldatei auswählen</button><span id="keyFileName">Keine Datei ausgewählt</span></div></label><label class="form-field"><span>Passphrase <small>(optional)</small></span><input type="password" name="passphrase" placeholder="Schlüssel-Passphrase"></label></div><div class="auth-security">${icons.shield}<span>Erstverbindungen prüfen den Server-Fingerabdruck. Zugangsdaten werden nicht gespeichert.</span></div><div class="modal-error" id="authError" hidden></div><div class="modal-footer"><button type="button" class="button button-secondary modal-cancel">Abbrechen</button><button type="submit" class="button button-primary" id="authSubmit">${icons.lock}Sicher verbinden</button></div></form></div>`;
  const modalRoot = $('#modalRoot');
  const close = () => { modalRoot.innerHTML = ''; };
  modalRoot.querySelectorAll('.modal-close, .modal-cancel').forEach(element => element.addEventListener('click', close));
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', event => { if (event.target === event.currentTarget) close(); });
  const authMethods = [...modalRoot.querySelectorAll('.auth-method')];
  authMethods.forEach(method => method.addEventListener('click', () => {
    authMethods.forEach(item => item.classList.toggle('active', item === method));
    const keyMode = method.querySelector('input').value === 'key';
    $('#passwordPane').hidden = keyMode;
    $('#keyPane').hidden = !keyMode;
  }));
  $('.key-choose').addEventListener('click', () => $('#keyPicker').click());
  $('#keyPicker').addEventListener('change', event => { $('#keyFileName').textContent = event.target.files[0]?.name || 'Keine Datei ausgewählt'; });
  $('.reveal-password').addEventListener('click', event => {
    const input = $('input[name="password"]');
    input.type = input.type === 'password' ? 'text' : 'password';
    event.currentTarget.textContent = input.type === 'password' ? 'Anzeigen' : 'Verbergen';
  });
  $('#authForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const method = form.get('method');
    const submit = $('#authSubmit');
    const errorBox = $('#authError');
    errorBox.hidden = true;
    let auth;
    if (method === 'key') {
      const keyFile = $('#keyPicker').files[0];
      if (!keyFile) { errorBox.textContent = 'Bitte wähle zuerst eine Schlüsseldatei aus.'; errorBox.hidden = false; return; }
      try { auth = { method, privateKey: await keyFile.text(), passphrase: form.get('passphrase') || '' }; }
      catch { errorBox.textContent = 'Die Schlüsseldatei konnte nicht gelesen werden.'; errorBox.hidden = false; return; }
    } else auth = { method, password: form.get('password') };
    if (method === 'password' && !auth.password) { errorBox.textContent = 'Bitte gib dein Passwort ein.'; errorBox.hidden = false; return; }
    const original = submit.innerHTML;
    submit.disabled = true;
    submit.innerHTML = '<span class="spinner"></span>Verbindung wird aufgebaut…';
    try {
      let result;
      try { result = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ hostId: host.id, auth }) }); }
      catch (connectError) {
        if (connectError.status !== 409 || connectError.data?.error !== 'HOST_KEY') throw connectError;
        const keyNote = connectError.data.changed ? 'Der gespeicherte Fingerabdruck hat sich geändert. Prüfe den neuen Schlüssel über einen sicheren zweiten Kanal.' : 'Dies ist der erste Kontakt zu diesem Server. Vergleiche den Fingerabdruck mit einer vertrauenswürdigen Quelle.';
        const accepted = confirm(`${keyNote}\n\n${connectError.data.fingerprint}\n\nMöchtest du diesem Server-Schlüssel vertrauen?`);
        if (!accepted) throw new Error('Verbindung abgebrochen. Der Server-Schlüssel wurde nicht bestätigt.');
        result = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ hostId: host.id, auth: { ...auth, trustFingerprint: connectError.data.fingerprint } }) });
      }
      state.sessions.push(result);
      state.activeId = result.id;
      state.closedTerminalHost = null;
      state.selectedHostId = host.id;
      resetMetrics(result.id);
      renderHosts();
      updateConnectionChrome();
      close();
      setRoute(targetRoute || 'terminal');
      toast(`Verbunden mit ${host.name}.`);
    } catch (connectError) {
      errorBox.textContent = connectError.message || 'Verbindung fehlgeschlagen.';
      errorBox.hidden = false;
      submit.disabled = false;
      submit.innerHTML = original;
    }
  });
}

function openDocumentation() {
  const modalRoot = $('#modalRoot');
  if (!modalRoot) return;
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal-card documentation-modal" aria-labelledby="documentationTitle"><div class="modal-top"><div><div class="eyebrow">TERMXXLE · HANDBUCH</div><h2 id="documentationTitle">Dokumentation</h2></div><button type="button" class="icon-button modal-close" aria-label="Schließen">${icons.close}</button></div><div class="documentation-content">
    <section><h3>1. Anmeldung und Betriebsarten</h3><p>${isLocalDesktopVault ? 'Der lokale Tresor wird auf diesem Windows-Konto direkt und ohne separates Konto geöffnet. Workspaces und Serverprofile bleiben in einem mit AES-GCM verschlüsselten Tresor; Windows schützt den Datenschlüssel. Für den Webserver meldest du dich weiterhin mit deinem Konto auf der Serverinstanz an.' : 'Ein Konto enthält deine eigenen Workspaces und Serverprofile. Die Desktop-App kann einen lokalen Tresor auf diesem PC oder eine selbst betriebene Instanz von Termxxle verwenden. Im lokalen Modus bleiben Kontodaten und Serverprofile auf diesem Gerät verschlüsselt; im Webmodus liegen sie auf der verbundenen Instanz. Die Desktop-App merkt sich beim Webmodus nur die Serveradresse.'}</p></section>
    <section><h3>2. Workspaces</h3><p>Öffne links oben den Workspace-Schalter, um einen Workspace zu wechseln, umzubenennen oder einen neuen anzulegen. Jeder Workspace hat seine eigene Serverliste. Beim Wechsel werden die aktiven SSH-Sitzungen beendet. Ein Workspace kann samt seinen Verbindungen gelöscht werden.</p></section>
    <section><h3>3. Serverprofile verwalten</h3><p>Beim Anlegen oder unter <b>Einstellungen</b> kannst du eine Beschreibung und bis zu zwölf Komma-getrennte Tags ergänzen. Die Daten gehören zum Serverprofil im aktuellen Workspace. Zum Entfernen öffnest du beim Server in der linken Liste das Drei-Punkte-Menü und wählst <b>Server entfernen</b>. Eine aktive Sitzung wird dabei getrennt; das Profil wird aus dem aktuellen Workspace gelöscht.</p></section>
    <section><h3>4. SSH-Verbindung</h3><p>Klicke auf einen Server und wähle die Anmeldung mit SSH-Passwort oder privatem Schlüssel. Eine Schlüsseldatei kann optional mit einer Passphrase geschützt sein. Diese Zugangsdaten werden nur für den Verbindungsaufbau verwendet und nicht im Serverprofil gespeichert. Beim ersten Kontakt zeigt Termxxle den Host-Fingerabdruck. Prüfe ihn über einen vertrauenswürdigen Weg mit deinem Server ab; eine unerwartete Änderung kann auf einen falschen Server oder einen Angriff hindeuten.</p></section>
    <section><h3>5. Terminal</h3><p>Nach der Verbindung öffnet sich das SSH-Terminal. Die Terminalgröße passt sich dem Fenster an. Über die Schaltfläche zum Leeren wird nur die lokale Terminalanzeige geleert; <b>Verbindung trennen</b> beendet die SSH-Sitzung.</p></section>
    <section><h3>6. Dateien per SFTP</h3><p>Öffne <b>Dateien</b>, um Ordner auf dem verbundenen Server zu durchsuchen. Du kannst Dateien hochladen, per Drag-and-drop übertragen und Dateien über das Download-Symbol auf deinen PC laden. Die Übertragung läuft über dieselbe verschlüsselte SSH-Verbindung. Der Serverbenutzer braucht passende Datei- und Ordnerrechte.</p></section>
    <section><h3>7. Monitoring und Laufzeit</h3><p>Die Live-Karten zeigen CPU, RAM, Root-Dateisystem, Netzwerkdurchsatz und die Systemlaufzeit seit dem letzten Neustart. Werte werden direkt vom Zielserver gelesen und in Termxxle nicht gespeichert. Die Monitoring-Abfragen benötigen derzeit ein Linux-Zielsystem mit den üblichen <code>/proc</code>-Dateien und <code>df</code>.</p></section>
    <section><h3>8. Maschineneinstellungen und Neustart</h3><p>Wähle beim Server in der Übersicht oder im linken Servermenü <b>Einstellungen</b>, um Beschreibung und Tags zu ändern. Ein Neustart ist nur bei aktiver SSH-Terminalsitzung verfügbar. Termxxle sendet den einfachen Befehl <code>reboot</code> als angemeldeter SSH-Benutzer; dieser braucht dafür die nötigen Rechte. Die Verbindung kann durch den Neustart abbrechen.</p></section>
    <section><h3>9. Theme und Kontosicherheit</h3><p>Wähle oben rechts <b>Material Dark</b>, <b>Material White</b> oder <b>Muxxle</b>. ${isLocalDesktopVault ? 'Die Auswahl wird lokal im verschlüsselten Tresor auf diesem Windows-Konto gespeichert.' : 'Die Auswahl wird deinem Konto zugeordnet und bei der nächsten Anmeldung wiederhergestellt. Über dein Profil kannst du E-Mail-Adresse und Passwort ändern sowie OTP oder Passkeys einrichten. Bewahre die angezeigten Wiederherstellungscodes sicher auf: Sie sind Einmalcodes und werden nach der Einrichtung nicht erneut angezeigt. Bestätige, dass du sie gespeichert hast, bevor du OTP oder Passkey aktivierst.'}</p></section>
    ${isLocalDesktopVault ? '' : '<section><h3>10. Admin-Nutzerverwaltung</h3><p>Admins sehen oben rechts <b>Einstellungen</b> und können dort unter <b>Users</b> ein temporäres Passwort für ein anderes Konto setzen. Dafür muss das Admin-Passwort erneut eingegeben werden. Das betroffene Konto wird abgemeldet und muss das temporäre Passwort direkt nach der nächsten Anmeldung ändern. Das eigene Passwort änderst du in deinen Kontoeinstellungen.</p></section>'}
    <section><h3>${isLocalDesktopVault ? '10' : '11'}. Hinweise zur Serverinstanz</h3><p>Für den Zugriff über das Internet müssen HTTPS und WebSocket-Weiterleitung für <code>/terminal</code> eingerichtet sein. E-Mail-Passwort-Resets funktionieren nur, wenn der Betreiber den Mailversand serverseitig aktiviert und SMTP konfiguriert hat.${isLocalDesktopVault ? '' : ' Im lokalen Modus ist keine separate Anmeldung erforderlich.'}</p></section>
  </div></section></div>`;
  modalRoot.querySelector('.modal-close').addEventListener('click', () => { modalRoot.innerHTML = ''; });
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', event => { if (event.target === event.currentTarget) modalRoot.innerHTML = ''; });
}

async function openAdminSettings() {
  if (state.user?.role !== 'admin') return;
  const modalRoot = $('#modalRoot');
  if (!modalRoot) return;
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal-card settings-modal"><div class="modal-top"><div><div class="eyebrow">ADMIN-EINSTELLUNGEN</div><h2>Einstellungen</h2></div><button type="button" class="icon-button modal-close" aria-label="Schließen">${icons.close}</button></div><div class="inline-empty"><span class="spinner"></span><b>Users werden geladen</b></div></section></div>`;
  modalRoot.querySelector('.modal-close').addEventListener('click', () => { modalRoot.innerHTML = ''; });
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', event => { if (event.target === event.currentTarget) modalRoot.innerHTML = ''; });
  try {
    const users = await api('/api/admin/users');
    if (!modalRoot.querySelector('.settings-modal')) return;
    const modal = modalRoot.querySelector('.settings-modal');
    modal.innerHTML = `<div class="modal-top"><div><div class="eyebrow">ADMIN-EINSTELLUNGEN</div><h2>Einstellungen</h2></div><button type="button" class="icon-button modal-close" aria-label="Schließen">${icons.close}</button></div><div class="settings-content"><div class="settings-section-heading"><div><span class="eyebrow">KONTEN</span><h3>Users</h3></div><span class="count-pill">${users.length}</span></div><p class="account-help">Setze bei Bedarf ein temporäres Passwort. Das Konto wird abgemeldet und muss es beim nächsten Login ändern.</p><div class="admin-user-list">${users.map(user => `<article class="admin-user-row"><div class="admin-user-info"><b>${escapeHtml(user.name)} <small>@${escapeHtml(user.username)}</small></b><span>${escapeHtml(user.email || 'Keine E-Mail-Adresse')}</span><small>${user.role === 'admin' ? 'Administrator' : 'Benutzer'}${user.mustChangePassword ? ' · Passwortänderung ausstehend' : ''}</small></div>${user.id === state.user.id ? '<span class="current-user-label">Du</span>' : `<button type="button" class="button button-secondary admin-reset-trigger" data-user="${escapeHtml(user.id)}">Passwort zurücksetzen</button>`}</article>`).join('') || '<p class="account-help">Noch keine Users vorhanden.</p>'}</div></div>`;
    modal.querySelector('.modal-close').addEventListener('click', () => { modalRoot.innerHTML = ''; });
    modal.querySelectorAll('.admin-reset-trigger').forEach(button => button.addEventListener('click', () => openAdminResetForm(users.find(user => user.id === button.dataset.user))));
  } catch (error) { toast(error.message, 'error'); modalRoot.innerHTML = ''; }
}

function openAdminResetForm(user) {
  if (!user || state.user?.role !== 'admin') return;
  const modalRoot = $('#modalRoot');
  const modal = modalRoot?.querySelector('.settings-modal');
  if (!modal) return;
  modal.innerHTML = `<div class="modal-top"><div><div class="eyebrow">USER-PASSWORT ZURÜCKSETZEN</div><h2>${escapeHtml(user.name)}</h2></div><button type="button" class="icon-button modal-close" aria-label="Schließen">${icons.close}</button></div><p class="account-help">@${escapeHtml(user.username)} wird abgemeldet und muss das neue temporäre Passwort beim nächsten Login ändern.</p><form id="adminResetForm" class="admin-reset-form"><label class="form-field"><span>Temporäres Passwort · mindestens 12 Zeichen</span><input type="password" name="password" minlength="12" maxlength="256" autocomplete="new-password" required></label><label class="form-field"><span>Dein aktuelles Admin-Passwort</span><input type="password" name="adminPassword" autocomplete="current-password" required></label><div class="account-message" id="adminResetError" hidden></div><div class="modal-footer"><button type="button" class="button button-secondary" id="backToUsers">Zurück zu Users</button><button class="button button-primary" type="submit">Passwort zurücksetzen</button></div></form>`;
  modal.querySelector('.modal-close').addEventListener('click', () => { modalRoot.innerHTML = ''; });
  modal.querySelector('#backToUsers').addEventListener('click', openAdminSettings);
  modal.querySelector('#adminResetForm').addEventListener('submit', async event => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const submit = event.currentTarget.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await api(`/api/admin/users/${encodeURIComponent(user.id)}/reset-password`, { method: 'POST', body: JSON.stringify({ password: values.get('password'), adminPassword: values.get('adminPassword') }) });
      modalRoot.innerHTML = '';
      toast('Passwort zurückgesetzt. Der User muss es beim nächsten Login ändern.');
    } catch (error) {
      const box = modal.querySelector('#adminResetError'); box.textContent = error.message; box.hidden = false; submit.disabled = false;
    }
  });
}

async function openAccountModal(forcePasswordChange = false, forceEmail = false) {
  const modalRoot = $('#modalRoot');
  if (!modalRoot) return;
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal-card account-modal"><div class="modal-top"><div><div class="eyebrow">KONTO & SICHERHEIT</div><h2>${forcePasswordChange ? 'Neues Passwort festlegen' : forceEmail ? 'E-Mail-Adresse hinterlegen' : 'Kontoeinstellungen'}</h2></div>${forcePasswordChange || forceEmail ? '' : `<button type="button" class="icon-button modal-close" aria-label="Schließen">${icons.close}</button>`}</div><div id="accountModalContent"><div class="inline-empty"><span class="spinner"></span><b>Einstellungen werden geladen</b></div></div></section></div>`;
  if (!forcePasswordChange && !forceEmail) {
    modalRoot.querySelector('.modal-close').addEventListener('click', () => { modalRoot.innerHTML = ''; });
    modalRoot.querySelector('.modal-backdrop').addEventListener('click', event => { if (event.target === event.currentTarget) modalRoot.innerHTML = ''; });
  }
  let security = { totpEnabled: false, passkeys: [], recoveryCodesRemaining: 0 };
  try { security = await api('/api/auth/security'); } catch (error) { toast(error.message, 'error'); }
  if (!$('#accountModalContent')) return;
  const securityStatus = [security.totpEnabled ? 'OTP aktiv' : '', ...security.passkeys.map(passkey => passkey.name), `${security.recoveryCodesRemaining} Wiederherstellungscodes verfügbar`].filter(Boolean).join(' · ') || 'Kein zusätzlicher Faktor aktiviert.';
  $('#accountModalContent').innerHTML = `<div class="account-scroll"><section class="account-section"><h3>E-Mail-Adresse</h3><p class="account-help">Wird für künftige Passwort-Resets verwendet. Der Mailversand lässt sich serverseitig aktivieren.</p><form id="emailForm" class="account-form"><label class="form-field"><span>E-Mail-Adresse</span><input type="email" name="email" value="${escapeHtml(state.user.email || '')}" maxlength="254" autocomplete="email" required></label><label class="form-field"><span>Passwort bestätigen</span><input type="password" name="currentPassword" autocomplete="current-password" required></label><button class="button button-secondary" type="submit">Speichern</button></form></section><section class="account-section"><h3>Passwort ändern</h3>${forcePasswordChange ? '<p class="account-help">Das Admin-Reset-Passwort muss jetzt durch dein eigenes Passwort ersetzt werden.</p>' : ''}<form id="passwordForm" class="account-form account-password-form"><label class="form-field"><span>${forcePasswordChange ? 'Temporäres Passwort' : 'Aktuelles Passwort'}</span><input type="password" name="currentPassword" autocomplete="current-password" required></label><label class="form-field"><span>Neues Passwort · mindestens 12 Zeichen</span><input type="password" name="newPassword" minlength="12" maxlength="256" autocomplete="new-password" required></label><div class="account-message" id="passwordMessage" hidden></div><button class="button button-primary" type="submit">Passwort ändern</button></form></section>${forcePasswordChange ? '' : `<section class="account-section"><h3>Zwei-Faktor-Anmeldung</h3><p class="account-help">${escapeHtml(securityStatus)} Wiederherstellungscodes sind Einmalcodes und müssen sicher abgelegt werden.</p><label class="form-field security-reauth"><span>Aktuelles Passwort zur Bestätigung</span><input id="securityPassword" type="password" autocomplete="current-password"></label><div class="security-actions"><button class="button button-secondary" id="enableTotp">${security.totpEnabled ? 'OTP ist aktiv' : 'OTP einrichten'}</button><button class="button button-secondary" id="enablePasskey">${security.passkeys.length ? 'Weiteren Passkey hinzufügen' : 'Passkey einrichten'}</button>${security.totpEnabled || security.passkeys.length ? '<button class="button button-danger" id="disableSecurity">Sicherheitsfaktoren deaktivieren</button>' : ''}</div><div class="account-message" id="securityMessage" hidden></div></section>`}</div>`;
  $('#emailForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = data.get('email');
    try { const result = await api('/api/auth/change-email', { method: 'POST', body: JSON.stringify({ email, currentPassword: data.get('currentPassword') }) }); state.user = result.user; toast('E-Mail-Adresse gespeichert.'); if (forceEmail && !forcePasswordChange) modalRoot.innerHTML = ''; }
    catch (error) { toast(error.message, 'error'); }
  });
  $('#passwordForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const message = $('#passwordMessage');
    try {
      const result = await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: data.get('currentPassword'), newPassword: data.get('newPassword') }) });
      state.user = result.user;
      if (forceEmail && !state.user.email) openAccountModal(false, true);
      else modalRoot.innerHTML = '';
      toast('Passwort wurde geändert.');
    } catch (error) { message.textContent = error.message; message.hidden = false; }
  });
  $('#enableTotp')?.addEventListener('click', async event => {
    if (security.totpEnabled) return;
    try {
      const setup = await api('/api/auth/totp/setup', { method: 'POST', body: JSON.stringify({ currentPassword: $('#securityPassword')?.value || '' }) });
      $('#accountModalContent').innerHTML = `<section class="account-section"><h3>Authenticator verbinden</h3><p class="account-help">Scanne den QR-Link in deiner Authenticator-App oder trage den Schlüssel manuell ein.</p><a class="otp-uri" href="${escapeHtml(setup.otpauth)}">Authenticator öffnen</a><div class="otp-secret">${escapeHtml(setup.secret)}</div><form id="totpConfirmForm" class="account-form"><label class="form-field"><span>Sechsstelliger Code</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label><div class="account-message" id="totpMessage" hidden></div><button class="button button-primary" type="submit">Code prüfen</button></form></section>`;
      $('#totpConfirmForm').addEventListener('submit', async formEvent => {
        formEvent.preventDefault();
        try { const result = await api('/api/auth/totp/prepare-enable', { method: 'POST', body: JSON.stringify({ code: new FormData(formEvent.currentTarget).get('code') }) }); showRecoveryConfirmation(result.codes, 'totp', forcePasswordChange); }
        catch (error) { const box = $('#totpMessage'); box.textContent = error.message; box.hidden = false; }
      });
    } catch (error) { const box = $('#securityMessage'); box.textContent = error.message; box.hidden = false; }
  });
  $('#enablePasskey')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try {
      const options = await api('/api/auth/passkeys/register/options', { method: 'POST', body: JSON.stringify({ currentPassword: $('#securityPassword')?.value || '' }) });
      const credential = await startRegistration({ optionsJSON: options });
      const result = await api('/api/auth/passkeys/register/verify', { method: 'POST', body: JSON.stringify(credential) });
      showRecoveryConfirmation(result.codes, 'passkey', forcePasswordChange);
    } catch (error) { const box = $('#securityMessage'); box.textContent = error.message; box.hidden = false; event.currentTarget.disabled = false; }
  });
  $('#disableSecurity')?.addEventListener('click', () => {
    modalRoot.innerHTML = `<div class="modal-backdrop"><form class="modal-card" id="disableSecurityForm"><div class="modal-top"><div><div class="eyebrow">SICHERHEITSFAKTOREN</div><h2>OTP und Passkeys deaktivieren</h2></div><button type="button" class="icon-button modal-close" aria-label="Schließen">${icons.close}</button></div><p class="account-help">Bestätige mit deinem Passwort und einem OTP- oder Wiederherstellungscode.</p><label class="form-field"><span>Aktuelles Passwort</span><input type="password" name="password" autocomplete="current-password" required></label><label class="form-field"><span>OTP- oder Wiederherstellungscode</span><input name="code" autocomplete="one-time-code" required></label><div class="account-message" id="disableError" hidden></div><div class="modal-footer"><button type="button" class="button button-secondary modal-cancel">Abbrechen</button><button class="button button-danger" type="submit">Deaktivieren</button></div></form></div>`;
    $('#disableSecurityForm').querySelector('.modal-close').addEventListener('click', () => openAccountModal());
    $('#disableSecurityForm').querySelector('.modal-cancel').addEventListener('click', () => openAccountModal());
    $('#disableSecurityForm').addEventListener('submit', async event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      try { await api('/api/auth/security/disable', { method: 'POST', body: JSON.stringify({ password: values.get('password'), code: values.get('code') }) }); toast('Zusätzliche Anmeldefaktoren wurden deaktiviert.'); openAccountModal(); }
      catch (error) { const box = $('#disableError'); box.textContent = error.message; box.hidden = false; }
    });
  });
}

function showRecoveryConfirmation(codes, kind, forcePasswordChange = false) {
  const modalRoot = $('#modalRoot');
  if (!modalRoot) return;
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal-card recovery-modal"><div class="modal-top"><div><div class="eyebrow">WIEDERHERSTELLUNG</div><h2>Codes jetzt speichern</h2></div></div><p class="account-help">Diese Einmalcodes sind nötig, falls du den zweiten Faktor verlierst. Danach werden sie nicht erneut angezeigt.</p><div class="recovery-code-grid">${codes.map(code => `<code>${escapeHtml(code)}</code>`).join('')}</div><button class="button button-secondary recovery-download" id="downloadRecovery">Wiederherstellungscodes herunterladen</button><label class="recovery-confirm"><input type="checkbox" id="recoverySaved"><span>Ich habe diese Wiederherstellungscodes sicher gespeichert.</span></label><div class="account-message" id="recoveryMessage" hidden></div><button class="button button-primary" id="confirmRecovery" disabled>Codes gespeichert · aktivieren</button></section></div>`;
  $('#downloadRecovery').addEventListener('click', () => {
    const file = new Blob([`Termxxle Wiederherstellungscodes\n\n${codes.join('\n')}\n\nJeder Code kann nur einmal verwendet werden. Bewahre diese Datei sicher auf.\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'termxxle-wiederherstellungscodes.txt'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('#recoverySaved').addEventListener('change', event => { $('#confirmRecovery').disabled = !event.currentTarget.checked; });
  $('#confirmRecovery').addEventListener('click', async () => {
    try {
      await api(kind === 'totp' ? '/api/auth/totp/enable' : '/api/auth/passkeys/enable', { method: 'POST', body: JSON.stringify({ codesSaved: true }) });
      toast('Sicherheitsfaktor aktiviert.');
      openAccountModal(forcePasswordChange);
    } catch (error) { const box = $('#recoveryMessage'); box.textContent = error.message; box.hidden = false; }
  });
}

function ensureTerminal(session) {
  const terminalHost = $('#terminalHost');
  let entry = state.terminalEntries.get(session.id);
  if (!entry) {
    for (const [sessionId, previous] of state.terminalEntries) {
      if (!previous.closed) continue;
      previous.resizeObserver.disconnect();
      previous.socket.close();
      previous.terminal.dispose();
      previous.layer.remove();
      state.terminalEntries.delete(sessionId);
    }
  }
  if (!entry) {
    const layer = document.createElement('div');
    layer.className = 'terminal-layer';
    layer.dataset.session = session.id;
    terminalHost.append(layer);
    const terminal = new Terminal({ cursorBlink: true, cursorStyle: 'bar', fontSize: 16, fontFamily: '"JetBrains Mono", "Cascadia Code", Consolas, monospace', lineHeight: 1.42, scrollback: 5000, allowProposedApi: true, theme: terminalThemeFor(document.documentElement.dataset.theme) });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(layer);
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${wsProtocol}//${location.host}/terminal?id=${encodeURIComponent(session.id)}`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => { fit.fit(); socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows })); terminal.focus(); };
    socket.onmessage = event => {
      let data = event.data;
      if (typeof data === 'string' && data.startsWith('{')) {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'closed') {
            if (!entry?.closed && !entry?.closing) {
              terminal.write('\r\n\x1b[90m[Verbindung geschlossen]\x1b[0m\r\n');
              handleSessionClosed(session.id);
            }
            return;
          }
        } catch {}
      }
      if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
      terminal.write(data);
    };
    socket.onclose = () => {
      if (entry?.closing || !state.sessions.some(item => item.id === session.id)) return;
      terminal.write('\r\n\x1b[90m[Verbindung zum Terminaldienst unterbrochen]\x1b[0m\r\n');
      handleSessionClosed(session.id);
      api(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' }).catch(() => {});
    };
    terminal.onData(data => { if (socket.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data)); });
    const resizeObserver = new ResizeObserver(() => {
      if (state.activeId !== session.id || state.route !== 'terminal') return;
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
      $('#terminalSize').textContent = `${terminal.cols} × ${terminal.rows}`;
    });
    resizeObserver.observe(terminalHost);
    entry = { layer, terminal, fit, socket, resizeObserver, closed: false, closing: false };
    state.terminalEntries.set(session.id, entry);
  }
  terminalHost.querySelectorAll('.terminal-layer').forEach(layer => { layer.hidden = layer.dataset.session !== session.id; });
  $('#terminalEmpty').hidden = true;
  $('#terminalHostName').classList.remove('connection-lost');
  requestAnimationFrame(() => { entry.fit.fit(); entry.terminal.focus(); $('#terminalSize').textContent = `${entry.terminal.cols} × ${entry.terminal.rows}`; });
}

function handleSessionClosed(sessionId) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return;
  state.sessions = state.sessions.filter(item => item.id !== sessionId);
  const entry = state.terminalEntries.get(sessionId);
  if (entry) {
    entry.closed = true;
    entry.terminal.options.disableStdin = true;
    entry.resizeObserver.disconnect();
  }
  if (state.activeId === sessionId) {
    state.activeId = state.sessions.at(-1)?.id || null;
    resetMetrics(state.activeId);
  }
  if (!state.activeId && !state.sessions.length) state.closedTerminalHost = session.host;
  renderHosts();
  updateConnectionChrome();
  if (state.route === 'terminal' && activeSession()) ensureTerminal(activeSession());
  toast(`Die SSH-Sitzung zu „${session.host.name}“ wurde beendet.`);
}

async function disconnectSession(sessionId) {
  const session = state.sessions.find(item => item.id === sessionId);
  if (!session) return;
  const entry = state.terminalEntries.get(sessionId);
  if (entry) entry.closing = true;
  try { await api(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }); } catch {}
  state.sessions = state.sessions.filter(item => item.id !== sessionId);
  if (entry) { entry.resizeObserver.disconnect(); entry.socket.close(); entry.terminal.dispose(); entry.layer.remove(); state.terminalEntries.delete(sessionId); }
  if (state.activeId === sessionId) {
    state.closedTerminalHost = null;
    state.activeId = state.sessions.at(-1)?.id || null;
    resetMetrics(state.activeId);
    if (state.route !== 'overview' && !state.activeId) setRoute('overview');
  }
  renderHosts();
  updateConnectionChrome();
}

function remoteJoin(base, name) { return `${base === '/' ? '' : base.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}` || '/'; }
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000, unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit++; }
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)} ${units[unit]}`;
}
function formatDate(seconds) {
  if (!seconds) return '—';
  return new Intl.DateTimeFormat('de-AT', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(seconds * 1000));
}

async function loadFiles() {
  const session = activeSession();
  const body = $('#fileTableBody');
  if (!session) {
    body.innerHTML = `<tr><td colspan="5"><div class="inline-empty">${icons.files}<b>Keine Verbindung ausgewählt</b><span>Verbinde dich mit einem Server, um Dateien zu durchsuchen.</span></div></td></tr>`;
    $('#fileCount').textContent = 'SFTP-Dateimanager';
    return;
  }
  if (state.fileSession !== session.id) { state.fileSession = session.id; state.filePath = session.home || '/'; }
  $('#filePathLabel').textContent = state.filePath;
  body.innerHTML = `<tr><td colspan="5"><div class="inline-loading"><span class="spinner"></span>Dateien werden geladen…</div></td></tr>`;
  try {
    const listing = await api(`/api/sessions/${encodeURIComponent(session.id)}/files?path=${encodeURIComponent(state.filePath)}`);
    state.files = listing.files;
    state.filePath = listing.path;
    $('#filePathLabel').textContent = state.filePath;
    $('#fileCount').textContent = `${listing.files.length} Einträge`;
    const rows = [];
    if (listing.path !== '/') rows.push(`<tr class="parent-row"><td><button class="file-name-button" data-parent="${escapeHtml(listing.parent)}"><span class="file-icon parent-icon">${icons.folder}</span><span>..</span></button></td><td>Übergeordnet</td><td>—</td><td>—</td><td></td></tr>`);
    for (const file of listing.files) {
      const fullPath = remoteJoin(listing.path, file.name);
      rows.push(`<tr><td><button class="file-name-button" ${file.type === 'directory' ? `data-directory="${escapeHtml(fullPath)}"` : ''}><span class="file-icon ${file.type}">${file.type === 'directory' ? icons.folder : icons.file}</span><span>${escapeHtml(file.name)}</span></button></td><td>${file.type === 'directory' ? 'Ordner' : 'Datei'}</td><td>${file.type === 'directory' ? '—' : formatBytes(file.size)}</td><td>${formatDate(file.modified)}</td><td>${file.type === 'file' ? `<a class="file-action" href="/api/sessions/${encodeURIComponent(session.id)}/download?path=${encodeURIComponent(fullPath)}" title="Herunterladen">${icons.download}</a>` : ''}</td></tr>`);
    }
    body.innerHTML = rows.length ? rows.join('') : `<tr><td colspan="5"><div class="inline-empty">${icons.folder}<b>Dieser Ordner ist leer</b><span>Ziehe eine Datei hierher oder nutze „Hochladen“.</span></div></td></tr>`;
    body.querySelectorAll('[data-directory]').forEach(button => button.addEventListener('click', () => { state.filePath = button.dataset.directory; loadFiles(); }));
    body.querySelectorAll('[data-parent]').forEach(button => button.addEventListener('click', () => { state.filePath = button.dataset.parent; loadFiles(); }));
  } catch (error) {
    body.innerHTML = `<tr><td colspan="5"><div class="inline-empty error-empty">${icons.close}<b>Ordner konnte nicht geladen werden</b><span>${escapeHtml(error.message)}</span></div></td></tr>`;
    $('#fileCount').textContent = 'SFTP-Fehler';
  }
}

async function beginUpload(files) {
  const session = activeSession();
  if (!session) { toast('Verbinde dich zuerst mit einem Server.', 'error'); return; }
  const uploadFiles = [...files];
  if (!uploadFiles.length) return;
  const progress = $('#uploadProgress');
  progress.hidden = false;
  let succeeded = 0;
  let lastError = '';
  for (let index = 0; index < uploadFiles.length; index++) {
    const file = uploadFiles[index];
    const target = remoteJoin(state.filePath || session.home || '/', file.name);
    const ok = await new Promise(resolve => {
      const request = new XMLHttpRequest();
      state.currentUpload = request;
      $('#uploadName').textContent = uploadFiles.length > 1 ? `${file.name} · ${index + 1}/${uploadFiles.length}` : `Übertrage ${file.name}`;
      $('#uploadPercent').textContent = '0%';
      $('#uploadBar').style.width = '0%';
      request.open('POST', `/api/sessions/${encodeURIComponent(session.id)}/upload?path=${encodeURIComponent(target)}`);
      request.setRequestHeader('Content-Type', 'application/octet-stream');
      request.upload.onprogress = event => {
        if (!event.lengthComputable) return;
        const percent = Math.round(event.loaded / event.total * 100);
        $('#uploadPercent').textContent = `${percent}%`;
        $('#uploadBar').style.width = `${percent}%`;
      };
      request.onload = () => {
        state.currentUpload = null;
        if (request.status >= 200 && request.status < 300) resolve(true);
        else {
          try { lastError = JSON.parse(request.responseText).error || 'Übertragung fehlgeschlagen.'; }
          catch { lastError = 'Übertragung fehlgeschlagen.'; }
          resolve(false);
        }
      };
      request.onerror = () => { state.currentUpload = null; lastError = 'Netzwerkfehler bei der Übertragung.'; resolve(false); };
      request.onabort = () => { state.currentUpload = null; lastError = 'Übertragung abgebrochen.'; resolve(false); };
      request.send(file);
    });
    if (ok) succeeded++;
  }
  progress.hidden = true;
  state.currentUpload = null;
  if (succeeded) { toast(`${succeeded} ${succeeded === 1 ? 'Datei' : 'Dateien'} übertragen.`); loadFiles(); }
  if (lastError) toast(lastError, 'error');
}

async function refreshMetrics() {
  const session = activeSession();
  if (!session) { updateMetricDisplay(null); return; }
  try {
    const metric = await api(`/api/sessions/${encodeURIComponent(session.id)}/metrics`);
    if (state.activeId !== session.id) return;
    state.latestMetrics = metric;
    state.metrics.push(metric);
    if (state.metrics.length > 60) state.metrics.shift();
    $('#monitorEmpty').hidden = true;
    $('#monitorDashboard').hidden = false;
    $('#monitorUpdated').textContent = `Aktualisiert ${new Intl.DateTimeFormat('de-AT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(metric.at))}`;
    updateMetricDisplay(metric);
    drawCharts();
  } catch (error) {
    if (state.activeId !== session.id) return;
    $('#monitorEmpty').hidden = false;
    $('#monitorDashboard').hidden = true;
    $('#monitorEmpty').innerHTML = `<div class="empty-monitor-icon">${icons.chart}</div><h3>Monitoring derzeit nicht verfügbar</h3><p>${escapeHtml(error.message)} Die Live-Werte benötigen ein Linux-System mit /proc und df.</p><button class="button button-secondary" id="retryMetrics">${icons.refresh}Erneut versuchen</button>`;
    $('#retryMetrics').addEventListener('click', refreshMetrics);
  }
}

function updateMetricDisplay(metric) {
  if (!metric) {
    $('#cpuValue').textContent = '—'; $('#memoryValue').textContent = '—'; $('#diskValue').textContent = '—';
    $('#memorySub').textContent = '— von — belegt'; $('#diskSub').textContent = '— von — belegt';
    $('#memoryBar').style.width = '0%'; $('#diskBar').style.width = '0%'; $('#rxValue').textContent = '—'; $('#txValue').textContent = '—'; $('#uptimeValue').textContent = '—';
    return;
  }
  $('#cpuValue').textContent = metric.cpu == null ? '—' : metric.cpu.toFixed(1);
  $('#cpuSub').textContent = metric.cpu == null ? 'Erste Messung läuft…' : 'Gesamtauslastung';
  $('#memoryValue').textContent = metric.memory.percent.toFixed(1);
  $('#memorySub').textContent = `${formatBytes(metric.memory.used)} von ${formatBytes(metric.memory.total)} belegt`;
  $('#memoryBar').style.width = `${Math.min(100, metric.memory.percent)}%`;
  $('#memoryTotal').textContent = formatBytes(metric.memory.total);
  $('#diskValue').textContent = metric.disk.percent.toFixed(1);
  $('#diskSub').textContent = `${formatBytes(metric.disk.used)} von ${formatBytes(metric.disk.total)} belegt`;
  $('#diskBar').style.width = `${Math.min(100, metric.disk.percent)}%`;
  $('#diskTotal').textContent = formatBytes(metric.disk.total);
  $('#rxValue').textContent = metric.network.rx == null ? '—' : `${formatBytes(metric.network.rx)}/s`;
  $('#txValue').textContent = metric.network.tx == null ? '—' : `${formatBytes(metric.network.tx)}/s`;
  $('#uptimeValue').textContent = formatUptime(metric.uptimeSeconds);
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days ? `${days} T · ${hours} Std` : `${hours} Std · ${minutes} Min`;
}

function drawLineChart(canvasId, series, color, maxOverride = null) {
  const canvas = $(`#${canvasId}`);
  if (!canvas || !canvas.offsetWidth) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  const values = series.filter(Number.isFinite);
  if (values.length < 2) return;
  const max = maxOverride || Math.max(1, ...values) * 1.15;
  context.beginPath();
  values.forEach((value, index) => {
    const x = index / (values.length - 1) * width;
    const y = height - 4 - (Math.min(value, max) / max) * (height - 8);
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.strokeStyle = color;
  context.lineWidth = 1.7;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.stroke();
  const last = values.at(-1);
  const lastY = height - 4 - (Math.min(last, max) / max) * (height - 8);
  context.beginPath(); context.arc(width, lastY, 2.2, 0, Math.PI * 2); context.fillStyle = color; context.fill();
}

function drawCharts() {
  const chartColors = document.documentElement.dataset.theme === 'material-white' ? ['#167c76', '#518983'] : ['#7ce9df', '#c5f4ef'];
  drawLineChart('cpuChart', state.metrics.map(item => item.cpu), chartColors[0], 100);
  drawLineChart('networkChart', state.metrics.map(item => Math.max(item.network.rx || 0, item.network.tx || 0)), chartColors[1]);
}

function bindEvents() {
  $('#workspaceSwitch').addEventListener('click', toggleWorkspaceMenu);
  $('#themeSelect').addEventListener('change', event => saveTheme(event.currentTarget.value));
  if (!isLocalDesktopVault) {
    $('#headerAvatar').addEventListener('click', () => openAccountModal());
    $('#accountName').addEventListener('click', () => openAccountModal());
  }
  $('#addHost').addEventListener('click', openHostModal);
  $('#headingAdd').addEventListener('click', openHostModal);
  $('#welcomeAdd').addEventListener('click', openHostModal);
  $('#overviewAdd').addEventListener('click', openHostModal);
  $('#terminalAdd').addEventListener('click', openHostModal);
  $('#monitorAdd').addEventListener('click', openHostModal);
  $('#hostSearch').addEventListener('input', event => { state.query = event.target.value; renderHosts(); });
  $('#routeTabs').addEventListener('click', event => { const tab = event.target.closest('[data-route]'); if (tab) setRoute(tab.dataset.route); });
  $('#quickTerminal').addEventListener('click', () => setRoute('terminal'));
  $('#refreshFiles').addEventListener('click', loadFiles);
  $('#uploadButton').addEventListener('click', () => $('#filePicker').click());
  $('#filePicker').addEventListener('change', event => { beginUpload(event.target.files); event.target.value = ''; });
  const dropZone = $('.file-table-wrap');
  dropZone.addEventListener('dragenter', event => { event.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragover', event => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
  dropZone.addEventListener('dragleave', event => { if (!dropZone.contains(event.relatedTarget)) dropZone.classList.remove('drag-over'); });
  dropZone.addEventListener('drop', event => { event.preventDefault(); dropZone.classList.remove('drag-over'); beginUpload(event.dataTransfer?.files || []); });
  $('#cancelUpload').addEventListener('click', () => state.currentUpload?.abort());
  $('#disconnectButton').addEventListener('click', () => { const session = activeSession(); if (session) disconnectSession(session.id).then(() => toast('Verbindung getrennt.')); });
  $('#clearTerminal').addEventListener('click', () => { const entry = state.terminalEntries.get(state.activeId) || [...state.terminalEntries.values()].find(item => item.closed); entry?.terminal.clear(); entry?.terminal.focus(); });
  $('#helpButton').addEventListener('click', () => toast('Wähle links einen Server aus. Für SSH, Dateiübertragung, Monitoring und Kontosicherheit öffnest du die Dokumentation.'));
  $('#documentationButton').addEventListener('click', openDocumentation);
  $('#settingsButton').addEventListener('click', openAdminSettings);
  $('#mobileMoreButton').addEventListener('click', () => {
    const button = $('#mobileMoreButton');
    const menu = $('#mobileMoreMenu');
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
  });
  $('#mobileMoreMenu').addEventListener('click', event => {
    const action = event.target.closest('[data-mobile-action]')?.dataset.mobileAction;
    if (!action) return;
    $('#mobileMoreMenu').hidden = true;
    $('#mobileMoreButton').setAttribute('aria-expanded', 'false');
    if (action === 'help') $('#helpButton').click();
    if (action === 'documentation') openDocumentation();
    if (action === 'settings') openAdminSettings();
  });
  $('#logoutButton').addEventListener('click', logoutUser);
  $('#mobileMenu').addEventListener('click', () => setMobileSidebarOpen(!$('.sidebar').classList.contains('mobile-open')));
  $('#sidebarBackdrop').addEventListener('click', () => setMobileSidebarOpen(false));
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openHostModal(); }
    if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { event.preventDefault(); $('#hostSearch').focus(); }
    if (event.key === 'Escape') { $('#modalRoot').innerHTML = ''; setMobileSidebarOpen(false); $('#mobileMoreMenu').hidden = true; $('#mobileMoreButton').setAttribute('aria-expanded', 'false'); }
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.mobile-more-wrap')) {
      $('#mobileMoreMenu').hidden = true;
      $('#mobileMoreButton').setAttribute('aria-expanded', 'false');
    }
  });
  window.addEventListener('resize', () => { const entry = state.terminalEntries.get(state.activeId); if (entry && state.route === 'terminal') { entry.fit.fit(); drawCharts(); } });
}

async function loadWorkspace() {
  try {
    const [workspaces, hosts, sessions] = await Promise.all([api('/api/workspaces'), api('/api/hosts'), api('/api/sessions')]);
    state.workspaces = workspaces.workspaces;
    state.activeWorkspaceId = workspaces.activeWorkspaceId;
    renderWorkspaceButton();
    state.hosts = hosts;
    state.sessions = sessions;
    state.closedTerminalHost = null;
    state.activeId = sessions.at(-1)?.id || null;
    state.selectedHostId = sessions.at(-1)?.host.id || null;
    renderHosts();
    updateConnectionChrome();
    resetMetrics(state.activeId);
  } catch (error) {
    if (error.status === 401) return;
    toast(`Lokaler SSH-Dienst nicht erreichbar: ${error.message}`, 'error');
  }
}

function renderWorkspaceButton() {
  const workspace = state.workspaces.find(item => item.id === state.activeWorkspaceId);
  if (!workspace || !$('#workspaceSwitch')) return;
  $('#workspaceName').textContent = workspace.name;
  $('#workspaceAvatar').textContent = workspace.name.trim().slice(0, 1).toUpperCase();
  $('#workspaceContext').textContent = isLocalInstance ? 'Lokaler Tresor' : 'Webserver-Workspace';
}

async function switchWorkspace(id) {
  if (id === state.activeWorkspaceId) return;
  try {
    await api(`/api/workspaces/${encodeURIComponent(id)}/activate`, { method: 'POST', body: '{}' });
    for (const entry of state.terminalEntries.values()) {
      entry.resizeObserver.disconnect();
      entry.socket.close();
      entry.terminal.dispose();
    }
    state.terminalEntries.clear();
    state.metrics = [];
    state.metricsSession = null;
    state.activeId = null;
    state.sessions = [];
    await loadWorkspace();
    toast('Workspace gewechselt.');
  } catch (error) { toast(error.message, 'error'); }
}

function toggleWorkspaceMenu() {
  document.querySelector('.workspace-menu')?.remove();
  const button = $('#workspaceSwitch');
  button.setAttribute('aria-expanded', 'true');
  const menu = document.createElement('div');
  menu.className = 'workspace-menu';
  const items = state.workspaces.map(workspace => `<button type="button" data-workspace-id="${escapeHtml(workspace.id)}" class="workspace-option ${workspace.id === state.activeWorkspaceId ? 'active' : ''}"><span>${escapeHtml(workspace.name)}</span>${workspace.id === state.activeWorkspaceId ? '<b>Aktiv</b>' : ''}</button>`).join('');
  menu.innerHTML = `<div class="workspace-menu-label">DEINE WORKSPACES</div>${items}<div class="workspace-menu-actions"><button type="button" data-action="create">＋ Neu</button><button type="button" data-action="rename">Umbenennen</button><button type="button" data-action="delete">Löschen</button></div>`;
  button.insertAdjacentElement('afterend', menu);
  menu.querySelectorAll('[data-workspace-id]').forEach(item => item.addEventListener('click', () => { button.setAttribute('aria-expanded', 'false'); menu.remove(); switchWorkspace(item.dataset.workspaceId); }));
  menu.querySelector('[data-action="create"]').addEventListener('click', async () => {
    const name = prompt('Name für den neuen Workspace:');
    if (!name?.trim()) return;
    try {
      const result = await api('/api/workspaces', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      button.setAttribute('aria-expanded', 'false'); menu.remove();
      state.activeWorkspaceId = result.activeWorkspaceId;
      for (const entry of state.terminalEntries.values()) { entry.resizeObserver.disconnect(); entry.socket.close(); entry.terminal.dispose(); }
      state.terminalEntries.clear(); state.sessions = []; state.activeId = null; state.selectedHostId = null;
      await loadWorkspace();
      toast('Workspace erstellt.');
    } catch (error) { toast(error.message, 'error'); }
  });
  menu.querySelector('[data-action="rename"]').addEventListener('click', async () => {
    const current = state.workspaces.find(item => item.id === state.activeWorkspaceId);
    const name = prompt('Neuer Workspace-Name:', current?.name || '');
    if (!current || !name?.trim()) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(current.id)}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
      current.name = name.trim(); renderWorkspaceButton(); menu.remove(); button.setAttribute('aria-expanded', 'false');
    } catch (error) { toast(error.message, 'error'); }
  });
  menu.querySelector('[data-action="delete"]').addEventListener('click', async () => {
    const current = state.workspaces.find(item => item.id === state.activeWorkspaceId);
    if (!current || !confirm(`Workspace „${current.name}“ und seine Verbindungen löschen?`)) return;
    try {
      await api(`/api/workspaces/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
      menu.remove(); button.setAttribute('aria-expanded', 'false');
      for (const entry of state.terminalEntries.values()) { entry.resizeObserver.disconnect(); entry.socket.close(); entry.terminal.dispose(); }
      state.terminalEntries.clear(); state.sessions = []; state.activeId = null; state.selectedHostId = null;
      await loadWorkspace();
      toast('Workspace gelöscht.');
    } catch (error) { toast(error.message, 'error'); }
  });
  setTimeout(() => document.addEventListener('click', function dismiss(event) {
    if (!menu.contains(event.target) && event.target !== button) { menu.remove(); button.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', dismiss); }
  }, { once: true }), 0);
}

async function init() {
  const resetToken = new URLSearchParams(location.search).get('reset');
  if (resetToken) { state.passwordResetEnabled = true; showResetScreen(resetToken); return; }
  try {
    const status = await api('/api/auth/status');
    state.passwordResetEnabled = Boolean(status.passwordResetEnabled);
    state.adminBootstrapRequired = Boolean(status.adminBootstrapRequired);
    state.adminBootstrapConfigured = Boolean(status.adminBootstrapConfigured);
  } catch {}
  try {
    const user = await api('/api/auth/me');
    await mountWorkspace(user);
  } catch (error) {
    if (isLocalDesktopVault) {
      showLocalVaultError(error.status === 401 ? 'Der automatische Tresorzugang fehlt. Starte Termxxle erneut, damit Windows eine neue lokale Sitzung anlegen kann.' : error.message);
      return;
    }
    if (error.status === 401) {
      try {
        const status = await api('/api/auth/status');
        state.adminBootstrapRequired = Boolean(status.adminBootstrapRequired);
        state.adminBootstrapConfigured = Boolean(status.adminBootstrapConfigured);
        showAuthScreen(status.hasAccounts ? 'login' : 'register');
      } catch (statusError) {
        showAuthScreen('login', `Lokaler Dienst nicht erreichbar: ${statusError.message}`);
      }
    } else showAuthScreen('login', error.message);
  }
}

init();

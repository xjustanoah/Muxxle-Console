'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const dataDir = path.resolve(process.env.NEXTERM_DATA_DIR || path.join(os.homedir(), '.nexterm'));
const keyPath = path.join(dataDir, '.data-key');

function prepareDataKey() {
  if (process.env.NEXTERM_DATA_KEY) {
    if (!/^[a-fA-F0-9]{64}$/.test(process.env.NEXTERM_DATA_KEY)) {
      throw new Error('NEXTERM_DATA_KEY muss aus genau 64 Hex-Zeichen bestehen.');
    }
    return;
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dataDir, 0o700);

  let key = '';
  try { key = fs.readFileSync(keyPath, 'utf8').trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  if (!key) {
    for (const filename of ['users.json', 'hosts.json']) {
      const filePath = path.join(dataDir, filename);
      if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').includes('nexterm-encrypted-json')) {
        throw new Error('Verschlüsselte Daten vorhanden, aber .data-key fehlt.');
      }
    }
    key = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyPath, `${key}\n`, { flag: 'wx', mode: 0o600 });
  }

  if (!/^[a-fA-F0-9]{64}$/.test(key)) throw new Error('.data-key muss aus genau 64 Hex-Zeichen bestehen.');
  if (process.platform !== 'win32') fs.chmodSync(keyPath, 0o600);
  process.env.NEXTERM_DATA_KEY = key;
  process.env.NEXTERM_DATA_DIR = dataDir;
}

try { prepareDataKey(); }
catch (error) {
  console.error('NexTerm Startfehler:', error.message);
  process.exit(1);
}

const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  cwd: __dirname,
  env: process.env,
  stdio: 'inherit'
});
let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}

child.on('error', error => {
  console.error('NexTerm Prozessfehler:', error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});

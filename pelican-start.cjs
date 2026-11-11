'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const projectEnv = require('./project-env.cjs');

const root = projectEnv('ROOT') || '/home/container';
process.chdir(root);

function withoutGitCredentials(source) {
  const env = { ...source };
  for (const key of [
    'USERNAME',
    'ACCESS_TOKEN',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
  ]) {
    delete env[key];
  }
  return env;
}

const appEnv = withoutGitCredentials(process.env);
const gitEnv = { ...appEnv };
if (process.env.USERNAME && process.env.ACCESS_TOKEN) {
  gitEnv.GIT_CONFIG_COUNT = '1';
  gitEnv.GIT_CONFIG_KEY_0 = 'http.extraHeader';
  gitEnv.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(
    `${process.env.USERNAME}:${process.env.ACCESS_TOKEN}`,
  ).toString('base64')}`;
}

const branch = process.env.BRANCH || 'main';
const autoUpdate = process.env.AUTO_UPDATE === '1';
const hasRepo = fs.existsSync(path.join(root, '.git'));
const npm = '/usr/local/bin/npm';

function run(command, args, env = appEnv) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with code ${result.status}`);
  }
}

function captureGit(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    env: gitEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} exited with code ${result.status}`);
  }
  return result.stdout.trim();
}

function runGit(args) {
  run('git', args, gitEnv);
}

function packageList(value) {
  return (value || '').trim().split(/\s+/).filter(Boolean);
}

function syncOrigin() {
  if (!process.env.GIT_ADDRESS) return;
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], {
    cwd: root,
    env: appEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error) throw result.error;
  run('git', result.status === 0
    ? ['remote', 'set-url', 'origin', process.env.GIT_ADDRESS]
    : ['remote', 'add', 'origin', process.env.GIT_ADDRESS]);
}

function updateOnStartup() {
  if (!autoUpdate || !hasRepo) return;
  console.log(`Muxxle Console: prüfe GitHub-Branch ${branch}`);
  syncOrigin();
  runGit(['-c', 'credential.interactive=never', 'pull', '--ff-only', 'origin', branch]);
}

function prepareDataKey() {
  const dataDir = path.join(root, '.nexterm');
  const keyFile = path.join(dataDir, '.data-key');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);

  let dataKey = '';
  try {
    dataKey = fs.readFileSync(keyFile, 'utf8').trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (!dataKey) {
    for (const file of ['users.json', 'hosts.json']) {
      const filePath = path.join(dataDir, file);
      if (
        fs.existsSync(filePath)
        && fs.readFileSync(filePath, 'utf8').includes('nexterm-encrypted-json')
      ) {
        throw new Error('Verschlüsselte Daten vorhanden, aber .data-key fehlt.');
      }
    }
    dataKey = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyFile, dataKey, { mode: 0o600 });
  }

  if (!/^[a-fA-F0-9]{64}$/.test(dataKey)) {
    throw new Error('.data-key muss aus genau 64 Hex-Zeichen bestehen.');
  }
  fs.chmodSync(keyFile, 0o600);
  return { dataDir, dataKey };
}

function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function main() {
  updateOnStartup();

  const extras = packageList(process.env.NODE_PACKAGES);
  const remove = packageList(process.env.UNNODE_PACKAGES);
  if (extras.length) run(npm, ['install', '--no-save', ...extras]);
  if (remove.length) run(npm, ['uninstall', ...remove]);
  if (fs.existsSync(path.join(root, 'package.json'))) {
    console.log('Muxxle Console: installiere Produktionsabhängigkeiten');
    run(npm, ['install', '--omit=dev']);
  }

  const { dataDir, dataKey } = prepareDataKey();
  Object.assign(appEnv, {
    HOST: '0.0.0.0',
    PORT: process.env.PORT || '8081',
    TRUST_PROXY: process.env.TRUST_PROXY || '1',
    MUXXLE_CONSOLE_DATA_DIR: dataDir,
    MUXXLE_CONSOLE_DATA_KEY: dataKey,
  });

  let child = null;
  let stopping = false;
  let updating = false;
  let checking = false;
  let timer = null;

  const launch = () => {
    const instance = spawn('/usr/local/bin/node', ['/home/container/server.js'], {
      cwd: root,
      env: appEnv,
      stdio: 'inherit',
    });
    child = instance;
    instance.on('error', (error) => {
      console.error('Muxxle Console Prozessfehler:', error.message);
      if (!stopping && !updating) process.exit(1);
    });
    instance.on('exit', (code, signal) => {
      if (child === instance) child = null;
      if (!stopping && !updating) {
        console.error('Muxxle Console wurde beendet.', signal || code);
        process.exit(code ?? 1);
      }
    });
  };

  const checkUpdate = async () => {
    if (!autoUpdate || !hasRepo || checking || stopping) return;
    checking = true;
    try {
      const remoteSha = captureGit([
        'ls-remote', 'origin', `refs/heads/${branch}`,
      ]).split(/\s+/)[0];
      if (!remoteSha) return;

      const localSha = captureGit(['rev-parse', 'HEAD']);
      if (remoteSha === localSha) return;

      console.log('Muxxle Console: neuer GitHub-Commit erkannt; aktualisiere.');
      runGit(['-c', 'credential.interactive=never', 'pull', '--ff-only', 'origin', branch]);
      const updatedSha = captureGit(['rev-parse', 'HEAD']);
      if (updatedSha === localSha) return;

      try {
        run(npm, ['install', '--omit=dev']);
      } catch (error) {
        try {
          runGit(['reset', '--hard', localSha]);
        } catch (rollbackError) {
          console.error('Muxxle Console: Rollback fehlgeschlagen:', rollbackError.message);
        }
        throw error;
      }

      updating = true;
      await stop(child);
      if (stopping) return;
      updating = false;
      console.log('Muxxle Console: Update aktiv; starte Dienst neu.');
      launch();
    } catch (error) {
      updating = false;
      console.error('Muxxle Console Auto-Update:', error.message);
    } finally {
      checking = false;
    }
  };

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    if (timer) clearInterval(timer);
    stop(child).finally(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  launch();

  if (autoUpdate && hasRepo) {
    console.log(`Muxxle Console: prüft ${branch} alle 60 Sekunden auf Updates.`);
    timer = setInterval(() => void checkUpdate(), 60000);
  }
}

main().catch((error) => {
  console.error('Muxxle Console Startfehler:', error.message);
  process.exit(1);
});

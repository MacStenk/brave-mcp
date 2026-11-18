import net from 'node:net';
import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Brave, API_VERSION } from './browser.mjs';
import { startControl } from './control.mjs';
import { controlPort } from './settings.mjs';

// Ein älterer Hintergrundprozess darf neue Optionen nicht still ignorieren.
export function versionError(clientVersion) {
  if (!Number.isInteger(clientVersion) || clientVersion <= API_VERSION) return null;
  return `Shared Brave connection is outdated (API ${API_VERSION}, client expects ${clientVersion}). Restart with node src/server.mjs --stop.`;
}

const uid = process.getuid?.();
const root = process.env.BRAVE_MCP_RUNTIME_DIR || `/tmp/brave-session-mcp-${uid}`;
const socketPath = `${root}/bridge.sock`;

async function directory() {
  if (uid === undefined) throw new Error('Shared local access currently requires macOS or Linux.');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077)) throw new Error('Runtime directory must be owned by your user and have mode 0700.');
}

export async function serveBridge() {
  await directory();
  const browser = new Brave();
  let queue = Promise.resolve();
  const server = net.createServer(socket => {
    let data = ''; let handled = false;
    socket.on('error', () => {});
    socket.setTimeout(45000, () => socket.destroy());
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 2000000) return socket.destroy();
      if (handled || !data.includes('\n')) return;
      handled = true;
      queue = queue.then(async () => {
        try {
          const { method, args, apiVersion } = JSON.parse(data.slice(0, data.indexOf('\n')));
          if (method === 'stop') { socket.end(JSON.stringify({ result: { stopped: true } }) + '\n', () => void stop()); return; }
          const outdated = versionError(apiVersion);
          if (outdated) { socket.end(JSON.stringify({ error: outdated }) + '\n'); return; }
          socket.end(JSON.stringify({ result: await browser.call(method, args) }) + '\n');
        } catch (error) {
          // Nur die erste Zeile: Playwright hängt ein Aufrufprotokoll an, das Adressen aller Zwischenseiten enthalten kann.
          socket.end(JSON.stringify({ error: String(error.message).split('\n')[0] }) + '\n');
        }
      }).catch(() => socket.destroy());
    });
  });
  // Prozessende schließt nur die CDP-Verbindung, nicht den Browser des Nutzers.
  const stop = async () => { server.close(); await fs.unlink(socketPath).catch(() => {}); process.exit(0); };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  // Ohne Steuerseite (Port belegt) laufen die Werkzeuge weiter; brave_status meldet den Grund, Einstellungen gehen dann per Befehl.
  const port = controlPort();
  await startControl(browser, { port }).then(
    () => { browser.control = { running: true, url: `http://127.0.0.1:${port}/` }; },
    error => { browser.control = { running: false, error: `Control page unavailable: ${error.message}` }; console.error(browser.control.error); });
}

function rpc(method, args) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    socket.setTimeout(45000, () => { socket.destroy(); reject(new Error('Local browser request timed out.')); });
    socket.on('connect', () => socket.write(JSON.stringify({ method, args, apiVersion: API_VERSION }) + '\n'));
    socket.on('error', reject);
    socket.on('data', chunk => { data += chunk; if (data.length > 32000000) socket.destroy(new Error('Response too large.')); });
    socket.on('end', () => { try { const result = JSON.parse(data); result.error ? reject(new Error(result.error)) : resolve(result.result); } catch (error) { reject(error); } });
  });
}

export async function request(method, args = {}) {
  await directory();
  try { return await rpc(method, args); } catch (error) {
    // Einen bereits angenommenen Auftrag niemals automatisch wiederholen.
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    if (error.code === 'ECONNREFUSED') {
      const stat = await fs.lstat(socketPath);
      if (!stat.isSocket() || stat.uid !== uid) throw new Error('Unknown socket file.');
      await fs.unlink(socketPath);
    }
    if (method === 'stop') return { stopped: true };
  }
  const log = openSync(`${root}/bridge.log`, 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url)), '--bridge'], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref(); closeSync(log);
  for (let i = 0; i < 50; i++) {
    try { return await rpc(method, args); } catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error('Could not start the local Brave connection.');
}

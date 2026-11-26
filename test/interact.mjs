// Live-Test für Koordinaten-Klick, Hover, Ziehen, Tasten und die Debug-Werkzeuge.
// Läuft mit einer eigenen Einstellungsdatei (Kopie der echten, debug: true), die echte bleibt unverändert.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadSettings } from '../src/settings.mjs';

const page = `<!doctype html><title>Interaktion</title>
<style>body{margin:0;font:14px sans-serif} #c{position:fixed;left:10px;top:10px;background:#eee} #m{position:fixed;left:10px;top:130px;width:120px;height:30px;background:#cde}
#k{position:fixed;left:10px;top:200px;width:30px;height:30px;background:#38f} #i{position:fixed;left:10px;top:260px} #out{position:fixed;left:300px;top:10px;white-space:pre}</style>
<canvas id="c" width="200" height="100"></canvas><div id="m">Menü</div><div id="k"></div><input id="i" aria-label="Eingabe"><div id="out"></div>
<script>
const out = (k, v) => { const o = document.getElementById('out'); o.dataset[k] = v; o.textContent = Object.entries(o.dataset).map(([a, b]) => a + '=' + b).join('\\n'); };
c.addEventListener('mousedown', e => out('canvas', e.offsetX + ',' + e.offsetY));
m.addEventListener('mouseenter', () => out('hover', 'offen'));
let drag = null; k.addEventListener('mousedown', e => drag = e.clientX - k.offsetLeft);
addEventListener('mousemove', e => { if (drag !== null) k.style.left = (e.clientX - drag) + 'px'; });
addEventListener('mouseup', () => { if (drag !== null) { out('drag', k.offsetLeft); drag = null; } });
i.addEventListener('keydown', e => { if (e.key === 'Enter') out('keys', 'Enter:' + i.value); });
console.log('Hallo Konsole'); console.error('Fehler-Test');
fetch('/api?access_token=geheim&x=1');
</script>`;
const fixture = http.createServer((req, res) => { res.setHeader('Content-Type', req.url.startsWith('/api') ? 'application/json' : 'text/html; charset=utf-8'); res.end(req.url.startsWith('/api') ? '{}' : page); });
await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${fixture.address().port}/`;

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brave-mcp-interact-'));
const settingsFile = path.join(dir, 'settings.json');
const real = await loadSettings();
await fs.writeFile(settingsFile, JSON.stringify({ mode: real.mode, profile: real.profile, blocked: real.blocked, debug: true }));
const server = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
execFileSync(process.execPath, [server, '--stop']);
const env = { ...process.env, BRAVE_MCP_SETTINGS: settingsFile };
const client = new Client({ name: 'Interaktion-Test', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: 'pipe' }));
const raw = (name, args = {}) => client.callTool({ name, arguments: args });
const call = async (name, args = {}) => { const r = await raw(name, args); if (r.isError) throw new Error(`${name}: ${r.content[0].text}`); return JSON.parse(r.content[0].text); };
const value = async (tabId, key) => ((await call('brave_read', { tabId })).text.match(new RegExp(`${key}=(.*)`)) || [])[1];
let tabId;
try {
  assert.equal((await client.listTools()).tools.length, 16);
  ({ tabId } = await call('brave_open', { url, wait: 1000 }));

  // Screenshot liefert den sichtbaren Bereich für Koordinaten mit.
  const shot = await raw('brave_screenshot', { tabId, width: 640 });
  const meta = JSON.parse(shot.content[1].text);
  assert.ok(meta.viewport.width > 300, JSON.stringify(meta));

  // Klick auf Koordinaten (CSS-Pixel) und aus verkleinertem Screenshot umgerechnet.
  await call('brave_click', { tabId, x: 60, y: 40 });
  assert.equal(await value(tabId, 'canvas'), '50,30');
  await call('brave_click', { tabId, x: 110 * 640 / meta.viewport.width, y: 60 * 640 / meta.viewport.width, screenshotWidth: 640 });
  const [cx, cy] = (await value(tabId, 'canvas')).split(',').map(Number);
  assert.ok(Math.abs(cx - 100) <= 1 && Math.abs(cy - 50) <= 1, `umgerechnet: ${cx},${cy}`);
  await raw('brave_click', { tabId, x: 99999, y: 5 }).then(r => assert.ok(r.isError, 'Punkt außerhalb wird abgewiesen'));

  // Hover, Ziehen, Tasten.
  await call('brave_hover', { tabId, x: 50, y: 145 });
  assert.equal(await value(tabId, 'hover'), 'offen');
  await call('brave_drag', { tabId, fromX: 25, fromY: 215, toX: 125, toY: 215 });
  assert.ok(Math.abs(Number(await value(tabId, 'drag')) - 110) <= 2, 'Kästchen um 100 px gezogen');
  const input = (await call('brave_read', { tabId })).controls.find(c => c.label === 'Eingabe');
  await call('brave_key', { tabId, ref: input.ref, text: 'Grenzgänger', keys: ['Enter'] });
  assert.equal(await value(tabId, 'keys'), 'Enter:Grenzgänger');
  await raw('brave_key', { tabId, keys: ['rm -rf /'] }).then(r => assert.match(r.content[0].text, /Unknown key/));

  // Debug-Werkzeuge (nur in dieser Testeinstellung eingeschaltet).
  await call('brave_navigate', { tabId, url, wait: 1000 });
  const consoleLog = await call('brave_console', { tabId });
  assert.ok(consoleLog.entries.some(e => e.text === 'Hallo Konsole'));
  assert.ok((await call('brave_console', { tabId, onlyErrors: true })).entries.every(e => e.type === 'error' || e.type === 'pageerror'));
  const net = await call('brave_network', { tabId, filter: '/api' });
  assert.ok(net.entries.length >= 1 && net.entries.every(e => !e.url.includes('geheim')), JSON.stringify(net.entries));
  assert.equal((await call('brave_eval', { tabId, expression: 'document.title' })).result, '"Interaktion"');

  // Ausgeschaltet: verweigert.
  await fs.writeFile(settingsFile, JSON.stringify({ mode: real.mode, profile: real.profile, blocked: real.blocked, debug: false }));
  assert.match((await raw('brave_eval', { tabId, expression: '1' })).content[0].text, /switched off/);

  console.log(JSON.stringify({ ok: true, tools: 16, checks: ['viewport meta', 'coordinate click', 'scaled coordinates', 'out of view rejected', 'hover', 'drag', 'type + Enter', 'unknown key rejected', 'console', 'console errors', 'network redacted', 'eval', 'debug off refused'] }));
} finally {
  if (tabId) await call('brave_close', { tabId }).catch(() => {});
  await client.close().catch(() => {});
  fixture.close();
  execFileSync(process.execPath, [server, '--stop']);
  await fs.rm(dir, { recursive: true, force: true });
}

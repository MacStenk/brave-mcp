// Live-Test für Randfälle des Torwächters: iframe einer fremden Site (eigener Prozess, OOPIF),
// Popup aus einem Agenten-Tab, echte schwere Seite. Öffnet und schließt nur eigene Tabs.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const listen = handler => new Promise(resolve => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const html = (res, body) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(body); };
// Zweiter Server unter "localhost": andere Site als 127.0.0.1, Brave legt das iframe in einen eigenen Prozess.
const foreign = await listen((req, res) => html(res, '<!doctype html><button onclick="this.textContent=\'Fremd bestätigt\'">Fremd-Test</button>'));
const main = await listen((req, res) => {
  if (req.url === '/popup') return html(res, '<!doctype html><title>Popup</title><h1>Popup erreicht</h1>');
  html(res, `<!doctype html><title>Randfälle</title><h1>Randfälle</h1>
<iframe src="http://localhost:${foreign.address().port}/" style="width:300px;height:80px"></iframe>
<button onclick="window.open('/popup','_blank')">Popup öffnen</button>`);
});
const base = `http://127.0.0.1:${main.address().port}`;

const server = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
execFileSync(process.execPath, [server, '--stop']);
const client = new Client({ name: 'Randfall-Test', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server], stderr: 'pipe' }));
const call = async (name, args = {}) => {
  const t0 = Date.now();
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
  return { ...(result.content[0].type === 'text' ? JSON.parse(result.content[0].text) : {}), ms: Date.now() - t0 };
};
const timings = {};
const opened = [];
try {
  // 1. iframe einer fremden Site
  const { tabId } = await call('brave_open', { url: `${base}/`, wait: 1500 }); opened.push(tabId);
  const page = await call('brave_read', { tabId });
  const xo = page.frames.find(f => f.url.startsWith('http://localhost:'));
  assert.ok(xo, `fremdes iframe in der Frame-Liste: ${JSON.stringify(page.frames)}`);
  const inner = await call('brave_read', { tabId, frameId: xo.frameId });
  await call('brave_click', { tabId, ref: inner.controls.find(c => c.label === 'Fremd-Test').ref });
  assert.match((await call('brave_read', { tabId, frameId: xo.frameId })).text, /Fremd bestätigt/);
  timings.crossSiteIframe = 'ok';

  // 2. Popup aus dem Agenten-Tab
  const read2 = await call('brave_read', { tabId });
  await call('brave_click', { tabId, ref: read2.controls.find(c => c.label === 'Popup öffnen').ref, wait: 1500 });
  const tabsResult = await client.callTool({ name: 'brave_tabs', arguments: {} });
  const tabs = JSON.parse(tabsResult.content[0].text);
  const popup = tabs.find(t => t.url === `${base}/popup`);
  assert.ok(popup, `Popup in brave_tabs: ${JSON.stringify(tabs.map(t => t.url))}`);
  assert.match((await call('brave_read', { tabId: popup.tabId })).text, /Popup erreicht/);
  timings.popup = 'ok';
  // Das Popup hat der Agent nicht mit brave_open geöffnet: Schließen bleibt (wie bisher) verweigert.
  await call('brave_close', { tabId: popup.tabId }).then(() => assert.fail('Popup ließ sich schließen'), error => assert.match(error.message, /Only tabs opened with brave_open/));
  timings.popupCloseDenied = 'ok';

  // 3. Echte schwere Seite
  const gh = await call('brave_open', { url: 'https://github.com/MacStenk/brave-mcp', wait: 2500 }); opened.push(gh.tabId);
  timings.realOpenMs = gh.ms;
  const ghRead = await call('brave_read', { tabId: gh.tabId });
  timings.realReadMs = ghRead.ms; timings.realChars = ghRead.charsTotal; timings.realControls = ghRead.controlsTotal;
  const issues = (await call('brave_read', { tabId: gh.tabId, controlFilter: 'Issues' })).controls[0];
  assert.ok(issues, 'Issues-Link gefunden');
  const click = await call('brave_click', { tabId: gh.tabId, ref: issues.ref, wait: 2500 });
  timings.realClickMs = click.ms;
  assert.match((await call('brave_read', { tabId: gh.tabId, maxChars: 2000 })).url, /\/issues/);
  const shot = await client.callTool({ name: 'brave_screenshot', arguments: { tabId: gh.tabId, width: 768 } });
  assert.equal(shot.content[0].type, 'image');
  timings.realPage = 'ok';

  console.log(JSON.stringify({ ok: true, ...timings }));
} finally {
  for (const tabId of opened) await call('brave_close', { tabId }).catch(() => {});
  await client.close().catch(() => {});
  main.close(); foreign.close();
  execFileSync(process.execPath, [server, '--stop']);
}

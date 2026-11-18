import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

const fixture = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Viele Navigationslinks vor einem unbeschrifteten Schalter und einer von einem Icon überdeckten Checkbox (wie Cloudflare und Bing).
  if (request.url === '/switch') return response.end(`<!doctype html><title>Schalter</title><nav>${Array.from({ length: 250 }, (_, i) => `<a href="#m${i}">Menü ${i}</a>`).join(' ')}</nav><div><span>"Bot Fight"-Modus</span> <span><button role="switch" aria-label="Switch" aria-checked="true" onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked') === 'true' ? 'false' : 'true')" style="width:40px;height:20px"></button><input type="checkbox" checked aria-hidden="true" tabindex="-1" style="position:fixed;left:0;top:0;width:1px;height:1px;margin:0"></span></div><label style="position:relative;display:inline-block;padding-left:24px"><input type="checkbox" style="position:absolute;left:0;top:0"><i style="position:absolute;left:0;top:0;width:20px;height:20px;background:#38f"></i>Alle Subdomains</label>`);
  response.end(request.url === '/frame' ? '<button onclick="this.textContent=\'Frame bestätigt\'">Frame-Test</button>' : request.url === '/next' ? '<!doctype html><title>Brave MCP – nächste Seite</title><h1>Nächste Seite erreicht</h1><p><a href="/">Zurück</a></p>' : `<!doctype html><title>Brave MCP – lokaler Funktionstest</title><h1>Lokaler MCP-Test</h1><label>Name <input id="name"></label><button onclick="document.querySelector('#result').textContent='Hallo '+document.querySelector('#name').value">Bestätigen</button><p id="result"></p><label>Datei <input type="file" hidden onchange="document.querySelector('#file').textContent=this.files[0].name"></label><p id="file"></p><iframe src="/frame"></iframe><a href="/next">Weiter</a><p id="long"></p><script>document.querySelector('#long').textContent='x'.repeat(15000)+'ENDE-MARKER'</script>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const clients = [];
async function client(name) {
  const client = new Client({ name, version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], stderr: 'pipe' }));
  clients.push(client); return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content[0].text);
  return result.content[0].type === 'text' ? JSON.parse(result.content[0].text) : result;
}
try {
  const a = await client('Test-Agent-A'), b = await client('Test-Agent-B');
  assert.equal((await a.listTools()).tools.length, 9);
  const { tabId } = await call(a, 'brave_open', { url: `http://127.0.0.1:${fixture.address().port}/` });
  const read = await call(a, 'brave_read', { tabId });
  const ref = label => read.controls.find(control => control.label === label).ref;
  await call(b, 'brave_fill', { tabId, ref: ref('Name'), text: 'MCP' });
  await call(b, 'brave_click', { tabId, ref: ref('Bestätigen') });
  assert.match((await call(a, 'brave_read', { tabId })).text, /Hallo MCP/);
  const upload = read.controls.find(control => control.type === 'file');
  await call(a, 'brave_upload', { tabId, ref: upload.ref, files: [fileURLToPath(new URL('./browser.test.mjs', import.meta.url))] });
  assert.match((await call(a, 'brave_read', { tabId })).text, /browser.test.mjs/);
  const frameId = read.frames.find(frame => frame.url.endsWith('/frame')).frameId;
  const frame = await call(a, 'brave_read', { tabId, frameId });
  await call(b, 'brave_click', { tabId, ref: frame.controls.find(control => control.label === 'Frame-Test').ref });
  assert.match((await call(a, 'brave_read', { tabId, frameId })).text, /Frame bestätigt/);
  const start = await call(a, 'brave_read', { tabId, maxChars: 100 });
  assert.ok(start.charsTotal > 15000, `Langer Text vollständig erkannt: ${start.charsTotal}`);
  const tail = await call(a, 'brave_read', { tabId, maxChars: 500, charOffset: start.charsTotal - 500 });
  assert.equal(tail.charOffset, start.charsTotal - 500);
  assert.equal(tail.nextCharOffset, null);
  assert.match(tail.text, /ENDE-MARKER/);
  const before = await call(a, 'brave_read', { tabId });
  await call(b, 'brave_click', { tabId, ref: before.controls.find(control => control.label === 'Weiter').ref, wait: 4000 });
  assert.match((await call(a, 'brave_read', { tabId })).text, /Nächste Seite erreicht/);
  await call(a, 'brave_navigate', { tabId, url: `http://127.0.0.1:${fixture.address().port}/switch` });
  const crowded = await call(a, 'brave_read', { tabId, maxChars: 100 });
  assert.equal(crowded.controls.length, 200);
  assert.ok(crowded.controlsTotal > 200 && crowded.nextControlOffset === 200, 'Kürzung der Bedienelemente wird gemeldet');
  const [toggle] = (await call(a, 'brave_read', { tabId, maxChars: 100, controlFilter: 'Bot Fight' })).controls;
  assert.equal(toggle.role, 'switch'); assert.equal(toggle.checked, true); assert.match(toggle.context, /Bot Fight/);
  assert.equal((await call(b, 'brave_click', { tabId, ref: toggle.ref })).checked, false, 'Schalter meldet neuen Zustand');
  const [box] = (await call(a, 'brave_read', { tabId, maxChars: 100, controlFilter: 'Subdomains' })).controls;
  assert.equal(box.checked, false);
  assert.equal((await call(b, 'brave_click', { tabId, ref: box.ref })).checked, true, 'Überdeckte Checkbox lässt sich setzen');
  const screenshot = await b.callTool({ name: 'brave_screenshot', arguments: { tabId } });
  assert.equal(screenshot.content[0].type, 'image');
  assert.ok(Buffer.from(screenshot.content[0].data, 'base64').length > 100);
  const small = await b.callTool({ name: 'brave_screenshot', arguments: { tabId, width: 480 } });
  const smallBytes = Buffer.from(small.content[0].data, 'base64');
  assert.equal(small.content[0].mimeType, 'image/jpeg');
  assert.equal(smallBytes[0], 0xff, 'JPEG-Magiebyte');
  assert.ok(smallBytes.length < Buffer.from(screenshot.content[0].data, 'base64').length, 'verkleinerter Screenshot ist kleiner');
  const sa = await call(a, 'brave_status'), sb = await call(b, 'brave_status');
  assert.equal(sa.daemonPid, sb.daemonPid); assert.equal(sa.browserConnections, 1); assert.equal(sb.browserConnections, 1);
  assert.ok(Number.isInteger(sa.apiVersion) && sa.apiVersion >= 2 && sa.apiVersion === sb.apiVersion, 'API-Version im Status beider Clients');
  await call(a, 'brave_navigate', { tabId, url: 'about:blank' }).then(() => assert.fail('Interne Navigation wurde erlaubt'), () => {});
  console.log(JSON.stringify({ ok: true, tools: 9, clients: 2, browserConnections: 1, checks: ['initialize', 'tools/list', 'fill', 'trusted click', 'hidden upload', 'iframe', 'charOffset paging', 'wait after click navigation', 'control paging', 'control filter', 'switch state', 'covered checkbox', 'screenshot', 'scaled screenshot', 'version handshake', 'client sharing', 'URL validation'] }));
  // Testseite leer zurücklassen; fremde Tabs bleiben unverändert.
  await call(a, 'brave_navigate', { tabId, url: `http://127.0.0.1:${fixture.address().port}/done` });
} finally {
  await Promise.allSettled(clients.map(client => client.close()));
  fixture.close();
}

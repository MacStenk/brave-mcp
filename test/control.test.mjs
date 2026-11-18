import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { normalizeSite, isBlocked, isControl, agentVisible, loadSettings, updateSettings, controlKey, controlKeyPath } from '../src/settings.mjs';
import { startControl } from '../src/control.mjs';

test('Sperrliste: Domain sperrt Subdomains, aber keine ähnlich klingenden Domains', () => {
  assert.equal(normalizeSite('https://www.Sparkasse.de/login?x=1'), 'sparkasse.de');
  assert.equal(normalizeSite('mail.google.com/'), 'mail.google.com');
  assert.throws(() => normalizeSite('javascript:alert(1)'), /not a domain/);
  assert.ok(isBlocked('https://mail.google.com/u/0', ['google.com']));
  assert.ok(!isBlocked('https://notgoogle.com/', ['google.com']));
  assert.ok(!isBlocked('https://google.com/', ['mail.google.com']));
});

test('Abschließender Punkt im Hostnamen umgeht weder Sperrliste noch Steuerseite', () => {
  assert.ok(isBlocked('https://bank.de./konto', ['bank.de']));
  assert.ok(isBlocked('https://login.bank.de../', ['bank.de']));
  assert.ok(isControl('http://localhost.:47821/', 47821));
  assert.ok(isControl('http://127.0.0.1:47821/', 47821));
  assert.equal(normalizeSite('bank.de.'), 'bank.de');
});

test('Für Agenten sichtbar sind nur http(s)-Seiten ohne Sperre, Steuerseite und Debugging-Schnittstelle', () => {
  for (const url of ['https://example.org/', 'http://intranet.example/x']) assert.ok(agentVisible(url, ['bank.de'], 9222), url);
  for (const url of ['about:blank', 'about:srcdoc', 'blob:https://example.org/1234', 'data:text/html,x', 'brave://history', 'chrome-extension://abc/vault.html',
    'view-source:https://example.org/', 'filesystem:https://example.org/temporary/x', 'file:///etc/passwd', 'https://bank.de/', 'https://bank.de./',
    'http://127.0.0.1:47821/', 'http://127.0.0.1:9222/json/list', 'http://localhost:9222/', 'kaputt']) {
    assert.ok(!agentVisible(url, ['bank.de'], 9222), url);
  }
  // blob: zählt zur Herkunft, die ihn erzeugt hat.
  assert.ok(isBlocked('blob:https://bank.de/1234', ['bank.de']));
});

test('Fehlerhafte Einstellungen brechen ab statt alles zu erlauben', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brave-mcp-settings-'));
  const file = path.join(dir, 'settings.json');
  const save = value => fs.writeFile(file, JSON.stringify(value));
  try {
    for (const bad of [{ mode: 'Agent' }, { mode: 1 }, { blocked: 'bank.de' }, { blocked: [42] }, { blocked: ['kein domain'] }, { profile: '' }, [], null]) {
      await save(bad);
      await assert.rejects(loadSettings(file), /Settings file/, JSON.stringify(bad));
    }
    await save({ mode: 'all', blocked: ['https://www.Bank.de/login', 'bank.de', 'Mail.Google.com.'] });
    assert.deepEqual((await loadSettings(file)).blocked, ['bank.de', 'mail.google.com']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Gleichzeitige Änderungen gehen nicht verloren', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brave-mcp-settings-'));
  const file = path.join(dir, 'settings.json');
  try {
    const sites = Array.from({ length: 20 }, (_, i) => `site${i}.example`);
    await Promise.all(sites.map(site => updateSettings(s => { s.blocked.push(site); }, file)));
    assert.deepEqual((await loadSettings(file)).blocked.sort(), sites.sort());
    assert.deepEqual((await fs.readdir(dir)).filter(name => name.endsWith('.tmp')), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Steuerseite nur mit Schlüssel des Nutzers; Änderungen nur mit eigenem Host, eigener Herkunft und Formularschlüssel', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brave-mcp-control-'));
  const file = path.join(dir, 'settings.json');
  const port = 40000 + Math.floor(Math.random() * 20000);
  const server = await startControl({ openUrls: () => ['https://www.bank.example/konto', 'https://github.com/'] }, { port, file });
  const base = `http://127.0.0.1:${port}/`;
  try {
    const key = await controlKey(file);
    assert.equal((await fs.stat(controlKeyPath(file))).mode & 0o777, 0o600);
    assert.equal(await controlKey(file), key, 'Schlüssel bleibt über Aufrufe gleich');

    // Ohne Cookie: weder Seite noch Änderungen, nur der Hinweis auf den Befehl.
    const locked = await fetch(base);
    assert.equal(locked.status, 403);
    const lockedHtml = await locked.text();
    assert.match(lockedHtml, /npx brave-session-mcp control/);
    assert.doesNotMatch(lockedHtml, /bank\.example|token/);
    assert.equal((await fetch(`${base}?key=falsch`, { redirect: 'manual' })).status, 403);

    // Mit Schlüssel: 303 auf / und ein HttpOnly-, SameSite=Strict-Cookie.
    const unlock = await fetch(`${base}?key=${key}`, { redirect: 'manual' });
    assert.equal(unlock.status, 303);
    assert.equal(unlock.headers.get('location'), '/');
    const setCookie = unlock.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
    assert.ok(!setCookie.includes(key), 'Cookie enthält nicht den dauerhaften Schlüssel');
    const cookie = setCookie.split(';')[0];

    const html = await (await fetch(base, { headers: { Cookie: cookie } })).text();
    assert.match(html, /bank\.example/);
    const token = html.match(/name="token" value="([^"]+)"/)[1];
    const post = (body, headers = {}) => fetch(base, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: `http://127.0.0.1:${port}`, Cookie: cookie, ...headers }, body: new URLSearchParams(body) });

    const rebound = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: `evil.example:${port}`, Cookie: cookie } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    assert.equal(rebound, 421);
    assert.equal((await post({ action: 'block', site: 'bank.example', token }, { Cookie: '' })).status, 403, 'POST ohne Cookie');
    assert.equal((await post({ action: 'block', site: 'bank.example', token: 'guess' })).status, 403);
    assert.equal((await post({ action: 'block', site: 'bank.example', token }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ action: 'block', site: 'bank.example', token }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.deepEqual((await loadSettings(file)).blocked, []);

    assert.equal((await post({ action: 'block', site: 'bank.example', token }, { 'Sec-Fetch-Site': 'same-origin' })).status, 303);
    assert.equal((await post({ action: 'mode', mode: 'agent', token })).status, 303);
    assert.deepEqual(await loadSettings(file), { mode: 'agent', profile: process.env.BRAVE_MCP_PROFILE || 'Agent', blocked: ['bank.example'] });
    assert.equal((await post({ action: 'unblock', site: 'bank.example', token })).status, 303);
    assert.deepEqual((await loadSettings(file)).blocked, []);
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

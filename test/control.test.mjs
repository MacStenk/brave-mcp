import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { normalizeSite, isBlocked, loadSettings } from '../src/settings.mjs';
import { startControl } from '../src/control.mjs';

test('Sperrliste: Domain sperrt Subdomains, aber keine ähnlich klingenden Domains', () => {
  assert.equal(normalizeSite('https://www.Sparkasse.de/login?x=1'), 'sparkasse.de');
  assert.equal(normalizeSite('mail.google.com/'), 'mail.google.com');
  assert.throws(() => normalizeSite('javascript:alert(1)'), /not a domain/);
  assert.ok(isBlocked('https://mail.google.com/u/0', ['google.com']));
  assert.ok(!isBlocked('https://notgoogle.com/', ['google.com']));
  assert.ok(!isBlocked('https://google.com/', ['mail.google.com']));
});

test('Steuerseite ändert Einstellungen nur mit eigenem Host, eigener Herkunft und Schlüssel', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brave-mcp-control-'));
  const file = path.join(dir, 'settings.json');
  const port = 40000 + Math.floor(Math.random() * 20000);
  const server = await startControl({ openUrls: () => ['https://www.bank.example/konto', 'https://github.com/'] }, { port, file });
  const base = `http://127.0.0.1:${port}/`;
  try {
    const html = await (await fetch(base)).text();
    assert.match(html, /bank\.example/);
    const token = html.match(/name="token" value="([^"]+)"/)[1];
    const post = (body, headers = {}) => fetch(base, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: `http://127.0.0.1:${port}`, ...headers }, body: new URLSearchParams(body) });

    const rebound = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: `evil.example:${port}` } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    assert.equal(rebound, 421);
    assert.equal((await post({ action: 'block', site: 'bank.example', token: 'guess' })).status, 403);
    assert.equal((await post({ action: 'block', site: 'bank.example', token }, { Origin: 'https://evil.example' })).status, 403);
    assert.deepEqual((await loadSettings(file)).blocked, []);

    assert.equal((await post({ action: 'block', site: 'bank.example', token })).status, 303);
    assert.equal((await post({ action: 'mode', mode: 'agent', token })).status, 303);
    assert.deepEqual(await loadSettings(file), { mode: 'agent', profile: process.env.BRAVE_MCP_PROFILE || 'Agent', blocked: ['bank.example'] });
    assert.equal((await post({ action: 'unblock', site: 'bank.example', token })).status, 303);
    assert.deepEqual((await loadSettings(file)).blocked, []);
  } finally {
    server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

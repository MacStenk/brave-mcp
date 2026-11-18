import test from 'node:test';
import assert from 'node:assert/strict';
import { Brave, localEndpoint, API_VERSION, pageControls, stripIcons, uploadPaths, profileDirectory } from '../src/browser.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { versionError } from '../src/bridge.mjs';

test('Verbindet ausschließlich den lokalen Debugging-Endpunkt', () => {
  assert.equal(localEndpoint('1234\n/devtools/browser/abc-123\n'), 'ws://127.0.0.1:1234/devtools/browser/abc-123');
  for (const text of ['0\n/devtools/browser/a', '65536\n/devtools/browser/a', '1234\nws://example.org/x', '1234\n/devtools/browser/../a', '1234\n/devtools/browser/a\nextra']) assert.throws(() => localEndpoint(text));
});
test('Elementreferenzen können nicht auf einen anderen Tab angewendet werden', async () => {
  const brave = new Brave();
  brave.page = async () => ({});
  brave.refs.set('ref-a', { tabId: 'tab-a', created: Date.now() });
  await assert.rejects(brave.element('tab-b', 'ref-a'), /another tab/);
});
test('Veraltete Referenzen werden vor jeder Browseraktion abgewiesen', async () => {
  const brave = new Brave();
  brave.page = async () => ({});
  brave.refs.set('ref-a', { tabId: 'tab-a', created: 0 });
  await assert.rejects(brave.element('tab-a', 'ref-a'), /Stale reference/);
});
test('Wartezeit wartet nach einer Aktion auf Laden und Beruhigung', async () => {
  const brave = new Brave();
  const seen = [];
  const page = {
    waitForLoadState: async (state, options) => { seen.push(['load', state, options.timeout]); },
    waitForTimeout: async ms => { seen.push(['settle', ms]); },
  };
  await brave.settle(page);
  assert.deepEqual(seen, []);
  await brave.settle(page, 4000);
  assert.deepEqual(seen[0], ['load', 'domcontentloaded', 4000]);
  assert.equal(seen[1][0], 'settle'); assert.ok(seen[1][1] > 3900, `Beruhigungsfenster fast vollständig: ${seen[1][1]}`);
});
test('Versionsabgleich meldet nur veraltete Hintergrundprozesse', () => {
  assert.equal(versionError(undefined), null, 'Alter Client ohne Versionsfeld bleibt erlaubt');
  assert.equal(versionError(API_VERSION), null);
  assert.match(versionError(API_VERSION + 1), /outdated/);
});
test('Nach Trennung wird die alte Verbindung verworfen und klar zur Freigabe aufgefordert', async () => {
  const brave = new Brave();
  brave.browser = { isConnected: () => false };
  process.env.BRAVE_USER_DATA_DIR = '/tmp/brave-mcp-ohne-freigabe';
  try {
    await assert.rejects(brave.connect(), /remote debugging not found/);
    assert.equal(brave.browser, undefined, 'Veraltete Verbindung wurde verworfen');
  } finally { delete process.env.BRAVE_USER_DATA_DIR; }
});
test('Bedienelemente hinter vielen Navigationslinks bleiben über Filter und Blättern erreichbar', () => {
  const nav = Array.from({ length: 250 }, (_, i) => ({ label: `Menü ${i}` }));
  const items = [...nav, { label: '', context: '"Bot Fight"-Modus Erkennen und fordern Sie Bot-Traffic heraus.', role: 'switch', checked: true }];
  const first = pageControls(items);
  assert.equal(first.page.length, 200);
  assert.equal(first.controlsTotal, 251);
  assert.equal(first.nextControlOffset, 200, 'Kürzung wird gemeldet');
  const rest = pageControls(items, { controlOffset: first.nextControlOffset });
  assert.equal(rest.page.at(-1).role, 'switch');
  assert.equal(rest.nextControlOffset, null);
  const filtered = pageControls(items, { controlFilter: 'bot fight' });
  assert.deepEqual(filtered.page.map(item => item.role), ['switch'], 'Filter durchsucht auch den Kontext unbeschrifteter Schalter');
  assert.equal(filtered.controlsTotal, 1);
});
test('Icon-Zeichen aus Webfonts verschwinden samt ihrer leeren Zeilen', () => {
  assert.equal(stripIcons('\uE774\ncodeback.de/\n\uE70D\n\uE80F\nHome\nKI \u{F0001}fragen'), 'codeback.de/\nHome\nKI fragen');
});
test('Tabs des Nutzers lassen sich nicht schließen', async () => {
  const brave = new Brave();
  let closed = false;
  brave.page = async () => ({ close: async () => { closed = true; } });
  await assert.rejects(brave.call('close', { tabId: 'tab-nutzer' }), /Only tabs opened with brave_open/);
  assert.equal(closed, false);
});
test('Uploads nur aus dem Upload-Ordner, auch nicht über Symlinks oder ../', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'brave-mcp-upload-'));
  try {
    const root = path.join(tmp, 'erlaubt');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'bild.png'), 'x');
    await fs.writeFile(path.join(tmp, 'geheim.txt'), 'x');
    await fs.symlink(path.join(tmp, 'geheim.txt'), path.join(root, 'link.txt'));
    const [ok] = await uploadPaths(['bild.png'], root);
    assert.equal(ok, await fs.realpath(path.join(root, 'bild.png')));
    for (const file of [path.join(tmp, 'geheim.txt'), '../geheim.txt', 'link.txt']) {
      await assert.rejects(uploadPaths([file], root), /only allowed from/, `rejected: ${file}`);
    }
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});
test('Agenten-Profil wird über seinen Anzeigenamen gefunden, fehlendes Profil erklärt den Weg', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'brave-mcp-profile-'));
  try {
    await fs.writeFile(path.join(tmp, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Persönliches' }, 'Profile 3': { name: 'Agent' } } } }));
    assert.equal(await profileDirectory('Agent', tmp), 'Profile 3');
    await assert.rejects(profileDirectory('Fehlt', tmp), /profile icon → Add/);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

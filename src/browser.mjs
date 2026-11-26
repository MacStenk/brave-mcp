import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { loadSettings, agentVisible, isForbidden } from './settings.mjs';
import { Gate } from './gate.mjs';

export function localEndpoint(portFile) {
  const [port, route, ...rest] = portFile.trim().split(/\r?\n/);
  if (rest.length || !/^\d+$/.test(port) || +port < 1 || +port > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(route)) throw new Error('Invalid Brave debugging address.');
  return `ws://127.0.0.1:${+port}${route}`;
}

// Brave-Varianten in Suchreihenfolge. Gewählt wird die mit aktiver Debugging-Freigabe (DevToolsActivePort),
// sonst die erste installierte. BRAVE_USER_DATA_DIR, BRAVE_APP und BRAVE_BIN überschreiben die Erkennung.
export const BRAVE_VARIANTS = [
  { name: 'nightly', dir: 'Brave-Browser-Nightly', app: 'Brave Browser Nightly', bin: 'brave-browser-nightly' },
  { name: 'beta', dir: 'Brave-Browser-Beta', app: 'Brave Browser Beta', bin: 'brave-browser-beta' },
  { name: 'stable', dir: 'Brave-Browser', app: 'Brave Browser', bin: 'brave-browser' },
];
export function userDataDirOf(variant, platform = process.platform, home = os.homedir(), localAppData = process.env.LOCALAPPDATA) {
  if (platform === 'darwin') return path.join(home, 'Library/Application Support/BraveSoftware', variant.dir);
  if (platform === 'win32') return path.join(localAppData || path.join(home, 'AppData/Local'), 'BraveSoftware', variant.dir, 'User Data');
  return path.join(home, '.config/BraveSoftware', variant.dir);
}
const exists = file => fs.access(file).then(() => true, () => false);
export async function detectBrave({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (env.BRAVE_USER_DATA_DIR) {
    const known = BRAVE_VARIANTS.find(v => env.BRAVE_USER_DATA_DIR.includes(v.dir + path.sep) || env.BRAVE_USER_DATA_DIR.endsWith(v.dir)) ?? BRAVE_VARIANTS[0];
    return { ...known, userDataDir: env.BRAVE_USER_DATA_DIR, app: env.BRAVE_APP || known.app, bin: env.BRAVE_BIN || known.bin };
  }
  const candidates = BRAVE_VARIANTS.map(v => ({ ...v, userDataDir: userDataDirOf(v, platform, home, env.LOCALAPPDATA) }));
  const pick = (await Promise.all(candidates.map(async c => (await exists(path.join(c.userDataDir, 'DevToolsActivePort'))) && c))).find(Boolean)
    ?? (await Promise.all(candidates.map(async c => (await exists(c.userDataDir)) && c))).find(Boolean)
    ?? candidates[0];
  return { ...pick, app: env.BRAVE_APP || pick.app, bin: env.BRAVE_BIN || pick.bin };
}

const describe = element => {
  const role = element.getAttribute('role');
  const checkable = element.matches('input[type=checkbox],input[type=radio]') || ['switch', 'checkbox', 'radio'].includes(role);
  const byId = (element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => id && element.ownerDocument.getElementById(id)?.innerText).filter(Boolean).join(' ');
  // Icon-Zeichen aus Webfonts (Unicode Private Use Area) tragen keine Bedeutung und kosten nur Tokens.
  // Gleiche Regel wie stripIcons; hier eingebettet, weil describe im Browser läuft und keine Modulvariablen sieht.
  const clean = text => text.replace(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, '').trim();
  const label = clean(element.getAttribute('aria-label') || byId || element.labels?.[0]?.innerText || element.innerText || element.getAttribute('placeholder') || element.title || '').slice(0, 180);
  // Schalter und unbeschriftete Elemente: Text der nächsten umgebenden Zeile als Kontext,
  // weil Beschriftungen wie aria-label="Switch" (Cloudflare) nichts über die Einstellung sagen.
  let context;
  if (!label || checkable) for (let node = element.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth++) {
    const text = clean(node.innerText || '');
    if (text) { context = text.replace(/\s+/g, ' ').slice(0, 180); break; }
  }
  return {
    tag: element.tagName.toLowerCase(),
    label,
    type: element.getAttribute('type'),
    ...(role ? { role } : {}),
    ...(context ? { context } : {}),
    ...(checkable ? { checked: element.matches('input') ? element.checked : element.getAttribute('aria-checked') === 'true' } : {}),
    value: element.matches('input:not([type=password]):not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=radio]),textarea,select') ? element.value.slice(0, 250) : undefined,
  };
};

// Text, Adresse und Bedienelemente in einem einzigen Aufruf ohne Warten: Alles stammt sicher aus demselben Dokument,
// und die zurückgegebene Adresse lässt sich danach prüfen (ein Wechsel auf eine gesperrte Seite während des Lesens fällt auf).
const collect = (describe, selector) => {
  const shown = e => {
    const style = getComputedStyle(e); const rect = e.getBoundingClientRect();
    return e.checkVisibility() && style.visibility === 'visible' && rect.width > 0 && rect.height > 0;
  };
  const elements = []; const items = [];
  for (const e of document.querySelectorAll(selector)) {
    if (!shown(e) && !e.matches('input[type=file]')) continue;
    // UI-Bibliotheken (Base UI, Radix) spiegeln einen Schalter in ein verstecktes 1×1-Eingabefeld; nur den echten Schalter liefern.
    if (e.matches('input[type=checkbox],input[type=radio]') && e.parentElement?.querySelector('[role=switch],[role=checkbox],[role=radio]')) continue;
    elements.push(e); items.push(describe(e));
  }
  return { href: location.href, text: document.body?.innerText ?? '', elements, items };
};

const CONTROLS = 'button,a[href],input:not([type=hidden]),textarea,select,summary,[role=button],[role=radio],[role=checkbox],[role=switch],[role=tab],[role=menuitem],[contenteditable=true]';
// Als Ausdruck statt Funktion übergeben, damit describe mitkommt; CDP-Auswertung unterliegt nicht der CSP der Seite.
const COLLECT = `(${collect})(${describe}, ${JSON.stringify(CONTROLS)})`;

const HIDDEN = 'This page is not available to agents (blocked by the user or not an http(s) page).';
const CHANGED = 'The page changed while it was being read; call brave_tabs and brave_read again.';

// Ein Frame ist nur sichtbar, wenn er selbst und alle umgebenden Frames sichtbar sind.
export function frameVisible(frame, blocked, devtoolsPort) {
  for (let item = frame; item; item = item.parentFrame()) if (!agentVisible(item.url(), blocked, devtoolsPort)) return false;
  return true;
}
// Seite bettet eine gesperrte Seite ein (Frames darunter zählen mit, weil ihr Elternframe gesperrt ist).
export function embedsForbidden(page, blocked, devtoolsPort) {
  return page.frames().some(frame => isForbidden(frame.url(), blocked, devtoolsPort));
}

// Filtert nach Beschriftung oder Kontext und schneidet eine Seite heraus; kennt nur beschriebene Elemente.
export function pageControls(items, { controlOffset = 0, maxControls = 200, controlFilter } = {}) {
  const needle = controlFilter?.trim().toLowerCase();
  const matching = needle ? items.filter(item => `${item.label} ${item.context || ''}`.toLowerCase().includes(needle)) : items;
  const page = matching.slice(controlOffset, controlOffset + maxControls);
  return { page, controlsTotal: matching.length, nextControlOffset: controlOffset + page.length < matching.length ? controlOffset + page.length : null };
}

// 1: alles vor dem Versionsabgleich (18.11.2026). 3: Bedienelemente blätter- und filterbar, Schalterzustand.
// 4: Icon-Zeichen (Private Use Area) aus Text und Beschriftungen entfernt, brave_close für selbst geöffnete Tabs.
// 5: Uploads nur aus dem Upload-Ordner (BRAVE_MCP_UPLOAD_DIR, Standard ~/Downloads).
// 6: BRAVE_MCP_PROFILE beschränkt alle Werkzeuge auf ein Brave-Profil, brave_open öffnet dort.
// 7: Sperrliste und umschaltbarer Agent-Modus (Steuerseite, settings.json); gesperrte Seiten sind unsichtbar.
// 8: Nur http(s)-Seiten sichtbar, Lesen ohne Warten mit Nachprüfung, Screenshots ohne Seitenskript, Steuerseite mit Schlüssel.
// 10: Koordinaten-Klick, Hover, Ziehen, Tasten; Debug-Werkzeuge (nur vom Nutzer einschaltbar); Brave Stable/Beta/Linux.
// 9: Torwächter (gate.mjs): angedockt wird nur an Tabs, die ein Agent benutzt; Auflisten weckt keine Tabs.
export const API_VERSION = 10;

// Entfernt Icon-Zeichen aus Webfonts; Zeilen, die nur aus Icons bestanden, verschwinden mit, echte Leerzeilen bleiben.
export function stripIcons(text) {
  return text.split('\n').flatMap(line => {
    const kept = line.replace(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, '');
    return kept.trim() || !line.trim() ? [kept] : [];
  }).join('\n');
}

// Uploads nur aus einem Ordner: Eine Website mit versteckten Anweisungen soll einen Agenten nicht dazu
// bringen können, ~/.ssh oder Passwortdateien hochzuladen. Standard ~/Downloads, änderbar per BRAVE_MCP_UPLOAD_DIR.
export function uploadRoot() {
  return process.env.BRAVE_MCP_UPLOAD_DIR || path.join(os.homedir(), 'Downloads');
}
// Eine einzige Meldung für fehlend, außerhalb und Ordner: verrät weder echte Pfade noch, ob eine Datei existiert.
const UPLOAD_DENIED = 'File not available for upload. Only regular files inside the upload folder (BRAVE_MCP_UPLOAD_DIR) can be uploaded.';
const inside = (base, file) => {
  const rel = path.relative(base, file);
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};
export async function uploadPaths(files, root = uploadRoot()) {
  const base = await fs.realpath(root).catch(() => { throw new Error('Upload folder does not exist (BRAVE_MCP_UPLOAD_DIR).'); });
  return Promise.all(files.map(async file => {
    // Erst am Pfadtext prüfen, dann realpath (löst Symlinks auf, damit kein Link hinausführt); nur einzelne Dateien, keine Ordner.
    const wanted = path.resolve(base, file);
    if (!inside(base, wanted)) throw new Error(UPLOAD_DENIED);
    const real = await fs.realpath(wanted).catch(() => null);
    if (!real || !inside(base, real) || !(await fs.stat(real)).isFile()) throw new Error(UPLOAD_DENIED);
    return real;
  }));
}

// Agenten-Profil: Im Agent-Modus sehen alle Werkzeuge nur die Tabs dieses Brave-Profils,
// und brave_open öffnet dort. Das Profil legt der Nutzer selbst in Brave an; hier wird es nur gelesen.
export async function profileDirectory(name, userDataDir) {
  userDataDir ??= (await detectBrave()).userDataDir;
  const state = JSON.parse(await fs.readFile(path.join(userDataDir, 'Local State'), 'utf8').catch(() => '{}'));
  const entry = Object.entries(state.profile?.info_cache ?? {}).find(([, info]) => info.name === name);
  if (!entry) throw new Error(`Brave profile "${name}" not found (agent mode). Create it in Brave: profile icon → Add, name it "${name}", then try again. Or switch brave-mcp back to all profiles.`);
  return entry[0];
}
async function launchInProfile(directory, url) {
  // Über das Betriebssystem öffnen: Die Debugging-Schnittstelle kann keine Tabs in einem anderen Profil anlegen.
  const brave = await detectBrave();
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) => execFile('open', ['-na', brave.app, '--args', `--profile-directory=${directory}`, url], error => error ? reject(new Error(`Could not open ${brave.app}: ${error.message}`)) : resolve()));
  }
  if (process.platform === 'linux') {
    // Ein laufendes Brave übernimmt den Aufruf und öffnet den Tab im genannten Profil (ungetestet, siehe README).
    return new Promise((resolve, reject) => execFile(brave.bin, [`--profile-directory=${directory}`, url], { timeout: 10000 }, error => error ? reject(new Error(`Could not open ${brave.bin}: ${error.message}`)) : resolve()));
  }
  throw new Error('Agent mode works on macOS and Linux only.');
}

// Werte von Parametern, die nach Zugangsdaten aussehen, aus Adressen entfernen (Netzwerkprotokoll für Agenten).
const SECRET_PARAM = /token|key|secret|auth|session|sig|pass|code|jwt|credential|ticket/i;
export function redactUrl(raw) {
  try {
    const url = new URL(raw);
    url.username = ''; url.password = '';
    for (const name of [...url.searchParams.keys()]) if (SECRET_PARAM.test(name)) url.searchParams.set(name, 'REDACTED');
    if (url.hash.length > 1) url.hash = '#REDACTED';
    return url.href;
  } catch { return String(raw).slice(0, 200); }
}
// Tastennamen wie Enter, ArrowDown, Control+a, Meta+Shift+P; keine freien Zeichenketten.
export function validKey(key) {
  return typeof key === 'string' && /^((Control|Shift|Alt|Meta|ControlOrMeta)\+){0,3}([A-Za-z0-9]|F[1-9]|F1[0-2]|Enter|Tab|Escape|Backspace|Delete|Space|Home|End|PageUp|PageDown|Insert|Arrow(Up|Down|Left|Right)|[\-=,.\/;'\[\]`])$/.test(key);
}
const DEBUG_OFF = 'Debug tools are switched off. Only the user can switch them on: npx brave-session-mcp debug on';
const RING = 300;

export class Brave {
  pages = new Map(); frames = new Map(); refs = new Map(); opened = new Set(); connections = 0;
  contextOf = new WeakMap(); byTarget = new Map(); logs = new WeakMap();
  async connect() {
    if (this.browser?.isConnected()) return this.browser;
    // Nach Browserende neu verbinden, statt --stop zu verlangen; die Freigabe erteilt der Nutzer in Brave.
    this.browser = undefined; this.cdp = undefined; this.scope = undefined; this.byTarget = new Map();
    this.gate?.close(); this.gate = undefined;
    this.brave = await detectBrave();
    const portFile = await fs.readFile(path.join(this.brave.userDataDir, 'DevToolsActivePort'), 'utf8').catch(() => {
      throw new Error('Brave remote debugging not found. Open brave://inspect/#remote-debugging in Brave and enable it.');
    });
    const endpoint = localEndpoint(portFile);
    // Port der Debugging-Schnittstelle merken: Agenten dürfen sie weder öffnen noch sehen.
    this.devtoolsPort = +new URL(endpoint).port;
    // Über den Torwächter verbinden: Playwright dockt so nur an Tabs an, die ein Agent wirklich benutzt (siehe gate.mjs).
    const unreachable = () => new Error('Brave not reachable. Check remote debugging in Brave or restart the browser, then try again.');
    const gate = new Gate(endpoint);
    const gateUrl = await gate.start().catch(() => { gate.close(); throw unreachable(); });
    this.browser = await chromium.connectOverCDP(gateUrl, { timeout: 15000 }).catch(() => { gate.close(); throw unreachable(); });
    this.gate = gate;
    this.browser.on('disconnected', () => gate.close());
    this.connections++;
    return this.browser;
  }
  visible(url, settings) {
    return agentVisible(url, settings.blocked, this.devtoolsPort) && !this.isGate(url);
  }
  // Der lokale Torwächter ist für Agenten so tabu wie die Debugging-Schnittstelle.
  isGate(url) {
    if (!this.gate?.port) return false;
    try { const u = new URL(url); return ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && +u.port === this.gate.port; } catch { return false; }
  }
  id(map, object, prefix) {
    for (const [id, item] of map) if (item === object) return id;
    const id = `${prefix}-${randomUUID().slice(0, 12)}`;
    map.set(id, object); return id;
  }
  async targets() {
    if (!this.cdp) {
      const cdp = await (await this.connect()).newBrowserCDPSession();
      // Neue Tabs und Adresswechsel melden lassen, damit openInProfile seinen Tab an der Adresse erkennt, auch nach schneller Weiterleitung.
      const note = ({ targetInfo }) => this.watching?.(targetInfo);
      cdp.on('Target.targetCreated', note); cdp.on('Target.targetInfoChanged', note);
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      this.cdp = cdp;
    }
    return (await this.cdp.send('Target.getTargets')).targetInfos.filter(t => t.type === 'page');
  }
  // Ziel-Info eines Tabs; null, wenn der Tab inzwischen geschlossen wurde.
  async pageTarget(page) {
    if (!this.contextOf.has(page)) {
      try {
        const session = await page.context().newCDPSession(page);
        const { targetInfo } = await session.send('Target.getTargetInfo');
        await session.detach().catch(() => {});
        this.contextOf.set(page, targetInfo);
      } catch { return null; }
    }
    return this.contextOf.get(page);
  }
  // Öffnet url im Profil und liefert die Ziel-Info des neuen Tabs. Erkannt wird er an der geöffneten Adresse
  // (nicht als irgendein neuer Tab), damit ein gleichzeitig geöffneter Tab des Nutzers nicht verwechselt wird.
  async openInProfile(directory, url, contextId) {
    const before = new Set((await this.targets()).map(t => t.targetId));
    let created;
    this.watching = t => { if (!created && t.type === 'page' && t.url === url && !before.has(t.targetId) && (!contextId || t.browserContextId === contextId)) created = t; };
    try {
      await launchInProfile(directory, url);
      for (const until = Date.now() + 15000; Date.now() < until; await new Promise(r => setTimeout(r, 250))) {
        for (const target of await this.targets()) this.watching(target);
        if (created) return created;
      }
    } finally { this.watching = undefined; }
    throw new Error('Brave did not open a tab in the agent profile within 15 seconds.');
  }
  async profileScope(settings) {
    if (settings.mode !== 'agent') return null;
    const name = settings.profile;
    if (this.scope?.name !== name) {
      this.scope = undefined;
      const directory = await profileDirectory(name);
      // Kennung des Profils einmal über einen Tab mit eindeutiger Adresse ermitteln und ihn danach wieder schließen
      // (data: statt about:blank, weil Brave about:-Adressen von der Befehlszeile durch einen neuen Tab ersetzt).
      const marker = await this.openInProfile(directory, `data:text/plain,brave-mcp-${randomUUID()}`);
      await this.cdp.send('Target.closeTarget', { targetId: marker.targetId }).catch(() => {});
      this.scope = { name, directory, contextId: marker.browserContextId };
    }
    return this.scope;
  }
  async tabs() {
    await this.connect();
    const settings = await loadSettings();
    const scope = await this.profileScope(settings);
    // Nur auflisten, nicht andocken: Titel und Adressen kommen vom Browser, kein Tab wird dabei geweckt.
    const found = (await this.targets()).filter(info => (!scope || info.browserContextId === scope.contextId) && this.visible(info.url, settings));
    for (const [id, targetId] of this.pages) if (!found.some(info => info.targetId === targetId)) this.pages.delete(id);
    return found.map(info => ({ tabId: this.id(this.pages, info.targetId, 'tab'), title: info.title, url: info.url }));
  }
  // Für die Steuerseite: Adressen aller Tabs, ohne Filter; null, solange keine Verbindung besteht (keine neue Freigabe-Abfrage).
  async openUrls() {
    if (!this.browser?.isConnected() || !this.cdp) return null;
    return (await this.targets()).map(info => info.url);
  }
  // Dockt erst jetzt an genau diesen Tab an und liefert die Playwright-Seite dazu.
  async attachPage(targetId) {
    const cached = this.byTarget.get(targetId);
    if (cached && !cached.isClosed()) return cached;
    const browser = await this.connect();
    await this.gate.allow(targetId);
    for (const until = Date.now() + 10000; Date.now() < until; await new Promise(r => setTimeout(r, 100))) {
      for (const candidate of browser.contexts().flatMap(context => context.pages())) {
        if ((await this.pageTarget(candidate))?.targetId === targetId) { this.byTarget.set(targetId, candidate); this.watch(candidate); return candidate; }
      }
    }
    throw new Error('Could not attach to the tab; call brave_tabs again.');
  }
  // Konsole und Netzwerk eines angedockten Tabs mitschreiben (Ringpuffer); ausgeliefert nur bei eingeschalteten Debug-Werkzeugen.
  watch(page) {
    if (this.logs.has(page)) return;
    const log = { console: [], network: [] };
    this.logs.set(page, log);
    const push = (list, entry) => { list.push({ at: new Date().toISOString(), ...entry }); if (list.length > RING) list.shift(); };
    page.on('console', message => push(log.console, { type: message.type(), text: message.text().slice(0, 2000) }));
    page.on('pageerror', error => push(log.console, { type: 'pageerror', text: String(error.message).slice(0, 2000) }));
    page.on('response', response => { const request = response.request(); push(log.network, { method: request.method(), url: redactUrl(request.url()), status: response.status(), type: request.resourceType() }); });
    page.on('requestfailed', request => push(log.network, { method: request.method(), url: redactUrl(request.url()), failed: request.failure()?.errorText ?? 'failed', type: request.resourceType() }));
  }
  async targetOf(page) {
    const targetId = (await this.pageTarget(page))?.targetId;
    if (targetId) this.byTarget.set(targetId, page);
    return targetId;
  }
  async page(tabId) {
    await this.tabs();
    const targetId = this.pages.get(tabId);
    if (!targetId) throw new Error('Tab no longer available; call brave_tabs again.');
    const page = await this.attachPage(targetId);
    if (page.isClosed()) throw new Error('Tab no longer available; call brave_tabs again.');
    return page;
  }
  async frame(tabId, frameId) {
    const page = await this.page(tabId);
    const settings = await loadSettings();
    const frame = frameId ? this.frames.get(frameId) : page.mainFrame();
    if (!frame || !page.frames().includes(frame)) throw new Error('Frame does not belong to this tab or was reloaded.');
    // Eine erlaubte Seite kann eine gesperrte Domain einbetten; solche Frames und alles darin bleiben unlesbar.
    if (!frameVisible(frame, settings.blocked, this.devtoolsPort)) throw new Error(HIDDEN);
    return { page, frame, settings };
  }
  // Nach dem Lesen: Hat der Tab oder Frame inzwischen auf eine verborgene Seite gewechselt, wird das Ergebnis verworfen.
  unchanged(page, frame, settings) {
    return !page.isClosed() && page.frames().includes(frame) && frameVisible(frame, settings.blocked, this.devtoolsPort) && this.visible(page.url(), settings);
  }
  async read({ tabId, frameId, maxChars = 6000, charOffset = 0, controlOffset = 0, maxControls = 200, controlFilter }) {
    const { page, frame, settings } = await this.frame(tabId, frameId);
    const result = await frame.evaluateHandle(COLLECT).catch(() => { throw new Error(CHANGED); });
    const controls = [];
    try {
      const { href, text: raw, items } = await result.evaluate(r => ({ href: r.href, text: r.text, items: r.items })).catch(() => { throw new Error(CHANGED); });
      if (!this.visible(href, settings)) throw new Error(CHANGED);
      const full = stripIcons(raw);
      const text = full.slice(charOffset, charOffset + maxChars);
      const nextCharOffset = charOffset + text.length < full.length ? charOffset + text.length : null;
      const { page: chosen, controlsTotal, nextControlOffset } = pageControls(items.map((item, index) => ({ index, ...item })), { controlOffset, maxControls, controlFilter });
      const handles = await (await result.getProperty('elements')).getProperties();
      for (const [key, handle] of handles) if (!chosen.some(c => String(c.index) === key)) await handle.dispose();
      for (const { index, ...item } of chosen) controls.push({ element: handles.get(String(index)).asElement(), item });
      if (!this.unchanged(page, frame, settings)) throw new Error(CHANGED);
      const frames = page.frames().filter(f => frameVisible(f, settings.blocked, this.devtoolsPort)).map(f => ({ frameId: this.id(this.frames, f, 'frame'), url: f.url(), main: f === page.mainFrame() }));
      const listed = controls.map(({ element, item }) => {
        const ref = `ref-${randomUUID()}`;
        this.refs.set(ref, { element, tabId, frame, description: item, created: Date.now() });
        return { ref, ...item };
      });
      controls.length = 0;
      for (const [ref, item] of this.refs) if (Date.now() - item.created > 600000 || this.refs.size > 2000) { this.refs.delete(ref); await item.element.dispose().catch(() => {}); }
      return { tabId, frameId: this.id(this.frames, frame, 'frame'), url: href, charOffset, charsTotal: full.length, nextCharOffset, text, controlOffset, controlsTotal, nextControlOffset, controls: listed, frames };
    } finally {
      // Bei Abbruch nichts zurückbehalten; übernommene Elemente stehen dann schon in refs.
      for (const { element } of controls) await element.dispose().catch(() => {});
      await result.dispose().catch(() => {});
    }
  }
  async settle(page, ms = 0) {
    if (!ms) return;
    const until = Date.now() + ms;
    // Eine laufende Navigation zulassen; bereits geladene Seiten kehren sofort zurück.
    await page.waitForLoadState('domcontentloaded', { timeout: ms }).catch(() => {});
    // Restzeit als Beruhigungsfenster, da SPAs das DOM ohne Navigation ändern.
    const left = until - Date.now();
    if (left > 0) await page.waitForTimeout(left).catch(() => {});
  }
  async shot(page, width) {
    const settings = await loadSettings();
    // Ein Screenshot zeigt auch eingebettete Frames; mit gesperrtem Frame auf der Seite daher keinen.
    if (embedsForbidden(page, settings.blocked, this.devtoolsPort)) throw new Error('This page embeds a site blocked for agents; screenshots are disabled on it.');
    // Direkt über CDP aufnehmen und skalieren: kein Skript in der Seite, die das Bild sonst abgreifen oder fälschen könnte.
    const session = await page.context().newCDPSession(page);
    let data;
    try {
      const capture = (async () => {
        const { cssVisualViewport: view, contentSize, cssContentSize } = await session.send('Page.getLayoutMetrics');
        const deviceScale = contentSize.width / cssContentSize.width || 1;
        // CSS-Pixel statt Gerätepixel: auf Retina grob ein Viertel der Bild-Tokens; mit width weiter verkleinert als JPEG.
        const clip = { x: view.pageX, y: view.pageY, width: Math.floor(view.clientWidth), height: Math.floor(view.clientHeight), scale: (width ? width / Math.floor(view.clientWidth) : 1) / deviceScale };
        return (await session.send('Page.captureScreenshot', width ? { format: 'jpeg', quality: 85, clip } : { format: 'png', clip })).data;
      })();
      let timer;
      data = await Promise.race([capture, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Screenshot timed out.')), 8000); })]).finally(() => clearTimeout(timer));
    } finally { await session.detach().catch(() => {}); }
    // Hat die Seite währenddessen auf eine verborgene Seite gewechselt oder einen gesperrten Frame geladen, Bild verwerfen.
    if (page.isClosed() || !this.visible(page.url(), settings) || embedsForbidden(page, settings.blocked, this.devtoolsPort)) throw new Error(CHANGED);
    return { buffer: Buffer.from(data, 'base64'), mimeType: width ? 'image/jpeg' : 'image/png' };
  }
  async element(tabId, ref, upload = false) {
    await this.page(tabId);
    const item = this.refs.get(ref);
    if (!item || item.tabId !== tabId || Date.now() - item.created > 600000) throw new Error('Stale reference or reference from another tab; call brave_read again.');
    if (!item.frame.page().frames().includes(item.frame) || (!(await item.element.isVisible()) && !(upload && item.description.type === 'file'))) throw new Error('Element is no longer visible.');
    const settings = await loadSettings();
    if (!frameVisible(item.frame, settings.blocked, this.devtoolsPort)) throw new Error(HIDDEN);
    const current = await item.element.evaluate(describe);
    if (current.tag !== item.description.tag || current.label !== item.description.label) throw new Error('Element has changed; call brave_read again.');
    return item.element;
  }
  // Breite des sichtbaren Bereichs in CSS-Pixeln (Bezug für Koordinaten aus verkleinerten Screenshots).
  async viewport(page) {
    const session = await page.context().newCDPSession(page);
    try { const { cssVisualViewport: v } = await session.send('Page.getLayoutMetrics'); return { width: Math.floor(v.clientWidth), height: Math.floor(v.clientHeight) }; }
    finally { await session.detach().catch(() => {}); }
  }
  // Zielpunkt aus Elementreferenz oder Koordinaten (CSS-Pixel des sichtbaren Bereichs, wie im Screenshot ohne width;
  // mit screenshotWidth werden Koordinaten aus einem verkleinerten Screenshot umgerechnet).
  async point(tabId, { ref, x, y, screenshotWidth } = {}) {
    const page = await this.page(tabId);
    if (ref) {
      const element = await this.element(tabId, ref);
      await element.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      const box = await element.boundingBox();
      if (!box) throw new Error('Element has no visible area.');
      return { page, element, x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Give either ref or both x and y.');
    const { blocked } = await loadSettings();
    // Mit gesperrtem Frame auf der Seite keine Koordinaten: Ein Punkt könnte darin landen.
    if (embedsForbidden(page, blocked, this.devtoolsPort)) throw new Error('This page embeds a site blocked for agents; use element references instead of coordinates.');
    const view = await this.viewport(page);
    const factor = screenshotWidth ? view.width / screenshotWidth : 1;
    const px = x * factor, py = y * factor;
    if (px < 0 || py < 0 || px > view.width || py > view.height) throw new Error(`Point outside the visible area (${view.width}×${view.height} CSS pixels).`);
    return { page, x: px, y: py };
  }
  async debugOn() {
    if (!(await loadSettings()).debug) throw new Error(DEBUG_OFF);
  }
  async call(method, args = {}) {
    if (method === 'status') {
      const settings = await loadSettings().catch(() => null);
      return { connected: !!this.browser?.isConnected(), browserConnections: this.connections, daemonPid: process.pid, apiVersion: API_VERSION, controlPage: this.control ?? null, brave: this.brave?.name ?? (await detectBrave()).name, debugTools: !!settings?.debug };
    }
    if (method === 'tabs') return this.tabs();
    if (method === 'read') return this.read(args);
    if (method === 'click' && !args.ref) {
      const target = await this.point(args.tabId, args);
      await target.page.mouse.click(target.x, target.y, { button: args.button || 'left', clickCount: args.clickCount || 1 });
      await this.settle(target.page, args.wait);
      return { clicked: true, x: Math.round(target.x), y: Math.round(target.y) };
    }
    if (method === 'click') {
      const element = await this.element(args.tabId, args.ref);
      const page = await this.page(args.tabId);
      const before = await element.evaluate(describe);
      if ('checked' in before) {
        // Frameworks legen oft ein Icon über Checkbox oder Schalter, das den Klick abfängt;
        // dann auf die Position klicken, ohne die Überdeckungsprüfung (trifft das Label).
        // Nicht, wenn die Seite einen gesperrten Frame enthält: Der ungeprüfte Klick könnte darin landen.
        const { blocked } = await loadSettings();
        const force = !embedsForbidden(page, blocked, this.devtoolsPort);
        await element.click({ timeout: 2000 }).catch(() => element.click({ force, timeout: 6000 }));
        await this.settle(page, args.wait || 300);
        let after = await element.evaluate(describe).catch(() => null);
        if (after && after.checked === before.checked) {
          // Versteckte Eingabefelder (Opazität 0, Größe 0) reagieren nur über ihr sichtbares Label oder die Hülle.
          const holder = (await element.evaluateHandle(e => e.labels?.[0] || e.closest('label') || e.parentElement)).asElement();
          if (holder) { await holder.click({ force, timeout: 6000 }); await this.settle(page, args.wait || 300); }
          after = await element.evaluate(describe).catch(() => null);
          await holder?.dispose();
        }
        return { clicked: true, ...(after && 'checked' in after ? { checked: after.checked } : {}) };
      }
      await element.click({ timeout: 8000, button: args.button || 'left', clickCount: args.clickCount || 1 });
      await this.settle(page, args.wait);
      return { clicked: true };
    }
    if (method === 'hover') {
      const target = await this.point(args.tabId, args);
      if (target.element) await target.element.hover({ timeout: 8000 }); else await target.page.mouse.move(target.x, target.y);
      await this.settle(target.page, args.wait || 300);
      return { hovered: true };
    }
    if (method === 'drag') {
      const from = await this.point(args.tabId, { ref: args.fromRef, x: args.fromX, y: args.fromY, screenshotWidth: args.screenshotWidth });
      const to = await this.point(args.tabId, { ref: args.toRef, x: args.toX, y: args.toY, screenshotWidth: args.screenshotWidth });
      const { mouse } = from.page;
      await mouse.move(from.x, from.y); await mouse.down();
      await mouse.move(to.x, to.y, { steps: 15 }); await mouse.up();
      await this.settle(from.page, args.wait || 300);
      return { dragged: true };
    }
    if (method === 'key') {
      if (!args.keys?.length && !args.text) throw new Error('Give keys or text.');
      for (const key of args.keys ?? []) if (!validKey(key)) throw new Error(`Unknown key "${String(key).slice(0, 40)}". Examples: Enter, Tab, ArrowDown, Control+a, Meta+k.`);
      const page = await this.page(args.tabId);
      if (args.ref) await (await this.element(args.tabId, args.ref)).focus();
      if (args.text) await page.keyboard.type(args.text);
      for (const key of args.keys ?? []) await page.keyboard.press(key);
      await this.settle(page, args.wait);
      return { pressed: (args.keys ?? []).length, typed: (args.text ?? '').length };
    }
    if (method === 'console' || method === 'network') {
      await this.debugOn();
      const page = await this.page(args.tabId);
      const entries = this.logs.get(page)?.[method] ?? [];
      const filter = args.filter?.toLowerCase();
      const matching = entries.filter(entry => (!args.onlyErrors || (method === 'console' ? ['error', 'pageerror'].includes(entry.type) : (entry.failed || entry.status >= 400))) && (!filter || JSON.stringify(entry).toLowerCase().includes(filter)));
      return { tabId: args.tabId, total: matching.length, entries: matching.slice(-(args.limit || 50)), note: 'Recorded since the server attached to this tab; reload the page to capture its start.' };
    }
    if (method === 'eval') {
      await this.debugOn();
      const { page, frame, settings } = await this.frame(args.tabId, args.frameId);
      let timer;
      const value = await Promise.race([frame.evaluate(args.expression), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Evaluation timed out after 10 seconds.')), 10000); })]).finally(() => clearTimeout(timer));
      if (!this.unchanged(page, frame, settings)) throw new Error(CHANGED);
      let text;
      try { text = JSON.stringify(value) ?? 'undefined'; } catch { text = String(value); }
      return { result: text.length > 12000 ? text.slice(0, 12000) : text, truncated: text.length > 12000 };
    }
    if (method === 'fill') { await (await this.element(args.tabId, args.ref)).fill(args.text, { timeout: 8000 }); return { filled: true }; }
    if (method === 'upload') {
      const element = await this.element(args.tabId, args.ref, true);
      if (!(await element.evaluate(e => e.matches('input[type=file]')))) throw new Error('Reference is not a file upload field.');
      await element.setInputFiles(await uploadPaths(args.files), { timeout: 10000 }); return { uploaded: args.files.length };
    }
    if (method === 'screenshot') {
      const page = await this.page(args.tabId);
      const { buffer, mimeType } = await this.shot(page, args.width);
      const view = await this.viewport(page).catch(() => null);
      return { image: buffer.toString('base64'), mimeType, ...(view ? { viewport: view, imageWidth: args.width || view.width } : {}) };
    }
    if (method === 'navigate' || method === 'open') {
      const url = new URL(args.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) URLs without embedded credentials.');
      const settings = await loadSettings();
      await this.connect();
      if (!this.visible(url.href, settings)) throw new Error(HIDDEN);
      let page; let failed;
      const scope = method === 'open' ? await this.profileScope(settings) : null;
      if (scope) {
        const target = await this.openInProfile(scope.directory, url.href, scope.contextId);
        page = await this.attachPage(target.targetId).catch(() => { throw new Error('Opened a tab in the agent profile but could not attach to it.'); });
        this.opened.add(page);
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      } else {
        page = method === 'open' ? await (await this.connect()).contexts()[0].newPage() : await this.page(args.tabId);
        if (method === 'open') { this.opened.add(page); this.watch(page); }
        await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(error => { failed = error; });
      }
      if (!failed) await this.settle(page, args.wait);
      // Eine Weiterleitung auf eine verborgene Seite (gesperrt, Steuerseite, kein http(s)) nicht verraten.
      if (failed || !this.visible(page.url(), settings)) {
        // Selbst geöffnete Tabs wieder schließen, damit kein gesperrter oder kaputter Tab liegen bleibt.
        if (method === 'open') { this.opened.delete(page); await page.close().catch(() => {}); }
        throw failed ?? new Error(HIDDEN);
      }
      return { tabId: this.id(this.pages, await this.targetOf(page), 'tab'), url: page.url() };
    }
    if (method === 'close') {
      // Nur Tabs schließen, die ein Agent selbst mit brave_open geöffnet hat; Tabs des Nutzers bleiben unberührt.
      const page = await this.page(args.tabId);
      if (!this.opened.has(page)) throw new Error('Only tabs opened with brave_open can be closed.');
      const targetId = await this.targetOf(page);
      await page.close();
      this.opened.delete(page);
      this.byTarget.delete(targetId);
      for (const [id, item] of this.pages) if (item === targetId) this.pages.delete(id);
      return { closed: true };
    }
    throw new Error('Unknown browser function.');
  }
}

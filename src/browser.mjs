import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function localEndpoint(portFile) {
  const [port, route, ...rest] = portFile.trim().split(/\r?\n/);
  if (rest.length || !/^\d+$/.test(port) || +port < 1 || +port > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(route)) throw new Error('Ungültige Brave-Debugging-Adresse.');
  return `ws://127.0.0.1:${+port}${route}`;
}

function profile() {
  if (process.env.BRAVE_USER_DATA_DIR) return process.env.BRAVE_USER_DATA_DIR;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser-Nightly');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA, 'BraveSoftware/Brave-Browser-Nightly/User Data');
  return path.join(os.homedir(), '.config/BraveSoftware/Brave-Browser-Nightly');
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

const CONTROLS = 'button,a[href],input:not([type=hidden]),textarea,select,summary,[role=button],[role=radio],[role=checkbox],[role=switch],[role=tab],[role=menuitem],[contenteditable=true]';

// Filtert nach Beschriftung oder Kontext und schneidet eine Seite heraus; kennt nur beschriebene Elemente.
export function pageControls(items, { controlOffset = 0, maxControls = 200, controlFilter } = {}) {
  const needle = controlFilter?.trim().toLowerCase();
  const matching = needle ? items.filter(item => `${item.label} ${item.context || ''}`.toLowerCase().includes(needle)) : items;
  const page = matching.slice(controlOffset, controlOffset + maxControls);
  return { page, controlsTotal: matching.length, nextControlOffset: controlOffset + page.length < matching.length ? controlOffset + page.length : null };
}

// 1: alles vor dem Versionsabgleich (18.11.2026). 3: Bedienelemente blätter- und filterbar, Schalterzustand.
// 4: Icon-Zeichen (Private Use Area) aus Text und Beschriftungen entfernt, brave_close für selbst geöffnete Tabs.
export const API_VERSION = 4;

// Entfernt Icon-Zeichen aus Webfonts; Zeilen, die nur aus Icons bestanden, verschwinden mit, echte Leerzeilen bleiben.
export function stripIcons(text) {
  return text.split('\n').flatMap(line => {
    const kept = line.replace(/[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, '');
    return kept.trim() || !line.trim() ? [kept] : [];
  }).join('\n');
}

export class Brave {
  pages = new Map(); frames = new Map(); refs = new Map(); opened = new Set(); connections = 0;
  async connect() {
    if (this.browser?.isConnected()) return this.browser;
    // Nach Browserende neu verbinden, statt --stop zu verlangen; die Freigabe erteilt der Nutzer in Brave.
    this.browser = undefined;
    const portFile = await fs.readFile(path.join(profile(), 'DevToolsActivePort'), 'utf8').catch(() => {
      throw new Error('Brave-Freigabe nicht gefunden. brave://inspect/#remote-debugging in Brave öffnen und die Freigabe aktivieren.');
    });
    this.browser = await chromium.connectOverCDP(localEndpoint(portFile), { timeout: 15000 }).catch(() => {
      throw new Error('Brave nicht erreichbar. Freigabe in Brave prüfen oder Browser neu starten; danach erneut aufrufen.');
    });
    this.connections++;
    return this.browser;
  }
  id(map, object, prefix) {
    for (const [id, item] of map) if (item === object) return id;
    const id = `${prefix}-${randomUUID().slice(0, 12)}`;
    map.set(id, object); return id;
  }
  async tabs() {
    const browser = await this.connect();
    const pages = browser.contexts().flatMap(context => context.pages());
    for (const [id, page] of this.pages) if (!pages.includes(page)) this.pages.delete(id);
    return Promise.all(pages.map(async page => ({ tabId: this.id(this.pages, page, 'tab'), title: await page.title(), url: page.url() })));
  }
  async page(tabId) {
    await this.tabs();
    const page = this.pages.get(tabId);
    if (!page || page.isClosed()) throw new Error('Tab nicht mehr verfügbar; brave_tabs erneut aufrufen.');
    return page;
  }
  async frame(tabId, frameId) {
    const page = await this.page(tabId);
    if (!frameId) return { page, frame: page.mainFrame() };
    const frame = this.frames.get(frameId);
    if (!frame || !page.frames().includes(frame)) throw new Error('Frame gehört nicht zu diesem Tab oder wurde neu geladen.');
    return { page, frame };
  }
  async read({ tabId, frameId, maxChars = 6000, charOffset = 0, controlOffset = 0, maxControls = 200, controlFilter }) {
    const { page, frame } = await this.frame(tabId, frameId);
    const frames = page.frames().map(f => ({ frameId: this.id(this.frames, f, 'frame'), url: f.url(), main: f === page.mainFrame() }));
    const full = stripIcons(await frame.locator('body').innerText({ timeout: 5000 }));
    const text = full.slice(charOffset, charOffset + maxChars);
    const nextCharOffset = charOffset + text.length < full.length ? charOffset + text.length : null;
    const found = [];
    for (const element of await frame.locator(CONTROLS).elementHandles()) {
      if (!(await element.isVisible()) && !(await element.evaluate(e => e.matches('input[type=file]')))) { await element.dispose(); continue; }
      // UI-Bibliotheken (Base UI, Radix) spiegeln einen Schalter in ein verstecktes 1×1-Eingabefeld; nur den echten Schalter liefern.
      if (await element.evaluate(e => e.matches('input[type=checkbox],input[type=radio]') && !!e.parentElement?.querySelector('[role=switch],[role=checkbox],[role=radio]'))) { await element.dispose(); continue; }
      found.push({ element, ...(await element.evaluate(describe)) });
    }
    const { page: chosen, controlsTotal, nextControlOffset } = pageControls(found, { controlOffset, maxControls, controlFilter });
    const controls = [];
    for (const { element, ...item } of found) {
      if (!chosen.some(c => c.element === element)) { await element.dispose(); continue; }
      const ref = `ref-${randomUUID()}`;
      this.refs.set(ref, { element, tabId, frame, description: item, created: Date.now() });
      controls.push({ ref, ...item });
    }
    for (const [ref, item] of this.refs) if (Date.now() - item.created > 600000 || this.refs.size > 2000) { this.refs.delete(ref); await item.element.dispose().catch(() => {}); }
    return { tabId, frameId: this.id(this.frames, frame, 'frame'), url: frame.url(), charOffset, charsTotal: full.length, nextCharOffset, text, controlOffset, controlsTotal, nextControlOffset, controls, frames };
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
    // CSS-Pixel statt Gerätepixel: auf Retina grob ein Viertel der Bild-Tokens.
    const buffer = await page.screenshot({ type: 'png', scale: 'css', timeout: 8000 });
    if (!width) return { buffer, mimeType: 'image/png' };
    try {
      // Im Tab selbst verkleinern; das Bild wird dafür nicht ins DOM eingehängt.
      const scaled = await page.evaluate(async ([dataUrl, target]) => {
        const image = new Image(); image.src = dataUrl; await image.decode();
        const height = Math.max(1, Math.round(image.naturalHeight * target / image.naturalWidth));
        const canvas = document.createElement('canvas'); canvas.width = target; canvas.height = height;
        canvas.getContext('2d').drawImage(image, 0, 0, target, height);
        return canvas.toDataURL('image/jpeg', 0.85);
      }, [`data:image/png;base64,${buffer.toString('base64')}`, width]);
      return { buffer: Buffer.from(scaled.split(',')[1], 'base64'), mimeType: 'image/jpeg' };
    } catch {
      // Strenge Seitenregeln (CSP) können data:-Bilder blockieren; dann unverkleinert.
      return { buffer, mimeType: 'image/png' };
    }
  }
  async element(tabId, ref, upload = false) {
    await this.page(tabId);
    const item = this.refs.get(ref);
    if (!item || item.tabId !== tabId || Date.now() - item.created > 600000) throw new Error('Veraltete oder tabfremde Referenz; brave_read erneut aufrufen.');
    if (!item.frame.page().frames().includes(item.frame) || (!(await item.element.isVisible()) && !(upload && item.description.type === 'file'))) throw new Error('Element ist nicht mehr sichtbar.');
    const current = await item.element.evaluate(describe);
    if (current.tag !== item.description.tag || current.label !== item.description.label) throw new Error('Element hat sich verändert; brave_read erneut aufrufen.');
    return item.element;
  }
  async call(method, args = {}) {
    if (method === 'status') return { connected: !!this.browser?.isConnected(), browserConnections: this.connections, daemonPid: process.pid, apiVersion: API_VERSION };
    if (method === 'tabs') return this.tabs();
    if (method === 'read') return this.read(args);
    if (method === 'click') {
      const element = await this.element(args.tabId, args.ref);
      const page = await this.page(args.tabId);
      const before = await element.evaluate(describe);
      if ('checked' in before) {
        // Frameworks legen oft ein Icon über Checkbox oder Schalter, das den Klick abfängt;
        // dann auf die Position klicken, ohne die Überdeckungsprüfung (trifft das Label).
        await element.click({ timeout: 2000 }).catch(() => element.click({ force: true, timeout: 6000 }));
        await this.settle(page, args.wait || 300);
        let after = await element.evaluate(describe).catch(() => null);
        if (after && after.checked === before.checked) {
          // Versteckte Eingabefelder (Opazität 0, Größe 0) reagieren nur über ihr sichtbares Label oder die Hülle.
          const holder = (await element.evaluateHandle(e => e.labels?.[0] || e.closest('label') || e.parentElement)).asElement();
          if (holder) { await holder.click({ force: true, timeout: 6000 }); await this.settle(page, args.wait || 300); }
          after = await element.evaluate(describe).catch(() => null);
          await holder?.dispose();
        }
        return { clicked: true, ...(after && 'checked' in after ? { checked: after.checked } : {}) };
      }
      await element.click({ timeout: 8000 });
      await this.settle(page, args.wait);
      return { clicked: true };
    }
    if (method === 'fill') { await (await this.element(args.tabId, args.ref)).fill(args.text, { timeout: 8000 }); return { filled: true }; }
    if (method === 'upload') {
      const element = await this.element(args.tabId, args.ref, true);
      if (!(await element.evaluate(e => e.matches('input[type=file]')))) throw new Error('Referenz ist kein Datei-Uploadfeld.');
      await element.setInputFiles(args.files.map(file => path.resolve(file)), { timeout: 10000 }); return { uploaded: args.files.length };
    }
    if (method === 'screenshot') {
      const { buffer, mimeType } = await this.shot(await this.page(args.tabId), args.width);
      return { image: buffer.toString('base64'), mimeType };
    }
    if (method === 'navigate' || method === 'open') {
      const url = new URL(args.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Nur HTTP(S)-Adressen ohne eingebettete Zugangsdaten.');
      const page = method === 'open' ? await (await this.connect()).contexts()[0].newPage() : await this.page(args.tabId);
      if (method === 'open') this.opened.add(page);
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await this.settle(page, args.wait);
      return { tabId: this.id(this.pages, page, 'tab'), url: page.url() };
    }
    if (method === 'close') {
      // Nur Tabs schließen, die ein Agent selbst mit brave_open geöffnet hat; Tabs des Nutzers bleiben unberührt.
      const page = await this.page(args.tabId);
      if (!this.opened.has(page)) throw new Error('Nur mit brave_open geöffnete Tabs können geschlossen werden.');
      await page.close();
      this.opened.delete(page);
      for (const [id, item] of this.pages) if (item === page) this.pages.delete(id);
      return { closed: true };
    }
    throw new Error('Unbekannte Browserfunktion.');
  }
}

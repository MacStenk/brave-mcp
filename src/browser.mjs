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

const describe = element => ({
  tag: element.tagName.toLowerCase(),
  label: (element.getAttribute('aria-label') || element.labels?.[0]?.innerText || element.innerText || element.getAttribute('placeholder') || element.title || '').trim().slice(0, 180),
  type: element.getAttribute('type'),
  value: element.matches('input:not([type=password]):not([type=hidden]):not([type=file]),textarea,select') ? element.value.slice(0, 250) : undefined,
});

export class Brave {
  pages = new Map(); frames = new Map(); refs = new Map(); connections = 0;
  async connect() {
    if (this.browser?.isConnected()) return this.browser;
    if (this.browser) throw new Error('Brave wurde getrennt. Lokalen Server mit --stop beenden, danach erneut freigeben.');
    const endpoint = localEndpoint(await fs.readFile(path.join(profile(), 'DevToolsActivePort'), 'utf8'));
    this.browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
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
  async read({ tabId, frameId, maxChars = 6000 }) {
    const { page, frame } = await this.frame(tabId, frameId);
    const frames = page.frames().map(f => ({ frameId: this.id(this.frames, f, 'frame'), url: f.url(), main: f === page.mainFrame() }));
    const text = (await frame.locator('body').innerText({ timeout: 5000 })).slice(0, maxChars);
    const controls = [];
    for (const element of (await frame.locator('button,a[href],input:not([type=hidden]),textarea,select,[role=button],[role=radio],[contenteditable=true]').elementHandles()).slice(0, 200)) {
      if (!(await element.isVisible()) && !(await element.evaluate(e => e.matches('input[type=file]')))) { await element.dispose(); continue; }
      const item = await element.evaluate(describe);
      const ref = `ref-${randomUUID()}`;
      this.refs.set(ref, { element, tabId, frame, description: item, created: Date.now() });
      controls.push({ ref, ...item });
    }
    for (const [ref, item] of this.refs) if (Date.now() - item.created > 600000 || this.refs.size > 2000) { this.refs.delete(ref); await item.element.dispose().catch(() => {}); }
    return { tabId, frameId: this.id(this.frames, frame, 'frame'), url: frame.url(), text, controls, frames };
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
    if (method === 'status') return { connected: !!this.browser?.isConnected(), browserConnections: this.connections, daemonPid: process.pid };
    if (method === 'tabs') return this.tabs();
    if (method === 'read') return this.read(args);
    if (method === 'click') { await (await this.element(args.tabId, args.ref)).click({ timeout: 8000 }); return { clicked: true }; }
    if (method === 'fill') { await (await this.element(args.tabId, args.ref)).fill(args.text, { timeout: 8000 }); return { filled: true }; }
    if (method === 'upload') {
      const element = await this.element(args.tabId, args.ref, true);
      if (!(await element.evaluate(e => e.matches('input[type=file]')))) throw new Error('Referenz ist kein Datei-Uploadfeld.');
      await element.setInputFiles(args.files.map(file => path.resolve(file)), { timeout: 10000 }); return { uploaded: args.files.length };
    }
    if (method === 'screenshot') {
      const page = await this.page(args.tabId);
      return { image: (await page.screenshot({ type: 'png', timeout: 8000 })).toString('base64') };
    }
    if (method === 'navigate' || method === 'open') {
      const url = new URL(args.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Nur HTTP(S)-Adressen ohne eingebettete Zugangsdaten.');
      const page = method === 'open' ? await (await this.connect()).contexts()[0].newPage() : await this.page(args.tabId);
      await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
      return { tabId: this.id(this.pages, page, 'tab'), url: page.url() };
    }
    throw new Error('Unbekannte Browserfunktion.');
  }
}

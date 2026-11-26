import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { loadSettings, updateSettings, normalizeSite, isBlocked, isControl, controlPort, settingsPath, controlKey } from './settings.mjs';

// Steuerseite für den Nutzer: Modus umschalten und Sperrliste pflegen.
// Nur auf 127.0.0.1 und nur mit dem Schlüssel aus control-key neben settings.json (0600): Den kennt nur der Nutzer,
// andere lokale Nutzer und Prozesse kommen nicht hinein. Die Adresse mit ?key= setzt ein HttpOnly-Cookie für diesen Start.
// Änderungen zusätzlich nur per Formular dieser Seite (Host, Origin, Sec-Fetch-Site und Formularschlüssel geprüft),
// damit andere Websites und DNS-Rebinding nichts umstellen können.

const LOCKED = '<p>This page needs its key. Run <code>npx brave-session-mcp control</code> in a terminal and open the address it prints (bookmark that address).</p>';

const escape = value => String(value).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const host = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; } };

export async function applyAction(form, file = settingsPath()) {
  const action = form.get('action');
  if (action === 'mode') {
    const mode = form.get('mode');
    if (!['agent', 'all'].includes(mode)) throw new Error('Unknown mode.');
    return updateSettings(s => { s.mode = mode; }, file);
  }
  if (action === 'profile') {
    const name = (form.get('profile') || '').trim();
    if (!name || name.length > 100) throw new Error('Enter the profile name as shown in Brave.');
    return updateSettings(s => { s.profile = name; }, file);
  }
  if (action === 'debug') {
    const value = form.get('debug');
    if (!['on', 'off'].includes(value)) throw new Error('Unknown debug setting.');
    return updateSettings(s => { s.debug = value === 'on'; }, file);
  }
  if (action === 'block') {
    const site = normalizeSite(form.get('site'));
    return updateSettings(s => { if (!s.blocked.includes(site)) s.blocked.push(site); s.blocked.sort(); }, file);
  }
  if (action === 'unblock') {
    const site = form.get('site');
    return updateSettings(s => { s.blocked = s.blocked.filter(item => item !== site); }, file);
  }
  throw new Error('Unknown action.');
}

function render({ mode, profile, blocked, debug }, urls, token) {
  const hidden = `<input type="hidden" name="token" value="${token}">`;
  const button = (fields, label) => `<form method="post">${hidden}${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${escape(v)}">`).join('')}<button>${escape(label)}</button></form>`;
  const sites = urls === null ? null : [...new Set(urls.filter(url => /^https?:/.test(url) && !isControl(url)).map(host).filter(Boolean))].sort();
  const openList = sites === null
    ? '<p class="muted">No agent is connected to Brave right now, so open tabs are not listed. Add sites by hand below.</p>'
    : sites.length === 0 ? '<p class="muted">No open websites.</p>'
    : `<ul>${sites.map(site => `<li><span>${escape(site)}</span>${isBlocked(`https://${site}/`, blocked) ? '<em>blocked</em>' : button({ action: 'block', site }, 'Block')}</li>`).join('')}</ul>`;
  const blockedList = blocked.length === 0 ? '<p class="muted">Nothing blocked yet.</p>'
    : `<ul>${blocked.map(site => `<li><span>${escape(site)}</span>${button({ action: 'unblock', site }, 'Remove')}</li>`).join('')}</ul>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>brave-mcp control</title>
<style>
:root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
body { max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 2rem; }
ul { list-style: none; padding: 0; } li { display: flex; justify-content: space-between; align-items: center; padding: .3rem 0; border-bottom: 1px solid #8884; }
form { display: inline; } button { font: inherit; padding: .2rem .7rem; cursor: pointer; }
.modes { display: flex; gap: .5rem; margin-bottom: .8rem; } .modes button[aria-pressed="true"] { font-weight: 600; outline: 2px solid currentColor; }
.muted { opacity: .7; } em { opacity: .7; }
input[type=text] { font: inherit; padding: .2rem .4rem; }
</style></head><body>
<h1>brave-mcp control</h1>
<p class="muted">Changes apply to the next agent action. Agents cannot open this page.</p>
<h2>Agents see</h2>
<div class="modes">
${button({ action: 'mode', mode: 'all' }, 'All profiles').replace('<button>', `<button aria-pressed="${mode === 'all'}">`)}
${button({ action: 'mode', mode: 'agent' }, `Only profile “${profile}”`).replace('<button>', `<button aria-pressed="${mode === 'agent'}">`)}
</div>
<div><form method="post">${hidden}<input type="hidden" name="action" value="profile"><label>Agent profile name <input type="text" name="profile" value="${escape(profile)}" required maxlength="100"></label> <button>Save</button></form></div>
<h2>Debug tools for agents</h2>
<p class="muted">Console, network log and JavaScript in agent tabs. JavaScript runs inside your logged-in profile; a page with hidden instructions could try to misuse it. Switch on only while you need it.</p>
<div class="modes">
${button({ action: 'debug', debug: 'off' }, 'Off').replace('<button>', `<button aria-pressed="${!debug}">`)}
${button({ action: 'debug', debug: 'on' }, 'On').replace('<button>', `<button aria-pressed="${!!debug}">`)}
</div>
<h2>Open websites</h2>
${openList}
<h2>Blocked for agents</h2>
<p class="muted">Blocked sites are invisible to agents and cannot be opened by them. A domain includes its subdomains.</p>
${blockedList}
<div><form method="post">${hidden}<input type="hidden" name="action" value="block"><input type="text" name="site" placeholder="bank.example" required> <button>Block</button></form></div>
</body></html>`;
}

export function startControl(browser, { port = controlPort(), file = settingsPath() } = {}) {
  const token = randomUUID();
  // Sitzung pro Start: Ein abgegriffenes Cookie verfällt mit dem Neustart und verrät den dauerhaften Schlüssel nicht.
  const session = randomBytes(32).toString('hex');
  const cookie = `brave_mcp_${port}`;
  const same = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const server = http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      res.writeHead(status, {
        // same-origin statt no-referrer: Bei no-referrer sendet Chromium beim Formular "Origin: null", und die Prüfung schlägt fehl.
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", ...headers,
      });
      res.end(body);
    };
    // Host prüfen gegen DNS-Rebinding: eine fremde Domain, die auf 127.0.0.1 zeigt, bekommt die Seite nicht.
    if (!hosts.includes(req.headers.host)) return send(421, 'Wrong host.');
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('key')) {
        if (!same(url.searchParams.get('key'), await controlKey(file))) return send(403, LOCKED);
        return send(303, '', { Location: '/', 'Set-Cookie': `${cookie}=${session}; Path=/; HttpOnly; SameSite=Strict` });
      }
      const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split('=')).filter(([name]) => name));
      if (!same(cookies[cookie], session)) return send(403, LOCKED);
      if (req.method === 'GET' && url.pathname === '/') return send(200, render(await loadSettings(file), await browser.openUrls(), token));
      if (req.method === 'POST' && url.pathname === '/') {
        if (!hosts.some(h => req.headers.origin === `http://${h}`)) return send(403, 'Forbidden.');
        // Fetch-Metadaten: Formulare, die eine andere Seite auslöst (auch über ein Popup), gelten nicht.
        if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') return send(403, 'Forbidden.');
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 10000) return send(413, 'Too large.'); }
        const form = new URLSearchParams(body);
        if (form.get('token') !== token) return send(403, 'This page is outdated. <a href="/">Reload</a>');
        await applyAction(form, file);
        return send(303, '', { Location: '/' });
      }
      send(404, 'Not found.');
    } catch (error) { send(400, `<p>${escape(error.message)}</p><p><a href="/">Back</a></p>`); }
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server)); });
}

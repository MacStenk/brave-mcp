import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

// Einstellungen, die der Nutzer zur Laufzeit ändert (Steuerseite oder Befehl); wird bei jedem Zugriff neu gelesen.
// Agenten haben bewusst kein Werkzeug dafür.
export function settingsPath() {
  return process.env.BRAVE_MCP_SETTINGS || path.join(os.homedir(), '.config/brave-mcp/settings.json');
}

export function controlPort() {
  return Number(process.env.BRAVE_MCP_CONTROL_PORT) || 47821;
}

// Schlüssel der Steuerseite liegt neben den Einstellungen und ist nur für den Nutzer lesbar (0600),
// damit andere lokale Nutzer und Prozesse die Seite nicht bedienen können.
export function controlKeyPath(file = settingsPath()) {
  return path.join(path.dirname(file), 'control-key');
}
export async function controlKey(file = settingsPath()) {
  const keyFile = controlKeyPath(file);
  await fs.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  try { await fs.writeFile(keyFile, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = await fs.lstat(keyFile);
  if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077)) throw new Error(`Control key ${keyFile} must be a file owned by your user with mode 0600.`);
  const key = (await fs.readFile(keyFile, 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error(`Control key ${keyFile} is invalid; delete it to create a new one.`);
  return key;
}

export async function loadSettings(file = settingsPath()) {
  let saved = {};
  try { saved = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Settings file ${file} is not valid JSON: ${error.message}`);
  }
  // Fehlerhafte Einträge brechen ab statt still auf "alles erlaubt" zurückzufallen.
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error(`Settings file ${file} must contain a JSON object.`);
  if (saved.mode !== undefined && saved.mode !== 'agent' && saved.mode !== 'all') throw new Error(`Settings file ${file}: "mode" must be "agent" or "all".`);
  if (saved.profile !== undefined && (typeof saved.profile !== 'string' || !saved.profile.trim())) throw new Error(`Settings file ${file}: "profile" must be a profile name.`);
  if (saved.blocked !== undefined && !Array.isArray(saved.blocked)) throw new Error(`Settings file ${file}: "blocked" must be a list of domains.`);
  // Ohne gespeicherte Wahl gilt BRAVE_MCP_PROFILE wie bisher als Agent-Modus.
  const mode = saved.mode ?? (process.env.BRAVE_MCP_PROFILE ? 'agent' : 'all');
  const profile = saved.profile || process.env.BRAVE_MCP_PROFILE || 'Agent';
  const blocked = [...new Set((saved.blocked ?? []).map(site => {
    try { return normalizeSite(site); } catch (error) { throw new Error(`Settings file ${file}: ${error.message}`); }
  }))];
  return { mode, profile, blocked };
}

// Schreibt nacheinander (Warteschlange im Prozess) und über eindeutige Zwischendateien,
// damit gleichzeitige Änderungen sich nicht überschreiben oder halbe Dateien hinterlassen.
let writes = Promise.resolve();
export function updateSettings(change, file = settingsPath()) {
  const run = writes.then(async () => {
    const settings = await loadSettings(file);
    change(settings);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file).catch(async error => { await fs.unlink(temp).catch(() => {}); throw error; });
    return settings;
  });
  writes = run.catch(() => {});
  return run;
}

// Akzeptiert Adresse oder Domain ("https://www.sparkasse.de/login", "sparkasse.de"); liefert die Domain ohne www.
export function normalizeSite(input) {
  let site = String(input ?? '').trim().toLowerCase();
  if (site.includes('://')) {
    try { site = new URL(site).hostname; } catch { site = ''; }
  }
  site = site.split(/[/?#:]/)[0].replace(/^www\./, '').replace(/\.+$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site)) throw new Error(`"${input}" is not a domain like example.com.`);
  return site;
}

// Hostname ohne abschließende Punkte ("bank.de." = "bank.de"); blob:/filesystem: zählen zu ihrer Herkunft.
function hostOf(url) {
  const { origin } = new URL(url);
  if (origin === 'null') return '';
  return new URL(origin).hostname.toLowerCase().replace(/\.+$/, '');
}

// Eine Domain sperrt auch alle Subdomains: google.com sperrt mail.google.com.
export function isBlocked(url, blocked) {
  let host;
  try { host = hostOf(url); } catch { return false; }
  return !!host && blocked.some(site => host === site || host.endsWith(`.${site}`));
}

// Lokale Adresse auf dem Port (Steuerseite, mit anderem Port auch die Debugging-Schnittstelle).
export function isControl(url, port = controlPort()) {
  try {
    return new URL(url).port === String(port) && ['127.0.0.1', 'localhost', '[::1]'].includes(hostOf(url));
  } catch { return false; }
}

// Für Agenten sichtbar sind nur http(s)-Seiten, die weder gesperrt noch Steuerseite noch Debugging-Schnittstelle sind.
// Alles andere (about:, blob:, data:, brave://, Erweiterungen) bleibt verborgen, weil die Sperrliste es nicht erfassen kann.
export function agentVisible(url, blocked, devtoolsPort) {
  let protocol;
  try { ({ protocol } = new URL(url)); } catch { return false; }
  if (protocol !== 'http:' && protocol !== 'https:') return false;
  return !isBlocked(url, blocked) && !isControl(url) && !(devtoolsPort && isControl(url, devtoolsPort));
}

// Gesperrt im engeren Sinn: gesperrte Domain, Steuerseite oder Debugging-Schnittstelle (für Screenshot und Klick-Fallback).
export function isForbidden(url, blocked, devtoolsPort) {
  return isBlocked(url, blocked) || isControl(url) || !!(devtoolsPort && isControl(url, devtoolsPort));
}

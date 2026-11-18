import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Einstellungen, die der Nutzer zur Laufzeit ändert (Steuerseite oder Befehl); wird bei jedem Zugriff neu gelesen.
// Agenten haben bewusst kein Werkzeug dafür.
export function settingsPath() {
  return process.env.BRAVE_MCP_SETTINGS || path.join(os.homedir(), '.config/brave-mcp/settings.json');
}

export function controlPort() {
  return Number(process.env.BRAVE_MCP_CONTROL_PORT) || 47821;
}

export async function loadSettings(file = settingsPath()) {
  let saved = {};
  try { saved = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Settings file ${file} is not valid JSON: ${error.message}`);
  }
  // Ohne gespeicherte Wahl gilt BRAVE_MCP_PROFILE wie bisher als Agent-Modus.
  const mode = saved.mode === 'agent' || saved.mode === 'all' ? saved.mode : process.env.BRAVE_MCP_PROFILE ? 'agent' : 'all';
  const profile = saved.profile || process.env.BRAVE_MCP_PROFILE || 'Agent';
  const blocked = Array.isArray(saved.blocked) ? saved.blocked.filter(site => typeof site === 'string') : [];
  return { mode, profile, blocked };
}

export async function updateSettings(change, file = settingsPath()) {
  const settings = await loadSettings(file);
  change(settings);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
  return settings;
}

// Akzeptiert Adresse oder Domain ("https://www.sparkasse.de/login", "sparkasse.de"); liefert die Domain ohne www.
export function normalizeSite(input) {
  let site = String(input ?? '').trim().toLowerCase();
  if (site.includes('://')) {
    try { site = new URL(site).hostname; } catch { site = ''; }
  }
  site = site.split(/[/?#:]/)[0].replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site)) throw new Error(`"${input}" is not a domain like example.com.`);
  return site;
}

// Eine Domain sperrt auch alle Subdomains: google.com sperrt mail.google.com.
export function isBlocked(url, blocked) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return blocked.some(site => host === site || host.endsWith(`.${site}`));
}

export function isControl(url, port = controlPort()) {
  try {
    const { hostname, port: urlPort } = new URL(url);
    return urlPort === String(port) && ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
  } catch { return false; }
}

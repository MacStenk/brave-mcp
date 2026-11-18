// Rendert docs/architecture.png mit Brave Nightly headless (wie social-preview).
// Aufruf: node scripts/architecture.mjs   (BRAVE_BINARY überschreibt den Binary-Pfad)
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const executablePath = process.env.BRAVE_BINARY
  || (process.platform === 'darwin' ? '/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly' : null);
if (!executablePath) throw new Error('BRAVE_BINARY mit dem Pfad zur Brave-Binärdatei setzen.');
const box = (title, sub, border, color) => `<div style="border:2px solid ${border};border-radius:12px;padding:14px 18px;background:#161b22;"><div style="color:${color};font-size:22px;font-weight:600;">${title}</div><div style="color:#8b949e;font-size:16px;margin-top:4px;">${sub}</div></div>`;
const arrow = '<div style="color:#58a6ff;font-size:34px;font-weight:700;">→</div>';
const html = `<!doctype html><body style="margin:0;background:#0d1117;font-family:-apple-system,'Segoe UI',sans-serif;"><div style="padding:34px 40px;display:flex;align-items:center;gap:18px;">
  <div style="display:flex;flex-direction:column;gap:12px;">${box('ZCode · Claude Desktop · Codex', 'local MCP clients (stdio)', '#30363d', '#c9d1d9')}${box('Any other local agent', 'supports local MCP servers', '#30363d', '#c9d1d9')}</div>
  ${arrow}
  ${box('Shared daemon', 'one CDP connection · serialized queue · version handshake', '#1f6feb', '#58a6ff')}
  ${arrow}
  ${box('Brave Nightly', 'your profile · your logins · your tabs', '#238636', '#7ee787')}
  <div style="color:#8b949e;font-size:15px;margin-left:14px;">10 tools: read · click · fill · upload ·<br>screenshot · navigate · open · close</div>
</div></body>`;
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1160, height: 300 }, deviceScaleFactor: 2 });
await page.setContent(html);
await mkdir(new URL('../docs/', import.meta.url).pathname, { recursive: true });
await page.screenshot({ path: new URL('../docs/architecture.png', import.meta.url).pathname });
await browser.close();
console.log('docs/architecture.png geschrieben.');

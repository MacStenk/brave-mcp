// Rendert docs/social-preview.png (1280×640) mit Brave Nightly headless.
// Aufruf: node scripts/social-preview.mjs   (BRAVE_BINARY überschreibt den Binary-Pfad)
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const executablePath = process.env.BRAVE_BINARY
  || (process.platform === 'darwin' ? '/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly' : null);
if (!executablePath) throw new Error('BRAVE_BINARY mit dem Pfad zur Brave-Binärdatei setzen.');
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });
await page.setContent('<!doctype html><body style="margin:0;background:#0d1117;font-family:-apple-system,\'Segoe UI\',sans-serif;"><div style="padding:90px 100px;box-sizing:border-box;height:100%;"><div style="font-size:24px;color:#58a6ff;font-family:ui-monospace,monospace;">github.com/MacStenk/brave-mcp</div><h1 style="color:#fff;font-size:88px;margin:28px 0 22px;font-weight:800;">Brave Session MCP</h1><p style="color:#9fb0c3;font-size:32px;line-height:1.4;max-width:1000px;margin:0;">Your AI agents. Your logged-in Brave.<br>One shared, token-efficient MCP server.</p><div style="position:absolute;left:100px;bottom:70px;color:#8b949e;font-size:24px;font-family:ui-monospace,monospace;">MCP · Node ≥ 22 · Playwright · MIT</div></div></body>');
await mkdir(new URL('../docs/', import.meta.url).pathname, { recursive: true });
await page.screenshot({ path: new URL('../docs/social-preview.png', import.meta.url).pathname });
await browser.close();
console.log('docs/social-preview.png geschrieben.');

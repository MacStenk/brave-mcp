// Misst den Bild-Tokenverbrauch der Screenshot-Varianten am eigenen Rechner.
// Alle Tokenwerte sind Näherungen nach der Anbieterdokumentation (Stand 11/2026).
import { Brave } from '../src/browser.mjs';

const providers = {
  'OpenAI low detail': () => 85,
  'OpenAI high detail': (w, h) => { const s = Math.min(1, 2048 / Math.max(w, h)); return 85 + 170 * Math.ceil(w * s / 512) * Math.ceil(h * s / 512); },
  'Claude klassisch': (w, h) => Math.ceil(w * h / 750),
  'Claude 28-px-Patches': (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28),
  'Gemini 768er-Kacheln': (w, h) => 258 * Math.ceil(w / 768) * Math.ceil(h / 768),
};
const pngSize = buffer => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });

const brave = new Brave();
const page = await (await brave.connect()).contexts()[0].newPage();
try {
  await page.goto('about:blank');
  const view = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
  const device = pngSize(await page.screenshot({ type: 'png', scale: 'device' }));
  const css = pngSize((await brave.shot(page)).buffer);
  await brave.shot(page, 768); // Verkleinerung läuft über denselben Pfad wie im Server.
  const small = { width: 768, height: Math.max(1, Math.round(css.height * 768 / css.width)) };
  const variants = [
    ['Geräteauflösung (alter Standard)', device],
    ['CSS-Auflösung (aktueller Standard)', css],
    ['CSS + width=768', small],
  ];
  console.log(`Fenster: ${view.width}x${view.height} CSS-Pixel, Retina-Faktor ${view.dpr}`);
  for (const [name, size] of variants) {
    const tokens = Object.entries(providers).map(([provider, formula]) => `${provider}: ${formula(size.width, size.height)}`).join(', ');
    console.log(`${name} | ${size.width}x${size.height} | ${tokens}`);
  }
} finally {
  await page.close().catch(() => {}); // Mess-Tab schließen ...
  await brave.browser?.close().catch(() => {}); // ... und nur die eigene CDP-Verbindung trennen, nicht den Browser.
}

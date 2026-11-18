import test from 'node:test';
import assert from 'node:assert/strict';
import { Brave, localEndpoint } from '../src/browser.mjs';

test('Verbindet ausschließlich den lokalen Debugging-Endpunkt', () => {
  assert.equal(localEndpoint('1234\n/devtools/browser/abc-123\n'), 'ws://127.0.0.1:1234/devtools/browser/abc-123');
  for (const text of ['0\n/devtools/browser/a', '65536\n/devtools/browser/a', '1234\nws://example.org/x', '1234\n/devtools/browser/../a', '1234\n/devtools/browser/a\nextra']) assert.throws(() => localEndpoint(text));
});
test('Elementreferenzen können nicht auf einen anderen Tab angewendet werden', async () => {
  const brave = new Brave();
  brave.page = async () => ({});
  brave.refs.set('ref-a', { tabId: 'tab-a', created: Date.now() });
  await assert.rejects(brave.element('tab-b', 'ref-a'), /tabfremde/);
});
test('Veraltete Referenzen werden vor jeder Browseraktion abgewiesen', async () => {
  const brave = new Brave();
  brave.page = async () => ({});
  brave.refs.set('ref-a', { tabId: 'tab-a', created: 0 });
  await assert.rejects(brave.element('tab-a', 'ref-a'), /Veraltete/);
});

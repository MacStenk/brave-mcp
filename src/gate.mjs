// CDP-Torwächter zwischen Playwright und Brave.
//
// Playwrights connectOverCDP schaltet beim Verbinden Target.setAutoAttach auf Browserebene ein. Brave hängt
// daraufhin JEDEN offenen Tab aller Profile an die Verbindung, Playwright aktiviert in jedem Tab seine Domains.
// Folgen: langsames Verbinden bei vielen Tabs, gedrosselte Hintergrund-Tabs (z. B. YouTube) laufen wieder an,
// und technisch hängt der Prozess auch an privaten Tabs, die der Agent-Modus nur ausblendet.
//
// Der Torwächter nimmt Playwrights Verbindung auf einem lokalen Zufallspfad an und reicht alles an Brave weiter,
// außer dem automatischen Andocken auf Browserebene. Angedockt wird nur, was der Server ausdrücklich freigibt
// (allow) oder was Playwright selbst neu anlegt (Target.createTarget). Alles andere bleibt unberührt.
import { randomUUID } from 'node:crypto';
import { ws as WebSocket, wsServer as WebSocketServer } from 'playwright-core/lib/utilsBundle';

const OWN = 1_000_000_000; // eigene Nachrichten-IDs, getrennt von Playwrights
const QUIET = new Set(['Target.targetCreated', 'Target.targetInfoChanged', 'Target.targetDestroyed']);

export class Gate {
  constructor(upstreamUrl) {
    this.upstreamUrl = upstreamUrl;
    this.nextId = OWN;
    this.pending = new Map();       // eigene IDs -> resolve/reject
    this.creating = new Set();      // Playwrights Target.createTarget-IDs
    this.allowed = new Set();       // targetIds, an die angedockt werden darf
    this.attached = new Set();      // targetIds, an die der Torwächter selbst angedockt hat
    this.autoAttach = false;        // Playwright hat Andocken angefordert (ab dann dürfen freigegebene Tabs angedockt werden)
    this.waitingAutoAttach = [];
    this.announced = new Set();     // sessionIds, deren Target.attachedToTarget Playwright schon kennt
  }

  async start() {
    this.upstream = new WebSocket(this.upstreamUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      this.upstream.once('open', resolve);
      this.upstream.once('error', reject);
    });
    this.upstream.on('message', data => this.fromBrave(data.toString()));
    this.upstream.on('close', () => this.close());
    this.upstream.on('error', () => this.close());

    const route = `/devtools/browser/gate-${randomUUID()}`;
    this.server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: route, maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => { this.server.once('listening', resolve); this.server.once('error', reject); });
    // Genau eine Verbindung (Playwright); jede weitere wird abgewiesen.
    this.server.on('connection', socket => {
      if (this.client) return socket.close(1008, 'busy');
      this.client = socket;
      socket.on('message', data => this.fromPlaywright(data.toString()));
      socket.on('close', () => this.close());
    });
    this.port = this.server.address().port;
    // Brave meldet neue Tabs, damit Popups freigegebener Tabs mit angedockt werden können.
    await this.send('Target.setDiscoverTargets', { discover: true });
    return `ws://127.0.0.1:${this.port}${route}`;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.upstream.send(JSON.stringify({ id, method, params }));
    });
  }

  toPlaywright(message) {
    if (this.client?.readyState === WebSocket.OPEN) this.client.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  fromPlaywright(raw) {
    const message = JSON.parse(raw);
    if (!message.sessionId) {
      if (message.method === 'Target.setAutoAttach') {
        // Nicht weiterreichen: Brave würde sonst alle Tabs andocken.
        this.autoAttach = true;
        this.toPlaywright({ id: message.id, result: {} });
        for (const resolve of this.waitingAutoAttach.splice(0)) resolve();
        return;
      }
      if (message.method === 'Target.attachToTarget' && !this.allowed.has(message.params?.targetId)) {
        this.toPlaywright({ id: message.id, error: { code: -32000, message: 'Target not released by brave-mcp.' } });
        return;
      }
      if (message.method === 'Target.createTarget') this.creating.add(message.id);
    }
    this.upstream.send(raw);
  }

  fromBrave(raw) {
    const message = JSON.parse(raw);
    if (message.id >= OWN && !message.sessionId) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (waiter) message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
      return;
    }
    if (!message.sessionId && message.id !== undefined && this.creating.has(message.id)) {
      this.creating.delete(message.id);
      const targetId = message.result?.targetId;
      this.toPlaywright(raw);
      if (targetId) void this.allow(targetId).catch(() => {});
      return;
    }
    if (!message.sessionId && QUIET.has(message.method)) {
      // Eigene Tab-Meldungen nicht an Playwright geben; Popups freigegebener Tabs mit andocken.
      const info = message.params?.targetInfo;
      if (message.method === 'Target.targetCreated' && info?.type === 'page' && info.openerId && this.allowed.has(info.openerId)) void this.allow(info.targetId).catch(() => {});
      if (message.method === 'Target.targetDestroyed') { this.allowed.delete(message.params.targetId); this.attached.delete(message.params.targetId); }
      return;
    }
    if (!message.sessionId && message.method === 'Target.detachedFromTarget' && message.params?.targetId) this.attached.delete(message.params.targetId);
    if (!message.sessionId && message.method === 'Target.attachedToTarget') this.announced.add(message.params?.sessionId);
    this.toPlaywright(raw);
  }

  // Gibt einen Tab frei und dockt an. Playwright erhält Target.attachedToTarget und legt die Seite an.
  async allow(targetId) {
    this.allowed.add(targetId);
    if (this.attached.has(targetId)) return;
    if (!this.autoAttach) await new Promise(resolve => this.waitingAutoAttach.push(resolve));
    if (this.attached.has(targetId)) return;
    this.attached.add(targetId);
    try {
      const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
      // Meldet Brave das Andocken nicht selbst als Ereignis, Playwright die Seite trotzdem bekannt machen.
      if (!this.announced.has(sessionId)) {
        const { targetInfo } = await this.send('Target.getTargetInfo', { targetId });
        this.announced.add(sessionId);
        this.toPlaywright({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false } });
      }
    } catch (error) { this.attached.delete(targetId); throw error; }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error('Brave connection closed.'));
    this.pending.clear();
    try { this.client?.close(); } catch {}
    try { this.upstream?.close(); } catch {}
    try { this.server?.close(); } catch {}
  }
}

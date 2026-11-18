# Brave Session MCP

A local MCP server that gives your AI agents safe, token-efficient access to the Brave browser you're already logged into.

**Status:** early, actively maintained by one person · tested on macOS with Brave Nightly; Linux plausible, untested · License: [MIT](LICENSE)

## What is this?

[Model Context Protocol (MCP)](https://modelcontextprotocol.io) is the open standard AI applications use to call external tools. This server exposes your already-running Brave Nightly — its open tabs and its logged-in sessions. Agents read pages, click, fill forms, upload files and take screenshots inside the real browser profile, not a disposable automation profile. One shared background process holds the debugging connection open for every local MCP client, so a new agent never triggers a new Brave permission prompt.

## Why this over the alternatives?

The official [@playwright/mcp](https://github.com/microsoft/playwright-mcp) and browser agents such as browser-use drive their own browser instance with a fresh profile — your logins are missing there and every agent spins up its own browser. This server takes the opposite trade-off:

- **Your real session** — agents work where you are already logged in; nothing to re-authenticate.
- **One shared connection** — a single background daemon serves all local MCP clients over one CDP connection.
- **Token-efficient by design** — capped reads, paged text (`charOffset`), waited actions (`wait`), CSS-scaled screenshots; measured numbers in the [Tokenverbrauch](#tokenverbrauch) section below.
- **Small attack surface** — no arbitrary page-script execution; page content is treated as untrusted data.

Not for you when you need headless cross-platform CI automation — Playwright MCP is the better fit there.

## Quick start

```sh
pnpm install --frozen-lockfile
node src/server.mjs
```

Requires Node ≥ 22, pnpm and Brave Nightly (remote debugging enabled once, see below). Install means `git clone` — this is not published to a package registry. For regular Brave instead of Nightly, set `BRAVE_USER_DATA_DIR` to its profile directory (see below).

---

Betrieb und alle Details auf Deutsch:

## Start

Voraussetzungen: Node.js ab 22, pnpm und Brave Nightly. Kein separat heruntergeladener
Testbrowser und keine Erweiterung nötig.

```sh
pnpm install --frozen-lockfile
node src/server.mjs
```

Der Server spricht MCP über stdin/stdout. Daher im MCP-Client direkt `node` starten,
nicht einen Paketmanager, der zusätzliche Meldungen auf stdout ausgibt.

Einmal in Brave Nightly `brave://inspect/#remote-debugging` öffnen und die Freigabe
für diese Browserinstanz aktivieren. Brave kann die erste Verbindung bestätigen lassen.
Danach bleibt sie bis zum Browserende oder bewussten Trennen bestehen.
Nach einem Browserneustart genügt die neue Freigabe in Brave; der gemeinsame Prozess
verbindet sich beim nächsten Aufruf selbst neu.
Für ein anderes Brave-Profil `BRAVE_USER_DATA_DIR` auf dessen Benutzerverzeichnis setzen.
Es werden weder Profile noch Cookies oder Schlüsseldateien kopiert.

## Clients

Die Beispiele in `config/` enthalten Platzhalter-Pfade; beim Übernehmen den absoluten
Pfad des eigenen Klons einsetzen. Startet ein Client `node` nicht, weil er keine
PATH-Umgebung erbt (bei grafischen Apps üblich), den absoluten Node-Pfad aus
`which node` als command eintragen.

- Claude Desktop und andere lokale Clients mit `mcpServers`: Eintrag aus `config/mcp.json` übernehmen.
- Codex und andere TOML-Clients: `config/codex.toml` als Beispiel verwenden.
- ZCode: Eintrag aus `config/zcode.json` in `~/.zcode/cli/config.json` unter `mcp.servers` übernehmen.
- Andere Agenten können denselben stdio-Server starten, sofern ihre Anwendung lokale MCP-Server unterstützt.
- ChatGPT im normalen Web und Grok im Web sind dadurch noch nicht automatisch verbunden.
  Eine Anwendung, die nur entfernte MCP-Server unterstützt, benötigt eine zusätzliche
  lokale Brücke oder eine passende Host-Integration. Dieser Server veröffentlicht keinen Netzwerkzugang.

Die Client-Konfigurationen wurden als Beispiele angelegt; bestehende App-Einstellungen
wurden nicht automatisch verändert. Es wurde kein Plugin und kein öffentlicher
Verzeichniseintrag angelegt. Lizenz: MIT, siehe LICENSE.

## Werkzeuge

| Name | Funktion |
| --- | --- |
| `brave_status` | Gemeinsame Verbindung und Prozess prüfen |
| `brave_tabs` | Offene Tabs mit stabilen IDs auflisten |
| `brave_read` | Sichtbaren Text, Bedienelemente und Frames lesen; Text mit `charOffset`, Bedienelemente mit `controlOffset` blätterbar, mit `controlFilter` durchsuchbar |
| `brave_click` | Ein gelesenes Element anklicken, optional mit Wartezeit; Checkboxen und Schalter melden danach ihren Zustand |
| `brave_fill` | Ein gelesenes Eingabefeld ausfüllen |
| `brave_upload` | Lokale Dateien in einem Uploadfeld auswählen |
| `brave_screenshot` | Screenshot des Tabs in CSS-Auflösung, optional auf Zielbreite verkleinert |
| `brave_navigate` | Einen gewählten Tab zu HTTP(S) navigieren, optional mit Wartezeit |
| `brave_open` | Eine Adresse in einem neuen Tab öffnen, optional mit Wartezeit |
| `brave_close` | Einen selbst mit `brave_open` geöffneten Tab schließen; Tabs des Nutzers bleiben unberührt |

Zuerst `brave_tabs`, danach `brave_read` mit einer konkreten Tab-ID aufrufen.
`brave_read` nennt `charsTotal` und `nextCharOffset`; mit `charOffset` blättern
Agenten durch Seiten, die länger als das Leselimit sind. Klicken, Navigieren und
Öffnen akzeptieren `wait` in Millisekunden und kehren erst nach dem Laden und einer
kurzen Beruhigungsphase zurück; ohne `wait` kehrt die Aktion sofort zurück.
Eingebettete Anwendungen lassen sich anschließend über die zurückgegebenen Frame-IDs
lesen. Aktionen verwenden Referenzen auf konkrete DOM-Elemente, gebunden an ihren Tab.
Veränderte, abgelaufene und tabfremde Referenzen werden zurückgewiesen.
Bedienelemente: `controlsTotal` nennt alle Treffer, `nextControlOffset` die nächste
Seite (sonst `null`). Auf Seiten mit großer Navigation sucht `controlFilter` gezielt
nach Beschriftung oder Zeilentext, statt 200 Menülinks zu lesen. Checkboxen,
Radiobuttons und Schalter (`role="switch"`) tragen `checked`; unbeschriftete Elemente
den Text ihrer Zeile als `context`. Liegt ein Icon über einer Checkbox, klickt
`brave_click` auf die Position statt abzubrechen.
Die Texte einer Website bleiben untrusted data, keine Anweisungen an den Agenten.

Mehrere Agenten teilen sich den Browser. Einzelne Aufrufe werden nacheinander
abgearbeitet; komplette Arbeitsabläufe sind nicht exklusiv reserviert. Agenten sollten
eigene Tabs verwenden und nach fremden Änderungen erneut lesen.

## Tokenverbrauch

Der Server begrenzt den Tokenverbrauch der Agenten von Haus aus, statt ihn dem
Client zu überlassen:

- `brave_read` liefert höchstens 12.000 Zeichen pro Aufruf (Standard 6.000),
  höchstens 200 Bedienelemente pro Aufruf (mit `controlsTotal` und `nextControlOffset`
  blätterbar), Labels auf 180 Zeichen gestutzt, Icon-Zeichen aus Webfonts (Unicode
  Private Use Area) entfernt. Mit `charOffset`
  und `nextCharOffset` blättern Agenten gezielt weiter, statt eine lange Seite
  mehrfach komplett zu lesen.
- `brave_read` liefert sichtbaren Text statt HTML-Quelltext: Mark-up, Attribute
  und Skriptblöcke sind selbst ein Vielfaches des sichtbaren Texts und bleiben
  draußen.
- Aktionen senden nur eine kompakte Elementreferenz statt einer kompletten
  Elementbeschreibung; `brave_tabs` und `brave_status` sind schlanke
  Metadaten-Aufrufe ohne Seiteninhalt.
- `wait` ersetzt Polling-Schleifen nach Klicks: eine wartende Aktion statt
  wiederholter voller Lesevorgänge.
- `brave_screenshot` nimmt in CSS-Pixelauflösung auf statt in Geräteauflösung;
  auf Retina-Displays kostet das grob ein Viertel der Bild-Tokens. Der optionale
  `width`-Parameter (320–1280) verkleinert zusätzlich. Bild-Tokens richten sich
  nach Pixelabmessungen, nicht nach Dateigröße; JPEG-Kompression spart also keine
  Tokens, kleinere Abmessungen schon. Auch WebP oder neurale Codecs ändern daran
  nichts — sie optimieren Bytes, nicht Pixel. Dieser Server speichert Screenshots
  gar nicht (nur Übergabe über den lokalen Socket), daher ist JPEG bewusst gewählt;
  käme je eine Speicherung hinzu, wäre WebP passend (25–35 % kleiner, von allen
  Vision-APIs akzeptiert). Breiten von 320–512 erreichen das Niveau von
  OpenAIs `detail: low`; der echte Parameter lässt sich nur beim aufrufenden Client
  setzen, nicht serverseitig.

Eigene Messung vom 18.11.2026 (`node test/tokens.mjs`, dieses Retina-Display,
Fenster 2302×1364 CSS-Pixel, Retina-Faktor 2; Tokenwerte sind Näherungen nach
Anbieterformeln):

| Screenshot-Variante | Pixel | Claude klassisch | Claude 28-px-Patches | OpenAI high detail | Gemini |
| --- | --- | --- | --- | --- | --- |
| Geräteauflösung (alter Standard) | 4604×2728 | 16.747 | 16.170 | 2.125 | 6.192 |
| CSS-Auflösung (aktueller Standard) | 2302×1364 | 4.187 | 4.067 | 2.125 | 1.548 |
| CSS + `width=768` | 768×455 | 466 | 476 | 425 | 258 |

Ergebnis: Der Standard-Screenshot kostet durch die CSS-Auflösung rund ein Viertel
des alten Werts (OpenAI skaliert ohnehin vorher auf 2048 Pixel herunter, dort bringt
die CSS-Auflösung keine Ersparnis, `width` aber sehr wohl). Mit `width=768` fällt
ein Screenshot auf 258–476 Tokens — unter einem Drittel eines `brave_read`-Aufrufs
mit 6.000 Zeichen (rund 1.500–2.000 Tokens). Der alte Screenshot in Geräteauflösung
auf Claude kostete dagegen so viel wie gut neun solcher Textreads.

## Arbeitsregeln für Agenten

Erfahrungen aus dem Einsatz; wer dieses MCP nutzt, arbeitet danach:

- Erst die angebotenen Funktionen prüfen, dann über den Browser auf fehlende
  Oberflächen zugreifen. Ein einzelner MCP deckt eine Anwendung selten vollständig ab.
- Absenden ist nicht erledigt. Erst sichtbare Belege prüfen: der neue Beitrag im
  Verlauf, die Bestätigung, die erzeugte Datei. „Angefordert", „ausgeführt" und
  „gespeichert" sind unterschiedliche Zustände; Schreibaufträge bei unklarem Ausgang
  nicht blind wiederholen, sondern den Zustand neu lesen.
- Vor Beginn festlegen, wann die Arbeit fertig ist, und weitere Ausbauten als eigenen
  Auftrag melden, statt eine Prüfung still zu erweitern.

## Grenzen

Downloads laufen im Browser selbst in den Download-Ordner des Profils; dieser Server bildet
sie bisher nicht als Werkzeug ab und meldet weder Pfad noch Erfolg. Sollte das
gebraucht werden, ist das ein eigener Ausbauauftrag.

## Verbindung beenden

```sh
node src/server.mjs --stop
```

Dies trennt den gemeinsamen Zugang für alle Clients, lässt Brave und seine Tabs aber
geöffnet. Das Beenden eines einzelnen MCP-Clients trennt die gemeinsame Verbindung nicht.
Nach Änderungen am Servercode den gemeinsamen Prozess einmal mit `--stop` beenden;
der nächste Client-Aufruf startet ihn mit dem neuen Code. Der Client vergleicht seine
API-Version mit der des Prozesses; ein veralteter Prozess wird ausdrücklich gemeldet,
statt neue Optionen still zu ignorieren.

Der lokale Unix-Socket liegt in einem Benutzerverzeichnis mit Modus 0700 und ist selbst
nur für diesen Benutzer zugänglich (0600). Es gibt keinen offenen HTTP-Server für MCP.
Unterstützt werden derzeit POSIX-Systeme; live geprüft wurde macOS mit Brave Nightly.

## Prüfung

```sh
pnpm test
node test/smoke.mjs
node test/tokens.mjs
```

Die Tokenmessung öffnet einen eigenen Testtab, vermisst die drei Screenshot-Varianten
am eigenen Rechner und schließt ihn danach wieder.

Der Live-Test öffnet einen eigenen lokalen Test-Tab. Er prüft den MCP-Handshake,
Werkzeugkatalog, Texteingabe, echte Klicks, einen versteckten Datei-Upload, einen
eingebetteten Frame und Screenshots. Zwei getrennte MCP-Clients müssen denselben
Prozess und genau eine Browserverbindung melden. Bestehende Tabs werden nicht navigiert.
Am Ende schließt der Test seinen Tab mit `brave_close`; sein Testserver endet mit dem Testprozess.

Stand 18.11.2026: sechs lokale Prüfungen bestanden, Live-Test mit zwei MCP-Clients und
allen neun Werkzeugen erfolgreich, einschließlich Wartezeit nach Klick/Navigation,
Textblättern per `charOffset`, auf Zielbreite verkleinerter Screenshots,
Versionsabgleich und Neuverbindung nach Browserneustart.

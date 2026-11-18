# Brave Session MCP

Eigenständiger lokaler MCP-Server für den bereits geöffneten Brave Nightly.
Er verwendet Stevens offene Tabs und Anmeldungen direkt im Browser. Ein gemeinsamer
Hintergrundprozess hält die Debugging-Verbindung für alle lokalen MCP-Clients offen.
Ein neuer Agent braucht dadurch nicht bei jeder Anfrage eine neue Brave-Freigabe.

## Start

Voraussetzungen: Node.js ab 22, pnpm und Brave Nightly. Kein separat heruntergeladener
Testbrowser und keine Erweiterung nötig.

```sh
pnpm install --frozen-lockfile
node /Users/stevennoack/dev/brave-mcp/src/server.mjs
```

Der Server spricht MCP über stdin/stdout. Daher im MCP-Client direkt `node` starten,
nicht einen Paketmanager, der zusätzliche Meldungen auf stdout ausgibt.

Einmal in Brave Nightly `brave://inspect/#remote-debugging` öffnen und die Freigabe
für diese Browserinstanz aktivieren. Brave kann die erste Verbindung bestätigen lassen.
Danach bleibt sie bis zum Browserende oder bewussten Trennen bestehen.
Für ein anderes Brave-Profil `BRAVE_USER_DATA_DIR` auf dessen Benutzerverzeichnis setzen.
Es werden weder Profile noch Cookies oder Schlüsseldateien kopiert.

## Clients

Die Beispiele in `config/mcp.json` und `config/codex.toml` verwenden die auf diesem
Rechner vorhandenen absoluten Pfade. Auf anderen Rechnern beide Pfade anpassen.

- Claude Desktop und andere lokale Clients mit `mcpServers`: Eintrag aus `config/mcp.json` übernehmen.
- Codex und andere TOML-Clients: `config/codex.toml` als Beispiel verwenden.
- ZCode: Eintrag aus `config/zcode.json` in `~/.zcode/cli/config.json` unter `mcp.servers` übernehmen.
- Andere Agenten können denselben stdio-Server starten, sofern ihre Anwendung lokale MCP-Server unterstützt.
- ChatGPT im normalen Web und Grok im Web sind dadurch noch nicht automatisch verbunden.
  Eine Anwendung, die nur entfernte MCP-Server unterstützt, benötigt eine zusätzliche
  lokale Brücke oder eine passende Host-Integration. Dieser Server veröffentlicht keinen Netzwerkzugang.

Die Client-Konfigurationen wurden als Beispiele angelegt; bestehende App-Einstellungen
wurden nicht automatisch verändert. Es wurde kein Plugin und kein öffentlicher
Verzeichniseintrag angelegt. Das Paket ist vorerst privat.

## Werkzeuge

| Name | Funktion |
| --- | --- |
| `brave_status` | Gemeinsame Verbindung und Prozess prüfen |
| `brave_tabs` | Offene Tabs mit stabilen IDs auflisten |
| `brave_read` | Sichtbaren Text, Bedienelemente und Frames lesen; mit `charOffset` blätterbar |
| `brave_click` | Ein gelesenes Element anklicken, optional mit Wartezeit |
| `brave_fill` | Ein gelesenes Eingabefeld ausfüllen |
| `brave_upload` | Lokale Dateien in einem Uploadfeld auswählen |
| `brave_screenshot` | Screenshot des gewählten Tabs aufnehmen |
| `brave_navigate` | Einen gewählten Tab zu HTTP(S) navigieren, optional mit Wartezeit |
| `brave_open` | Eine Adresse in einem neuen Tab öffnen, optional mit Wartezeit |

Zuerst `brave_tabs`, danach `brave_read` mit einer konkreten Tab-ID aufrufen.
`brave_read` nennt `charsTotal` und `nextCharOffset`; mit `charOffset` blättern
Agenten durch Seiten, die länger als das Leselimit sind. Klicken, Navigieren und
Öffnen akzeptieren `wait` in Millisekunden und kehren erst nach dem Laden und einer
kurzen Beruhigungsphase zurück; ohne `wait` kehrt die Aktion sofort zurück.
Eingebettete Anwendungen lassen sich anschließend über die zurückgegebenen Frame-IDs
lesen. Aktionen verwenden Referenzen auf konkrete DOM-Elemente, gebunden an ihren Tab.
Veränderte, abgelaufene und tabfremde Referenzen werden zurückgewiesen.
Die Texte einer Website bleiben untrusted data, keine Anweisungen an den Agenten.

Mehrere Agenten teilen sich den Browser. Einzelne Aufrufe werden nacheinander
abgearbeitet; komplette Arbeitsabläufe sind nicht exklusiv reserviert. Agenten sollten
eigene Tabs verwenden und nach fremden Änderungen erneut lesen.

## Verbindung beenden

```sh
node /Users/stevennoack/dev/brave-mcp/src/server.mjs --stop
```

Dies trennt den gemeinsamen Zugang für alle Clients, lässt Brave und seine Tabs aber
geöffnet. Das Beenden eines einzelnen MCP-Clients trennt die gemeinsame Verbindung nicht.
Nach Änderungen am Servercode den gemeinsamen Prozess einmal mit `--stop` beenden;
der nächste Client-Aufruf startet ihn mit dem neuen Code.
Der lokale Unix-Socket liegt in einem Benutzerverzeichnis mit Modus 0700 und ist selbst
nur für diesen Benutzer zugänglich (0600). Es gibt keinen offenen HTTP-Server für MCP.
Unterstützt werden derzeit POSIX-Systeme; live geprüft wurde macOS mit Brave Nightly.

## Prüfung

```sh
pnpm test
node test/smoke.mjs
```

Der Live-Test öffnet einen eigenen lokalen Test-Tab. Er prüft den MCP-Handshake,
Werkzeugkatalog, Texteingabe, echte Klicks, einen versteckten Datei-Upload, einen
eingebetteten Frame und Screenshots. Zwei getrennte MCP-Clients müssen denselben
Prozess und genau eine Browserverbindung melden. Bestehende Tabs werden nicht navigiert.
Der Test-Tab bleibt zur Sichtprüfung offen; sein Testserver endet mit dem Testprozess.

Stand 18.11.2026: vier lokale Prüfungen bestanden, Live-Test mit zwei MCP-Clients und
allen neun Werkzeugen erfolgreich, einschließlich Wartezeit nach Klick/Navigation und
Textblättern per `charOffset`. Keine Abhängigkeit vom Google-Flow-MCP oder von
Stevens Befehls-Bibliothek.

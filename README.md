# Brave Session MCP

English · [Deutsch](README.de.md)

A local MCP server that gives your AI agents safe, token-efficient access to the Brave browser you're already logged into.

[![npm](https://img.shields.io/npm/v/brave-session-mcp)](https://www.npmjs.com/package/brave-session-mcp) [![Release](https://img.shields.io/github/v/release/MacStenk/brave-mcp)](https://github.com/MacStenk/brave-mcp/releases) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-339933.svg)](package.json)

**Status:** early, actively maintained by one person · tested on macOS with Brave Nightly; Brave Stable/Beta are detected automatically; Linux agent mode implemented but untested · License: [MIT](LICENSE)

## What is this?

[Model Context Protocol (MCP)](https://modelcontextprotocol.io) is the open standard AI applications use to call external tools. This server exposes your already-running Brave Nightly — its open tabs and its logged-in sessions. Agents read pages, click, fill forms, upload files and take screenshots inside the real browser profile, not a disposable automation profile. One shared background process holds the debugging connection open for every local MCP client, so a new agent never triggers a new Brave permission prompt.

![Architecture: local MCP clients connect over stdio to one shared daemon, which holds a single CDP connection to your running Brave with its profile, logins and tabs](docs/architecture.png)

## Why this over the alternatives?

Attaching an agent to your logged-in browser is no longer unique: [@playwright/mcp](https://github.com/microsoft/playwright-mcp) can connect to existing Chrome or Edge tabs through its browser extension (`--extension`), and [Chrome DevTools MCP](https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session) attaches to a running Chrome with `--autoConnect` (Chrome 144+). Use those if you live in Chrome. This server is the Brave-first option and makes different trade-offs:

- **Brave, your real profile** — works with the Brave you are already logged in to (Nightly, Beta or Stable, detected automatically); no extension to install, no profile copied.
- **One shared connection for all agents** — a single background process serves every local MCP client over one CDP connection, so a second agent does not trigger another permission prompt.
- **Token-efficient by design** — capped and paged text (`charOffset`), paged and filterable controls (`controlFilter`), waited actions (`wait`), icon characters stripped, CSS-scaled screenshots; measured numbers in the [Token usage](#token-usage) section below.
- **Small attack surface** — narrow tools and no page-script execution unless you switch on the debug tools yourself; uploads only from one folder; agents can close only tabs they opened; page content is treated as untrusted data.

Not for you when you need headless cross-platform CI automation, or a full DevTools toolbox (network, performance traces, console) — Playwright MCP and Chrome DevTools MCP are the better fit there.

## Quick start

```sh
npx -y brave-session-mcp
```

Requires Node ≥ 22 and Brave Nightly (remote debugging enabled once, see below). In an MCP client, set the command to `npx` with the arguments `-y brave-session-mcp`; examples are in `config/`. From a clone, `pnpm install --frozen-lockfile` and `node src/server.mjs` work the same. Regular Brave instead of Nightly is untested: set `BRAVE_USER_DATA_DIR` to its profile directory and `BRAVE_APP` to its app name (see below).

*Unofficial community project — Brave is a trademark of Brave Software, Inc.; this tool is not affiliated with or endorsed by them.*

## Running the server

Requirements: Node.js 22+, pnpm and Brave Nightly. No separately downloaded
test browser and no extension required.

The server speaks MCP over stdin/stdout. In your MCP client, start `node`
directly — not a package manager that prints extra output to stdout.

Open `brave://inspect/#remote-debugging` in Brave Nightly once and enable the
permission for that browser instance. Brave may ask you to confirm the first
connection. It then persists until the browser closes or you disconnect it.
After a browser restart, granting the permission in Brave again is enough; the
shared process reconnects on the next call. For a different Brave profile, set
`BRAVE_USER_DATA_DIR` to its user data directory. No profiles, cookies or key
files are ever copied.

`brave_upload` only accepts single files from one folder, `~/Downloads` by default.
Set `BRAVE_MCP_UPLOAD_DIR` to use another one; a dedicated folder that you fill on
purpose is safer than Downloads (see [Limits](#limits)). Paths outside it, `../`
tricks, symlinks pointing out of it and whole folders are refused, so a page cannot
talk an agent into uploading your SSH keys. The error does not say whether a refused
path exists. The shared background process reads the variable when it starts; after
changing it, run `npx brave-session-mcp --stop`.

### Keeping agents away from sensitive tabs

By default agents see every website tab of your browser, including mail and banking. Pages that are not plain `http(s)` websites (`about:`, `blob:`, `data:`, `brave://` and extension pages) are always hidden, because the blocklist cannot recognise them. Two switches change what agents see at any time, without a restart:

- **Blocklist:** blocked sites are invisible to agents and cannot be opened by them, while you stay in your normal profile with all logins. A domain includes its subdomains (`google.com` also blocks `mail.google.com`). Frames inside a blocked frame are hidden too; on a page that embeds a blocked site, `brave_screenshot` is refused and clicks never bypass the check of what is under the pointer.
- **Agent mode:** agents see **only** the tabs of one Brave profile, and `brave_open` opens tabs there. Create it once in Brave (profile icon → **Add**, name it `Agent`, pick a colour you will recognise) and sign in there only to services agents may use. Opening tabs in another profile goes through macOS `open`, so agent mode is macOS-only for now.

**Control page:** run `npx brave-session-mcp control` and open the address it prints (`http://127.0.0.1:47821/?key=…`); bookmark that address. The key lives in `~/.config/brave-mcp/control-key` (next to the settings file, readable only by you), so other users and programs on your computer cannot use the page; without it the page answers 403. The page switches the mode, lists the sites open in your tabs with a **Block** button, and manages the blocklist. It only accepts changes from its own forms (host, origin, fetch metadata and a per-start form key are checked), and agents cannot open it. `brave_status` reports whether the page is running, for example when another program already uses the port.

**Terminal:**

```sh
npx brave-session-mcp block add bank.example   # block; without a domain: the front tab in Brave (macOS)
npx brave-session-mcp block remove bank.example
npx brave-session-mcp block                    # show the list
npx brave-session-mcp mode agent               # or: all; without argument: show
npx brave-session-mcp debug on                 # or: off; without argument: show
```

Settings live in `~/.config/brave-mcp/settings.json` (`BRAVE_MCP_SETTINGS` to move it) and are read on every agent action. Agents have no tool to change them. A broken file (invalid JSON, an unknown `mode`, a `blocked` entry that is not a domain) makes every tool fail with an error instead of silently allowing everything. Without a saved mode, `BRAVE_MCP_PROFILE=Agent` starts in agent mode. `BRAVE_MCP_CONTROL_PORT` changes the port. The Brave variant is detected automatically: the one with remote debugging switched on, otherwise the first installed of Nightly, Beta, Stable. `BRAVE_USER_DATA_DIR`, `BRAVE_APP` (macOS app name) and `BRAVE_BIN` (Linux command) override the detection. Agent mode works on macOS and Linux (Linux untested).

## Clients

The examples in `config/` start the published package with `npx`. If a client
cannot start `npx` because it inherits no PATH environment (common for GUI
apps), use the absolute path from `which npx` as the command.

- Claude Desktop and other local clients using `mcpServers`: copy the entry from `config/mcp.json`.
- Codex and other TOML clients: use `config/codex.toml` as the example.
- ZCode: copy the entry from `config/zcode.json` into `~/.zcode/cli/config.json` under `mcp.servers`.
- Other agents can start the same stdio server as long as their application supports local MCP servers.
- ChatGPT on the web and Grok on the web are not connected automatically. An
  application that only supports remote MCP servers needs an additional local
  bridge or a matching host integration. This server exposes no network access.

The client configurations are examples; existing app settings were not changed
automatically. No plugin and no public directory listing were created. License:
MIT, see LICENSE.

## Tools

| Name | Function |
| --- | --- |
| `brave_status` | Check the shared connection and process |
| `brave_tabs` | List open tabs with stable IDs |
| `brave_read` | Read visible text, controls and frames; text paged via `charOffset`, controls paged via `controlOffset`, searchable via `controlFilter` |
| `brave_click` | Click a previously read element, optionally with wait time; checkboxes and switches report their state afterwards |
| `brave_fill` | Fill a previously read input field |
| `brave_upload` | Select files from the upload folder (`BRAVE_MCP_UPLOAD_DIR`, default `~/Downloads`) in an upload field |
| `brave_screenshot` | Screenshot of a tab at CSS resolution, optionally downscaled to a target width |
| `brave_navigate` | Navigate a selected tab to HTTP(S), optionally with wait time |
| `brave_open` | Open an address in a new tab, optionally with wait time |
| `brave_close` | Close a tab you opened with `brave_open`; the user's own tabs stay untouched |
| `brave_hover` | Move the mouse over an element or a point (hover menus, tooltips) |
| `brave_drag` | Drag from an element or point to an element or point (sliders, sortable lists, canvas) |
| `brave_key` | Type text and press keys or combinations (`Enter`, `ArrowDown`, `Control+a`) in the page |
| `brave_console` | Debug, off by default: console messages and page errors of a tab |
| `brave_network` | Debug, off by default: requests with method, status and type; no headers or bodies, secret-looking URL parameters redacted |
| `brave_eval` | Debug, off by default: evaluate a JavaScript expression in a tab or frame |

`brave_click` also accepts a point `x`/`y` in CSS pixels of the visible area, for canvas
apps, maps and charts where there is no element to reference. `brave_screenshot` returns
the size of the visible area next to the image; coordinates taken from a downscaled
screenshot are converted when you pass its width as `screenshotWidth`. On a page that embeds
a blocked site, coordinates are refused.

**Debug tools** (`brave_console`, `brave_network`, `brave_eval`) are off by default and
only you can switch them on: `npx brave-session-mcp debug on` or the control page; agents
have no tool for it. JavaScript then runs inside your logged-in profile, and a page with
hidden instructions could try to talk an agent into misusing it. Switch them on while you
debug and off again with `npx brave-session-mcp debug off`.

Call `brave_tabs` first, then `brave_read` with a concrete tab ID.
`brave_read` reports `charsTotal` and `nextCharOffset`; with `charOffset`,
agents page through pages longer than the read limit. Click, navigate and open
accept `wait` in milliseconds and return only after the page has loaded plus a
short settle phase; without `wait`, the action returns immediately. Embedded
applications are read through the returned frame IDs. Actions use references to
concrete DOM elements, bound to their tab. Changed, expired and foreign-tab
references are rejected. Controls: `controlsTotal` reports all matches,
`nextControlOffset` the next page (otherwise `null`). On pages with huge
navigations, `controlFilter` searches by label or row text instead of reading
200 menu links. Checkboxes, radio buttons and switches (`role="switch"`) carry
`checked`; unlabeled elements carry their row text as `context`. When an icon
sits on top of a checkbox, `brave_click` clicks the position instead of
failing. Website text remains untrusted data — never an instruction to the agent.

Multiple agents share the browser. Individual calls are processed one after
another; whole workflows are not reserved exclusively. Agents should use their
own tabs and re-read after changes made by others.

## Token usage

The server limits agent token usage by design instead of leaving it to the
client:

- `brave_read` returns at most 12,000 characters per call (default 6,000), at
  most 200 controls per call (paged via `controlsTotal` and
  `nextControlOffset`), labels truncated to 180 characters, icon characters
  from web fonts (Unicode Private Use Area) removed. With `charOffset` and
  `nextCharOffset`, agents page deliberately instead of re-reading a long page
  in full.
- `brave_read` returns visible text, not HTML source: markup, attributes and
  script blocks are a multiple of the visible text and stay out.
- Actions send only a compact element reference instead of a full element
  description; `brave_tabs` and `brave_status` are lean metadata calls with no
  page content.
- `wait` replaces polling loops after clicks: one waiting action instead of
  repeated full reads.
- `brave_screenshot` captures at CSS pixel resolution instead of device
  resolution; on retina displays that costs roughly a quarter of the image
  tokens. The optional `width` parameter (320–1280) downscales further. Image
  tokens follow pixel dimensions, not file size; JPEG compression saves no
  tokens, smaller dimensions do. WebP and neural codecs change nothing either —
  they optimize bytes, not pixels. This server never stores screenshots (local
  socket delivery only), so JPEG is a deliberate choice; if storage ever gets
  added, WebP would be the right pick (25–35% smaller, accepted by all vision
  APIs). Widths of 320–512 reach the level of OpenAI's `detail: low`; the real
  parameter can only be set by the calling client, not server-side.

Own measurement from 2026-11-18 (`node test/tokens.mjs`, this retina display,
window 2302×1364 CSS pixels, retina factor 2; token values are approximations
based on provider formulas):

| Screenshot variant | Pixels | Claude classic | Claude 28-px patches | OpenAI high detail | Gemini |
| --- | --- | --- | --- | --- | --- |
| Device resolution (old default) | 4604×2728 | 16,747 | 16,170 | 2,125 | 6,192 |
| CSS resolution (current default) | 2302×1364 | 4,187 | 4,067 | 2,125 | 1,548 |
| CSS + `width=768` | 768×455 | 466 | 476 | 425 | 258 |

Result: the default screenshot costs about a quarter of the old value thanks to
CSS resolution (OpenAI pre-scales to 2048 pixels anyway, so CSS resolution
saves nothing there — `width` does). With `width=768` a screenshot drops to
258–476 tokens — under a third of one `brave_read` call with 6,000 characters
(roughly 1,500–2,000 tokens). The old device-resolution screenshot on Claude
cost as much as a good nine such text reads.

## Working rules for agents

Field-tested practices; anyone using this MCP works by them:

- Check the functions an MCP offers first, then reach missing surfaces through
  the browser. A single MCP rarely covers a whole application.
- Submitted is not done. Check visible evidence first: the new post in the
  history, the confirmation, the produced file. "Requested", "executed" and
  "saved" are different states; when the outcome is unclear, do not blindly
  repeat a write — re-read the state.
- Define what "done" means before starting, and report further extensions as
  their own task instead of quietly widening a check.

## Limits

Downloads run inside the browser into the profile's download folder; this
server does not expose them as a tool yet and reports neither path nor success.
If that is needed, it is its own follow-up task.

Known security limits:

- **Upload folder:** the default upload folder is `~/Downloads`, where files from
  blocked sites (bank statements, for example) also land. A page could ask an agent
  to upload such a file by a guessed name. Set `BRAVE_MCP_UPLOAD_DIR` to a dedicated
  folder that only contains files you want agents to upload.
- **One shared process:** all agents share one background process and its queue. A
  frozen or very heavy tab can stall every agent until it responds or you run
  `npx brave-session-mcp --stop`.
- **Runtime folder:** the background process uses `/tmp/brave-session-mcp-<uid>`
  (or `BRAVE_MCP_RUNTIME_DIR`). If another user on the same computer creates that
  folder first, the safety checks refuse it and every tool fails with an error
  (it fails closed); set `BRAVE_MCP_RUNTIME_DIR` to a folder of your own.
- **Same settings file:** the terminal commands and the background process each read
  `BRAVE_MCP_SETTINGS` from their own environment. If your MCP client sets it, set
  the same value in the shell you run `block`, `mode` and `control` from, or your
  changes go to a different file.
- **Redirect hops:** `brave_navigate` and `brave_open` check the address you give and
  the address the tab ends on. A redirect chain that passes through a blocked site
  in between is not stopped, and the blocked site sees that request with your
  cookies.

## Stopping the shared connection

```sh
npx brave-session-mcp --stop
```

This disconnects the shared access for all clients but leaves Brave and its
tabs open. Closing a single MCP client does not disconnect the shared
connection. After changes to the server code, stop the shared process once
with `--stop`; the next client call restarts it with the new code. The client
compares its API version with the process's; an outdated process is reported
explicitly instead of silently ignoring new options.

The local Unix socket lives in a user directory with mode 0700 and is itself
accessible only to that user (0600). There is no open HTTP server for MCP.
Inside the background process, a CDP gate between Playwright and Brave listens on
`127.0.0.1` on a random port and path and accepts exactly one connection. It keeps
Playwright from attaching to every open tab: the server attaches only to the tab an
agent works with, so listing tabs never wakes or touches your other tabs.
POSIX systems are supported; tested live on macOS with Brave Nightly.

## Releases

What changed in each version: [CHANGELOG.md](CHANGELOG.md). What a version number
promises, what counts as breaking and which versions get fixes:
[RELEASES.md](RELEASES.md).

## Verification

```sh
pnpm test
node test/smoke.mjs
node test/edge.mjs
node test/interact.mjs
node test/tokens.mjs
```

The token measurement opens its own test tab, measures the three screenshot
variants on your own machine and closes it again.

The live test opens its own local test tab. It verifies the MCP handshake, the
tool catalog, text input, real clicks, a hidden file upload, an embedded frame
and screenshots. Two separate MCP clients must report the same process and
exactly one browser connection. Existing tabs are never navigated. At the end
the test closes its own tab with `brave_close`; its test server ends with the
test process.

As of 2026-11-18: nine local checks passing, live test with two MCP clients
and all ten tools successful, including wait after click/navigation, text
paging via `charOffset`, control paging and filtering, switch state, covered
checkboxes, icon character removal, closing your own tab, target-width
screenshots, version handshake and reconnection after browser restart.

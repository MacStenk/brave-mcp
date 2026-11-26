# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses Semantic Versioning in its 0.x form: until 1.0, the MINOR digit
is the breaking digit. See [RELEASES.md](RELEASES.md) for what each number
promises and which versions get fixes.

## [Unreleased]

## [0.5.0] - 2026-11-27

### Added

- `brave_click` accepts a point `x`/`y` (CSS pixels) for canvas apps, maps and charts;
  `screenshotWidth` converts coordinates from a downscaled screenshot. `brave_screenshot`
  returns the size of the visible area. Coordinates are refused on pages that embed a blocked site.
- New tools `brave_hover`, `brave_drag` and `brave_key` (named keys and combinations only, page only).
- Debug tools `brave_console`, `brave_network` (no headers or bodies, secret-looking URL
  parameters redacted) and `brave_eval`. Off by default; only the user switches them on with
  `npx brave-session-mcp debug on` or the control page.
- Brave Stable and Beta are detected automatically (the variant with remote debugging first);
  `BRAVE_BIN` for Linux. Agent mode on Linux (untested).
- Live test `test/interact.mjs` for coordinates, hover, drag, keys and debug tools.

### Changed

- API version 10: older background processes are reported as outdated.

- New CDP gate (`src/gate.mjs`) between Playwright and Brave. Until now
  `connectOverCDP` attached to every open tab of every profile when connecting.
  That made connecting slow with many tabs, woke throttled background tabs
  (for example YouTube) and technically tied the process to private tabs that
  agent mode only hides. `brave_tabs` now only lists tabs; the server attaches
  to a tab only when an agent works with it, in agent mode only to tabs of the
  agent profile.
- Measured on 2026-11-27 with 43 open tabs: 0 attached tabs after `brave_tabs`
  (previously all 43), `brave_open` 0.6 s instead of about 6 s, `brave_read` 22 ms.
- The gate listens on `127.0.0.1` on a random port with a random path and accepts
  exactly one connection (Playwright in the same process). Agents cannot open its address.
- New live test `test/edge.mjs`: iframe of a foreign site (own process), popup
  opened from an agent tab, and a real page (GitHub repo: read, filter, click, screenshot).

## [0.4.0] - 2026-11-18

### Security

Findings and status of the review that led to this release:
[docs/security-review-2026-11-18.md](docs/security-review-2026-11-18.md).

- `brave_read` reads text, address and controls of one document in a single step and
  discards the result if the tab or frame switched to a blocked page meanwhile.
  Screenshots get the same check afterwards, and `brave_tabs` takes titles from the
  browser instead of the page.
- Only `http(s)` websites are visible to agents. `about:`, `blob:`, `data:`,
  `brave://` and extension pages are hidden, and so is everything inside a blocked
  frame.
- **Breaking:** the control page needs a key that only you can read
  (`~/.config/brave-mcp/control-key`). Open it with the address that
  `npx brave-session-mcp control` prints and bookmark that address; without it the
  page answers 403. Forms sent from other sites are refused.
- `brave_screenshot` captures and scales the image in the browser engine instead of
  running code in the page, so a page can no longer read or swap the screenshot.
- Agent mode finds its profile and its opened tabs by a unique address instead of
  taking the first new tab, so a tab you open at the same time is no longer mistaken
  for it.
- `brave_screenshot` is refused on a page that embeds a blocked site, and clicks there
  never bypass the check of what is under the pointer.
- `brave_status` reports whether the control page is running and why not.
- A trailing dot in the address (`bank.example.`) no longer bypasses the blocklist or
  the control page check.
- A settings file with an unknown `mode`, a `blocked` value that is not a list, or an
  entry that is not a domain now makes every tool fail instead of allowing everything.
  Entries like `https://www.Bank.example/login` are normalized to `bank.example`.
- Quick successive changes on the control page no longer lose a change, and writes
  at the same time no longer fail or leave a half-written settings file.
- `brave_upload` refuses folders; only single files from the upload folder are
  accepted.
- Error messages no longer reveal more than needed: one message for every refused
  upload path (no real path, no hint whether the file exists), no blocked host names,
  and no browser call logs with the addresses of intermediate pages.
- `brave_navigate` and `brave_open` refuse Brave's debugging address, and such tabs
  are hidden.
- Updated zod to 4.6.7 (GHSA-mrhx-c7xc-m3w5).

## [0.3.1] - 2026-11-18

### Security

- Blocklist now also covers embedded frames: an allowed page that embeds a
  blocked site no longer lists that frame, and it cannot be read or clicked.
  A tab opened by an agent that redirects to a blocked site is closed again.

## [0.3.0] - 2026-11-18

### Added

- Published on npm as `brave-session-mcp`: `npx -y brave-session-mcp` replaces
  cloning; the config examples use it.
- Agent mode: every tool sees only the tabs of one Brave profile, chosen by the
  name you gave it in Brave, and `brave_open` opens tabs there. macOS only for now.
- Blocklist: blocked sites are invisible to agents and cannot be opened by them,
  also after a redirect. A domain includes its subdomains.
- Control page at `http://127.0.0.1:47821/` and terminal commands (`block`,
  `mode`) switch both at any time without a restart. Agents cannot change them.

### Security

- **Breaking:** `brave_upload` only accepts files from one folder (`~/Downloads`
  by default, set with `BRAVE_MCP_UPLOAD_DIR`). Before, an agent could upload any
  file the process could read, so a page with hidden instructions could have
  asked for your SSH keys. Affects agents that upload from other folders: move
  the file into the upload folder or set the variable, then restart the
  background process with `node src/server.mjs --stop`.

### Changed

- Tool descriptions, parameter descriptions and error messages are now in English
  (they were German). Agents matching on the old German error text need to update.
- The README is now in English; the German version lives in `README.de.md`.

## [0.2.0] - 2026-11-18

First public release. Install by cloning the repository; nothing is published to
a package registry.

### Added

- Ten MCP tools: `brave_status`, `brave_tabs`, `brave_read`, `brave_click`,
  `brave_fill`, `brave_upload`, `brave_screenshot`, `brave_navigate`,
  `brave_open` and `brave_close`.
- One shared background process holds a single connection to your running Brave
  for every local MCP client, reconnects after a browser restart, and reports when
  it is older than the connecting client (`apiVersion` in `brave_status`), so you
  know to restart it with `--stop`.
- `brave_read` pages long text with `charOffset`, `charsTotal` and
  `nextCharOffset`.
- `brave_read` pages controls with `controlOffset`, `controlsTotal` and
  `nextControlOffset`, and searches them by label or row text with
  `controlFilter`. Before this, pages with large navigation silently cut off
  every control after the 200th.
- Checkboxes, radio buttons and switches (`role="switch"`) report `checked`;
  unlabeled controls report the text of their row as `context`.
- `brave_click`, `brave_navigate` and `brave_open` accept `wait` and return only
  after the page has loaded and settled, so agents do not need to poll.
- `brave_click` reaches checkboxes and switches covered by an icon and reports
  their new state.
- `brave_close` closes tabs an agent opened with `brave_open`; your own tabs are
  refused.
- `brave_screenshot` captures at CSS resolution and accepts `width` (320 to 1280)
  to downscale further. On a Retina display this cut one screenshot from about
  16,700 to about 4,200 image tokens at full width and to under 500 at
  `width=768` (Claude formula, measured with `test/tokens.mjs`).
- Icon characters from web fonts (Unicode Private Use Area) are removed from text,
  labels and context.
- Hidden mirror inputs that UI libraries place next to a switch are skipped, so
  `controlFilter` returns the switch itself.
- Element references are bound to their tab and expire after ten minutes; page
  text is returned as untrusted data, and no tool runs page scripts.

[Unreleased]: https://github.com/MacStenk/brave-mcp/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/MacStenk/brave-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/MacStenk/brave-mcp/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/MacStenk/brave-mcp/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/MacStenk/brave-mcp/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MacStenk/brave-mcp/releases/tag/v0.2.0

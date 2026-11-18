# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses Semantic Versioning in its 0.x form: until 1.0, the MINOR digit
is the breaking digit. See [RELEASES.md](RELEASES.md) for what each number
promises and which versions get fixes.

## [Unreleased]

### Added

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

[Unreleased]: https://github.com/MacStenk/brave-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/MacStenk/brave-mcp/releases/tag/v0.2.0

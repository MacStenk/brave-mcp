# Release policy

## Version numbers

We use Semantic Versioning in its 0.x form (`0.MINOR.PATCH`). Until 1.0, 0.MINOR
is the breaking digit and 0.x.PATCH is a compatible fix. New features also ship
in a MINOR release.

There is no package registry: you install by cloning the repository, and a
release is a git tag `vX.Y.Z` with a GitHub release. `package.json` carries the
same version, and the server reports it to MCP clients.

We plan to ship 1.0 once the tool surface below has stayed unchanged through a
few releases and more than one person runs it day to day.

## What we consider breaking

Covered by this promise:

- Tool names and their input parameters (names, types, defaults, limits).
- Fields in tool results that agents read: `tabId`, `frameId`, `ref`, `text`,
  `charOffset`, `charsTotal`, `nextCharOffset`, `controls` and their fields
  (`tag`, `label`, `type`, `role`, `context`, `checked`, `value`),
  `controlOffset`, `controlsTotal`, `nextControlOffset`, `frames`, and the
  results of click, fill, upload, close, navigate and open.
- Safety guarantees: references bound to their tab and expiring, no page-script
  execution, `brave_close` refusing tabs it did not open, navigation limited to
  HTTP(S) without embedded credentials.
- The command line: `node src/server.mjs`, `--stop`, `block`, `mode`, `control`,
  and the environment variables `BRAVE_USER_DATA_DIR`, `BRAVE_MCP_UPLOAD_DIR`,
  `BRAVE_MCP_PROFILE`, `BRAVE_APP`, `BRAVE_MCP_SETTINGS` and `BRAVE_MCP_CONTROL_PORT`.
- The control page address and the settings file format.
- In agent mode, tools never see or touch tabs of other profiles; blocked sites
  are never shown to or opened by agents.
- The Node.js floor declared in `package.json` (`engines.node`).

Not covered:

- Wording of error messages and tool descriptions (they are German or English and
  may change in any release).
- Order and exact count of controls beyond "DOM order", and the label length cap.
- The local socket path and the protocol between clients and the background
  process; the `apiVersion` handshake detects a mismatch and tells you to restart
  it with `--stop`.
- Screenshot bytes, image format details and the token figures in the README.
- Test scripts under `test/` and helper scripts under `scripts/`.

Opt-in unstable: none.

## Runtime support

We support Node.js 22 and newer, declared in `package.json` as `engines.node`.
pnpm and npm only warn when the floor is not met, so raising it is a breaking
change and ships in a MINOR release, announced one release ahead.

Browser: Brave Nightly on macOS is tested. Regular Brave and Linux are expected to
work but are untested; Windows is not tested. A Brave or Chromium update that
breaks the server is fixed in a PATCH release when the fix is compatible.

## Pre-releases and channels

There are no pre-releases and no channels. `main` may hold unreleased changes;
only tagged versions are supported.

A release is marked as withdrawn in the changelog and on its GitHub release for a
security hole, data loss, or a break shipped as a PATCH. Tags are never moved or
deleted; fixes go forward in a new release.

## Release cadence

Feature-based: we release when something is ready. A merged fix ships within four
weeks. Security fixes ship as soon as they are ready.

## Supported versions

| Line | Status      | Fixes | Supported until |
| ---- | ----------- | ----- | --------------- |
| 0.2  | current     | all   | while current   |
| older | unsupported | none  | -               |

Only the latest release line gets fixes. Issues on older versions are closed with
a link to this table unless they reproduce on the latest release.

## Backports

None. Fixes land on `main` and ship in the next release of the current line.

## Deprecation

A tool, parameter or result field we plan to remove is first marked deprecated in
the tool description and in the changelog, and stays for at least one MINOR
release before removal. The changelog entry names the replacement.

## Known past breaks

None.

## Who can cut a release

Steven Noack (@MacStenk) holds push rights to the repository and creates tags and
GitHub releases. If he is unavailable, no release ships.

Before tagging, `pnpm run release:check` must pass: it confirms that
`package.json`, the newest version heading in `CHANGELOG.md` and the tag agree.

## Changes to this policy

Announced in the changelog in the release before they apply.

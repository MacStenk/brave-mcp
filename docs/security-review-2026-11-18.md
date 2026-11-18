# Security review, 18 November 2026

Scope: `src/*.mjs` of brave-mcp 0.3.1, read against README.md, RELEASES.md and SECURITY.md.
Method: a read-only code review by a separate AI agent (Claude), followed by fixes and
live tests in Brave Nightly on macOS. The findings were traced through the code; the
fixes were tested. Triggered by a question on X about redirects to blocked sites.

Threat model:

- **A** a malicious web page the agent reads
- **B** another website in the same browser that targets the local control page
- **C** another user or process on the same machine

Known limits that were not counted as findings: prompt injection in page text, and
Brave containers not being distinguishable over CDP
([brave/brave-browser#61986](https://github.com/brave/brave-browser/issues/61986)).

## Findings and status

| ID | Severity | Finding | Status |
|---|---|---|---|
| H1 | high | The blocklist was checked before reading; a page could swap to a blocked site while `brave_read` waited for the document | Fixed in 0.4.0: the result is discarded if the tab or frame address changed during the read; same check after screenshots |
| M1 | medium | Non-http(s) pages (`blob:`, `about:`, `brave://`, extension pages) skipped the blocklist | Fixed in 0.4.0: agents only see http(s) tabs and frames; everything inside a blocked frame is hidden |
| M2 | medium | Screenshot scaling ran in the page, which could read or swap the image | Fixed in 0.4.0: scaling via CDP `Page.captureScreenshot`, no code in the page |
| M3 | medium | Other local users or processes could use the control page | Fixed in 0.4.0: a key in a 0600 file is required, exchanged for an HttpOnly SameSite=Strict cookie |
| M4 | medium | Agent mode could lock onto the wrong profile through a race | Fixed in 0.4.0: the profile and opened tabs are matched by a unique address |
| M5 | medium | Blocked iframes appeared in screenshots; forced clicks could land in them | Fixed in 0.4.0: screenshots refused on such pages, no forced clicks there |
| L1 | low | A failed control page start was only logged | Fixed in 0.4.0: `brave_status` reports it |
| L2 | low | A trailing dot (`bank.example.`) skipped the blocklist | Fixed in 0.4.0 |
| L3 | low | A broken settings file allowed everything | Fixed in 0.4.0: invalid settings make every tool fail |
| L4 | low | Concurrent settings writes could be lost | Fixed in 0.4.0 within one process; CLI and background process are not locked against each other |
| L5 | low | Folders could be uploaded | Fixed in 0.4.0 |
| L6 | low | The default upload folder is `~/Downloads` | Documented; a dedicated folder is recommended |
| L7 | low | Error messages revealed paths, blocked hosts and browser call logs | Fixed in 0.4.0 |
| L8 | low | One frozen tab can stall the shared process for all agents | Documented |
| L9 | low | Another user can pre-create the runtime folder in `/tmp` (tools then fail closed) | Documented |
| L10 | low | CLI and background process can use different settings files | Documented |
| L11 | low | Intermediate redirect hops through a blocked site are not checked | Documented |
| L12 | low | Double-click tricks against the control page (speculative) | Fixed in 0.4.0: cross-site form posts refused |
| L13 | low | The browser's debugging address could be opened (speculative) | Fixed in 0.4.0 |

Dependency audit the same day: `zod` below 4.6.6 had a high-severity advisory
([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)); updated to
4.6.7 in 0.4.0. `pnpm audit --prod` reports no known vulnerabilities.

## Checks that passed

Hostname normalization (case, ports, userinfo, percent-encoding, IPv4 shorthand),
subdomain matching, http(s)-only navigation without credentials, control page Host
allowlist against DNS rebinding, exact Origin check, no scripts and escaped output on the
control page, Unix socket permissions (0700 folder, 0600 socket, owner checks, size
limits), upload realpath checks, atomic settings writes, and argument-list calls to
`open` and `osascript`.

Found something else? See [SECURITY.md](../SECURITY.md).

## External scan

Same day, after the fixes: [HOL Guard plugin-scanner](https://github.com/hashgraph-online/hol-guard)
3.59.0, run locally without an account. The first run scored 92/100 with one low
finding (no Dependabot configuration); after adding `.github/dependabot.yml` it scored
100/100 with no findings. The scanner checks repository hygiene and code patterns
(secrets, `eval`, shell injection, MCP command and transport settings, lockfiles); the
logic findings above come from the code review. Its Cisco MCP scan was skipped because
the repository has no `.mcp.json`.

Reproduce from a clone:

```sh
uvx --from plugin-scanner plugin-scanner scan .
```

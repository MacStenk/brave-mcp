#!/usr/bin/env node
// Release-time check (RELEASES.md): package.json, newest CHANGELOG version and git tag must agree.
// Usage: node scripts/check-release.mjs [vX.Y.Z]   (without argument: the tag on HEAD, if any)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')).version;
const changelog = fs.readFileSync(new URL('CHANGELOG.md', root), 'utf8');
const newest = changelog.match(/^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})/m);
const tag = process.argv[2] ?? (() => {
  try { return execFileSync('git', ['describe', '--tags', '--exact-match', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; }
})();

const problems = [];
if (!newest) problems.push('CHANGELOG.md has no released version heading "## [X.Y.Z] - YYYY-MM-DD".');
else if (newest[1] !== pkg) problems.push(`package.json says ${pkg}, newest CHANGELOG entry is ${newest[1]}.`);
if (tag && tag !== `v${pkg}`) problems.push(`Tag ${tag} does not match package.json ${pkg}.`);
if (!changelog.includes(`[${pkg}]: https://github.com/MacStenk/brave-mcp/`)) problems.push(`CHANGELOG.md lacks the link reference for [${pkg}].`);

if (problems.length) { console.error(problems.map(p => `✗ ${p}`).join('\n')); process.exit(1); }
console.log(`✓ ${pkg}: package.json, CHANGELOG.md${tag ? ` and tag ${tag}` : ''} agree.`);

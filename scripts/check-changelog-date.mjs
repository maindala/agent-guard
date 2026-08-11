#!/usr/bin/env node
// Release-time gate: the CHANGELOG.md entry for the version being released must carry a
// real ISO date before the npm tarball is built and published.
//
// Why this doesn't just stamp the date for you: CHANGELOG.md ships INSIDE the published
// tarball (it's in this package's `files` list), built from the released commit before
// `npm publish` runs. A step that wrote the date automatically would have to run either
// after publish (too late — the tarball is already built and immutable) or on the same
// job that holds publish rights via OIDC, which would need `contents: write` there — a
// real privilege increase on the single most sensitive workflow this repo has. Neither is
// acceptable, so this stays a gate, not a fix: it runs in the existing `verify` job
// (contents: read, no new permissions) and fails the release loudly and early if the top
// CHANGELOG.md entry isn't a real, matching, dated heading. Fixing it then costs a commit
// and a re-cut release — cheap, because nothing has shipped yet.
//
// Run in CI: node scripts/check-changelog-date.mjs (release.yml sets RELEASE_TAG for it).
// Run locally to rehearse a release, or to watch this gate fail on purpose:
//   RELEASE_TAG=v1.2.3 node scripts/check-changelog-date.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Prints the failure and exits non-zero. Every call site explains what's wrong AND how to
// fix it — a bare "regex did not match" is not an acceptable message on the publish path.
function fail(message) {
  console.error(`\nchangelog-date-gate: FAIL\n\n${message}\n`);
  process.exit(1);
}

// ── Source of truth #1: package.json's own version ──────────────────────────────────
const pkgPath = path.join(ROOT, 'package.json');
if (!fs.existsSync(pkgPath)) {
  fail(`package.json not found at ${pkgPath}.`);
}
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const pkgVersion = pkg.version;
if (!pkgVersion) {
  fail('package.json has no "version" field — cannot verify the changelog against it.');
}

// ── Source of truth #2: the tag actually being released ─────────────────────────────
const releaseTag = process.env.RELEASE_TAG;
if (!releaseTag) {
  fail(
    'RELEASE_TAG is not set. This script expects the tag being released (e.g. "v1.2.3") in ' +
      'the RELEASE_TAG env var — release.yml sets it from ${{ github.event.release.tag_name }}. ' +
      'If you are rehearsing a release locally, set it yourself, e.g.:\n' +
      `  RELEASE_TAG=v${pkgVersion} node scripts/check-changelog-date.mjs`
  );
}
const tagVersion = releaseTag.replace(/^v/, '');

// ── Parse CHANGELOG.md's TOP heading only. An entry for the right version sitting below
// the top (rather than at it) is the same "released the wrong thing" bug this also guards
// against — the top of the file is what a human (and this gate) treats as "current". ──
const changelogPath = path.join(ROOT, 'CHANGELOG.md');
if (!fs.existsSync(changelogPath)) {
  fail(`CHANGELOG.md not found at the repo root (${changelogPath}).`);
}
const changelog = fs.readFileSync(changelogPath, 'utf8');

// Matches "## [1.2.3] - 2026-08-11", "## [1.2.3] — Unreleased", "## [1.2.3] – TBD", etc.
// Accepts a hyphen, en dash, or em dash as the separator — this project's changelogs are
// not consistent about which one they use, and that inconsistency is not itself a defect
// worth gating on.
//
// Whitespace around the brackets/separator is deliberately [ \t]* (horizontal only), NOT
// \s* — \s matches newlines too, and a plain \s* here will happily skip over a blank line
// and grab the *next paragraph's* text as if it were the date (caught by testing an empty
// "## [1.2.3] —" heading directly above a body paragraph — \s* silently matched through
// to "Some change." on the line below). Restricting to same-line whitespace is what makes
// an actually-empty date correctly read as empty instead of accidentally finding text.
const HEADING_RE = /^##[ \t]*\[([^\]]+)\][ \t]*[-–—][ \t]*(.*)$/m;
const match = changelog.match(HEADING_RE);
if (!match) {
  fail(
    'CHANGELOG.md has no top-level version heading in the expected form ' +
      '"## [X.Y.Z] - YYYY-MM-DD". Add one before releasing.'
  );
}
const [, headingVersionRaw, dateRaw] = match;
const headingVersion = headingVersionRaw.trim();
const dateStr = dateRaw.trim();

// ── Version must agree on all three sides: changelog heading, package.json, release tag ──
if (headingVersion !== pkgVersion) {
  fail(
    `CHANGELOG.md's top entry is for version "${headingVersion}", but package.json declares ` +
      `"${pkgVersion}". Move (or add) a "## [${pkgVersion}] - <date>" entry to the TOP of ` +
      `CHANGELOG.md — the top entry must always describe the version being released.`
  );
}
if (headingVersion !== tagVersion) {
  fail(
    `The release tag is "${releaseTag}" (version "${tagVersion}"), but CHANGELOG.md's top ` +
      `entry is for version "${headingVersion}". One of the two is wrong for this release — ` +
      `fix whichever doesn't match the version actually being published, then re-cut.`
  );
}

// ── The date itself: reject anything that isn't a real, present, ISO-format date ────────
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOW_TO_FIX =
  `Fix: in CHANGELOG.md, set the top heading to "## [${pkgVersion}] - YYYY-MM-DD" with ` +
  'today\'s real date, as part of the release-prep commit — before the tag is cut, not ' +
  'after. This cannot be fixed post-publish: CHANGELOG.md ships inside the npm tarball, ' +
  'built from the released commit, and npm versions are immutable once published.';

if (dateStr === '') {
  fail(`CHANGELOG.md's heading for ${pkgVersion} ("## [${pkgVersion}] -") has no date at all.\n\n${HOW_TO_FIX}`);
}
if (/^unreleased$/i.test(dateStr)) {
  fail(
    `CHANGELOG.md's heading for ${pkgVersion} still says "Unreleased", but this version is ` +
      `about to be published to npm right now.\n\n${HOW_TO_FIX}`
  );
}
if (/^tbd$/i.test(dateStr)) {
  fail(
    `CHANGELOG.md's heading for ${pkgVersion} says "TBD" — the release date is not a ` +
      `"to be decided" value once the release is actually being cut.\n\n${HOW_TO_FIX}`
  );
}
if (!ISO_DATE_RE.test(dateStr)) {
  fail(`CHANGELOG.md's date for ${pkgVersion} ("${dateStr}") is not in ISO format (YYYY-MM-DD).\n\n${HOW_TO_FIX}`);
}
// The regex only checks the shape; also reject shapes like 2026-13-40 that parse but are
// not real calendar dates.
const [y, m, d] = dateStr.split('-').map(Number);
const parsed = new Date(Date.UTC(y, m - 1, d));
const isRealDate = parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
if (!isRealDate) {
  fail(`CHANGELOG.md's date for ${pkgVersion} ("${dateStr}") is not a real calendar date.\n\n${HOW_TO_FIX}`);
}

console.log(
  `changelog-date-gate: OK — CHANGELOG.md's top entry ("## [${pkgVersion}] - ${dateStr}") ` +
    `matches package.json and release tag ${releaseTag}.`
);

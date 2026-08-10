# Releasing `@maindala/agent-guard`

This package publishes to npm via **trusted publishing (OIDC)** — CI exchanges a
short-lived, workflow-scoped OIDC token for publish rights on every release. No npm
token is stored anywhere, in this repo or in the `maindala` org's secrets. This
replaces the old flow of an owner running `npm publish` locally behind an interactive
2FA prompt.

## How to cut a release

1. Bump `version` in `package.json` and add an entry to `CHANGELOG.md` (this repo
   backfills the changelog against what's actually live on npm — keep that habit). This
   can go directly to `main` as usual — branch protection on this repo only requires a
   reviewed PR for changes under `.github/` (see below), not for every change.
2. If the change instead touches `.github/` — most importantly `release.yml` itself —
   it must go through a PR, and `.github/CODEOWNERS` requires that PR to be approved by
   an owner before it can merge. This is deliberate: an unreviewed edit to the publish
   workflow could grant publish rights to a different repo/branch/environment, which
   would defeat the whole point of the required-reviewer gate on the workflow it edits.
   Direct pushes to `.github/` remain technically possible for repo admins (branch
   protection does not block admins here — see `enforce_admins` on the branch protection
   settings) but should not be used for this path; treat the PR+review step as real, not
   optional, specifically for `.github/`.
3. Cut the release, which is what actually triggers `release.yml`:
   ```
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-from-tag
   ```
   (or use the GitHub UI: Releases → Draft a new release → publish). **Publishing the
   release is the publish trigger** — nothing before this step calls `npm publish`.
4. Watch the Actions run. The `verify` job re-builds and re-tests the released commit
   from a clean checkout. The `publish` job then **pauses** behind the `npm-publish`
   Environment until the configured reviewer approves it in the Actions UI — that
   approval click is the human gate, replacing the old interactive npm 2FA step.
5. Once approved, `npm publish --access public` runs with `id-token: write` and no
   stored credential. Provenance is generated automatically as part of the OIDC
   exchange — verify afterward with `npm view @maindala/agent-guard` (should show a
   provenance attestation) and `npm audit signatures`.

Pushing a `main` commit or merging a PR **does not publish anything** — only a
published GitHub Release does. This is deliberate (see the design doc's §6.1): a merge
must not be able to publish.

## One-time setup this depends on — owner action, not automatable

Trusted publishing has to be configured on **npmjs.com itself** (there is no GitHub API
for this) before the first release through this workflow will succeed. On the
package's settings page (`npmjs.com` → `@maindala/agent-guard` → Settings → Trusted
Publisher → GitHub Actions), enter exactly:

| Field | Value |
|---|---|
| Organization or user | `maindala` |
| Repository | `agent-guard` |
| Workflow filename | `release.yml` (filename only, not the full path) |
| Environment name | `npm-publish` |
| Allowed actions | `npm publish` |

Also required (verified against npm's live docs 2026-08, per the design doc's §6.1
build-time caveat): **npm CLI >= 11.5.1** and **Node >= 22.14.0** in the publish job —
`release.yml` already pins Node 24 and force-installs the latest npm CLI, so nothing
further is needed there once the npmjs.com side is configured.

The GitHub side is already in place: the `npm-publish` Environment exists on this repo
with a required reviewer configured. If npm ever needs it, the environment name is
`npm-publish`.

## Break-glass path

If trusted publishing is ever broken or unavailable, `scripts/publish-package.sh` in
the private monorepo remains the documented fallback — it publishes from a clone of
this public repo in `public-repo` mode (so `gitHead` still resolves to a real, public
commit) rather than from the monorepo working tree. See that script's own header
comment for the full `gitHead` provenance story this exists to avoid repeating.

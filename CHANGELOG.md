# Changelog

All notable changes to `@maindala/agent-guard` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions below are backfilled
against what is actually live on npm (`npm view @maindala/agent-guard versions`), not
just what shipped in source.

## [1.0.1] — 2026-08-11

No functional change. Date corrected after the fact (confirmed via `npm view
@maindala/agent-guard time --json`, not guessed) — this is the same defect the entry
below describes, recurring the very next day, which is what motivated the release-time
changelog-date gate this release adds (`scripts/check-changelog-date.mjs`, see RELEASING.md).
**The published `1.0.1` tarball on npm still contains this heading as "Unreleased"** —
CHANGELOG.md ships inside the tarball built at publish time, and npm versions are
immutable, so that copy can never be corrected. Only this repo copy, and only going
forward, is fixed.

### Fixed
- **This entry itself.** `CHANGELOG.md` headed this release "## [1.0.1] — Unreleased"
  while 1.0.1 was already live on npm — the identical defect QFX-3 fixed by hand for
  `1.0.0` one day earlier, recurring immediately. A release-time gate
  (`scripts/check-changelog-date.mjs`, wired into `release.yml`'s `verify` job) now fails
  any future release whose top changelog entry isn't a real, matching, ISO-dated heading
  — see RELEASING.md.
- This changelog headed the `1.0.0` entry below "Unreleased" for several days after
  `1.0.0` was actually live on npm (confirmed via `npm view`) — a public-facing accuracy
  gap on the release notes for the version consumers were already installing. The date
  is now correct.
- Source comments referencing an internal initiative codename ("Free Telemetry Wedge P2")
  and an internal service's private codename genericized to describe behavior instead of
  internal architecture — comment-only, zero behavior change. (QFX-2)

## [1.0.0] — 2026-08-10

**Breaking change — read this before upgrading.** `checkTool()`'s default posture when
the governance plane is unreachable flips from **fail-open** to **fail-closed**.

- **Before (0.2.x, always):** an unreachable/erroring/timed-out gateway returned
  `{ allow: true, reason: 'guard_error' }` — every tool call was allowed through
  unchecked for as long as the outage lasted, with no way to opt out.
- **Now (1.0.0, default):** the same outage returns
  `{ allow: false, reason: 'guard_unavailable' }` instead.
- **One-line migration** if you need the old behavior back:
  ```ts
  new AgentGuard({ apiKey, failMode: 'open' }) // reproduces 0.2.x exactly
  ```

### Fixed
- **`checkTool()` could hang forever.** It called `fetch()` with no timeout and no
  `AbortController`. A gateway that accepted the TCP connection and never responded —
  as opposed to one that was simply down or erroring — never reached either fail-open
  branch, so the documented "an outage must not block the agent" guarantee did not
  actually hold for the most common real-world outage shape. Fixed with a real
  `AbortController`-backed `timeoutMs` (default 5000ms); a timeout is treated as a
  guard error and routed through `failMode` like any other outcome, and is never
  retried (see below — it has already spent its full time budget).
- **A narrower version of the same hang, found in review of the above fix.**
  `clearTimeout(timer)` was called immediately after `fetch()` resolved — i.e. as soon
  as response *headers* arrived — but before `await res.json()` read the *body*. A
  gateway that sent `200` + headers and then stalled mid-body disarmed the abort before
  the body read completed, hanging `checkTool()` forever despite `timeoutMs`. Fixed by
  moving `clearTimeout` into a `finally` block that only runs once the full round trip
  (headers **and** body) has resolved one way or another.

### Added
- `failMode: 'open' | 'closed'` on `AgentGuardConfig` (default `'closed'`, see the
  breaking-change note above).
- `toolFailModes?: Record<string, FailMode>` — per-tool override, so a privileged tool
  (e.g. `payments:refund`) can stay strict (`'closed'`) while the rest of an agent
  configured with `failMode: 'open'` keeps running through a governance-plane outage.
- Bounded retry with jitter on transport-level failures (network errors, non-2xx
  status, unparseable JSON) — `maxRetries` (default 2), `retryBaseDelayMs` (default
  100), `retryMaxDelayMs` (default 2000). A **timeout** is never retried (it already
  spent its full budget) and a **valid decision response is never retried**, even
  `{ allow: false }` — a real policy denial always produces exactly one request.
- A per-instance circuit breaker: after `breakerThreshold` (default 5) consecutive
  failed calls, the breaker opens and every call resolves immediately via `failMode`
  without touching the network — so a genuinely downed gateway doesn't cost every
  single tool call the full `timeoutMs` wait. After `breakerCooldownMs` (default
  30000ms), exactly one probe call is let through; success closes the breaker,
  failure reopens it.
- `onDecision(record)` config callback — fires for every `checkTool()` outcome (allow,
  deny, guard_error, timeout, or a cache hit) with `{ toolRef, decision, reason,
  latencyMs, cacheHit }`. This is the integration point for writing decisions into
  *your own* audit system — this SDK does not persist decisions and is not itself an
  audit log. A callback that throws is caught and logged; it can never break the
  guarded call.
- `wrapTool(tool)` / `wrapTools(tools)` — governs a tool registry once, at registration,
  instead of requiring every call site to remember to call `checkTool()` by hand (the
  reviewer's second architectural criticism: "a forgotten wrapper bypasses it"). A
  denied call returns the denial to the caller as a normal string result — it never
  throws — mirroring the house pattern `packages/agent-runtime`'s
  `callExternalAgentViaBroker` already uses for a blocked A2A delegation.
- `coverageReport(registered, wrapped)` — reports which registered tools were never
  wrapped, so a forgotten wrapper is visible instead of silent.
- `@maindala/agent-guard/adapters/mcp` (`wrapMcpTool`) and
  `@maindala/agent-guard/adapters/vercel-ai` (`wrapVercelAiTool`) — framework-native
  adapters for the MCP TypeScript SDK and the Vercel AI SDK (Gate 1 scope: these two
  only; LangChain/LangGraph and the OpenAI Agents SDK are explicitly out of scope).
  Both are **optional peer dependencies** — `dependencies` stays empty, and the core
  `import { AgentGuard } from '@maindala/agent-guard'` works with zero frameworks
  installed; only importing an adapter's own subpath needs that framework present, and
  even then only for full type inference (both adapters are structurally typed, so the
  built JS itself never imports the framework's runtime code). Runnable, fully offline
  examples for both adapters plus `wrapTool`/`wrapTools`/`coverageReport` ship in
  `examples/` (`npm run examples`), verified with outbound network to anything but
  localhost blocked.

## [0.2.5] — 2026-08-09

### Changed
- `catalogUrl`'s default no longer points at the raw Cloud Run hostname — repointed to
  the now-live public `https://api.maindala.com`. Still fully overridable via
  `config.catalogUrl`.

## [0.2.4] — 2026-08-09

### Added
- `pushToolCallTelemetry()` now validates the *values* of the fields it forwards
  (`validateTelemetryEvent()`), not just which keys are present — an out-of-range
  `latencyMs`, an oversized `toolName`, or a `kind`/`decision` outside the documented
  enum is rejected client-side (event dropped, warning logged, nothing sent) rather
  than reaching the wire and depending on the server's own validation to catch it.

## [0.2.3] — 2026-08-09

### Changed
- `repository`/`homepage`/`bugs` repointed from the private monorepo to the (at the
  time, not-yet-public) dedicated `maindala/agent-guard` repo — version-only change,
  no code diff.

## [0.2.2] — 2026-08-09

### Security
- `pushToolCallTelemetry()`'s outbound request body is now built by explicitly picking
  the documented allowlisted fields (`kind`, `toolName`, `target`, `latencyMs`,
  `decision`, `findingClasses`) instead of serializing the caller's event object
  directly. Previously, an extra property on the event (accidental, or via a spread of
  a larger internal object) would have been forwarded as-is — TypeScript's structural
  typing only constrains callers at compile time, not what's actually present on the
  object at runtime. Unknown fields are now dropped before the request is sent, with a
  warning naming what was dropped.

## [0.2.1] — 2026-07-26

### Changed
- `repository`/`homepage`/`bugs` repointed from the pre-migration private repo path to
  `maindala/maindala` following the GitHub org migration. No code change.

## [0.2.0] — 2026-07-25

First published version. (The package was originally built at `0.1.0` during External
Agent Governance G4 but never published to npm; this is the first release, and it
already includes the Free Telemetry Wedge P2 additions below.)

### Added
- `pushToolCallTelemetry(token, event)` — pushes a single metadata-only tool-call/A2A
  event to the free `maindala tail`. Takes its own `mt_` telemetry token per call and
  works with zero org/governance configuration (`new AgentGuard({})` is sufficient).
- `apiKey`/`orgSlug` on `AgentGuardConfig` made optional, to allow the zero-config use
  above — `checkTool()`/`pushTelemetry()` still require them and throw a clear
  configuration error if called without.

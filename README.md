# @maindala/agent-guard

[![CI](https://github.com/maindala/agent-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/maindala/agent-guard/actions/workflows/ci.yml)

Governance SDK for external agents — policy pre-flight checks, DLP redaction, and telemetry push to
the mAIndala governance plane. Opt-in: call the guard from your own agent's code before/after tool
invocations to enforce your org's governance policy locally, without routing every tool call through
a broker.

## Install

```bash
npm install @maindala/agent-guard
```

## Quick start

```ts
import { AgentGuard } from '@maindala/agent-guard';

const guard = new AgentGuard({ apiKey: process.env.MAINDALA_ORG_KEY }); // mx_... org gateway key

const decision = await guard.checkTool('send_email');
if (!decision.allow) {
  throw new Error(`Blocked by org policy: ${decision.reason}`);
}

const result = await sendEmail(/* ... */);
const redacted = guard.applyDlp(result, decision.dlpPatterns);
```

`pushToolCallTelemetry(token, event)` works standalone with zero org configuration — see
[@maindala/telemetry](https://www.npmjs.com/package/@maindala/telemetry) if that's all you need;
this package is the fuller governance surface it sits alongside.

## Fail-open vs. fail-closed — read this before deploying

**`checkTool()` needs a default for one question: what happens when the mAIndala governance plane
itself can't be reached** — unreachable, erroring, returning something unparseable, or timing out?
That's a `failMode`, not a policy decision from the plane, and as of **1.0.0 the default is
`'closed'`**: an unreachable plane denies. This is a breaking change from every 0.2.x release, which
always failed open. See the [CHANGELOG](./CHANGELOG.md) for the full rationale and the one-line
migration if you're upgrading.

```ts
new AgentGuard({ apiKey })                          // failMode: 'closed' (default) — denies on outage
new AgentGuard({ apiKey, failMode: 'open' })         // reproduces 0.2.x exactly — allows on outage
new AgentGuard({
  apiKey,
  failMode: 'open',                                  // instance default: keep the agent running
  toolFailModes: { 'payments:refund': 'closed' },    // this one tool stays strict regardless
})
```

**Choosing `'closed'` (the default):** an outage denies every tool call until the plane is back.
Right for privileged, destructive, or regulated actions (payments, data deletion, anything a
compliance owner would ask "was this checked?" about) — a governance blind spot must never look the
same as "the request was actually reviewed and allowed."

**Choosing `'open'`:** an outage lets the agent keep working unchecked until the plane recovers.
Right when availability matters more than enforcement for a given tool — read-only tools, low-risk
actions, or an agent where a governance-plane outage genuinely should not be able to take the whole
thing down. The security implication is the direct consequence of the choice and worth stating
plainly: **while the plane is unreachable, every `'open'`-mode tool call is allowed through
unchecked**, for as long as the outage lasts.

Both modes share the same reliability machinery, all configurable:

- **`timeoutMs`** (default 5000) — `checkTool()` aborts via a real `AbortController` rather than
  hanging forever on a gateway that accepts the connection and never responds. A timeout is treated
  as a guard error and routed through `failMode` like any other outcome, and is **never retried** —
  it has already spent its full time budget.
- **Bounded retry with jitter** (`maxRetries`, default 2) on transport-level failures only — network
  errors, non-2xx status, unparseable JSON. A **valid decision is never retried**, even
  `{ allow: false }`: a real policy denial always produces exactly one request.
- **A circuit breaker** — after `breakerThreshold` (default 5) consecutive failed calls, every
  further call resolves immediately via `failMode` without touching the network, until
  `breakerCooldownMs` (default 30000) elapses and a single probe call tests recovery. This is what
  keeps a genuinely downed gateway from costing every tool call the full timeout.

The one case that fails neither open nor closed: calling `checkTool()` without `config.apiKey` throws
immediately. That's a caller misconfiguration, not a governance-plane problem, so it's surfaced
rather than silently resolved either way.

## Observing decisions — `onDecision`

```ts
const guard = new AgentGuard({
  apiKey,
  onDecision(record) {
    // record: { toolRef, decision, reason, latencyMs, cacheHit }
    // decision: 'allow' | 'deny' | 'guard_error' | 'timeout'
    myAuditLog.write(record);
  },
});
```

`onDecision` fires for every `checkTool()` outcome, including cache hits (`cacheHit: true`) and
plane-unreachable outcomes (`decision: 'guard_error' | 'timeout'`). **This SDK does not persist
decisions and is not itself an audit log** — `onDecision` is the integration point for writing them
into whatever audit system you already have. A callback that throws is caught and logged; it can
never break the guarded call.

## Governing a tool registry — `wrapTool`/`wrapTools`, and framework adapters

Calling `checkTool()` by hand at every call site works, but it's one forgotten call site away
from being bypassed. `wrapTool()`/`wrapTools()` govern a tool once, at registration, instead:

```ts
const tools = [
  { name: 'send_email', execute: async (args) => sendEmail(args) },
  { name: 'read_crm',   execute: async (args) => readCrm(args) },
];

const governedTools = guard.wrapTools(tools);
// every governedTools[i].execute() now runs checkTool() + DLP redaction first, automatically
```

**A denied call returns the denial to the caller as a normal string result — it never throws.**
The model needs to see "this was blocked by policy" as something it can reason about and report,
not an unhandled crash:

```ts
await governedTools[0].execute({ to: 'finance@example.com', body: '...' });
// → '[Tool "send_email" was blocked by governance policy: rate_limit_exceeded]'
```

### Coverage — make a forgotten wrapper visible, not silent

```ts
const report = guard.coverageReport(allRegisteredTools, wrappedTools);
report.ungoverned; // ['read_crm'] — exactly what was registered but never wrapped
```

### Framework adapters

Two adapters ship as **optional peer dependencies** — the core `@maindala/agent-guard` import
still has **zero required runtime dependencies** whether or not either framework is installed
(only importing the adapter's own subpath needs the corresponding framework present):

```ts
// MCP TypeScript SDK — wrap the handler you'd pass to registerTool() anyway
import { wrapMcpTool } from '@maindala/agent-guard/adapters/mcp';

server.registerTool('send_email', config, wrapMcpTool(guard, 'send_email', async (args) => {
  return { content: [{ type: 'text', text: await sendEmail(args) }] };
}));
```

```ts
// Vercel AI SDK — wrap the whole tool() definition; every other field passes through unchanged
import { wrapVercelAiTool } from '@maindala/agent-guard/adapters/vercel-ai';

const sendEmailTool = wrapVercelAiTool(guard, 'send_email', tool({
  description: 'Send an email',
  inputSchema: z.object({ to: z.string(), body: z.string() }),
  execute:     async (args) => sendEmail(args),
}));
```

Only MCP SDK and Vercel AI SDK are covered (a Gate 1 scope decision) — LangChain/LangGraph and the
OpenAI Agents SDK are explicitly out of scope. Runnable, fully offline examples for all of the
above live in [`examples/`](./examples) (`npm run examples`).

## Metadata-only telemetry, by construction

`pushToolCallTelemetry()` never forwards more than the documented event shape (`kind`, `toolName`,
`target`, `latencyMs`, `decision`, `findingClasses`) — the outbound request body is built by
explicitly picking those fields, not by serializing whatever object you pass in. If you pass extra
fields (accidentally or via a spread of a larger internal object), they're dropped before the
request is sent and a warning is logged naming what was dropped, rather than being forwarded.

## API

- `checkTool(toolRef): Promise<{ allow, reason, dlpPatterns }>` — pre-flight policy check. Cached 30s
  per `toolRef`. Governed by `failMode`/`toolFailModes`, `timeoutMs`, retry, the circuit breaker, and
  `onDecision` — see the sections above.
- `applyDlp(text, patterns): string` — apply DLP redaction patterns to a string.
- `checkAndRedact(toolRef, toolResult): Promise<{ allowed, reason, redacted }>` — the two above, combined.
- `wrapTool(tool, options?): GovernableTool` — returns a governed equivalent of `tool`; a denial
  returns as a normal string result, never a throw. See "Governing a tool registry" above.
- `wrapTools(tools, options?): GovernableTool[]` — `wrapTool()` over a whole collection.
- `coverageReport(registered, wrapped): { totalRegistered, totalWrapped, ungoverned }` — names
  registered-but-ungoverned tools. Pure; no network call.
- `pushTelemetry(usage): Promise<void>` — push LLM usage/cost telemetry (requires `apiKey` + `orgSlug`). Never throws.
- `pushToolCallTelemetry(token, event): Promise<void>` — push one metadata-only tool-call/A2A event to your free tail. Takes its own `mt_` token; works with zero org config. Never throws.
- `@maindala/agent-guard/adapters/mcp` → `wrapMcpTool(guard, toolName, handler)` — MCP SDK adapter.
- `@maindala/agent-guard/adapters/vercel-ai` → `wrapVercelAiTool(guard, toolName, toolDef)` — Vercel AI SDK adapter.

## Releasing

See [RELEASING.md](./RELEASING.md) — publishing runs through a GitHub Release +
trusted-publishing CI workflow with a required-reviewer approval gate, not a local
`npm publish`.

## License

MIT

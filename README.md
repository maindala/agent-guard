# @maindala/agent-guard

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

## Examples

[`examples/`](examples/) has a runnable sample for every method, plus one for the fail-open behaviour
below. They run offline against a local stub gateway — no account, no credentials, no network beyond
localhost:

```bash
npm run examples
```

`examples/04-telemetry.mjs` is worth a look even if you don't run it: it deliberately tries to smuggle
a `prompt` and a `result` field through `pushToolCallTelemetry()` via a spread, then inspects exactly
what the stub gateway received on the wire — a live demonstration of the metadata-only guarantee
below, not just a claim about it.

## Fail-open posture — read this before deploying

**`checkTool()` fails open.** If the mAIndala governance plane is unreachable, returns an error
status, or returns a response this SDK can't parse, `checkTool()` does not throw — it returns
`{ allow: true, reason: 'guard_error', dlpPatterns: [] }` and logs a warning to the console.

This is a deliberate default: a governance-plane outage should not be able to take your agent down
with it. The security implication is the direct consequence of that choice and worth stating plainly:
**while the governance plane is unreachable, every tool call your agent makes is allowed through
unchecked**, for as long as the outage lasts. There is currently no built-in option to fail closed
instead — if your deployment needs that tradeoff made the other way, that has to be handled by the
caller (e.g. treating `reason === 'guard_error'` as a signal to pause rather than proceed).
See `examples/06-fail-open.mjs` for this in action against a real unreachable endpoint.

The one case that does **not** fail open: calling `checkTool()` without `config.apiKey` throws
immediately. That's treated as a caller misconfiguration, not a governance-plane problem, so it's
surfaced rather than silently allowed.

## Metadata-only telemetry, by construction

`pushToolCallTelemetry()` never forwards more than the documented event shape (`kind`, `toolName`,
`target`, `latencyMs`, `decision`, `findingClasses`) — the outbound request body is built by
explicitly picking those fields, not by serializing whatever object you pass in. If you pass extra
fields (accidentally or via a spread of a larger internal object), they're dropped before the
request is sent and a warning is logged naming what was dropped, rather than being forwarded.

## API

- `checkTool(toolRef): Promise<{ allow, reason, dlpPatterns }>` — pre-flight policy check. Cached 30s per `toolRef`.
- `applyDlp(text, patterns): string` — apply DLP redaction patterns to a string.
- `checkAndRedact(toolRef, toolResult): Promise<{ allowed, reason, redacted }>` — the two above, combined.
- `pushTelemetry(usage): Promise<void>` — push LLM usage/cost telemetry (requires `apiKey` + `orgSlug`). Never throws.
- `pushToolCallTelemetry(token, event): Promise<void>` — push one metadata-only tool-call/A2A event to your free tail. Takes its own `mt_` token; works with zero org config. Never throws.

## License

MIT

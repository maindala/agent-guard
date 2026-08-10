// @maindala/agent-guard — Governance SDK for external agents.
// Provides policy pre-flight checks, DLP redaction, and telemetry push to the
// mAIndala governance plane. Opt-in: add to your agent's code and call the guard
// before/after tool invocations to enforce your org's governance policy locally.

export interface DlpPattern {
  name:        string;
  regex:       string;
  replacement: string;
}

export interface PolicyCheckResult {
  allow:       boolean;
  reason:      string;
  dlpPatterns: DlpPattern[];
}

export interface UsageEvent {
  provider:         string;
  model:            string;
  promptTokens?:    number;
  completionTokens?: number;
  totalTokens?:     number;
  externalAgentId?: string;
}

// Whether checkTool() allows the call through or denies it when the
// governance plane itself can't be reached (unreachable, erroring, or timed
// out) — as opposed to a real allow/deny decision returned BY the plane.
// 'closed' is the default as of 1.0.0 (a deliberate breaking change from the
// 0.2.x always-fail-open behavior — see the README's "Fail-open vs.
// fail-closed" section and CHANGELOG for the one-line migration back to 'open').
export type FailMode = 'open' | 'closed';

// One record per checkTool() outcome, passed to `onDecision` if configured.
// `decision` collapses the raw result into the bucket a compliance owner
// actually cares about; `reason` carries the finer-grained string (the
// gateway's own policy reason, or 'guard_error'/'guard_unavailable').
export type DecisionKind = 'allow' | 'deny' | 'guard_error' | 'timeout';

export interface DecisionRecord {
  toolRef:    string;
  decision:   DecisionKind;
  reason:     string;
  latencyMs:  number;
  cacheHit:   boolean;
}

export interface AgentGuardConfig {
  // mx_ Bearer key issued by your org admin in the mAIndala Governance tab.
  // Optional: only checkTool/applyDlp/checkAndRedact/pushTelemetry (the org-
  // governed methods) need it. pushToolCallTelemetry (Free Telemetry Wedge P2)
  // takes its own mt_ token per call and needs neither this nor orgSlug — that's
  // the whole point of the free, zero-setup tier.
  apiKey?:      string;
  // Your org's slug (e.g. "acme-corp") — used for the telemetry endpoint
  orgSlug?:     string;
  // mAIndala MCP gateway base URL (default: https://mcp.maindala.com)
  gatewayUrl?: string;
  // mAIndala catalog base URL (default: https://api.maindala.com)
  catalogUrl?: string;

  // What checkTool() does when the governance plane can't be reached at all
  // (network error, non-2xx status, unparseable response, or timeout).
  // Default: 'closed' (see FailMode above). Set 'open' to reproduce 0.2.x.
  failMode?: FailMode;
  // Per-toolRef override of failMode — lets e.g. 'payments:refund' stay
  // strict ('closed') while the rest of the agent runs with failMode:'open'
  // so a governance-plane outage doesn't take the whole agent down with it.
  // Checked before the instance-wide `failMode`.
  toolFailModes?: Record<string, FailMode>;

  // Abort the policy-check request after this many ms (default 5000) using a
  // real AbortController. Without this, a gateway that accepts the TCP
  // connection and never responds hangs checkTool() forever — neither
  // fail-open nor fail-closed is ever reached. A timeout is treated as a
  // guard error and routed through failMode like any other, and is NEVER
  // retried (see maxRetries below) — it has already spent its full budget.
  timeoutMs?: number;
  // Bounded retry with jitter, applied only to transport-level failures
  // (network errors, non-2xx status, bad JSON) — never to a timeout, and
  // never to a successfully-parsed decision even when that decision is
  // `allow: false`. A real policy denial must produce exactly one request.
  maxRetries?:       number; // default 2 (so up to 3 attempts total)
  retryBaseDelayMs?: number; // default 100 — first-retry jitter ceiling
  retryMaxDelayMs?:  number; // default 2000 — jitter ceiling cap

  // Circuit breaker: after this many consecutive failed checkTool() calls,
  // stop hitting the network at all for `breakerCooldownMs` and resolve
  // immediately via failMode instead — so a genuinely downed gateway doesn't
  // add timeoutMs to every single tool call. After the cooldown, exactly one
  // "probe" call is allowed through (no retries); success closes the breaker,
  // failure reopens it and restarts the cooldown.
  breakerThreshold?:   number; // default 5 consecutive failures
  breakerCooldownMs?:  number; // default 30000

  // Fires after every checkTool() outcome — allow, deny, guard_error,
  // timeout, or a cache hit — so the host app can write it to ITS OWN audit
  // system. This SDK does not persist decisions and is not itself an audit
  // log; onDecision is the integration point for one. A throwing callback is
  // caught and warned, never allowed to break the guarded call.
  onDecision?: (record: DecisionRecord) => void;
}

// ── Tunable defaults ──
// All overridable per-instance via AgentGuardConfig; chosen to be safe
// out of the box without any config at all.
const DEFAULT_TIMEOUT_MS            = 5_000;
const DEFAULT_FAIL_MODE: FailMode   = 'closed';
const DEFAULT_MAX_RETRIES           = 2;
const DEFAULT_RETRY_BASE_DELAY_MS   = 100;
const DEFAULT_RETRY_MAX_DELAY_MS    = 2_000;
const DEFAULT_BREAKER_THRESHOLD     = 5;
const DEFAULT_BREAKER_COOLDOWN_MS   = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Full-jitter exponential backoff: a random delay between 0 and
// min(maxDelayMs, baseDelayMs * 2^attempt). Full jitter (rather than a fixed
// or half-jitter delay) avoids many callers retrying in lockstep against the
// same recovering gateway.
function jitterDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.random() * cap;
}

// Free Telemetry Wedge P2: a single governed action, metadata-only. Never carries
// prompts/tool-args/results — only what tool ran, its target, latency, and the
// governance decision (if any). Mirrors the shape mcp-gateway's /telemetry/ingest
// validates server-side.
export interface ToolCallTelemetryEvent {
  kind:            'tool_call' | 'a2a_call';
  toolName:        string;
  target:          string;
  latencyMs?:      number;
  decision?:       'allow' | 'deny' | 'redact' | 'flag' | 'observed';
  findingClasses?: string[];
}

// Validation limits, mirrored from mcp-gateway's validateTelemetryIngestBody()
// — that function is the source of truth for the wire contract. Duplicated
// rather than imported because this package ships independently of the
// gateway, matching the per-package-duplication convention used elsewhere in
// this codebase. Kept byte-identical to @maindala/telemetry's copy: the two
// implement the same wire contract and must not drift.
const TELEMETRY_KINDS = ['tool_call', 'a2a_call'] as const;
const TELEMETRY_DECISIONS = ['allow', 'deny', 'redact', 'flag', 'observed'] as const;
const MAX_STRING_FIELD_LEN = 200;
const MAX_FINDING_CLASSES = 10;
const MAX_FINDING_CLASS_LEN = 50;

// Returns an error string describing the first rule the event breaks, or null
// if it's valid. Checks the VALUES of the allowed fields — the field allowlist
// in pushToolCallTelemetry only controls which keys are forwarded, so without
// this an untyped JS caller or a spread could still put arbitrary-length
// arbitrary content into `findingClasses`, `toolName`, etc. and it would reach
// the wire before the server's own allowlist rejected it.
function validateTelemetryEvent(event: ToolCallTelemetryEvent): string | null {
  if (!TELEMETRY_KINDS.includes(event.kind)) {
    return `\`kind\` must be one of: ${TELEMETRY_KINDS.join(', ')}`;
  }
  for (const field of ['toolName', 'target'] as const) {
    const value = event[field];
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_STRING_FIELD_LEN) {
      return `\`${field}\` must be a non-empty string up to ${MAX_STRING_FIELD_LEN} chars`;
    }
  }
  if (event.latencyMs !== undefined) {
    if (typeof event.latencyMs !== 'number' || !Number.isFinite(event.latencyMs) || event.latencyMs < 0) {
      return '`latencyMs` must be a non-negative finite number';
    }
  }
  if (event.decision !== undefined && !TELEMETRY_DECISIONS.includes(event.decision)) {
    return `\`decision\` must be one of: ${TELEMETRY_DECISIONS.join(', ')}`;
  }
  if (event.findingClasses !== undefined) {
    if (!Array.isArray(event.findingClasses) || event.findingClasses.length > MAX_FINDING_CLASSES) {
      return `\`findingClasses\` must be an array of at most ${MAX_FINDING_CLASSES} strings`;
    }
    for (const c of event.findingClasses) {
      if (typeof c !== 'string' || c.length === 0 || c.length > MAX_FINDING_CLASS_LEN) {
        return `\`findingClasses\` entries must be non-empty strings up to ${MAX_FINDING_CLASS_LEN} chars (class names only, never matched content)`;
      }
    }
  }
  return null;
}

// Cache of policy-check responses keyed by toolRef, with 30-second TTL.
// Avoids a round-trip to the gateway per tool call.
interface CachedCheck {
  result:    PolicyCheckResult;
  expiresAt: number;
}

// ── OAE-10: govern the tool REGISTRY, not each call site ──
// The reviewer's second architectural criticism: a wrapper you have to apply by hand at every
// call site is a security hole waiting to happen — "a forgotten wrapper bypasses it." wrapTool()/
// wrapTools() are the structural fix: wrap a tool once, at registration, and every future call
// through it is governed automatically. Framework adapters (src/adapters/) build on this same
// primitive for MCP and Vercel AI SDK tool shapes specifically.

// A minimal, framework-agnostic tool shape wrapTool()/wrapTools() operate on. Framework adapters
// translate between a framework's native tool representation and this shape (or wrap the
// framework's own execute/handler function directly — see each adapter file's own doc comment).
export interface GovernableTool<Args = unknown, Result = unknown> {
  name:    string;
  execute: (args: Args) => Result | Promise<Result>;
}

export interface WrapToolOptions {
  // Overrides the toolRef passed to checkTool() for this tool; defaults to tool.name. Use this
  // when your org's gateway policy keys tools by something other than the tool's own name (e.g.
  // a namespaced ref like "crm:update_contact" for a tool named "update_contact").
  toolRef?: string;
}

// A tool reference for coverageReport() — either the bare name, or anything with a `.name`
// (a GovernableTool, a framework's own tool object, etc.), so callers don't have to map their
// registered/wrapped collections down to strings themselves.
export type ToolRef = string | { name: string };

export interface CoverageReport {
  totalRegistered: number;
  totalWrapped:    number;
  // Names present in `registered` but absent from `wrapped` — a forgotten wrapper, made visible
  // instead of silent.
  ungoverned:      string[];
}

export class AgentGuard {
  private readonly gatewayUrl: string;
  private readonly catalogUrl: string;
  private readonly policyCache = new Map<string, CachedCheck>();

  // ── Circuit breaker state (instance-wide, not per-toolRef) ──
  // The breaker tracks the health of the gateway itself, not any one tool —
  // an outage affects every tool call, so one breaker per AgentGuard instance
  // is what actually protects against "downed gateway taxes every call".
  private breakerState: 'closed' | 'open' | 'half-open' = 'closed';
  private breakerOpenedAt = 0;
  private consecutiveFailures = 0;

  constructor(private readonly config: AgentGuardConfig) {
    this.gatewayUrl = config.gatewayUrl?.replace(/\/$/, '') ?? 'https://mcp.maindala.com';
    this.catalogUrl = config.catalogUrl?.replace(/\/$/, '') ?? 'https://api.maindala.com';
  }

  // Resolves the effective fail mode for a given tool: a per-tool override
  // wins over the instance-wide default, which itself defaults to 'closed'.
  private resolveFailMode(toolRef: string): FailMode {
    return this.config.toolFailModes?.[toolRef] ?? this.config.failMode ?? DEFAULT_FAIL_MODE;
  }

  // The result checkTool() returns when the governance plane could not be
  // reached at all, shaped by the resolved fail mode for this tool.
  private failResult(toolRef: string): PolicyCheckResult {
    return this.resolveFailMode(toolRef) === 'open'
      ? { allow: true, reason: 'guard_error', dlpPatterns: [] }
      : { allow: false, reason: 'guard_unavailable', dlpPatterns: [] };
  }

  // Invokes onDecision (if configured) for one checkTool() outcome. Never
  // lets a throwing callback escape — observability must not be able to
  // break the guarded call, same contract as the telemetry methods below.
  private emitDecision(toolRef: string, result: PolicyCheckResult, latencyMs: number, cacheHit: boolean, kind: DecisionKind): void {
    if (!this.config.onDecision) return;
    try {
      this.config.onDecision({ toolRef, decision: kind, reason: result.reason, latencyMs, cacheHit });
    } catch (err) {
      console.warn(`[agent-guard] onDecision callback threw — ignoring (${(err as Error).message})`);
    }
  }

  // Performs the actual HTTP round trip to /broker/policy-check, with a real
  // AbortController-backed timeout and bounded jittered retry.
  //
  // Retry applies ONLY to transport-level failures — network errors, non-2xx
  // status, or a response body that doesn't parse as JSON. It never applies
  // to a timeout (which has already spent its full budget — retrying would
  // multiply exactly the wait the breaker/timeout exist to bound) and never
  // to a successfully-parsed decision, even `{ allow: false }` — a real
  // policy denial must reach the caller as exactly one request (OAE-TC18).
  //
  // `allowRetries: false` is used for the circuit breaker's single half-open
  // probe, so recovery-testing never itself hammers a still-recovering gateway.
  private async performRequest(
    toolRef: string,
    allowRetries: boolean,
  ): Promise<{ ok: true; data: PolicyCheckResult } | { ok: false; timeout: boolean }> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseDelayMs = this.config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const maxDelayMs = this.config.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    const maxAttempts = allowRetries ? 1 + maxRetries : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${this.gatewayUrl}/broker/policy-check`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          body:   JSON.stringify({ toolRef }),
          signal: controller.signal,
        });

        if (res.ok) {
          // The timer MUST stay armed through this await too. fetch()
          // resolving only means response headers arrived — res.json()
          // separately reads the body, which can stall independently (a
          // server that sends `200` + headers then never finishes the
          // body). Clearing the timer as soon as fetch() resolves — as an
          // earlier version of this method did — disarms the abort exactly
          // while the body read is still outstanding, reproducing the same
          // class of hang OAE-1 fixed for the connect phase, just one layer
          // deeper (OAE-TC35). Verified (not assumed) that Node's fetch
          // surfaces this as a DOMException with name 'AbortError' — the
          // same shape as an abort during connect — so the isTimeout check
          // below classifies it correctly without a separate branch.
          const data = (await res.json()) as PolicyCheckResult;
          return { ok: true, data };
        }
        // Reachable but erroring — a real decision only ever arrives on a
        // 2xx, so this is a transport-ish failure and eligible for retry.
        if (attempt < maxAttempts - 1) {
          await sleep(jitterDelay(attempt, baseDelayMs, maxDelayMs));
          continue;
        }
        return { ok: false, timeout: false };
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === 'AbortError';
        if (isTimeout) return { ok: false, timeout: true };
        if (attempt < maxAttempts - 1) {
          await sleep(jitterDelay(attempt, baseDelayMs, maxDelayMs));
          continue;
        }
        return { ok: false, timeout: false };
      } finally {
        // Clearing here (rather than at the top of try/catch) is what keeps
        // the timer armed for the full round trip — headers AND body — on
        // every exit path: success, non-ok status, and any caught error.
        clearTimeout(timer);
      }
    }
    // Unreachable — the loop above always returns before falling through —
    // but TypeScript can't prove that, so give it a value to satisfy the
    // return type rather than an explicit non-null assertion.
    return { ok: false, timeout: false };
  }

  // Pre-flight check: ask the governance plane whether this tool call is allowed.
  // Also fetches DLP patterns so you can redact sensitive data from tool results.
  // Results are cached for 30 seconds to keep latency low.
  async checkTool(toolRef: string): Promise<PolicyCheckResult> {
    if (!this.config.apiKey) {
      throw new Error('AgentGuard.checkTool requires config.apiKey (an mx_ org gateway key) — this is a caller misconfiguration, not a governance-plane outage, so it throws rather than failing open.');
    }

    const start = Date.now();

    const cached = this.policyCache.get(toolRef);
    if (cached && cached.expiresAt > Date.now()) {
      this.emitDecision(toolRef, cached.result, Date.now() - start, true, cached.result.allow ? 'allow' : 'deny');
      return cached.result;
    }

    // ── Circuit breaker: an open breaker skips the network entirely ──
    // A genuinely downed gateway shouldn't cost every single call the full
    // timeoutMs wait. While open, resolve immediately via failMode; once the
    // cooldown has elapsed, move to half-open and let exactly one probe
    // request through below (no retries on that probe).
    //
    // KNOWN, ACCEPTED RACE: this read-then-write of breakerState is not
    // locked. If two checkTool() calls for different toolRefs are in flight
    // at the moment the cooldown elapses, both can observe 'open' with the
    // cooldown expired and both transition to 'half-open', so both go out as
    // probes instead of exactly one. Worst case is a couple of extra live
    // requests during recovery, not a correctness or safety issue (each
    // probe is still a single, non-retried request, and the breaker still
    // closes correctly once either succeeds). Not worth adding lock/mutex
    // machinery for a client-side SDK over this — documented here instead so
    // the tradeoff is explicit rather than silently relied upon.
    if (this.breakerState === 'open') {
      const cooldownMs = this.config.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
      if (Date.now() - this.breakerOpenedAt < cooldownMs) {
        const result = this.failResult(toolRef);
        console.warn(`[agent-guard] circuit breaker open for ${toolRef} — skipping network call, resolving via failMode='${this.resolveFailMode(toolRef)}'`);
        this.emitDecision(toolRef, result, Date.now() - start, false, 'guard_error');
        return result;
      }
      this.breakerState = 'half-open';
    }

    const probing = this.breakerState === 'half-open';
    const outcome = await this.performRequest(toolRef, /* allowRetries */ !probing);

    if (outcome.ok) {
      // Any successful round trip — including the half-open probe — proves
      // the gateway is healthy again.
      this.breakerState = 'closed';
      this.consecutiveFailures = 0;
      this.policyCache.set(toolRef, { result: outcome.data, expiresAt: Date.now() + 30_000 });
      this.emitDecision(toolRef, outcome.data, Date.now() - start, false, outcome.data.allow ? 'allow' : 'deny');
      return outcome.data;
    }

    // ── Failure: advance breaker state, then resolve via fail mode ──
    // A failed probe reopens immediately (no point waiting for N more
    // failures to re-confirm what the probe just proved); otherwise the
    // breaker opens once consecutiveFailures reaches the threshold.
    this.consecutiveFailures += 1;
    const threshold = this.config.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD;
    if (probing || this.consecutiveFailures >= threshold) {
      this.breakerState = 'open';
      this.breakerOpenedAt = Date.now();
    }

    const result = this.failResult(toolRef);
    console.warn(`[agent-guard] policy-check ${outcome.timeout ? 'timed out' : 'failed'} for ${toolRef} — resolving via failMode='${this.resolveFailMode(toolRef)}'`);
    this.emitDecision(toolRef, result, Date.now() - start, false, outcome.timeout ? 'timeout' : 'guard_error');
    return result;
  }

  // Apply DLP redaction patterns to a string (e.g. tool response text).
  // Call this on tool outputs when checkTool returns dlpPatterns.
  applyDlp(text: string, patterns: DlpPattern[]): string {
    if (patterns.length === 0) return text;
    let result = text;
    for (const p of patterns) {
      try {
        result = result.replace(
          new RegExp(p.regex, 'g'),
          p.replacement || `[REDACTED:${p.name.toUpperCase()}]`,
        );
      } catch {
        // skip malformed regex
      }
    }
    return result;
  }

  // Push LLM usage telemetry to the mAIndala usage ledger.
  // This normalises off-platform token consumption into the same reporting view
  // as mAIndala-hosted agents, enabling unified cost + usage dashboards.
  async pushTelemetry(usage: UsageEvent): Promise<void> {
    if (!this.config.apiKey || !this.config.orgSlug) return; // telemetry loss is acceptable, never throw
    try {
      await fetch(
        `${this.catalogUrl}/orgs/${encodeURIComponent(this.config.orgSlug)}/telemetry`,
        {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify(usage),
        },
      );
    } catch {
      // telemetry loss is acceptable — never throw from this method
    }
  }

  // Free Telemetry Wedge P2: push a single metadata-only tool-call/A2A-delegation
  // event to the free tail (`maindala tail`). Takes its OWN mt_ token per call —
  // deliberately does NOT use config.apiKey/orgSlug, so this works standalone
  // with zero org/governance setup (`new AgentGuard({})` is enough). Async
  // fire-and-forget, same never-throws contract as pushTelemetry: observability
  // must never be able to break the agent it's observing.
  async pushToolCallTelemetry(telemetryToken: string, event: ToolCallTelemetryEvent): Promise<void> {
    // Build the outbound body by explicitly picking the known fields, rather
    // than serializing `event` as-is. TypeScript's structural typing only
    // constrains callers at compile time — it does not stop a spread
    // (`{ ...internalEvent }`) or an untyped JS caller from attaching extra
    // properties, and JSON.stringify would forward whatever is actually
    // present on the object at runtime. This is what makes the metadata-only
    // guarantee true by construction on the client, rather than depending on
    // the server's own allowlist to catch what shouldn't have been sent.
    const safeEvent: ToolCallTelemetryEvent = {
      kind:     event.kind,
      toolName: event.toolName,
      target:   event.target,
      ...(event.latencyMs !== undefined ? { latencyMs: event.latencyMs } : {}),
      ...(event.decision !== undefined ? { decision: event.decision } : {}),
      ...(event.findingClasses !== undefined ? { findingClasses: event.findingClasses } : {}),
    };
    const droppedKeys = Object.keys(event).filter(
      (k) => !['kind', 'toolName', 'target', 'latencyMs', 'decision', 'findingClasses'].includes(k),
    );
    if (droppedKeys.length > 0) {
      console.warn(`[agent-guard] dropped non-metadata field(s) before sending telemetry: ${droppedKeys.join(', ')}`);
    }

    // Reject the whole event rather than salvaging the valid fields: the server
    // rejects the entire request, so anything less would leave client and server
    // disagreeing about what a valid event is. Warn and return; never throw —
    // the never-throws contract above is load-bearing for callers.
    const invalid = validateTelemetryEvent(safeEvent);
    if (invalid) {
      console.warn(`[agent-guard] telemetry event not sent — ${invalid}`);
      return;
    }

    try {
      const res = await fetch(`${this.gatewayUrl}/telemetry/ingest`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${telemetryToken}`,
        },
        body: JSON.stringify(safeEvent),
      });
      if (!res.ok) {
        console.warn(`[agent-guard] telemetry event was not accepted (HTTP ${res.status}) — it was not delivered`);
      }
    } catch {
      // telemetry loss is acceptable — never throw from this method
    }
  }

  // Convenience: run checkTool then apply DLP redaction to the tool result string
  // in one call. Returns { allowed, reason, redacted } — if not allowed, redacted is null.
  async checkAndRedact(toolRef: string, toolResult: string): Promise<{
    allowed:  boolean;
    reason:   string;
    redacted: string | null;
  }> {
    const decision = await this.checkTool(toolRef);
    if (!decision.allow) return { allowed: false, reason: decision.reason, redacted: null };
    return {
      allowed:  true,
      reason:   decision.reason,
      redacted: this.applyDlp(toolResult, decision.dlpPatterns),
    };
  }

  // OAE-10: returns a governed equivalent of `tool` — every future call to the returned
  // `execute()` runs checkTool() first and applies DLP to a string result afterward, using the
  // same semantics as checkAndRedact() above. This is what lets governance be applied once, at
  // registration, instead of hand-wrapped at every call site.
  //
  // A DENIAL RETURNS AS A NORMAL RESULT, NOT A THROWN ERROR. This mirrors the house pattern in
  // packages/agent-runtime's callExternalAgentViaBroker, which returns a descriptive bracketed
  // string (`[Delegation to "X" was blocked by ... policy: reason]`) for a blocked A2A
  // delegation rather than throwing — the model needs to SEE "this was blocked by policy" as an
  // observation it can reason about and report, not an unhandled crash that takes the whole run
  // down. A non-string `execute()` result is returned unmodified (DLP redaction only ever
  // applies to text, matching applyDlp()'s own contract) — only the type of a denial widens to
  // `Result | string`, since a denial is always a string regardless of what the tool itself
  // would have returned.
  wrapTool<Args = unknown, Result = unknown>(
    tool: GovernableTool<Args, Result>,
    options?: WrapToolOptions,
  ): GovernableTool<Args, Result | string> {
    const toolRef = options?.toolRef ?? tool.name;
    return {
      name: tool.name,
      execute: async (args: Args) => {
        const decision = await this.checkTool(toolRef);
        if (!decision.allow) {
          return `[Tool "${tool.name}" was blocked by governance policy: ${decision.reason}]`;
        }
        const result = await tool.execute(args);
        if (typeof result === 'string') return this.applyDlp(result, decision.dlpPatterns);
        return result;
      },
    };
  }

  // Convenience: wrapTool() applied to a whole collection at once — the shape a tool registry
  // usually comes in.
  wrapTools(tools: GovernableTool[], options?: WrapToolOptions): GovernableTool[] {
    return tools.map((t) => this.wrapTool(t, options));
  }

  // OAE-10: makes a forgotten wrapper VISIBLE instead of silent. Pass every tool your agent
  // registers and every tool you actually ran through wrapTool()/wrapTools() (or a framework
  // adapter) — the difference is exactly what a careless refactor, or an attacker probing for
  // the weak spot, would find ungoverned. Pure: no network call, no guard state, safe to call as
  // often as a startup self-check or a CI assertion.
  coverageReport(registered: ToolRef[], wrapped: ToolRef[]): CoverageReport {
    const nameOf = (t: ToolRef): string => (typeof t === 'string' ? t : t.name);
    const registeredNames = registered.map(nameOf);
    const wrappedNames = new Set(wrapped.map(nameOf));
    const ungoverned = registeredNames.filter((n) => !wrappedNames.has(n));
    return { totalRegistered: registeredNames.length, totalWrapped: wrappedNames.size, ungoverned };
  }
}

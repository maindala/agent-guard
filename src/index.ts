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
  // mAIndala catalog base URL. The catalog service has no stable public
  // domain of its own yet — only its Cloud Run URL — so that's the default
  // below. Pass your own value here if that ever changes, rather than
  // waiting on a package upgrade.
  catalogUrl?: string;
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

export class AgentGuard {
  private readonly gatewayUrl: string;
  private readonly catalogUrl: string;
  private readonly policyCache = new Map<string, CachedCheck>();

  constructor(private readonly config: AgentGuardConfig) {
    this.gatewayUrl = config.gatewayUrl?.replace(/\/$/, '') ?? 'https://mcp.maindala.com';
    this.catalogUrl = config.catalogUrl?.replace(/\/$/, '') ?? 'https://catalog-service-x5yekys7wq-uw.a.run.app';
  }

  // Pre-flight check: ask the governance plane whether this tool call is allowed.
  // Also fetches DLP patterns so you can redact sensitive data from tool results.
  // Results are cached for 30 seconds to keep latency low.
  async checkTool(toolRef: string): Promise<PolicyCheckResult> {
    if (!this.config.apiKey) {
      throw new Error('AgentGuard.checkTool requires config.apiKey (an mx_ org gateway key) — this is a caller misconfiguration, not a governance-plane outage, so it throws rather than failing open.');
    }
    const cached = this.policyCache.get(toolRef);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    // Fail-open on ANY governance-plane problem — an outage must not block
    // the agent from working. Before this fix, that guarantee only held for
    // the !res.ok branch below (the gateway reachable but returning an
    // error status); a genuine outage — the gateway unreachable at all, or
    // the connection dropping mid-response — threw out of fetch()/res.json()
    // uncaught instead, which is precisely the "governance plane outage"
    // case this method's own comment already claimed to handle. See the
    // README's Fail-open posture section for the security implication of
    // this default: a downed gateway means every tool call is allowed
    // through unchecked until it comes back.
    try {
      const res = await fetch(`${this.gatewayUrl}/broker/policy-check`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({ toolRef }),
      });

      if (!res.ok) {
        console.warn(`[agent-guard] policy-check failed (${res.status}) for ${toolRef} — defaulting to allow`);
        return { allow: true, reason: 'guard_error', dlpPatterns: [] };
      }

      const data = (await res.json()) as PolicyCheckResult;
      this.policyCache.set(toolRef, { result: data, expiresAt: Date.now() + 30_000 });
      return data;
    } catch (err) {
      console.warn(`[agent-guard] policy-check errored for ${toolRef} (${(err as Error).message}) — defaulting to allow`);
      return { allow: true, reason: 'guard_error', dlpPatterns: [] };
    }
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
}

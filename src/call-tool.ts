// callTool(): one governed tool call through the mAIndala gateway's /broker/call, with an optional wait for a human
// approval. The gateway answers a held call with 202 and an approval id; this client can poll for the decision and
// then send the SAME call again once, carrying that id. It never sends a call twice for any other reason.

export interface CallToolRequest {
  // The catalog slug of the MCP service, e.g. "github-mcp-server".
  serviceSlug: string;
  // The tool name on that service, e.g. "create_issue".
  tool: string;
  // The tool's arguments. Sent as-is; this package never logs or keeps them.
  arguments?: Record<string, unknown>;
  // The vault connection that holds the vendor token (the workflow page prints it). Without one the gateway sends the vendor no credential.
  connectionId?: string;
}

export interface WaitForApproval {
  // Longest total wait for a decision, in ms (default 10 minutes). The wait also ends when the approval expires.
  timeoutMs?: number;
  // Time between checks, in ms (default 5000).
  pollMs?: number;
}

export interface CallToolOptions {
  // Set this to wait for a held call to be decided and send it again once if approved. Left out, a held call is returned as 'pending_approval'.
  waitForApproval?: WaitForApproval;
  // Abort one request to the gateway after this many ms (default 60000). A call that times out may still have run: it is never sent again.
  timeoutMs?: number;
}

export type CallToolResult =
  // The tool ran. `result` is the tool's own result as the gateway returned it (after any redaction your organization configured).
  | { status: 'completed'; result: unknown; toolRef: string; approvalId?: string; connectionInjected: boolean; dlpApplied: boolean; guardrailApplied: boolean }
  // Held for a human and not decided yet (or you did not ask to wait, or the wait ran out). Nothing ran.
  | { status: 'pending_approval'; approvalId: string; expiresAt: string }
  // A person rejected it. Nothing ran.
  | { status: 'denied'; approvalId: string; decidedBy?: string; note?: string }
  // Nobody decided before it expired. Nothing ran.
  | { status: 'expired'; approvalId: string }
  // The gateway refused or could not complete the call. `reason` is the gateway's own code when it sent one. When `maybeRan` is true the call
  // may already have run (the vendor failed or the answer never arrived); it was not sent again.
  | { status: 'refused'; reason: string; message: string; httpStatus?: number; maybeRan: boolean; approvalId?: string };

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_POLL_MS = 5_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// One HTTP exchange with the whole round trip (headers and body) under one abort timer.
async function exchange(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: Record<string, unknown> | null } | { failed: 'timeout' | 'network' }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    let body: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await res.json();
      body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return { failed: 'timeout' };
      body = null;
    }
    return { status: res.status, body };
  } catch (err) {
    return { failed: err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

export class CallToolClient {
  constructor(private readonly cfg: { apiKey?: string; gatewayUrl: string }) {}

  async call(req: CallToolRequest, options: CallToolOptions = {}): Promise<CallToolResult> {
    // Caller mistakes throw; nothing reaches the network.
    if (!this.cfg.apiKey) {
      throw new Error('AgentGuard.callTool requires config.apiKey (an mx_ org gateway key).');
    }
    if (!req || typeof req.serviceSlug !== 'string' || req.serviceSlug === '' || typeof req.tool !== 'string' || req.tool === '') {
      throw new Error('AgentGuard.callTool requires serviceSlug and tool (non-empty strings).');
    }
    const wait = options.waitForApproval;
    if (wait) {
      for (const [name, v] of [['timeoutMs', wait.timeoutMs], ['pollMs', wait.pollMs]] as const) {
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
          throw new Error(`waitForApproval.${name} must be a positive number of milliseconds.`);
        }
      }
    }
    const callTimeout = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` };
    // The arguments are serialised once, so a re-send carries the exact bytes the approval was pinned to.
    const base = {
      serviceSlug: req.serviceSlug,
      tool: req.tool,
      arguments: req.arguments ?? {},
      ...(req.connectionId !== undefined ? { connectionId: req.connectionId } : {}),
    };
    const send = (approvalId?: string) =>
      exchange(`${this.cfg.gatewayUrl}/broker/call`, { method: 'POST', headers, body: JSON.stringify(approvalId ? { ...base, approvalId } : base) }, callTimeout);

    // ── First send ──
    const first = await send();
    const toolRef = `${req.serviceSlug}:${req.tool}`;
    const held = this.interpret(first, toolRef, undefined);
    if (held.status !== 'pending_approval' || !wait) return held;

    // ── Held: wait for the decision ──
    const decision = await this.waitForDecision(held.approvalId, held.expiresAt, wait);
    if (decision.status !== 'approved') return decision.result;

    // ── Approved: the one and only re-send, same arguments, with the approval id ──
    const second = await send(held.approvalId);
    // A second hold would mean the gateway did not honour the approval; it is handed back as is, never looped on.
    return this.interpret(second, toolRef, held.approvalId);
  }

  // Maps one /broker/call answer to a typed result. Never throws.
  private interpret(r: Awaited<ReturnType<typeof exchange>>, toolRef: string, approvalId: string | undefined): CallToolResult {
    const withId = approvalId !== undefined ? { approvalId } : {};
    if ('failed' in r) {
      return {
        status: 'refused', reason: r.failed === 'timeout' ? 'gateway_timeout' : 'gateway_unreachable',
        message: r.failed === 'timeout' ? 'The gateway did not answer in time. The call may have run; it was not sent again.' : 'The gateway could not be reached. The call may have run; it was not sent again.',
        maybeRan: true, ...withId,
      };
    }
    const { status, body } = r;
    if (status === 202 && body && body['status'] === 'pending_approval') {
      const id = str(body['approvalId']);
      const expiresAt = str(body['expiresAt']);
      if (id && expiresAt) return { status: 'pending_approval', approvalId: id, expiresAt };
      return { status: 'refused', reason: 'invalid_response', message: 'The gateway held the call but sent no approval id.', httpStatus: status, maybeRan: false };
    }
    if (status >= 200 && status < 300) {
      if (body && body['allowed'] === true && 'result' in body) {
        return {
          status: 'completed', result: body['result'], toolRef: str(body['toolRef']) ?? toolRef,
          connectionInjected: body['connectionInjected'] === true, dlpApplied: body['dlpApplied'] === true, guardrailApplied: body['guardrailApplied'] === true,
          ...withId,
        };
      }
      return { status: 'refused', reason: 'invalid_response', message: 'The gateway answered in a form this package does not recognise. The call may have run; it was not sent again.', httpStatus: status, maybeRan: true, ...withId };
    }
    // Any other status: a refusal, or a failure after dispatch (502 / 5xx).
    const reason = str(body?.['reason']) ?? (status === 502 ? 'upstream_failed' : status === 401 ? 'unauthorized' : `http_${status}`);
    const message = str(body?.['error']) ?? `The gateway answered ${status}.`;
    return { status: 'refused', reason, message, httpStatus: status, maybeRan: status >= 500, ...withId };
  }

  // Polls GET /broker/approvals/:id until it is decided, expires, or the wait runs out. Reads are safe to repeat, so a failed read is simply tried again.
  private async waitForDecision(
    approvalId: string, expiresAt: string, wait: WaitForApproval,
  ): Promise<{ status: 'approved' } | { status: 'done'; result: CallToolResult }> {
    const pollMs = wait.pollMs ?? DEFAULT_POLL_MS;
    const started = Date.now();
    const waitUntil = started + (wait.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    const expiry = Date.parse(expiresAt);
    const pending = (): CallToolResult => ({ status: 'pending_approval', approvalId, expiresAt });
    const done = (result: CallToolResult) => ({ status: 'done' as const, result });

    for (;;) {
      const r = await exchange(`${this.cfg.gatewayUrl}/broker/approvals/${encodeURIComponent(approvalId)}`, { method: 'GET', headers: { Authorization: `Bearer ${this.cfg.apiKey}` } }, Math.min(DEFAULT_CALL_TIMEOUT_MS, Math.max(1, waitUntil - Date.now())));
      if (!('failed' in r)) {
        if (r.status === 401 || r.status === 404) {
          return done({ status: 'refused', reason: r.status === 401 ? 'unauthorized' : 'approval_not_found', message: str(r.body?.['error']) ?? `The gateway answered ${r.status} when checking the approval.`, httpStatus: r.status, maybeRan: false, approvalId });
        }
        if (r.status === 200 && r.body) {
          const state = r.body['state'];
          if (state === 'approved') return { status: 'approved' };
          if (state === 'rejected') {
            const decidedBy = str(r.body['decidedByName']); const note = str(r.body['decisionNote']);
            return done({ status: 'denied', approvalId, ...(decidedBy ? { decidedBy } : {}), ...(note ? { note } : {}) });
          }
          if (state === 'expired') return done({ status: 'expired', approvalId });
          // Already used: by an earlier send of this call or by another caller. Sending again could run it twice.
          if (state === 'consumed') return done({ status: 'refused', reason: 'approval_consumed', message: 'This approval was already used. The call was not sent again.', maybeRan: true, approvalId });
        }
      }
      const now = Date.now();
      if (Number.isFinite(expiry) && now >= expiry) return done({ status: 'expired', approvalId });
      if (now >= waitUntil) return done(pending());
      const stop = Math.min(waitUntil, Number.isFinite(expiry) ? expiry : waitUntil);
      await sleep(Math.max(0, Math.min(pollMs, stop - now)));
    }
  }
}

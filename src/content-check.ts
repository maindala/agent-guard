// @maindala/agent-guard — content check for text bound for, or returned by, an LLM call.
// If your organization has configured a content check, the gateway applies it to the text you send and answers pass, redact or block.
// If it has not, the answer is a plain pass. This file holds the request, retry and breaker logic; AgentGuard.checkContent() delegates here.
// The text is never logged, cached or kept by this SDK.

export type ContentDirection = 'outbound' | 'inbound';
// What to do when the gateway cannot give an answer (unreachable, erroring, rate limited, timed out, unreadable reply).
// There is deliberately no default: whether an outage lets text through is the caller's decision.
export type OnUnavailable = 'block' | 'allow';

export interface ContentCheckOptions {
  // 'outbound' = text you are about to send; 'inbound' = text you received.
  direction:     ContentDirection;
  onUnavailable: OnUnavailable;
}

export interface ContentCheckResult {
  action:       'pass' | 'redact' | 'block';
  // The text to use. The input on 'pass'; the redacted text on 'redact'; always '' on 'block' (nothing is to be used).
  text:         string;
  reason?:      string;
  // True when the gateway could not answer and `onUnavailable` decided the outcome.
  unavailable?: boolean;
}

export interface ContentCheckClientConfig {
  apiKey?:             string;
  gatewayUrl:          string;
  // Same retry and breaker settings as checkTool(); the breaker state is kept separately so a problem with this route never
  // changes how tool checks behave.
  maxRetries?:         number;
  retryBaseDelayMs?:   number;
  retryMaxDelayMs?:    number;
  breakerThreshold?:   number;
  breakerCooldownMs?:  number;
  // Wait for the answer. Text can take longer to check than a tool name, so this is separate from `timeoutMs` (default 20000).
  contentTimeoutMs?:   number;
  timeoutMs?:          number;
}

const DEFAULT_CONTENT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 100;
const DEFAULT_RETRY_MAX_DELAY_MS = 2_000;
const DEFAULT_BREAKER_THRESHOLD = 5;
const DEFAULT_BREAKER_COOLDOWN_MS = 30_000;
const UNAVAILABLE = 'content_check_unavailable';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const jitter = (attempt: number, base: number, max: number): number => Math.random() * Math.min(max, base * 2 ** attempt);

type Answer = { action: 'pass' | 'redact' | 'block'; text?: string; reason?: string };

// Reads the gateway's reply; anything that is not a well-formed answer counts as "could not answer".
function parseAnswer(data: unknown): Answer | null {
  const d = data as { action?: unknown; text?: unknown; reason?: unknown } | null;
  if (!d || typeof d !== 'object') return null;
  if (d.action !== 'pass' && d.action !== 'redact' && d.action !== 'block') return null;
  if (d.action === 'redact' && typeof d.text !== 'string') return null;
  return {
    action: d.action,
    ...(typeof d.text === 'string' ? { text: d.text } : {}),
    ...(typeof d.reason === 'string' ? { reason: d.reason } : {}),
  };
}

export class ContentCheckClient {
  private breakerState: 'closed' | 'open' | 'half-open' = 'closed';
  private breakerOpenedAt = 0;
  private consecutiveFailures = 0;

  constructor(private readonly config: ContentCheckClientConfig) {}

  // The result when no answer could be had, shaped by the caller's onUnavailable choice.
  private unavailableResult(text: string, onUnavailable: OnUnavailable): ContentCheckResult {
    return onUnavailable === 'allow'
      ? { action: 'pass', text, reason: UNAVAILABLE, unavailable: true }
      : { action: 'block', text: '', reason: UNAVAILABLE, unavailable: true };
  }

  // One round trip with a real timeout and bounded jittered retry on transport failures; a timeout is never retried.
  private async request(text: string, direction: ContentDirection, allowRetries: boolean): Promise<{ ok: true; answer: Answer } | { ok: false }> {
    const timeoutMs = this.config.contentTimeoutMs ?? Math.max(this.config.timeoutMs ?? 0, DEFAULT_CONTENT_TIMEOUT_MS);
    const maxAttempts = allowRetries ? 1 + (this.config.maxRetries ?? DEFAULT_MAX_RETRIES) : 1;
    const base = this.config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const max = this.config.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${this.config.gatewayUrl}/broker/content-check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.config.apiKey}` },
          body: JSON.stringify({ direction, text }),
          signal: controller.signal,
        });
        if (res.ok) {
          // The timer stays armed while the body is read, as in checkTool().
          const answer = parseAnswer(await res.json().catch(() => null));
          if (answer) return { ok: true, answer };
        }
        if (attempt < maxAttempts - 1) { await sleep(jitter(attempt, base, max)); continue; }
        return { ok: false };
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return { ok: false };
        if (attempt < maxAttempts - 1) { await sleep(jitter(attempt, base, max)); continue; }
        return { ok: false };
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false };
  }

  async check(text: string, options: ContentCheckOptions): Promise<ContentCheckResult> {
    // ── Caller mistakes throw: they are not an outage ──
    if (!this.config.apiKey) {
      throw new Error('AgentGuard.checkContent requires config.apiKey (an mx_ org gateway key) — this is a caller misconfiguration, not an outage, so it throws.');
    }
    if (typeof text !== 'string') throw new TypeError('AgentGuard.checkContent: `text` must be a string.');
    const { direction, onUnavailable } = (options ?? {}) as Partial<ContentCheckOptions>;
    if (direction !== 'outbound' && direction !== 'inbound') {
      throw new TypeError("AgentGuard.checkContent: `direction` must be 'outbound' or 'inbound'.");
    }
    if (onUnavailable !== 'block' && onUnavailable !== 'allow') {
      throw new TypeError("AgentGuard.checkContent: `onUnavailable` is required and must be 'block' or 'allow'. There is no default: choose what happens to the text when the check cannot be reached.");
    }

    // ── Breaker: an open breaker skips the network until the cooldown has passed ──
    if (this.breakerState === 'open') {
      if (Date.now() - this.breakerOpenedAt < (this.config.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS)) {
        console.warn(`[agent-guard] content check breaker open (${direction}) — skipping network call, onUnavailable='${onUnavailable}'`);
        return this.unavailableResult(text, onUnavailable);
      }
      this.breakerState = 'half-open';
    }
    const probing = this.breakerState === 'half-open';
    const outcome = await this.request(text, direction, !probing);

    if (outcome.ok) {
      this.breakerState = 'closed';
      this.consecutiveFailures = 0;
      const a = outcome.answer;
      if (a.action === 'block') return { action: 'block', text: '', ...(a.reason ? { reason: a.reason } : {}) };
      if (a.action === 'redact') return { action: 'redact', text: a.text as string, ...(a.reason ? { reason: a.reason } : {}) };
      return { action: 'pass', text, ...(a.reason ? { reason: a.reason } : {}) };
    }

    this.consecutiveFailures += 1;
    if (probing || this.consecutiveFailures >= (this.config.breakerThreshold ?? DEFAULT_BREAKER_THRESHOLD)) {
      this.breakerState = 'open';
      this.breakerOpenedAt = Date.now();
    }
    console.warn(`[agent-guard] content check could not be completed (${direction}) — onUnavailable='${onUnavailable}'`);
    return this.unavailableResult(text, onUnavailable);
  }
}

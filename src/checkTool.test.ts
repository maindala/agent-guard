// Vitest suite for checkTool()'s fail-mode/timeout/retry/circuit-breaker/
// onDecision behavior (OAE-1, OAE-7, OAE-8, OAE-9). Runs against real local
// HTTP servers (node:http, via ./stub-http-server.ts) rather than a mocked
// fetch — the bug this whole phase started from (a genuinely hung socket)
// only shows up against a real connection, not a stub that resolves/rejects
// synchronously.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentGuard, type DecisionRecord } from './index.js';
import { startHangingServer, startAllowServer, startStalledBodyServer, startStubServer, type StubServer } from './stub-http-server.js';

// Servers created per-test are tracked here and closed in afterEach so a
// failing assertion never leaks a listening port into later tests.
let servers: StubServer[] = [];
async function withServer(s: Promise<StubServer>): Promise<StubServer> {
  const started = await s;
  servers.push(started);
  return started;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => { /* silence expected warnings */ });
});
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  vi.restoreAllMocks();
});

// A port nothing is listening on (ECONNREFUSED, fails fast) — the shape of a
// genuinely dead/down gateway, distinct from a hung one.
async function deadPort(): Promise<number> {
  const s = await startStubServer(() => {});
  const url = new URL(s.url);
  await s.close();
  return Number(url.port);
}

describe('OAE-TC02/TC03 — timeout resolves through the fail mode, happy path unaffected', () => {
  it('TC02: a hung gateway resolves via failMode (not a hang) within ~timeoutMs', async () => {
    const server = await withServer(startHangingServer());
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: server.url, timeoutMs: 300, failMode: 'open' });

    const start = Date.now();
    const result = await guard.checkTool('some:tool');
    const elapsed = Date.now() - start;

    // NOTE ON A DOC DISCREPANCY (flagged in the build report): the QA case's
    // literal text says "default config" should yield `{allow:true,
    // reason:'guard_error'}` on timeout — that was written before Gate 1's
    // decision (§6 of the design doc) to flip the default failMode to
    // 'closed' in the SAME 1.0.0 release this suite ships with. Both are
    // exercised explicitly here rather than silently picking one.
    expect(result).toEqual({ allow: true, reason: 'guard_error', dlpPatterns: [] });
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1200); // proves no retry multiplication of the timeout wait
    // Exactly one request reached the server — a timeout is never retried.
    expect(server.requestCount()).toBe(1);
  });

  it('TC02b: with the real 1.0.0 default (failMode unset), the same hang denies instead', async () => {
    const server = await withServer(startHangingServer());
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: server.url, timeoutMs: 300 });

    const result = await guard.checkTool('some:tool');
    expect(result).toEqual({ allow: false, reason: 'guard_unavailable', dlpPatterns: [] });
  });

  it('TC03: a normally-responding gateway is unaffected by the timeout machinery', async () => {
    const server = await withServer(startAllowServer());
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: server.url, timeoutMs: 5000 });

    const start = Date.now();
    const result = await guard.checkTool('some:tool');
    const elapsed = Date.now() - start;

    expect(result).toEqual({ allow: true, reason: 'org_policy_allow', dlpPatterns: [] });
    expect(elapsed).toBeLessThan(200); // no added latency from the timeout/retry/breaker plumbing
  });
});

describe('OAE-TC35 — a stalled response body cannot hang checkTool() (watch-it-fail)', () => {
  it('a server that sends 200 + headers then never finishes the body still resolves via failMode within ~timeoutMs', async () => {
    // Distinct from TC01/TC02's fully-hung server: headers arrive (fetch()
    // resolves) but the body read (res.json()) stalls forever. This is the
    // narrower hang a QA reviewer found post-merge: clearTimeout(timer) had
    // been firing right after fetch() resolved, disarming the abort before
    // the body read completed.
    const server = await withServer(startStalledBodyServer());
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: server.url, timeoutMs: 300, maxRetries: 0, failMode: 'closed' });

    const start = Date.now();
    const result = await guard.checkTool('some:tool');
    const elapsed = Date.now() - start;

    expect(result).toEqual({ allow: false, reason: 'guard_unavailable', dlpPatterns: [] });
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(1200); // bounded by timeoutMs, not the stalled-body wait
    expect(server.requestCount()).toBe(1); // a body-read timeout is not retried, same as a connect-phase timeout
  });
});

describe('OAE-TC14 — the breaking default is real, and the migration works', () => {
  it('(a) with no failMode set on 1.0.0, a dead gateway denies — the default genuinely flipped', async () => {
    const port = await deadPort();
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: `http://127.0.0.1:${port}`, maxRetries: 0 });
    const result = await guard.checkTool('some:tool');
    expect(result).toEqual({ allow: false, reason: 'guard_unavailable', dlpPatterns: [] });
  });

  it('(b) failMode:"open" reproduces the exact 0.2.x shape — the documented one-line migration', async () => {
    const port = await deadPort();
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: `http://127.0.0.1:${port}`, failMode: 'open', maxRetries: 0 });
    const result = await guard.checkTool('some:tool');
    // Byte-identical to the pre-fix 0.2.5 return value for any unreachable
    // gateway: { allow: true, reason: 'guard_error', dlpPatterns: [] }.
    expect(result).toEqual({ allow: true, reason: 'guard_error', dlpPatterns: [] });
  });
});

describe('OAE-TC15 — fail-closed denies on an unreachable plane, without throwing', () => {
  it('denies with guard_unavailable and logs a warning, does not throw', async () => {
    const port = await deadPort();
    const warnSpy = vi.spyOn(console, 'warn');
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: `http://127.0.0.1:${port}`, failMode: 'closed', maxRetries: 0 });

    await expect(guard.checkTool('some:tool')).resolves.toEqual({ allow: false, reason: 'guard_unavailable', dlpPatterns: [] });
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('OAE-TC16 — per-tool override wins over the instance-wide fail mode', () => {
  it('one overridden tool denies while the rest of the agent stays available', async () => {
    const port = await deadPort();
    const guard = new AgentGuard({
      apiKey:         'mx_fake',
      gatewayUrl:     `http://127.0.0.1:${port}`,
      failMode:       'open',
      toolFailModes:  { 'payments:refund': 'closed' },
      maxRetries:     0,
    });

    const strict = await guard.checkTool('payments:refund');
    const lenient = await guard.checkTool('read:catalog');

    expect(strict).toEqual({ allow: false, reason: 'guard_unavailable', dlpPatterns: [] });
    expect(lenient).toEqual({ allow: true, reason: 'guard_error', dlpPatterns: [] });
  });
});

describe('OAE-TC17 — circuit breaker opens (no timeout paid) and recovers after cooldown', () => {
  it('opens after N consecutive failures, skips the network while open, and half-opens after cooldown', async () => {
    // A single server whose behavior is switchable mid-test, so the SAME
    // instance can be proven both "hung" (pre-open) and "healthy" (recovery
    // probe) without a port-reuse race between two separate listeners.
    let mode: 'hang' | 'allow' = 'hang';
    const server = await withServer(startStubServer((_req, res) => {
      if (mode === 'hang') return; // never respond
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allow: true, reason: 'org_policy_allow', dlpPatterns: [] }));
    }));

    const guard = new AgentGuard({
      apiKey:             'mx_fake',
      gatewayUrl:         server.url,
      timeoutMs:          400,
      maxRetries:         0,     // isolate breaker behavior from retry timing
      breakerThreshold:   2,
      breakerCooldownMs:  300,
    });

    // Two consecutive timeouts — real per-call latency, not a guess.
    const t1 = Date.now();
    await guard.checkTool('flaky-tool');
    const latency1 = Date.now() - t1;

    const t2 = Date.now();
    await guard.checkTool('flaky-tool');
    const latency2 = Date.now() - t2;

    expect(latency1).toBeGreaterThanOrEqual(380);
    expect(latency2).toBeGreaterThanOrEqual(380);
    expect(server.requestCount()).toBe(2);

    // Breaker should now be open — a third call must NOT touch the network
    // at all and must resolve near-instantly.
    const t3 = Date.now();
    const openResult = await guard.checkTool('flaky-tool');
    const latency3 = Date.now() - t3;

    expect(openResult).toEqual({ allow: false, reason: 'guard_unavailable', dlpPatterns: [] });
    expect(latency3).toBeLessThan(50); // measured, not assumed — this is the actual "no timeout paid" proof
    expect(server.requestCount()).toBe(2); // unchanged — the network was never touched

    // Wait out the cooldown, bring the gateway back healthy, and confirm the
    // half-open probe succeeds and normal operation resumes.
    await new Promise((r) => setTimeout(r, 350));
    mode = 'allow';

    const t4 = Date.now();
    const recovered = await guard.checkTool('flaky-tool-2'); // distinct toolRef so this is a live call, not a cache hit
    const latency4 = Date.now() - t4;

    expect(recovered).toEqual({ allow: true, reason: 'org_policy_allow', dlpPatterns: [] });
    expect(latency4).toBeLessThan(100); // real network round trip against a now-responsive server, no timeout wait
  });
});

describe('OAE-TC18 — retry never multiplies a valid decision', () => {
  it('a legitimate allow:false produces exactly one request even with retries enabled', async () => {
    const server = await withServer(startStubServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allow: false, reason: 'org_policy_deny', dlpPatterns: [] }));
    }));
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: server.url, maxRetries: 2 });

    const result = await guard.checkTool('blocked:tool');
    expect(result).toEqual({ allow: false, reason: 'org_policy_deny', dlpPatterns: [] });
    expect(server.requestCount()).toBe(1);
  });

  it('a transient (non-2xx) failure IS retried and can succeed on a later attempt', async () => {
    const server = await withServer(startStubServer((_req, res, index) => {
      if (index < 2) { res.writeHead(500); res.end('boom'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allow: true, reason: 'org_policy_allow', dlpPatterns: [] }));
    }));
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: server.url, maxRetries: 2, retryBaseDelayMs: 10, retryMaxDelayMs: 50 });

    const result = await guard.checkTool('flaky:tool');
    expect(result).toEqual({ allow: true, reason: 'org_policy_allow', dlpPatterns: [] });
    expect(server.requestCount()).toBe(3); // 2 failures + 1 success, proving retry genuinely happened
  });
});

describe('OAE-TC19/TC20 — onDecision fires for every outcome, and a throwing handler cannot break the call', () => {
  it('TC19: allow, deny, guard_error, timeout, and a cache hit each produce one correctly-shaped record', async () => {
    const records: DecisionRecord[] = [];
    const onDecision = (r: DecisionRecord) => records.push(r);

    const allowServer = await withServer(startAllowServer());
    const denyServer = await withServer(startStubServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allow: false, reason: 'org_policy_deny', dlpPatterns: [] }));
    }));
    const deadGuardPort = await deadPort();
    const hangServer = await withServer(startHangingServer());

    const allowGuard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: allowServer.url, onDecision });
    await allowGuard.checkTool('t-allow');       // live allow
    await allowGuard.checkTool('t-allow');       // cache hit (same instance + toolRef)

    const denyGuard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: denyServer.url, onDecision });
    await denyGuard.checkTool('t-deny');

    const errorGuard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: `http://127.0.0.1:${deadGuardPort}`, failMode: 'open', maxRetries: 0, onDecision });
    await errorGuard.checkTool('t-error');

    const timeoutGuard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: hangServer.url, timeoutMs: 200, failMode: 'open', onDecision });
    await timeoutGuard.checkTool('t-timeout');

    expect(records).toHaveLength(5);
    const [live, cacheHit, deny, guardError, timeout] = records;

    expect(live).toMatchObject({ toolRef: 't-allow', decision: 'allow', cacheHit: false });
    expect(cacheHit).toMatchObject({ toolRef: 't-allow', decision: 'allow', cacheHit: true });
    expect(deny).toMatchObject({ toolRef: 't-deny', decision: 'deny', reason: 'org_policy_deny', cacheHit: false });
    expect(guardError).toMatchObject({ toolRef: 't-error', decision: 'guard_error', reason: 'guard_error', cacheHit: false });
    expect(timeout).toMatchObject({ toolRef: 't-timeout', decision: 'timeout', reason: 'guard_error', cacheHit: false });
    for (const r of records) expect(typeof r.latencyMs).toBe('number');
  });

  it('TC20 (watch-it-fail): a throwing onDecision callback never breaks the guarded call', async () => {
    const server = await withServer(startAllowServer());
    const guard = new AgentGuard({
      apiKey:     'mx_fake',
      gatewayUrl: server.url,
      onDecision: () => { throw new Error('host audit sink is down'); },
    });

    await expect(guard.checkTool('some:tool')).resolves.toEqual({ allow: true, reason: 'org_policy_allow', dlpPatterns: [] });
  });
});

describe('checkTool still throws on caller misconfiguration (unchanged from 0.2.x)', () => {
  it('throws synchronously-awaited when apiKey is missing, before any network call', async () => {
    const guard = new AgentGuard({});
    await expect(guard.checkTool('some:tool')).rejects.toThrow(/requires config\.apiKey/);
  });
});

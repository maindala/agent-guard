// Vitest suite for checkContent(): the required onUnavailable choice, every kind of outage following it, text always usable,
// the text never logged, and the separate breaker. Runs against real local HTTP servers (./stub-http-server.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentGuard } from './index.js';
import { startHangingServer, startStubServer, type StubServer } from './stub-http-server.js';

let servers: StubServer[] = [];
async function withServer(s: Promise<StubServer>): Promise<StubServer> {
  const started = await s;
  servers.push(started);
  return started;
}
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* expected */ }); });
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  vi.restoreAllMocks();
});

const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const FAST = { retryBaseDelayMs: 1, retryMaxDelayMs: 2 };
const TEXT = 'a prompt with the marker QUOKKA-5521 inside';

describe('required onUnavailable', () => {
  it('throws when missing or invalid, and nothing reaches the network', async () => {
    const server = await withServer(startStubServer((_q, res) => json(res, 200, { action: 'pass', configured: true })));
    const guard = new AgentGuard({ apiKey: 'mx_k', gatewayUrl: server.url });
    await expect(guard.checkContent(TEXT, { direction: 'outbound' } as never)).rejects.toThrow(/onUnavailable/);
    await expect(guard.checkContent(TEXT, { direction: 'outbound', onUnavailable: 'maybe' } as never)).rejects.toThrow(/onUnavailable/);
    await expect(guard.checkContent(TEXT, undefined as never)).rejects.toThrow();
    await expect(guard.checkContent(TEXT, { direction: 'sideways', onUnavailable: 'block' } as never)).rejects.toThrow(/direction/);
    expect(server.requestCount()).toBe(0);
  });

  it('throws without an apiKey (a misconfiguration, not an outage)', async () => {
    await expect(new AgentGuard({}).checkContent(TEXT, { direction: 'outbound', onUnavailable: 'allow' })).rejects.toThrow(/apiKey/);
  });
});

describe('answers', () => {
  it('pass: the input text comes back, the request carries direction, text and the key', async () => {
    let auth = '';
    const server = await withServer(startStubServer((req, res) => { auth = String(req.headers['authorization']); json(res, 200, { action: 'pass', configured: true }); }));
    const r = await new AgentGuard({ apiKey: 'mx_k', gatewayUrl: server.url }).checkContent(TEXT, { direction: 'inbound', onUnavailable: 'block' });
    expect(r).toEqual({ action: 'pass', text: TEXT });
    expect(auth).toBe('Bearer mx_k');
    expect(JSON.parse(server.bodies()[0]!)).toEqual({ direction: 'inbound', text: TEXT });
  });

  it('redact: the redacted text is the text to use', async () => {
    const server = await withServer(startStubServer((_q, res) => json(res, 200, { action: 'redact', configured: true, text: 'a prompt with [REDACTED:X]' })));
    const r = await new AgentGuard({ apiKey: 'mx_k', gatewayUrl: server.url }).checkContent(TEXT, { direction: 'outbound', onUnavailable: 'block' });
    expect(r).toEqual({ action: 'redact', text: 'a prompt with [REDACTED:X]' });
  });

  it('block: carries the reason and no text to misuse', async () => {
    const server = await withServer(startStubServer((_q, res) => json(res, 200, { action: 'block', configured: true, reason: 'content_check:EMAIL' })));
    const r = await new AgentGuard({ apiKey: 'mx_k', gatewayUrl: server.url }).checkContent(TEXT, { direction: 'outbound', onUnavailable: 'allow' });
    expect(r).toEqual({ action: 'block', text: '', reason: 'content_check:EMAIL' });
  });

  it('not configured is a plain pass', async () => {
    const server = await withServer(startStubServer((_q, res) => json(res, 200, { action: 'pass', configured: false })));
    const r = await new AgentGuard({ apiKey: 'mx_k', gatewayUrl: server.url }).checkContent(TEXT, { direction: 'outbound', onUnavailable: 'block' });
    expect(r).toEqual({ action: 'pass', text: TEXT });
  });
});

describe('an outage follows onUnavailable', () => {
  const cases: [string, (res: import('node:http').ServerResponse) => void][] = [
    ['HTTP 500', (res) => json(res, 500, { error: 'boom' })],
    ['HTTP 429', (res) => json(res, 429, { error: 'slow down' })],
    ['HTTP 404 (a gateway without the route)', (res) => json(res, 404, { error: 'nope' })],
    ['HTTP 401', (res) => json(res, 401, { error: 'bad key' })],
    ['an unreadable body', (res) => json(res, 200, 'not json {{')],
    ['an unknown action', (res) => json(res, 200, { action: 'maybe' })],
    ['redact without text', (res) => json(res, 200, { action: 'redact' })],
  ];
  it.each(cases)('%s: block -> blocked, allow -> the input text passes; text is always a string', async (_n, respond) => {
    const server = await withServer(startStubServer((_q, res) => respond(res)));
    const guard = new AgentGuard({ apiKey: 'mx_k', gatewayUrl: server.url, ...FAST });
    const blocked = await guard.checkContent(TEXT, { direction: 'outbound', onUnavailable: 'block' });
    expect(blocked).toEqual({ action: 'block', text: '', reason: 'content_check_unavailable', unavailable: true });
    const allowed = await guard.checkContent(TEXT, { direction: 'outbound', onUnavailable: 'allow' });
    expect(allowed).toEqual({ action: 'pass', text: TEXT, reason: 'content_check_unavailable', unavailable: true });
    expect(typeof blocked.text).toBe('string');
    expect(typeof allowed.text).toBe('string');
  });

  it('a transport failure is retried, a later success is used', async () => {
    const server = await withServer(startStubServer((_q, res, i) => (i === 0 ? json(res, 500, {}) : json(res, 200, { action: 'pass', configured: true }))));
    const r = await new AgentGuard({ apiKey: 'mx_k', gatewayUrl: server.url, ...FAST }).checkContent(TEXT, { direction: 'outbound', onUnavailable: 'block' });
    expect(r.action).toBe('pass');
    expect(server.requestCount()).toBe(2);
  });

  it('a hung gateway resolves at the content timeout and is never retried', async () => {
    const server = await withServer(startHangingServer());
    const guard = new AgentGuard({ apiKey: 'mx_k', gatewayUrl: server.url, contentTimeoutMs: 250, ...FAST });
    const start = Date.now();
    const r = await guard.checkContent(TEXT, { direction: 'outbound', onUnavailable: 'block' });
    expect(r.unavailable).toBe(true);
    expect(Date.now() - start).toBeLessThan(1200);
    expect(server.requestCount()).toBe(1);
  });

  it('a reply that stalls after its headers also resolves at the content timeout and is never retried', async () => {
    const server = await withServer(startStubServer((_q, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"action":'); }));
    const guard = new AgentGuard({ apiKey: 'mx_k', gatewayUrl: server.url, contentTimeoutMs: 250, ...FAST });
    const r = await guard.checkContent(TEXT, { direction: 'outbound', onUnavailable: 'block' });
    expect(r.unavailable).toBe(true);
    expect(server.requestCount()).toBe(1);
  });

  it('nothing is reachable at all (connection refused)', async () => {
    const s = await startStubServer(() => {});
    const url = s.url;
    await s.close();
    const r = await new AgentGuard({ apiKey: 'mx_k', gatewayUrl: url, ...FAST }).checkContent(TEXT, { direction: 'outbound', onUnavailable: 'allow' });
    expect(r).toMatchObject({ action: 'pass', unavailable: true });
  });
});

describe('the text is never logged', () => {
  it('the marker appears in no console output across answers and outages', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => { /* captured */ }));
    const ok = await withServer(startStubServer((_q, res) => json(res, 200, { action: 'redact', configured: true, text: 'x' })));
    const bad = await withServer(startStubServer((_q, res) => json(res, 500, {})));
    await new AgentGuard({ apiKey: 'mx_k', gatewayUrl: ok.url }).checkContent(TEXT, { direction: 'outbound', onUnavailable: 'block' });
    await new AgentGuard({ apiKey: 'mx_k', gatewayUrl: bad.url, ...FAST }).checkContent(TEXT, { direction: 'outbound', onUnavailable: 'block' });
    expect(JSON.stringify(spies.flatMap((s) => s.mock.calls))).not.toContain('QUOKKA-5521');
    expect(warn).toBeDefined();
  });
});

describe('the breaker', () => {
  it('opens after consecutive failures, skips the network, and is separate from checkTool()', async () => {
    const server = await withServer(startStubServer((req, res) => {
      if (req.url === '/broker/policy-check') json(res, 200, { allow: true, reason: 'allowed', dlpPatterns: [] });
      else json(res, 500, {});
    }));
    const guard = new AgentGuard({ apiKey: 'mx_k', gatewayUrl: server.url, maxRetries: 0, breakerThreshold: 3, breakerCooldownMs: 60_000 });
    for (let i = 0; i < 3; i++) await guard.checkContent(TEXT, { direction: 'outbound', onUnavailable: 'block' });
    expect(server.requestCount()).toBe(3);
    const skipped = await guard.checkContent(TEXT, { direction: 'outbound', onUnavailable: 'block' });
    expect(skipped.unavailable).toBe(true);
    expect(server.requestCount()).toBe(3); // no new request while open
    // Tool checks are unaffected by the content-check breaker.
    expect((await guard.checkTool('svc:tool')).allow).toBe(true);
    expect(server.requestCount()).toBe(4);
  });
});

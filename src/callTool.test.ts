// Vitest suite for callTool(): a typed result for every gateway answer, exactly one re-send after an approval and never any other,
// no retry after a dispatched call may have run, and the arguments never logged. Runs against real local HTTP servers.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgentGuard } from './index.js';
import { startStubServer, type StubServer } from './stub-http-server.js';

let servers: StubServer[] = [];
async function withServer(s: Promise<StubServer>): Promise<StubServer> {
  const started = await s;
  servers.push(started);
  return started;
}
let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* captured */ });
  log = vi.spyOn(console, 'log').mockImplementation(() => { /* captured */ });
  error = vi.spyOn(console, 'error').mockImplementation(() => { /* captured */ });
});
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
  vi.restoreAllMocks();
});

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};
const REQ = { serviceSlug: 'github-mcp-server', tool: 'create_issue', arguments: { title: 'SECRET-TITLE-7781', n: 2 }, connectionId: 'c-1' };
const FUTURE = () => new Date(Date.now() + 60_000).toISOString();
const OK = { result: { content: [{ type: 'text', text: 'done' }] }, allowed: true, toolRef: 'github-mcp-server:create_issue', connectionInjected: true, dlpApplied: false, guardrailApplied: false };
const WAIT = { pollMs: 5, timeoutMs: 2_000 };

// A gateway whose i-th /broker/call answer is calls[i] (the last repeats) and whose approval reads come from `states` in order (the last repeats).
async function start(calls: Array<(res: ServerResponse) => void>, states: Array<{ status?: number; body: unknown }> = []) {
  let gets = 0;
  let posts = 0;
  const server = await withServer(startStubServer((req, res) => {
    if (req.method === 'GET') {
      const s = states[Math.min(gets, states.length - 1)] ?? { body: { state: 'pending' } };
      gets += 1;
      return json(res, s.status ?? 200, s.body);
    }
    const answer = calls[Math.min(posts, calls.length - 1)]!;
    posts += 1;
    return answer(res);
  }));
  const bodiesOfPosts = () => server.bodies().filter((b) => b !== '').map((b) => JSON.parse(b) as Record<string, unknown>);
  return { server, posts: () => posts, gets: () => gets, sent: bodiesOfPosts };
}
const held = (id = 'ap-1', expiresAt = FUTURE()) => (res: ServerResponse) => json(res, 202, { status: 'pending_approval', approvalId: id, toolRef: 'github-mcp-server:create_issue', expiresAt, reason: 'approval_required' });
const allowed = (res: ServerResponse) => json(res, 200, OK);
const guardFor = (url: string) => new AgentGuard({ apiKey: 'mx_key', gatewayUrl: url });

describe('inputs', () => {
  it('throws on a missing key or bad request, and nothing reaches the network', async () => {
    const g = await start([allowed]);
    await expect(new AgentGuard({ gatewayUrl: g.server.url }).callTool(REQ)).rejects.toThrow(/apiKey/);
    await expect(guardFor(g.server.url).callTool({ ...REQ, tool: '' })).rejects.toThrow(/serviceSlug and tool/);
    await expect(guardFor(g.server.url).callTool({ ...REQ, serviceSlug: '' })).rejects.toThrow(/serviceSlug and tool/);
    await expect(guardFor(g.server.url).callTool(REQ, { waitForApproval: { pollMs: 0 } })).rejects.toThrow(/pollMs/);
    await expect(guardFor(g.server.url).callTool(REQ, { waitForApproval: { timeoutMs: -1 } })).rejects.toThrow(/timeoutMs/);
    expect(g.posts()).toBe(0);
  });
});

describe('an allowed call', () => {
  it('returns the result after one POST carrying the key, the call and the connection', async () => {
    const g = await start([allowed]);
    const r = await guardFor(g.server.url).callTool(REQ);
    expect(r).toEqual({ status: 'completed', result: OK.result, toolRef: 'github-mcp-server:create_issue', connectionInjected: true, dlpApplied: false, guardrailApplied: false });
    expect(g.posts()).toBe(1);
    expect(g.sent()[0]).toEqual({ serviceSlug: REQ.serviceSlug, tool: REQ.tool, arguments: REQ.arguments, connectionId: 'c-1' });
  });

  it('sends the key as a Bearer header and omits connectionId and approvalId when not given', async () => {
    let auth = '';
    const g = await withServer(startStubServer((req, res) => { auth = String(req.headers['authorization']); allowed(res); }));
    await guardFor(g.url).callTool({ serviceSlug: 's', tool: 't' });
    expect(auth).toBe('Bearer mx_key');
    expect(JSON.parse(g.bodies()[0]!)).toEqual({ serviceSlug: 's', tool: 't', arguments: {} });
  });
});

describe('a held call', () => {
  it('without waitForApproval: returns pending_approval and reads nothing', async () => {
    const expiresAt = FUTURE();
    const g = await start([held('ap-9', expiresAt)]);
    const r = await guardFor(g.server.url).callTool(REQ);
    expect(r).toEqual({ status: 'pending_approval', approvalId: 'ap-9', expiresAt });
    expect(g.posts()).toBe(1);
    expect(g.gets()).toBe(0);
  });

  it('approved: sends the same arguments again exactly once, with the approval id', async () => {
    const g = await start([held('ap-1'), allowed], [{ body: { state: 'pending' } }, { body: { state: 'pending' } }, { body: { state: 'approved' } }]);
    const r = await guardFor(g.server.url).callTool(REQ, { waitForApproval: WAIT });
    expect(r).toMatchObject({ status: 'completed', result: OK.result, approvalId: 'ap-1' });
    expect(g.posts()).toBe(2);
    expect(g.gets()).toBe(3);
    const [a, b] = g.sent();
    expect(b).toEqual({ ...a, approvalId: 'ap-1' });
    expect(a).not.toHaveProperty('approvalId');
    expect(JSON.stringify(a!['arguments'])).toBe(JSON.stringify(b!['arguments']));
  });

  it('rejected: denied with who and why, and the call is never sent again', async () => {
    const g = await start([held('ap-2')], [{ body: { state: 'pending' } }, { body: { state: 'rejected', decidedByName: 'Priya', decisionNote: 'not now' } }]);
    const r = await guardFor(g.server.url).callTool(REQ, { waitForApproval: WAIT });
    expect(r).toEqual({ status: 'denied', approvalId: 'ap-2', decidedBy: 'Priya', note: 'not now' });
    expect(g.posts()).toBe(1);
  });

  it('expired by state: expired, one POST', async () => {
    const g = await start([held('ap-3')], [{ body: { state: 'expired' } }]);
    const r = await guardFor(g.server.url).callTool(REQ, { waitForApproval: WAIT });
    expect(r).toEqual({ status: 'expired', approvalId: 'ap-3' });
    expect(g.posts()).toBe(1);
  });

  it('expired by the clock while still pending: expired, one POST', async () => {
    const g = await start([held('ap-4', new Date(Date.now() + 80).toISOString())], [{ body: { state: 'pending' } }]);
    const r = await guardFor(g.server.url).callTool(REQ, { waitForApproval: { pollMs: 10, timeoutMs: 5_000 } });
    expect(r).toEqual({ status: 'expired', approvalId: 'ap-4' });
    expect(g.posts()).toBe(1);
  });

  it('wait runs out first: pending_approval again, one POST', async () => {
    const expiresAt = FUTURE();
    const g = await start([held('ap-5', expiresAt)], [{ body: { state: 'pending' } }]);
    const t0 = Date.now();
    const r = await guardFor(g.server.url).callTool(REQ, { waitForApproval: { pollMs: 10, timeoutMs: 120 } });
    expect(r).toEqual({ status: 'pending_approval', approvalId: 'ap-5', expiresAt });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(g.posts()).toBe(1);
  });

  it('already used (consumed): refused, and the call is not sent again', async () => {
    const g = await start([held('ap-6')], [{ body: { state: 'consumed' } }]);
    const r = await guardFor(g.server.url).callTool(REQ, { waitForApproval: WAIT });
    expect(r).toMatchObject({ status: 'refused', reason: 'approval_consumed', approvalId: 'ap-6' });
    expect(g.posts()).toBe(1);
  });

  it('a failed read of the approval is tried again; a 404 ends the wait', async () => {
    const ok = await start([held('ap-7'), allowed], [{ status: 500, body: { error: 'x' } }, { body: { state: 'approved' } }]);
    expect(await guardFor(ok.server.url).callTool(REQ, { waitForApproval: WAIT })).toMatchObject({ status: 'completed' });
    expect(ok.posts()).toBe(2);
    const gone = await start([held('ap-8')], [{ status: 404, body: { error: 'Approval not found' } }]);
    expect(await guardFor(gone.server.url).callTool(REQ, { waitForApproval: WAIT })).toMatchObject({ status: 'refused', reason: 'approval_not_found', httpStatus: 404, maybeRan: false });
    expect(gone.posts()).toBe(1);
  });

  it('the re-send is refused by the gateway: refused with its reason, and no third request', async () => {
    const g = await start(
      [held('ap-10'), (res) => json(res, 403, { error: 'Approval expired', reason: 'approval_expired', toolRef: 'x' })],
      [{ body: { state: 'approved' } }],
    );
    const r = await guardFor(g.server.url).callTool(REQ, { waitForApproval: WAIT });
    expect(r).toMatchObject({ status: 'refused', reason: 'approval_expired', httpStatus: 403, maybeRan: false, approvalId: 'ap-10' });
    expect(g.posts()).toBe(2);
  });

  it('a second hold on the re-send is handed back, never looped on', async () => {
    const g = await start([held('ap-11'), held('ap-12')], [{ body: { state: 'approved' } }]);
    const r = await guardFor(g.server.url).callTool(REQ, { waitForApproval: WAIT });
    expect(r).toMatchObject({ status: 'pending_approval', approvalId: 'ap-12' });
    expect(g.posts()).toBe(2);
  });
});

describe('refusals and failures', () => {
  it('a policy 403 is refused with the gateway reason, one request, no retry', async () => {
    const g = await start([(res) => json(res, 403, { error: 'Tool call denied by policy', reason: 'not_in_allow_list', toolRef: 'x' })]);
    const r = await guardFor(g.server.url).callTool(REQ, { waitForApproval: WAIT });
    expect(r).toEqual({ status: 'refused', reason: 'not_in_allow_list', message: 'Tool call denied by policy', httpStatus: 403, maybeRan: false });
    expect(g.posts()).toBe(1);
    expect(g.gets()).toBe(0);
  });

  it('a 502 after dispatch is refused, may have run, and is never retried', async () => {
    const g = await start([(res) => json(res, 502, { error: 'MCP tool call failed', toolRef: 'x' })]);
    const r = await guardFor(g.server.url).callTool(REQ);
    expect(r).toEqual({ status: 'refused', reason: 'upstream_failed', message: 'MCP tool call failed', httpStatus: 502, maybeRan: true });
    expect(g.posts()).toBe(1);
  });

  it('carries the vendor-refused-the-token reason through', async () => {
    const g = await start([(res) => json(res, 502, { error: 'MCP tool call failed', toolRef: 'x', reason: 'target_auth_failed' })]);
    expect(await guardFor(g.server.url).callTool(REQ)).toMatchObject({ status: 'refused', reason: 'target_auth_failed', maybeRan: true });
    expect(g.posts()).toBe(1);
  });

  it('a 502 on the re-send is not sent a third time', async () => {
    const g = await start([held('ap-13'), (res) => json(res, 502, { error: 'MCP tool call failed' })], [{ body: { state: 'approved' } }]);
    const r = await guardFor(g.server.url).callTool(REQ, { waitForApproval: WAIT });
    expect(r).toMatchObject({ status: 'refused', reason: 'upstream_failed', maybeRan: true, approvalId: 'ap-13' });
    expect(g.posts()).toBe(2);
  });

  it('a call that never answers times out as refused, may have run, and is not sent again', async () => {
    const g = await start([() => { /* never answer */ }]);
    const r = await guardFor(g.server.url).callTool(REQ, { timeoutMs: 80, waitForApproval: WAIT });
    expect(r).toMatchObject({ status: 'refused', reason: 'gateway_timeout', maybeRan: true });
    expect(g.posts()).toBe(1);
  });

  it('a body that stalls after its headers is cut off too', async () => {
    const g = await start([(res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '999' }); res.write('{"allowed":true'); }]);
    expect(await guardFor(g.server.url).callTool(REQ, { timeoutMs: 80 })).toMatchObject({ status: 'refused', reason: 'gateway_timeout', maybeRan: true });
    expect(g.posts()).toBe(1);
  });

  it('an unreachable gateway is refused (never a pass)', async () => {
    const g = await start([allowed]);
    const url = g.server.url;
    await g.server.close();
    servers = servers.filter((s) => s !== g.server);
    expect(await guardFor(url).callTool(REQ)).toMatchObject({ status: 'refused', reason: 'gateway_unreachable', maybeRan: true });
  });

  it('an unrecognised 200 is refused, not treated as success', async () => {
    const g = await start([(res) => json(res, 200, { hello: 'world' })]);
    expect(await guardFor(g.server.url).callTool(REQ)).toMatchObject({ status: 'refused', reason: 'invalid_response', maybeRan: true });
    expect(g.posts()).toBe(1);
  });

  it('a 202 with no approval id is refused', async () => {
    const g = await start([(res) => json(res, 202, { status: 'pending_approval' })]);
    expect(await guardFor(g.server.url).callTool(REQ, { waitForApproval: WAIT })).toMatchObject({ status: 'refused', reason: 'invalid_response', maybeRan: false });
    expect(g.gets()).toBe(0);
  });
});

describe('the arguments', () => {
  it('are never logged, on success, hold, refusal or failure', async () => {
    for (const calls of [[allowed], [held('ap-1'), allowed], [(res: ServerResponse) => json(res, 403, { reason: 'x', error: 'y' })], [(res: ServerResponse) => json(res, 502, { error: 'z' })]]) {
      const g = await start(calls, [{ body: { state: 'approved' } }]);
      await guardFor(g.server.url).callTool(REQ, { waitForApproval: WAIT });
    }
    const all = JSON.stringify([warn.mock.calls, log.mock.calls, error.mock.calls]);
    expect(all).not.toContain('SECRET-TITLE-7781');
  });
});

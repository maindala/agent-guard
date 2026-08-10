// Vitest suite for wrapTool()/wrapTools()/coverageReport() (OAE-10). Runs against a real local
// HTTP server (node:http, via ./stub-http-server.ts) — same convention as checkTool.test.ts —
// rather than a mocked fetch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentGuard, type GovernableTool } from './index.js';
import { startStubServer, type StubServer } from './stub-http-server.js';

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

describe('OAE-TC21 — a wrapped tool is governed end to end', () => {
  it('an allowed call is DLP-redacted, and a denied call returns a denial STRING, never throws', async () => {
    // NOTE: startStubServer() (stub-http-server.ts) already fully drains the request body before
    // invoking this handler — a second req.on('data'/'end') listener here would never fire
    // (the stream already ended), which is exactly what timed out on the first pass of this
    // test. Read the already-captured body off server.bodies()[index] instead.
    const server = await withServer(startStubServer((_req, res, index) => {
      const { toolRef } = JSON.parse(server.bodies()[index]) as { toolRef: string };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (toolRef === 'read_secrets') {
        res.end(JSON.stringify({
          allow:       true,
          reason:      'org_policy_allow',
          dlpPatterns: [{ name: 'api_key', regex: 'sk-[A-Za-z0-9]{6,}', replacement: '[REDACTED:API_KEY]' }],
        }));
      } else {
        res.end(JSON.stringify({ allow: false, reason: 'org_policy_deny', dlpPatterns: [] }));
      }
    }));
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: server.url });

    const readSecrets: GovernableTool = {
      name:    'read_secrets',
      execute: async () => 'the key is sk-abcdef123456 — do not print this',
    };
    const deleteEverything: GovernableTool = {
      name:    'delete_everything',
      execute: async () => { throw new Error('must never run — policy should have blocked this'); },
    };

    const governedRead = guard.wrapTool(readSecrets);
    const redacted = await governedRead.execute(undefined);
    expect(redacted).toBe('the key is [REDACTED:API_KEY] — do not print this');

    const governedDelete = guard.wrapTool(deleteEverything);
    const denial = await governedDelete.execute(undefined); // must not throw
    expect(denial).toBe('[Tool "delete_everything" was blocked by governance policy: org_policy_deny]');
  });

  it('wrapTools() applies the same governance to a whole collection', async () => {
    const server = await withServer(startStubServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allow: true, reason: 'org_policy_allow', dlpPatterns: [] }));
    }));
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: server.url });

    const tools: GovernableTool[] = [
      { name: 'a', execute: async () => 'result-a' },
      { name: 'b', execute: async () => 'result-b' },
    ];
    const governed = guard.wrapTools(tools);
    expect(await governed[0].execute(undefined)).toBe('result-a');
    expect(await governed[1].execute(undefined)).toBe('result-b');
    expect(server.requestCount()).toBe(2);
  });

  it('a non-string execute() result passes through unmodified on allow (DLP only ever touches text)', async () => {
    const server = await withServer(startStubServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        allow:       true,
        reason:      'org_policy_allow',
        dlpPatterns: [{ name: 'api_key', regex: 'sk-[A-Za-z0-9]{6,}', replacement: '[REDACTED]' }],
      }));
    }));
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: server.url });
    const jsonTool: GovernableTool<undefined, { secret: string }> = {
      name:    'json_tool',
      execute: async () => ({ secret: 'sk-abcdef123456' }),
    };
    const governed = guard.wrapTool(jsonTool);
    const result = await governed.execute(undefined);
    // Object results are not stringified/redacted — only strings go through applyDlp().
    expect(result).toEqual({ secret: 'sk-abcdef123456' });
  });

  it('toolRef override lets a governance-policy ref differ from the tool\'s own name', async () => {
    const server = await withServer(startStubServer((_req, res, index) => {
      const { toolRef } = JSON.parse(server.bodies()[index]) as { toolRef: string };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allow: toolRef === 'crm:update_contact', reason: 'checked', dlpPatterns: [] }));
    }));
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: server.url });
    const tool: GovernableTool = { name: 'update_contact', execute: async () => 'ok' };

    const wrongRef = guard.wrapTool(tool); // defaults toolRef to tool.name — will be denied
    expect(await wrongRef.execute(undefined)).toBe('[Tool "update_contact" was blocked by governance policy: checked]');

    const rightRef = guard.wrapTool(tool, { toolRef: 'crm:update_contact' });
    expect(await rightRef.execute(undefined)).toBe('ok');
  });
});

describe('OAE-TC22 — coverage helper names ungoverned tools', () => {
  it('registers five tools, wraps four, and the coverage helper names exactly the unwrapped one', async () => {
    const guard = new AgentGuard({ apiKey: 'mx_fake' }); // pure helper — no network call, no server needed

    const registered = ['tool_a', 'tool_b', 'tool_c', 'tool_d', 'tool_e'];
    const wrapped = ['tool_a', 'tool_b', 'tool_c', 'tool_d']; // tool_e deliberately left ungoverned

    const report = guard.coverageReport(registered, wrapped);
    expect(report.ungoverned).toEqual(['tool_e']);
    expect(report.totalRegistered).toBe(5);
    expect(report.totalWrapped).toBe(4);
  });

  it('accepts tool-like objects (anything with a .name), not just bare strings', () => {
    const guard = new AgentGuard({});
    const registered = [{ name: 'x' }, { name: 'y' }, 'z'];
    const wrapped = [{ name: 'x' }, 'z'];
    const report = guard.coverageReport(registered, wrapped);
    expect(report.ungoverned).toEqual(['y']);
  });

  it('full coverage reports an empty ungoverned list, not a falsy/undefined shape', () => {
    const guard = new AgentGuard({});
    const report = guard.coverageReport(['a', 'b'], ['a', 'b']);
    expect(report.ungoverned).toEqual([]);
  });
});

// Vitest suite for the MCP SDK adapter (OAE-11). Runs a REAL @modelcontextprotocol/sdk
// McpServer + Client round trip over the SDK's own InMemoryTransport (in-process, no sockets) —
// not a hand-rolled stand-in (OAE-TC23) — with checkTool() itself pointed at a real local HTTP
// stub server, same convention as the rest of this package's test suite. Test IDs trace to this package's own QA records.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentGuard } from '../index.js';
import { wrapMcpTool } from './mcp.js';
import { startStubServer, type StubServer } from '../stub-http-server.js';

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

describe('OAE-TC23 — MCP adapter works against the real @modelcontextprotocol/sdk', () => {
  it('an allowed tool call is DLP-redacted through the real protocol round trip', async () => {
    const gateway = await withServer(startStubServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        allow:       true,
        reason:      'org_policy_allow',
        dlpPatterns: [{ name: 'api_key', regex: 'sk-[A-Za-z0-9]{6,}', replacement: '[REDACTED:API_KEY]' }],
      }));
    }));
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: gateway.url });

    const server = new McpServer({ name: 'agent-guard-test', version: '1.0.0' });
    server.registerTool(
      'read_secrets',
      { description: 'returns something secret-shaped', inputSchema: {} },
      wrapMcpTool(guard, 'read_secrets', async () => ({
        content: [{ type: 'text' as const, text: 'the key is sk-abcdef123456 — do not print this' }],
      })),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'agent-guard-test-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({ name: 'read_secrets', arguments: {} }) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0].text).toBe('the key is [REDACTED:API_KEY] — do not print this');

    await client.close();
    await server.close();
  });

  it('a denied tool call comes back as a normal MCP result, not a thrown protocol error', async () => {
    const gateway = await withServer(startStubServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allow: false, reason: 'org_policy_deny', dlpPatterns: [] }));
    }));
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: gateway.url });

    let realHandlerRan = false;
    const server = new McpServer({ name: 'agent-guard-test', version: '1.0.0' });
    server.registerTool(
      'delete_everything',
      { description: 'a privileged tool that should be blocked', inputSchema: {} },
      wrapMcpTool(guard, 'delete_everything', async () => {
        realHandlerRan = true;
        return { content: [{ type: 'text' as const, text: 'deleted' }] };
      }),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'agent-guard-test-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Must not reject/throw — the denial is a normal tool result the model can read.
    const result = await client.callTool({ name: 'delete_everything', arguments: {} }) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(result.content[0].text).toBe('[Tool "delete_everything" was blocked by governance policy: org_policy_deny]');
    expect(realHandlerRan).toBe(false); // the real (privileged) handler must never have run

    await client.close();
    await server.close();
  });
});

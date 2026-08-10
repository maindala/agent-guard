// Demonstrates the MCP SDK adapter (OAE-11) against the REAL @modelcontextprotocol/sdk package —
// an optional peer dependency of @maindala/agent-guard, never required by the core import (see
// 07-wrap-tool.mjs and OAE-TC24) — not a hand-rolled stand-in (OAE-TC23). Runs fully offline via
// the SDK's own InMemoryTransport: a real client<->server protocol round trip, in-process, no
// sockets, no network at all (OAE-TC25).
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AgentGuard } from '../dist/index.js';
import { wrapMcpTool } from '../dist/adapters/mcp.js';
import { startStubGateway } from './stub-gateway.mjs';

const gateway = await startStubGateway();
try {
  const guard = new AgentGuard({ apiKey: 'mx_example', gatewayUrl: gateway.url });

  const server = new McpServer({ name: 'agent-guard-example', version: '1.0.0' });

  // Governing an MCP tool is a one-line change at registration: wrap the handler you'd have
  // passed to registerTool() anyway. Nothing else about the tool's registration changes.
  server.registerTool(
    'read_secret_file',
    { description: 'Reads a file that happens to contain something secret-shaped', inputSchema: {} },
    wrapMcpTool(guard, 'read_secret_file', async () => ({
      content: [{ type: 'text', text: 'contents: sk-abcdefgh12345678 and nothing else' }],
    })),
  );
  // MCP tool names may not contain ":" (the SDK warns on it) — the stub gateway denies on
  // "delete" as well as "deny", so a spec-legal name is enough to trigger the deny path.
  server.registerTool(
    'delete_everything',
    { description: 'A privileged tool the stub gateway denies', inputSchema: {} },
    wrapMcpTool(guard, 'delete_everything', async () => {
      throw new Error('should never run — governance should have blocked this');
    }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'agent-guard-example-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const allowed = await client.callTool({ name: 'read_secret_file', arguments: {} });
  const allowedText = allowed.content[0].text;
  assert.equal(
    allowedText,
    'contents: [REDACTED:API_KEY] and nothing else',
    'DLP pattern should redact the secret through the real MCP protocol round trip',
  );
  console.log('allowed + redacted (via real MCP client/server):', allowedText);

  const denied = await client.callTool({ name: 'delete_everything', arguments: {} });
  const deniedText = denied.content[0].text;
  assert.match(
    deniedText,
    /blocked by governance policy/,
    'a denied MCP tool call must come back as a normal result, never a thrown protocol error',
  );
  console.log('denied (no throw, real protocol round trip):', deniedText);

  await client.close();
  await server.close();
  console.log('08-mcp-adapter: OK');
} finally {
  await gateway.close();
}

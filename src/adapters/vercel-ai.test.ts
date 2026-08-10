// Vitest suite for the Vercel AI SDK adapter (OAE-11). Constructs the tool definition with the
// REAL `ai` package's own tool() factory (not a hand-rolled stand-in, OAE-TC23) and invokes its
// governed execute() directly — the same way the SDK's own tool-execution loop would call it —
// with checkTool() pointed at a real local HTTP stub server, same convention as the rest of this
// package's test suite. Test IDs trace to this package's own QA records.
//
// Deliberately does NOT call `ai`'s generateText()/streamText() — those require a real language
// model provider and would make a real outbound network call, which this offline test suite must
// never do (see OAE-TC25). Calling execute() directly is exactly what those functions do
// internally once a model has decided to call the tool; it exercises the real tool() factory's
// schema/shape validation without needing a model in the loop.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { tool } from 'ai';
import { AgentGuard } from '../index.js';
import { wrapVercelAiTool } from './vercel-ai.js';
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

const fakeExecutionOptions = { toolCallId: 'test-call-1', messages: [] };

describe('OAE-TC23 — Vercel AI SDK adapter works against the real `ai` package', () => {
  it('an allowed tool execute() is DLP-redacted, and inputSchema/description survive unwrapped', async () => {
    const gateway = await withServer(startStubServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        allow:       true,
        reason:      'org_policy_allow',
        dlpPatterns: [{ name: 'api_key', regex: 'sk-[A-Za-z0-9]{6,}', replacement: '[REDACTED:API_KEY]' }],
      }));
    }));
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: gateway.url });

    const readSecrets = tool({
      description: 'returns something secret-shaped',
      inputSchema: z.object({}),
      execute:     async () => 'the key is sk-abcdef123456 — do not print this',
    });

    const governed = wrapVercelAiTool(guard, 'read_secrets', readSecrets);
    // Real ai `tool()` output survives the wrap — only execute() changed.
    expect(governed.description).toBe('returns something secret-shaped');
    expect(governed.inputSchema).toBe(readSecrets.inputSchema);

    const result = await governed.execute!({}, fakeExecutionOptions);
    expect(result).toBe('the key is [REDACTED:API_KEY] — do not print this');
  });

  it('a denied tool execute() returns a denial STRING, never throws, and the real execute never runs', async () => {
    const gateway = await withServer(startStubServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allow: false, reason: 'org_policy_deny', dlpPatterns: [] }));
    }));
    const guard = new AgentGuard({ apiKey: 'mx_fake', gatewayUrl: gateway.url });

    let realExecuteRan = false;
    const deleteEverything = tool({
      description: 'a privileged tool that should be blocked',
      inputSchema: z.object({}),
      execute:     async () => {
        realExecuteRan = true;
        return 'deleted';
      },
    });

    const governed = wrapVercelAiTool(guard, 'delete_everything', deleteEverything);
    const result = await governed.execute!({}, fakeExecutionOptions);

    expect(result).toBe('[Tool "delete_everything" was blocked by governance policy: org_policy_deny]');
    expect(realExecuteRan).toBe(false);
  });

  it('throws synchronously if handed a tool definition with no execute function', () => {
    const guard = new AgentGuard({ apiKey: 'mx_fake' });
    const noExecuteTool = { description: 'missing execute' };
    expect(() => wrapVercelAiTool(guard, 'broken_tool', noExecuteTool)).toThrow(/has no execute\(\) function/);
  });
});

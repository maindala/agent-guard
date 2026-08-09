// A realistic integration shape: wrapping an arbitrary tool call (an MCP
// tool, a plain function, whatever your agent framework hands you) with a
// policy check before it runs, DLP redaction after, and a telemetry event
// either way — the pattern most real callers of this SDK actually want.
// Run: node examples/05-mcp-tool-wrapper.mjs
import { AgentGuard } from '../dist/index.js';
import { startStubGateway } from './stub-gateway.mjs';

const gateway = await startStubGateway();
const guard = new AgentGuard({ apiKey: 'mx_example_key', gatewayUrl: gateway.url });

/**
 * Wraps an arbitrary async tool call with a guard.
 * @param {string} toolName
 * @param {() => Promise<string>} runTool - actually invokes the tool (MCP call, API request, etc.)
 */
async function guardedToolCall(toolName, runTool) {
  const startedAt = Date.now();
  const decision = await guard.checkTool(toolName);

  if (!decision.allow) {
    await guard.pushToolCallTelemetry('mt_example_token', {
      kind: 'tool_call', toolName, target: 'example', decision: 'deny',
    });
    return { blocked: true, reason: decision.reason, output: null };
  }

  const rawOutput = await runTool();
  const redacted = guard.applyDlp(rawOutput, decision.dlpPatterns);

  await guard.pushToolCallTelemetry('mt_example_token', {
    kind: 'tool_call', toolName, target: 'example',
    decision: 'allow', latencyMs: Date.now() - startedAt,
  });

  return { blocked: false, reason: decision.reason, output: redacted };
}

const ok = await guardedToolCall('lookup_customer', async () => 'Contact: alice@example.com');
console.log('lookup_customer ->', ok);
if (ok.blocked || ok.output.includes('@')) throw new Error('expected an allowed, redacted result');

const blocked = await guardedToolCall('deny_this_tool', async () => {
  throw new Error('runTool should never be called for a denied tool');
});
console.log('deny_this_tool  ->', blocked);
if (!blocked.blocked) throw new Error('expected this call to be blocked before runTool ran');

await gateway.close();
console.log('OK');

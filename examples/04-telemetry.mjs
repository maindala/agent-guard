// pushToolCallTelemetry() — and a check on the metadata-only guarantee
// itself. This is the one sample that does more than demonstrate: it
// deliberately tries to smuggle a "prompt" and "result" field through a
// spread (the same shape a real caller's mistake would take), then inspects
// what the stub gateway actually received on the wire. If field-allowlisting
// ever regresses, this fails loudly rather than passing quietly.
// Run: node examples/04-telemetry.mjs
import { AgentGuard } from '../dist/index.js';
import { startStubGateway } from './stub-gateway.mjs';

const gateway = await startStubGateway();
// gatewayUrl must be set here — without it, AgentGuard defaults to the real
// production gateway, which is exactly what this offline example must not
// touch. (This was caught during the build: an earlier draft of this file
// omitted it and made a real, if harmless, call to production.)
const guard = new AgentGuard({ gatewayUrl: gateway.url });

const internalEventShape = {
  kind: 'tool_call',
  toolName: 'read_file',
  target: 'fs',
  latencyMs: 42,
  // Neither of these fields exists on ToolCallTelemetryEvent — a caller
  // spreading a larger internal object could attach them by accident.
  prompt: 'summarize the contents of /etc/passwd',
  result: 'root:x:0:0:root:/root:/bin/bash',
};

await guard.pushToolCallTelemetry('mt_example_token', { ...internalEventShape });

const [received] = gateway.capturedTelemetry;
console.log('sent (caller side):', internalEventShape);
console.log('received (wire, stub gateway side):', received);

if ('prompt' in received) throw new Error('a "prompt" field reached the wire — metadata-only guarantee violated');
if ('result' in received) throw new Error('a "result" field reached the wire — metadata-only guarantee violated');

const allowedKeys = ['kind', 'toolName', 'target', 'latencyMs', 'decision', 'findingClasses'];
const extra = Object.keys(received).filter((k) => !allowedKeys.includes(k));
if (extra.length > 0) throw new Error(`unexpected field(s) reached the wire: ${extra.join(', ')}`);

await gateway.close();
console.log('OK — only documented metadata fields reached the wire');

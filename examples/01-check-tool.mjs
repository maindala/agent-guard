// checkTool() — the pre-flight policy check. Run against the stub gateway,
// this shows both outcomes: an allowed tool call, and one the org's policy
// denies. Run: node examples/01-check-tool.mjs
import { AgentGuard } from '../dist/index.js';
import { startStubGateway } from './stub-gateway.mjs';

const gateway = await startStubGateway();
const guard = new AgentGuard({ apiKey: 'mx_example_key', gatewayUrl: gateway.url });

const allowed = await guard.checkTool('send_email');
console.log('checkTool("send_email") ->', allowed);
if (allowed.allow !== true) throw new Error('expected this call to be allowed');

const denied = await guard.checkTool('deny_this_tool');
console.log('checkTool("deny_this_tool") ->', denied);
if (denied.allow !== false) throw new Error('expected this call to be denied');

// The allowed decision also carries DLP patterns for redacting the result —
// see 02-apply-dlp.mjs for what to do with them.
console.log('dlpPatterns on the allowed decision:', allowed.dlpPatterns);
if (allowed.dlpPatterns.length === 0) throw new Error('expected at least one DLP pattern');

await gateway.close();
console.log('OK');

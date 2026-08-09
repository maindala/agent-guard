// checkAndRedact() — checkTool() + applyDlp() in one call, the shape most
// tool-call wrappers actually want: run the policy check, and if allowed,
// get the result back pre-redacted. Run: node examples/03-check-and-redact.mjs
import { AgentGuard } from '../dist/index.js';
import { startStubGateway } from './stub-gateway.mjs';

const gateway = await startStubGateway();
const guard = new AgentGuard({ apiKey: 'mx_example_key', gatewayUrl: gateway.url });

// Simulates a tool that actually ran and returned a result containing an email.
const toolResult = 'Ticket owner: support@example.com';

const outcome = await guard.checkAndRedact('lookup_ticket', toolResult);
console.log(outcome);
if (!outcome.allowed) throw new Error('expected this call to be allowed');
if (outcome.redacted.includes('@')) throw new Error('expected the email to be redacted');

// The denied case: redacted is explicitly null, never a partially-processed result.
const deniedOutcome = await guard.checkAndRedact('deny_this_tool', toolResult);
console.log(deniedOutcome);
if (deniedOutcome.allowed !== false || deniedOutcome.redacted !== null) {
  throw new Error('expected allowed:false and redacted:null for a denied call');
}

await gateway.close();
console.log('OK');

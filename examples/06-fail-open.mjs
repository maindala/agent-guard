// The fail-open posture, made visible rather than merely documented. If the
// governance plane is unreachable, checkTool() does not throw — it returns
// an allow decision so a gateway outage can't take your agent down with it.
// The real consequence: while the gateway is down, every tool call is
// allowed through unchecked. Read README.md's "Fail-open posture" section
// before deciding whether that's the right default for your deployment.
// Run: node examples/06-fail-open.mjs
import { AgentGuard } from '../dist/index.js';

// Port 1 is never a real listener — this is a real connection failure,
// not a simulated one.
const guard = new AgentGuard({ apiKey: 'mx_example_key', gatewayUrl: 'http://127.0.0.1:1' });

console.log('Calling checkTool() against an unreachable gateway...');
const decision = await guard.checkTool('send_email');
console.log('Result:', decision);

if (decision.allow !== true || decision.reason !== 'guard_error') {
  throw new Error('expected a guard_error allow result, not a thrown exception');
}

console.log(
  '\nThe call was allowed, not blocked — because the gateway was unreachable, not because policy\n' +
  'said yes. This is the tradeoff: an outage never blocks your agent, but it also means every\n' +
  'tool call is unchecked for as long as the outage lasts. A [agent-guard] warning is logged to\n' +
  'the console on every occurrence (see stderr above) so this is at least visible, not silent.',
);
console.log('\nOK');

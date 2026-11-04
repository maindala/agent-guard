// Demonstrates callTool(): one governed call, a call held for a person, and waiting for the decision. Runs fully offline against a
// tiny local gateway defined here (it answers /broker/call and /broker/approvals only); no account, no credentials, no network
// beyond localhost. It always passes `gatewayUrl` explicitly, as every example here must (see stub-gateway.mjs).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AgentGuard } from '../dist/index.js';

let sends = 0;      // how many times /broker/call was posted
let reads = 0;      // how many approval reads
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const reply = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (req.method === 'POST' && req.url === '/broker/call') {
      sends += 1;
      const call = JSON.parse(body);
      if (call.tool === 'read_issue') return reply(200, { result: { content: [{ type: 'text', text: 'issue #1' }] }, allowed: true, toolRef: `${call.serviceSlug}:${call.tool}`, connectionInjected: true, dlpApplied: false, guardrailApplied: false });
      if (call.tool === 'create_issue' && !call.approvalId) return reply(202, { status: 'pending_approval', approvalId: 'demo-approval', toolRef: `${call.serviceSlug}:${call.tool}`, expiresAt: new Date(Date.now() + 60_000).toISOString(), reason: 'approval_required' });
      if (call.tool === 'create_issue' && call.approvalId === 'demo-approval') return reply(200, { result: { content: [{ type: 'text', text: 'created #2' }] }, allowed: true, toolRef: `${call.serviceSlug}:${call.tool}`, connectionInjected: true, dlpApplied: false, guardrailApplied: false });
      return reply(403, { error: 'Tool call denied by policy', reason: 'deny_list' });
    }
    if (req.method === 'GET' && req.url === '/broker/approvals/demo-approval') {
      reads += 1;
      return reply(200, { state: reads < 3 ? 'pending' : 'approved' });   // a person approves after two looks
    }
    return reply(404, { error: 'not found' });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const gatewayUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const guard = new AgentGuard({ apiKey: 'mx_example', gatewayUrl });
  const call = { serviceSlug: 'github-mcp-server', connectionId: 'conn-1' };

  const read = await guard.callTool({ ...call, tool: 'read_issue', arguments: { number: 1 } });
  assert.equal(read.status, 'completed');
  console.log('allowed:', read.status);

  // Held, and not waiting: you get the approval id and decide what to do.
  const held = await guard.callTool({ ...call, tool: 'create_issue', arguments: { title: 'hello' } });
  assert.equal(held.status, 'pending_approval');
  console.log('held:', held.status, held.approvalId);

  // Held, waiting: checks until a person decides, then sends the same call once more with the approval id.
  sends = 0; reads = 0;
  const waited = await guard.callTool({ ...call, tool: 'create_issue', arguments: { title: 'hello' } }, { waitForApproval: { pollMs: 10, timeoutMs: 5_000 } });
  assert.equal(waited.status, 'completed');
  assert.equal(sends, 2, 'one first send and exactly one re-send');
  console.log('approved then run:', waited.status, `(sent ${sends} times)`);

  const refused = await guard.callTool({ ...call, tool: 'delete_repo', arguments: {} });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.reason, 'deny_list');
  console.log('refused:', refused.reason);

  console.log('10-call-tool: OK');
} finally {
  await new Promise((resolve) => server.close(resolve));
}

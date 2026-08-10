// Demonstrates wrapTool()/wrapTools()/coverageReport() (OAE-10) — governing a tool registry once
// at registration instead of hand-wrapping every call site. Runs fully offline against
// ./stub-gateway.mjs; no account, no credentials, no network beyond localhost (OAE-TC25).
import assert from 'node:assert/strict';
import { AgentGuard } from '../dist/index.js';
import { startStubGateway } from './stub-gateway.mjs';

const gateway = await startStubGateway();
try {
  const guard = new AgentGuard({ apiKey: 'mx_example', gatewayUrl: gateway.url });

  // A tool whose real output happens to contain something secret-shaped — the stub gateway's
  // DLP pattern should redact it in the governed result.
  const readSecretFile = {
    name:    'read_secret_file',
    execute: async () => 'contents: sk-abcdefgh12345678 and nothing else',
  };
  // A privileged tool the stub gateway denies (any toolRef containing "deny").
  const deleteEverything = {
    name:    'deny:delete_everything',
    execute: async () => { throw new Error('should never run — governance should have blocked this'); },
  };

  const [governedRead, governedDelete] = guard.wrapTools([readSecretFile, deleteEverything]);

  const allowed = await governedRead.execute(undefined);
  assert.equal(allowed, 'contents: [REDACTED:API_KEY] and nothing else', 'DLP pattern should redact the secret-shaped string');
  console.log('allowed + redacted:', allowed);

  const denied = await governedDelete.execute(undefined);
  assert.match(denied, /blocked by governance policy/, 'a denied tool must return a denial STRING, never throw');
  console.log('denied (no throw):', denied);

  // Coverage: three tools registered, only two wrapped — the helper should name exactly the
  // third. This is the visibility fix for "a forgotten wrapper bypasses it."
  const registered = [readSecretFile, deleteEverything, { name: 'unwrapped_tool' }];
  const wrapped = [governedRead, governedDelete];
  const report = guard.coverageReport(registered, wrapped);
  assert.deepEqual(report.ungoverned, ['unwrapped_tool'], 'coverage helper must name exactly the ungoverned tool');
  console.log('coverage report:', report);

  console.log('07-wrap-tool: OK');
} finally {
  await gateway.close();
}

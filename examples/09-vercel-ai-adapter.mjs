// Demonstrates the Vercel AI SDK adapter (OAE-11) against the REAL `ai` package's own tool()
// factory — an optional peer dependency of @maindala/agent-guard, never required by the core
// import (see 07-wrap-tool.mjs and OAE-TC24) — not a hand-rolled stand-in (OAE-TC23). Runs fully
// offline against ./stub-gateway.mjs.
//
// Deliberately does NOT call generateText()/streamText() from `ai` — those need a real language
// model provider and would make a real outbound network call, which every example in this
// directory must never do (OAE-TC25). Calling the wrapped tool's own execute() directly is
// exactly what those functions do internally once a model has decided to call the tool — it
// exercises the real tool() factory's schema/shape handling without needing a model in the loop.
import assert from 'node:assert/strict';
import { z } from 'zod';
import { tool } from 'ai';
import { AgentGuard } from '../dist/index.js';
import { wrapVercelAiTool } from '../dist/adapters/vercel-ai.js';
import { startStubGateway } from './stub-gateway.mjs';

const gateway = await startStubGateway();
try {
  const guard = new AgentGuard({ apiKey: 'mx_example', gatewayUrl: gateway.url });

  // A real ai SDK tool definition — inputSchema, description, execute — built with the
  // package's own tool() factory.
  const readSecretFile = tool({
    description: 'Reads a file that happens to contain something secret-shaped',
    inputSchema: z.object({}),
    execute:     async () => 'contents: sk-abcdefgh12345678 and nothing else',
  });
  const deleteEverything = tool({
    description: 'A privileged tool the stub gateway denies',
    inputSchema: z.object({}),
    execute:     async () => { throw new Error('should never run — governance should have blocked this'); },
  });

  // Governing a Vercel AI SDK tool is a one-line change: wrap the whole tool() output. Every
  // other field (inputSchema, description, ...) is passed through untouched.
  const governedRead = wrapVercelAiTool(guard, 'read_secret_file', readSecretFile);
  const governedDelete = wrapVercelAiTool(guard, 'deny:delete_everything', deleteEverything);

  assert.equal(governedRead.description, readSecretFile.description, 'non-execute fields must pass through unchanged');

  const fakeExecutionOptions = { toolCallId: 'example-call-1', messages: [] };

  const allowed = await governedRead.execute({}, fakeExecutionOptions);
  assert.equal(allowed, 'contents: [REDACTED:API_KEY] and nothing else', 'DLP pattern should redact the secret-shaped string');
  console.log('allowed + redacted:', allowed);

  const denied = await governedDelete.execute({}, fakeExecutionOptions);
  assert.match(denied, /blocked by governance policy/, 'a denied tool must return a denial STRING, never throw');
  console.log('denied (no throw):', denied);

  console.log('09-vercel-ai-adapter: OK');
} finally {
  await gateway.close();
}

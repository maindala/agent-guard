// Local, offline stub of the mAIndala governance gateway, used only by the runnable examples in
// this directory. Listens on 127.0.0.1 (an ephemeral port) and answers exactly one route,
// /broker/policy-check, with a canned decision driven by the toolRef in the request body — no
// account, no credentials, and no network beyond localhost.
//
// This exists because of a real incident: an earlier draft of one of these examples omitted
// `gatewayUrl` when constructing AgentGuard, silently fell back to the SDK's production default,
// and genuinely called mcp.maindala.com. See OAE-TC25 — every example in this directory is run
// with outbound network to anything but localhost blocked, specifically to catch that class of
// mistake again. If you add a new example, always pass `gatewayUrl: gateway.url` explicitly.
import { createServer } from 'node:http';

// Any toolRef containing "deny" or "delete" is denied by this stub; everything else is allowed
// with one DLP pattern that redacts anything shaped like an API key, so the examples have
// something real to redact rather than a contrived string. ("delete" is matched too, not just
// "deny", so the MCP adapter example can use an MCP-spec-legal tool name — MCP tool names may
// not contain ":" — without needing the "deny:" prefix trick the non-MCP examples use.)
const DLP_PATTERNS = [
  { name: 'api_key', regex: 'sk-[A-Za-z0-9]{6,}', replacement: '[REDACTED:API_KEY]' },
];

export function startStubGateway() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/broker/policy-check') {
        const parsed = body ? JSON.parse(body) : {};
        const deny = typeof parsed.toolRef === 'string' && /deny|delete/.test(parsed.toolRef);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(
          deny
            ? { allow: false, reason: 'org_policy_deny', dlpPatterns: [] }
            : { allow: true, reason: 'org_policy_allow', dlpPatterns: DLP_PATTERNS },
        ));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url:   `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

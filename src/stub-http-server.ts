// Dev-only test helper — a minimal real HTTP server used by the vitest suite
// to exercise AgentGuard against genuine network behavior (a hung socket, an
// error status, a malformed body, a request-count assertion) rather than a
// mocked fetch. Excluded from both the published dist (tsconfig) and the
// runtime `dependencies` (uses only Node's built-in `http` module, so it adds
// no dependency, dev or otherwise, beyond what's already required to run
// Node at all).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubServer {
  url:           string;
  requestCount:  () => number;
  bodies:        () => string[];
  close:         () => Promise<void>;
}

// Starts a server whose behavior is fully controlled by `handler`, called
// once per completed request with the 0-based index of that request. Tracks
// every inbound request (count + raw body) so tests can assert exactly how
// many times the guard actually hit the network — e.g. OAE-TC18 requires a
// legitimate `allow:false` decision to produce exactly one request.
export function startStubServer(
  handler: (req: IncomingMessage, res: ServerResponse, requestIndex: number) => void,
): Promise<StubServer> {
  let count = 0;
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      bodies.push(body);
      const index = count;
      count += 1;
      handler(req, res, index);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url:          `http://127.0.0.1:${port}`,
        requestCount: () => count,
        bodies:       () => bodies,
        close:        () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

// A server that accepts every TCP connection and HTTP request but never
// writes a response — the real shape of a "hung" gateway (OAE-TC01/TC02),
// distinct from a refused connection (ECONNREFUSED, which fails fast) or an
// error status (which responds, just unsuccessfully).
export function startHangingServer(): Promise<StubServer> {
  return startStubServer(() => { /* never respond — deliberate */ });
}

// Convenience: a server that always returns a valid PolicyCheckResult body.
export function startAllowServer(): Promise<StubServer> {
  return startStubServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ allow: true, reason: 'org_policy_allow', dlpPatterns: [] }));
  });
}

// A server that sends response headers (200 + a Content-Length promising a
// full body) and a PARTIAL body, then never finishes — distinct from
// startHangingServer(), which never responds at all. This is the shape
// OAE-TC35 exists for: `fetch()` itself resolves as soon as headers arrive,
// so a naive "clearTimeout right after fetch() resolves" leaves the abort
// disarmed while `res.json()`'s body read is still outstanding.
export function startStalledBodyServer(): Promise<StubServer> {
  return startStubServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '999' });
    res.write('{"allow":true'); // deliberately never call res.end()
  });
}

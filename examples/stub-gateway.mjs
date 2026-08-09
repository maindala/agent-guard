// A tiny local stand-in for the mAIndala governance gateway, used only by
// these examples so they run offline, with no account, no credentials, and
// no network. It answers the two endpoints AgentGuard actually calls:
//
//   POST /broker/policy-check  — a toolRef containing "deny" is refused;
//                                 anything else is allowed and returns one
//                                 sample DLP pattern that redacts emails.
//   POST /telemetry/ingest     — always accepted; the raw body is captured
//                                 so a sample can inspect exactly what was
//                                 sent over the wire.
//
// This is a stub for demonstration purposes only — it is not a reference
// implementation of the real gateway's policy logic.
import http from 'node:http';

export function startStubGateway() {
  const capturedTelemetry = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/broker/policy-check') {
        const { toolRef } = JSON.parse(raw || '{}');
        const denied = typeof toolRef === 'string' && toolRef.includes('deny');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(
          denied
            ? { allow: false, reason: 'denied_by_policy', dlpPatterns: [] }
            : {
                allow: true,
                reason: 'allowed',
                dlpPatterns: [
                  { name: 'email', regex: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+', replacement: '[REDACTED:EMAIL]' },
                ],
              },
        ));
        return;
      }
      if (req.method === 'POST' && req.url === '/telemetry/ingest') {
        capturedTelemetry.push(JSON.parse(raw || '{}'));
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        capturedTelemetry,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// applyDlp() — redacting sensitive data out of a tool's result before your
// agent sees or logs it, using the patterns checkTool() returned.
// Run: node examples/02-apply-dlp.mjs
import { AgentGuard } from '../dist/index.js';

const guard = new AgentGuard({});

const patterns = [
  { name: 'email', regex: '[\\w.+-]+@[\\w-]+\\.[\\w.-]+', replacement: '[REDACTED:EMAIL]' },
];

const toolResult = 'Found 2 matching records: jane@example.com and john@example.com';
const redacted = guard.applyDlp(toolResult, patterns);
console.log('before:', toolResult);
console.log('after: ', redacted);
if (redacted.includes('@')) throw new Error('expected both emails to be redacted');

// A malformed pattern is skipped rather than thrown — one bad regex from
// policy config must not take down the whole redaction pass.
const withBadPattern = guard.applyDlp('some text', [
  { name: 'broken', regex: '(unterminated', replacement: 'x' },
]);
console.log('malformed pattern handled without throwing:', withBadPattern);

// No patterns at all — the text passes through unchanged.
const unchanged = guard.applyDlp('nothing to redact here', []);
if (unchanged !== 'nothing to redact here') throw new Error('expected passthrough with zero patterns');

console.log('OK');

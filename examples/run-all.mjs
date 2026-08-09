#!/usr/bin/env node
// Runs every numbered example against the built package (../dist/index.js)
// and exits non-zero if any of them fail. This is what makes the examples a
// regression test, not just documentation: if the package can't be
// imported, or a security guarantee (like 04's metadata-only check)
// regresses, this fails the same way a broken publish would.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examples = fs.readdirSync(__dirname)
  .filter((f) => /^\d\d-.*\.mjs$/.test(f))
  .sort();

if (examples.length === 0) {
  console.error('No numbered examples found.');
  process.exit(2);
}

let failures = 0;
for (const file of examples) {
  console.log(`\n=== ${file} ===`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  } catch {
    failures++;
    console.error(`\nFAILED: ${file}`);
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${examples.length - failures}/${examples.length} examples passed`);
process.exit(failures === 0 ? 0 : 1);

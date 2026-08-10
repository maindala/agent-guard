// Runs every example in this directory in-process, in order, and exits non-zero on the first
// failure. Wired as `npm run examples` (package.json) — the point is that a broken package
// cannot ship: publishing requires that the samples import the BUILT `dist/` output and actually
// run against real dependencies (the local stub gateway, and, for 08/09, the real
// @modelcontextprotocol/sdk and `ai` packages), not just that `tsc` succeeded.
//
// NOTE ON SCOPE: this covers the examples added for OAE-10/OAE-11 (wrapTool/wrapTools/
// coverageReport + the MCP and Vercel AI SDK adapters) — 07 through 09. Examples 01-06 for the
// pre-existing checkTool/applyDlp/checkAndRedact/pushToolCallTelemetry/fail-mode surface were
// built directly in this public repo and were never copied back into
// this monorepo — this file only runs what actually lives here.
const examples = [
  './07-wrap-tool.mjs',
  './08-mcp-adapter.mjs',
  './09-vercel-ai-adapter.mjs',
];

let failed = false;
for (const path of examples) {
  console.log(`\n--- running ${path} ---`);
  try {
    await import(path);
  } catch (err) {
    failed = true;
    console.error(`FAILED: ${path}`);
    console.error(err);
  }
}

if (failed) {
  console.error('\nOne or more examples failed.');
  process.exit(1);
}
console.log('\nAll examples passed.');

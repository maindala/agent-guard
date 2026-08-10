// Optional adapter for the Vercel AI SDK (`ai`) — an optional peer dependency of
// @maindala/agent-guard, never required to import the core package (OAE-11, OAE-TC24: the core
// `import { AgentGuard } from '@maindala/agent-guard'` works with zero framework installed at
// all; only importing THIS subpath — `@maindala/agent-guard/adapters/vercel-ai` — needs `ai`
// present). Governs a tool at REGISTRATION by wrapping the tool definition's own `execute`
// function — the same "wrap the registry, not the call site" fix wrapTool() applies generically;
// see that function's doc comment in ../index.ts.
//
// Deliberately structural rather than importing `ai`'s own Tool/ToolExecuteFunction types: `ai`
// is at major v7 as of this writing (verified against the live npm registry) and its
// tool-definition generics have already renamed a field across majors (`parameters` in v4/v5 ->
// `inputSchema` in v5+). Any object with an `execute` function is accepted here and returned with
// the same shape it came in with, verified against the real package's own tool() factory in
// examples/09-vercel-ai-adapter.mjs and src/adapters/vercel-ai.test.ts — not a hand-rolled
// stand-in (OAE-TC23).
import type { AgentGuard } from '../index.js';

export type VercelAiExecute<Input = unknown, Output = unknown> =
  (input: Input, options?: unknown) => Output | Promise<Output>;

export interface VercelAiToolLike<Input = unknown, Output = unknown> {
  execute?: VercelAiExecute<Input, Output>;
  [key: string]: unknown;
}

// Wraps a Vercel AI SDK tool definition — the object returned by ai's own tool({...}) helper, or
// any object with an `execute` function — with governance. Every other field (inputSchema,
// description, ...) is passed through unchanged, so this is a one-line change at the call site:
// `execute: wrapVercelAiTool(guard, name, tool({...})).execute` or, more simply, wrap the whole
// definition as shown in the example.
export function wrapVercelAiTool<T extends VercelAiToolLike>(
  guard: AgentGuard,
  toolName: string,
  toolDef: T,
): T {
  const originalExecute = toolDef.execute;
  if (typeof originalExecute !== 'function') {
    throw new Error(`wrapVercelAiTool: tool "${toolName}" has no execute() function to govern`);
  }
  const governedExecute: VercelAiExecute = async (input, options) => {
    const decision = await guard.checkTool(toolName);
    if (!decision.allow) {
      // Same denial-as-normal-result contract as wrapTool()/wrapMcpTool() — see ../index.ts.
      return `[Tool "${toolName}" was blocked by governance policy: ${decision.reason}]`;
    }
    const result = await originalExecute(input, options);
    if (typeof result === 'string') return guard.applyDlp(result, decision.dlpPatterns);
    return result;
  };
  // Cast is safe at runtime — the returned object is exactly toolDef's shape with `execute`
  // replaced. TypeScript can't statically prove governedExecute's widened Input/Output line up
  // with T's own generic parameters (a deliberate simplification described in the file header),
  // so this documents the gap rather than silently suppressing it with `any`.
  return { ...toolDef, execute: governedExecute } as T;
}

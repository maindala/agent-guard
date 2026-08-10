// Optional adapter for the MCP TypeScript SDK (@modelcontextprotocol/sdk) — an optional peer
// dependency of @maindala/agent-guard, never required to import the core package (OAE-11,
// OAE-TC24: `import { AgentGuard } from '@maindala/agent-guard'` works with zero framework
// installed at all; only importing THIS subpath — `@maindala/agent-guard/adapters/mcp` — needs
// the SDK present). Governs an MCP tool at REGISTRATION rather than requiring every line inside
// the handler to remember to call the guard — the same "wrap the registry, not the call site"
// fix wrapTool() applies generically; see that function's doc comment in ../index.ts.
//
// Deliberately structural rather than importing @modelcontextprotocol/sdk's own ToolCallback/
// CallToolResult types: those generics are tied to the SDK's Zod-schema machinery and it moved
// APIs across majors even in the version already vendored in this monorepo (registerTool
// superseded the deprecated .tool()). A handler matching the shape below is accepted by
// server.registerTool() at runtime regardless of which SDK version produced it — verified
// against the real package via InMemoryTransport in examples/08-mcp-adapter.mjs and
// src/adapters/mcp.test.ts, not a hand-rolled stand-in (OAE-TC23).
import type { AgentGuard } from '../index.js';

// One content part of an MCP CallToolResult. Only the 'text' variant is inspected/redacted here
// — non-text parts (images, resource links, structured content, ...) pass through untouched,
// matching AgentGuard.applyDlp()'s own text-only contract.
export interface McpTextContent {
  type: 'text';
  text: string;
  [key: string]: unknown;
}

export type McpContentPart = McpTextContent | Record<string, unknown>;

export interface McpCallToolResult {
  content: McpContentPart[];
  isError?: boolean;
  [key: string]: unknown;
}

// Matches @modelcontextprotocol/sdk's own ToolCallback shape closely enough to be assignable to
// a real server.registerTool() call: (args, extra) => CallToolResult | Promise<CallToolResult>.
export type McpToolHandler<Args = Record<string, unknown>> =
  (args: Args, extra?: unknown) => McpCallToolResult | Promise<McpCallToolResult>;

function isTextPart(part: McpContentPart): part is McpTextContent {
  return typeof part === 'object' && part !== null
    && (part as { type?: unknown }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string';
}

// Wraps an MCP tool handler with governance. Drop the return value straight into
// server.registerTool(name, config, wrapMcpTool(guard, name, handler)) — nothing else about the
// tool's registration needs to change; this is the "about five lines" the design doc targets.
export function wrapMcpTool<Args = Record<string, unknown>>(
  guard: AgentGuard,
  toolName: string,
  handler: McpToolHandler<Args>,
): McpToolHandler<Args> {
  return async (args, extra) => {
    const decision = await guard.checkTool(toolName);
    if (!decision.allow) {
      // A denial reaches the model as a normal MCP tool result, not a protocol-level error —
      // same never-throw contract as wrapTool() in ../index.ts, and the same house pattern
      // packages/agent-runtime's callExternalAgentViaBroker uses for a blocked A2A delegation.
      return {
        content: [{ type: 'text', text: `[Tool "${toolName}" was blocked by governance policy: ${decision.reason}]` }],
      };
    }
    const result = await handler(args, extra);
    if (decision.dlpPatterns.length === 0) return result;
    return {
      ...result,
      content: result.content.map((part) =>
        isTextPart(part) ? { ...part, text: guard.applyDlp(part.text, decision.dlpPatterns) } : part,
      ),
    };
  };
}

/**
 * Pure adapters between our Pi `defineTool` descriptors and the MCP wire shapes.
 *
 * Our tools carry TypeBox schemas, which already ARE JSON Schema, and return Pi's
 * `AgentToolResult` (`{ content, details }`). MCP wants `{ name, description,
 * inputSchema }` for `tools/list` and `{ content, structuredContent }` for
 * `tools/call`. These functions do that mapping with zero schema conversion so
 * they stay trivially unit-testable — no SDK, no I/O.
 */

import type { TSchema } from "typebox";

/** The subset of a Pi `ToolDefinition` the MCP layer relies on. */
export interface PiToolLike {
  name: string;
  description: string;
  /** TypeBox `Type.Object({...})` — already a valid JSON Schema object. */
  parameters: TSchema;
  execute: (id: string, args: Record<string, unknown>, ...rest: unknown[]) => Promise<PiToolResult>;
}

/** What our tools return (a structural subset of Pi's `AgentToolResult`). */
export interface PiToolResult {
  content: unknown[];
  details?: unknown;
}

/** An MCP tool descriptor as advertised by `tools/list`. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: TSchema;
}

/** An MCP `tools/call` result. */
export interface McpCallResult {
  content: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Advertise one Pi tool to MCP: TypeBox `parameters` becomes `inputSchema` verbatim. */
export function toMcpToolDescriptor(tool: PiToolLike): McpToolDescriptor {
  return { name: tool.name, description: tool.description, inputSchema: tool.parameters };
}

/**
 * Map a Pi tool result to an MCP call result. The `content` array is already
 * MCP-compatible (our tools emit `{ type: "text", text }`). Pi's `details` becomes
 * MCP `structuredContent`, but only when it's a plain object — MCP requires
 * structuredContent to be a JSON object, so scalar/array/null details are dropped
 * (the human-readable summary still rides in `content`).
 */
export function toMcpCallResult(pi: PiToolResult): McpCallResult {
  const out: McpCallResult = { content: pi.content ?? [] };
  if (isPlainObject(pi.details)) out.structuredContent = pi.details;
  return out;
}

/** An MCP error result (unknown tool, thrown execute, etc.) — `isError` so the model sees it. */
export function mcpErrorResult(message: string): McpCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

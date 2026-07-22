import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { mcpErrorResult, type PiToolLike, toMcpCallResult, toMcpToolDescriptor } from "./adapter";

const sampleTool: PiToolLike = {
  name: "sample",
  description: "A sample tool.",
  parameters: Type.Object({ album: Type.String(), n: Type.Optional(Type.Integer()) }),
  execute: async () => ({ content: [{ type: "text", text: "ok" }], details: { ok: true } }),
};

describe("toMcpToolDescriptor", () => {
  it("maps name/description and passes TypeBox parameters through as inputSchema", () => {
    const d = toMcpToolDescriptor(sampleTool);
    expect(d.name).toBe("sample");
    expect(d.description).toBe("A sample tool.");
    // TypeBox Type.Object already IS JSON Schema — advertised verbatim, no conversion.
    expect(d.inputSchema).toBe(sampleTool.parameters);
    expect((d.inputSchema as { type?: string }).type).toBe("object");
  });
});

describe("toMcpCallResult", () => {
  it("carries content through and maps object details to structuredContent", () => {
    const r = toMcpCallResult({ content: [{ type: "text", text: "hi" }], details: { a: 1, b: "x" } });
    expect(r.content).toEqual([{ type: "text", text: "hi" }]);
    expect(r.structuredContent).toEqual({ a: 1, b: "x" });
    expect(r.isError).toBeUndefined();
  });

  it("omits structuredContent when details is not a plain object", () => {
    expect(toMcpCallResult({ content: [], details: 42 }).structuredContent).toBeUndefined();
    expect(toMcpCallResult({ content: [], details: [1, 2] }).structuredContent).toBeUndefined();
    expect(toMcpCallResult({ content: [], details: null }).structuredContent).toBeUndefined();
    expect(toMcpCallResult({ content: [] }).structuredContent).toBeUndefined();
  });

  it("defaults missing content to an empty array", () => {
    expect(toMcpCallResult({ content: undefined as unknown as unknown[] }).content).toEqual([]);
  });
});

describe("mcpErrorResult", () => {
  it("produces an isError result with the message as text content", () => {
    const r = mcpErrorResult("unknown tool: nope");
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: "text", text: "unknown tool: nope" }]);
    expect(r.structuredContent).toBeUndefined();
  });
});

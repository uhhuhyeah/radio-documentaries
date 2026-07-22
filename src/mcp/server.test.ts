/**
 * Lightweight integration test: boot the real MCP HTTP server on an ephemeral
 * port, then exercise it over HTTP with the SDK client — tools/list, a ping
 * call, the health endpoint, and the 401 path without a bearer token.
 */

import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Type } from "typebox";

import { toolResult } from "../tools/util";
import type { PiToolLike } from "./adapter";
import { startMcpHttpServer } from "./server";

const TOKEN = "test-token-abc123";

// A tiny tool set (no network) so the integration test stays hermetic.
const testTools: PiToolLike[] = [
  {
    name: "ping",
    description: "Health check.",
    parameters: Type.Object({}),
    execute: async () => toolResult("pong", { pong: true }) as never,
  },
  {
    name: "echo",
    description: "Echo the message back.",
    parameters: Type.Object({ msg: Type.String() }),
    execute: async (_id, args) => toolResult(`echo: ${args.msg}`, { msg: args.msg }) as never,
  },
];

let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const httpServer = await startMcpHttpServer({ port: 0, token: TOKEN, host: "127.0.0.1", tools: testTools });
  const port = (httpServer.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  close = () =>
    new Promise<void>((resolve, reject) => httpServer.close((e) => (e ? reject(e) : resolve())));
});

afterAll(async () => {
  await close?.();
});

function connect(token?: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  return client.connect(transport).then(() => client);
}

describe("startMcpHttpServer", () => {
  it("refuses to start without a token (fail closed)", async () => {
    await expect(startMcpHttpServer({ port: 0, token: "" })).rejects.toThrow(/fail closed/i);
  });

  it("serves GET /health without auth", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("rejects /mcp without a bearer token (401)", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("lists tools over HTTP with the bearer token", async () => {
    const client = await connect(TOKEN);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["echo", "ping"]);
    // TypeBox schema advertised as JSON Schema inputSchema.
    expect(tools.find((t) => t.name === "echo")?.inputSchema.type).toBe("object");
    await client.close();
  });

  it("calls ping and echo and maps results to MCP shape", async () => {
    const client = await connect(TOKEN);

    const ping = await client.callTool({ name: "ping", arguments: {} });
    expect((ping.content as { type: string; text: string }[])[0]?.text).toBe("pong");
    expect(ping.structuredContent).toEqual({ pong: true });

    const echo = await client.callTool({ name: "echo", arguments: { msg: "hi" } });
    expect((echo.content as { type: string; text: string }[])[0]?.text).toBe("echo: hi");
    expect(echo.structuredContent).toEqual({ msg: "hi" });

    await client.close();
  });

  it("returns an isError result for an unknown tool", async () => {
    const client = await connect(TOKEN);
    const r = await client.callTool({ name: "does-not-exist", arguments: {} });
    expect(r.isError).toBe(true);
    await client.close();
  });
});

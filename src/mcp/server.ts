/**
 * The MCP server: exposes the pipeline's `documentaryTools` over Streamable HTTP
 * so Hermes (a remote LXC) can call them as a toolset.
 *
 * Design choices (see autonomy-plan.md T0-1):
 *  - Low-level `Server` (not the Zod-centric `McpServer`) so our TypeBox schemas
 *    are advertised as JSON Schema verbatim — no conversion (see ./adapter).
 *  - `StreamableHTTPServerTransport` in STATELESS per-request mode
 *    (`sessionIdGenerator: undefined`). A fresh Server+transport is created per
 *    request to avoid JSON-RPC id collisions across concurrent clients.
 *  - Bearer auth is checked BEFORE the transport; the token is env-only.
 *  - DNS-rebinding (Host/Origin) protection is left DISABLED — Hermes connects
 *    cross-LXC from a different host/IP, and that check is localhost-oriented.
 *    We rely on the bearer token + LAN isolation instead.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";

import { Type } from "typebox";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { type CallToolResult, CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { documentaryTools } from "../tools/index";
import { toolResult as result } from "../tools/util";
import { mcpErrorResult, type PiToolLike, toMcpCallResult, toMcpToolDescriptor } from "./adapter";
import { isAuthorized } from "./auth";

const SERVER_INFO = { name: "subwave-documentaries", version: "0.1.0" } as const;

/** Trivial health-check tool so `hermes mcp test` and monitoring have something to call. */
export const pingTool = defineTool({
  name: "ping",
  label: "Ping",
  description: "Health check — returns 'pong' and the server time. Use to verify connectivity and auth.",
  parameters: Type.Object({}),
  execute: async () => result("pong", { pong: true, time: new Date().toISOString() }),
});

/** Every tool the MCP server serves: all documentary tools plus the ping health-check. */
export const servedTools: PiToolLike[] = [...(documentaryTools as unknown as PiToolLike[]), pingTool as unknown as PiToolLike];

/** Build a fresh low-level MCP `Server` with `tools/list` + `tools/call` wired to `servedTools`. */
export function createMcpServer(tools: PiToolLike[] = servedTools): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });
  const byName = new Map(tools.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(toMcpToolDescriptor),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const tool = byName.get(req.params.name);
    if (!tool) return mcpErrorResult(`unknown tool: ${req.params.name}`) as CallToolResult;
    try {
      const pi = await tool.execute(`mcp-${req.params.name}`, req.params.arguments ?? {});
      return toMcpCallResult(pi) as CallToolResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return mcpErrorResult(`${req.params.name} failed: ${msg}`) as CallToolResult;
    }
  });

  return server;
}

export interface McpHttpOptions {
  port: number;
  token: string;
  host?: string;
  tools?: PiToolLike[];
}

/**
 * Start the MCP HTTP server. Fails closed: throws if no bearer token is provided
 * (the process must refuse to serve unauthenticated).
 *
 * Routes:
 *  - `GET  /health` → `200 ok` (unauthenticated, for monitoring)
 *  - `POST|GET|DELETE /mcp` → Streamable HTTP transport, bearer-gated (401 otherwise)
 */
export async function startMcpHttpServer(opts: McpHttpOptions): Promise<HttpServer> {
  if (!opts.token || opts.token.trim() === "") {
    throw new Error("DOCS_MCP_TOKEN is not set — refusing to start an unauthenticated MCP server (fail closed).");
  }
  const host = opts.host ?? "0.0.0.0";
  const tools = opts.tools ?? servedTools;

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, opts.token, tools).catch((err) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      if (!res.writableEnded) {
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(err) }, id: null }));
      }
    });
  });

  // Long tool calls (research ~9 min, write ~8 min, render) must not be cut off.
  httpServer.requestTimeout = 0; // no overall request timeout
  httpServer.timeout = 0; // no socket inactivity timeout
  httpServer.headersTimeout = 60_000; // headers must still arrive promptly
  httpServer.keepAliveTimeout = 20 * 60_000; // 20 min — keep long-poll SSE connections alive

  await new Promise<void>((resolve) => httpServer.listen(opts.port, host, resolve));
  return httpServer;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  tools: PiToolLike[],
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Health check — unauthenticated, minimal.
  if (url.pathname === "/health" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }

  if (url.pathname !== "/mcp") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  // Bearer auth BEFORE the transport touches anything.
  if (!isAuthorized(req.headers.authorization, token)) {
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }));
    return;
  }

  // Stateless per-request: a fresh Server + transport, closed when the response ends.
  const server = createMcpServer(tools);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableDnsRebindingProtection: false, // cross-LXC access; we rely on bearer + LAN
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

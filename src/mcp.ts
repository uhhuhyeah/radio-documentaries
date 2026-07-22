#!/usr/bin/env tsx
/**
 * Entry point for the MCP server — exposes the pipeline's `documentaryTools` over
 * Streamable HTTP so Hermes (Nous `hermes-agent`, a separate LXC) can register it:
 *
 *   hermes mcp add subwave --url http://<pipeline-lxc>:8848/mcp --auth header
 *
 * Config: port from settings.toml `[mcp]` / `DOCS_MCP_PORT` (default 8848); the
 * bearer token is env-only (secret) — `DOCS_MCP_TOKEN`, provisioned via `.env`.
 * Fails closed: refuses to start without a token.
 *
 *   pnpm mcp
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config";
import { startMcpHttpServer } from "./mcp/server";
import { loadDotenv } from "./navidrome";

loadDotenv(join(dirname(fileURLToPath(import.meta.url)), "..", ".env")); // .env → process.env

const token = process.env.DOCS_MCP_TOKEN ?? "";
const port = config.mcp.port;

startMcpHttpServer({ port, token })
  .then(() => {
    console.log(`mcp: listening on http://0.0.0.0:${port}/mcp  (health: GET /health)`);
  })
  .catch((e) => {
    console.error(`mcp: failed to start — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });

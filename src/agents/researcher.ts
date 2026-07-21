/**
 * Researcher sub-agent — a Pi agent with web tools that deep-researches an
 * album's making-of and writes organised notes to a file. The Writer later uses
 * ONLY those notes, so the Researcher must be exhaustive and factual.
 *
 * Runs as an "agent-as-tool": the Producer invokes it via the research_album
 * tool. Needs LLM auth (OpenRouter).
 */

import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import { webFetchTool, webSearchTool } from "../tools/web";
import { RESEARCHER_SYSTEM } from "./system-prompts";

const MODEL_ID = process.env.DOCS_LLM_MODEL ?? "qwen/qwen3-235b-a22b-2507";

export async function researchAlbum(
  album: string,
  artist: string,
  notesPath: string,
  focus?: string,
): Promise<void> {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel("openrouter", MODEL_ID);
  if (!model) {
    throw new Error(`model not found: openrouter/${MODEL_ID} (is OPENROUTER_API_KEY set?)`);
  }

  const { session } = await createAgentSession({
    model,
    modelRuntime,
    sessionManager: SessionManager.inMemory(),
    customTools: [webSearchTool, webFetchTool],
    tools: ["write", "web_search", "web_fetch"],
  });

  const task = [
    RESEARCHER_SYSTEM,
    "",
    `Research the making of "${album}" by ${artist}.`,
    focus ? `Focus especially on: ${focus}.` : "",
    "",
    "Use web_search to find sources, then web_fetch to read the promising ones. Cross-check.",
    `When done, use the write tool to save your organised markdown notes to exactly this path: ${notesPath}`,
  ]
    .filter(Boolean)
    .join("\n");

  await session.prompt(task);
}

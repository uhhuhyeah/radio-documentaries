/**
 * The Producer — a Pi agent that orchestrates an episode by calling the
 * deterministic documentary tools plus the built-in read/write/bash tools.
 *
 * NOTE: running this needs LLM auth (OpenRouter). It is wired and typechecked,
 * but a first live run should confirm the model/provider resolves via
 * ModelRuntime (see the auth note if getModel returns undefined).
 */

import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import { documentaryTools } from "../tools/index";
import { PRODUCER_SYSTEM } from "./system-prompts";

const MODEL_ID = process.env.DOCS_LLM_MODEL ?? "qwen/qwen3-235b-a22b-2507";

export async function runProducer(trigger: string): Promise<void> {
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel("openrouter", MODEL_ID);
  if (!model) {
    throw new Error(
      `model not found: openrouter/${MODEL_ID}. Ensure OPENROUTER_API_KEY is set and the ` +
        `openrouter provider is configured in ~/.pi/agent (models.json/auth.json).`,
    );
  }

  const { session } = await createAgentSession({
    model,
    modelRuntime,
    sessionManager: SessionManager.inMemory(),
    customTools: documentaryTools,
    // Built-in file/shell tools + all documentary tools.
    tools: ["read", "write", "bash", ...documentaryTools.map((t) => t.name)],
  });

  await session.prompt(`${PRODUCER_SYSTEM}\n\n--- TRIGGER ---\n${trigger}`);
}
